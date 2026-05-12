/**
 * POST /.netlify/functions/sync-worker-background — heavy-lifting worker.
 *
 * Track G2 (May 2026): the actual sync_sor_extract + import_work_orders
 * + sync_job_data pipeline run, invoked by the synchronous wrapper at
 * /api/sync. Netlify v2 background function — 15-min budget, 202
 * auto-emitted with empty body (caller doesn't read the response, it's
 * fire-and-forget).
 *
 * Auth: rejects POSTs without the shared INTERNAL_SYNC_SECRET in the
 * x-internal-secret header. Bg functions are reachable at their public
 * URL and Netlify doesn't gate them at the CDN, so the secret is the
 * only thing stopping a random POST from triggering arbitrary monday
 * writes.
 *
 * Workflow:
 *  1. Parse JSON body — {runId, mondayItemId, filename, fileBase64}
 *  2. Validate x-internal-secret header. Mismatch → 401 + log + exit
 *     (Netlify forces 202 to caller anyway, but we abort the function
 *     before doing work).
 *  3. Decode fileBase64 → Buffer.
 *  4. Run runSyncSor → runImportWorkOrders → runSyncJobData
 *     sequentially. Track J2 (May 2026) added the 3rd stage so per-job
 *     stored numerics + Primary Asset relations land on the same
 *     upload as the import — previously the dashboard would lag until
 *     the next manual sync_job_data CLI run.
 *  5. Update Sync Run item (mondayItemId) with final state — status,
 *     Finished At, Duration sec, all count columns, optional error msg.
 *  6. Post detailed pipeline log as a monday update on the same item.
 *  7. On exception anywhere: failure-state update with stack trace,
 *     wrapped in inner try/catch so the item never sticks in Running.
 *
 * Required env: MONDAY_API_TOKEN, INTERNAL_SYNC_SECRET (shared with
 * sync.ts).
 */
import type { Config } from "@netlify/functions";
import { runSyncSor } from "./lib/sync_sor_extract";
import { runImportWorkOrders } from "./lib/import_work_orders";
import { runSyncJobData } from "./lib/sync_job_data";
import {
  runReconcileRowPlacement,
  type ReconcileResult,
} from "./lib/reconcile_row_placement";

// ---- Sync Runs board (Track G1) ----
const SYNC_RUNS_BOARD = 5028347145;
const SYNC_RUNS_COL = {
  status: "color_mm35ty8j",
  finished_at: "date_mm35hhn7",
  duration_sec: "numeric_mm35zbbe",
  rows_updated: "numeric_mm35pha8",
  jobs_created_active: "numeric_mm35j6z4",
  jobs_created_approved: "numeric_mm352zek",
  failed_count: "numeric_mm35aese",
  error_message: "long_text_mm35dhbn",
};

// ---- monday client (mirrors lib/*.ts pattern) ----
async function monday<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("MONDAY_API_TOKEN env var not set");
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`monday HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`monday errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoTime(d: Date): string {
  return d.toISOString().slice(11, 19);
}

interface SyncRunUpdate {
  status: "Success" | "Partial" | "Failed";
  finishedAt: Date;
  durationSec: number;
  rowsUpdated: number;
  jobsCreatedActive: number;
  jobsCreatedApproved: number;
  failedCount: number;
  errorMessage: string;
}

async function updateSyncRunItem(itemId: string, upd: SyncRunUpdate): Promise<void> {
  const columnValues: Record<string, unknown> = {
    [SYNC_RUNS_COL.status]: { label: upd.status },
    [SYNC_RUNS_COL.finished_at]: {
      date: isoDate(upd.finishedAt),
      time: isoTime(upd.finishedAt),
    },
    [SYNC_RUNS_COL.duration_sec]: upd.durationSec,
    [SYNC_RUNS_COL.rows_updated]: upd.rowsUpdated,
    [SYNC_RUNS_COL.jobs_created_active]: upd.jobsCreatedActive,
    [SYNC_RUNS_COL.jobs_created_approved]: upd.jobsCreatedApproved,
    [SYNC_RUNS_COL.failed_count]: upd.failedCount,
    [SYNC_RUNS_COL.error_message]: upd.errorMessage.slice(0, 1000),
  };
  await monday(
    `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
      change_multiple_column_values(
        board_id: $boardId,
        item_id: $itemId,
        column_values: $cols,
        create_labels_if_missing: true
      ) { id }
    }`,
    {
      boardId: String(SYNC_RUNS_BOARD),
      itemId,
      cols: JSON.stringify(columnValues),
    }
  );
}

async function postSyncRunUpdate(itemId: string, body: string): Promise<void> {
  const safe = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 9000);
  await monday(
    `mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId, body: safe }
  );
}

interface WorkerPayload {
  runId?: string;
  mondayItemId?: string;
  filename?: string;
  fileBase64?: string;
}

export default async (req: Request): Promise<Response> => {
  // Netlify v2 background-function contract:
  //   - The `-background` SUFFIX on this file's name is what makes the
  //     CDN emit 202 to the caller (sync.ts) automatically the moment
  //     it routes the request, AND extends our budget to 15 minutes.
  //   - Our return value DOES NOT trigger the 202 — it's already on the
  //     wire by the time we run.
  //   - Lambda freezes the execution context the moment the handler
  //     promise resolves. Any pending promise we hand-rolled outside an
  //     `await` (e.g. `void runPipeline()`) gets orphaned and dies with
  //     the container. This was the live bug as of commit 7aa4093:
  //     audit rows stuck at Running forever because runPipeline's
  //     status-update tail never executed.
  //
  // So: AWAIT the work, then return. Status code on our Response is
  // logged by Netlify but otherwise ignored.
  console.log(
    `[sync-worker-bg] invoked: method=${req.method} url=${req.url}`
  );

  // --- Track G3 (May 2026): master diagnostic wrapper ---
  // Every code path that learns mondayItemId — even ones that error out
  // before the pipeline runs — should flip the audit row from Running to
  // Failed and stamp Finished At. The orphan-detection invariant is:
  //   any row with status=Running AND finishedAt=null AND
  //   startedAt > 30min ago = an orphan that escaped our error handling.
  let mondayItemId: string | null = null;
  let runId: string | null = null;
  const startedAt = new Date();
  let pipelineFinalized = false;

  try {
    if (req.method !== "POST") {
      console.warn(`[sync-worker-bg] rejected: non-POST method ${req.method}`);
      return new Response(null, { status: 405 });
    }

    // Secret moved to x-internal-secret header (G2-fix1).
    const expected = process.env.INTERNAL_SYNC_SECRET;
    if (!expected) {
      console.error("[sync-worker-bg] INTERNAL_SYNC_SECRET env var not set");
      return new Response(null, { status: 500 });
    }
    const provided = req.headers.get("x-internal-secret");
    if (provided !== expected) {
      console.warn(
        `[sync-worker-bg] rejected POST: x-internal-secret mismatch (received ${provided ? "<value>" : "<missing>"})`
      );
      return new Response(null, { status: 401 });
    }

    let payload: WorkerPayload;
    try {
      payload = (await req.json()) as WorkerPayload;
    } catch (err) {
      console.error("[sync-worker-bg] invalid JSON body:", err);
      return new Response(null, { status: 400 });
    }

    const { filename, fileBase64 } = payload;
    runId = payload.runId ?? null;
    mondayItemId = payload.mondayItemId ?? null;
    if (!runId || !mondayItemId || !fileBase64) {
      console.error(
        `[sync-worker-bg] rejected POST: missing required fields runId=${!!runId} mondayItemId=${!!mondayItemId} fileBase64=${!!fileBase64}`
      );
      return new Response(null, { status: 400 });
    }

    console.log(
      `[sync-worker-bg] runId=${runId} mondayItemId=${mondayItemId} filename="${filename ?? "?"}" fileSize=${fileBase64.length}b(b64) — pipeline starting`
    );

    // AWAIT the pipeline. Netlify keeps the function alive because of
    // the -background filename suffix, not because of what we return.
    // runPipeline owns its own status updates (success + failure paths).
    await runPipeline(
      Buffer.from(fileBase64, "base64"),
      filename ?? "extract.xlsx",
      mondayItemId,
      runId,
      startedAt
    );
    pipelineFinalized = true;
    return new Response(null, { status: 202 });
  } catch (err) {
    // Master catch — fires only if runPipeline THROWS something its
    // own inner try/catch didn't handle (it shouldn't, but defense in
    // depth). Also catches anything in the pre-pipeline setup that
    // happens AFTER we learned mondayItemId.
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? msg : msg;
    console.error(
      `[sync-worker-bg] runId=${runId ?? "?"} master catch:`,
      stack
    );
    if (mondayItemId) {
      pipelineFinalized = true; // we're handling it here
      const finishedAt = new Date();
      const durationSec = Math.round(
        (finishedAt.getTime() - startedAt.getTime()) / 1000
      );
      try {
        await updateSyncRunItem(mondayItemId, {
          status: "Failed",
          finishedAt,
          durationSec,
          rowsUpdated: 0,
          jobsCreatedActive: 0,
          jobsCreatedApproved: 0,
          failedCount: 1,
          errorMessage: `[master-catch] ${msg}`.slice(0, 1000),
        });
      } catch (innerErr) {
        console.error(
          `[sync-worker-bg] runId=${runId ?? "?"} master-catch updateSyncRunItem failed:`,
          innerErr
        );
      }
      try {
        await postSyncRunUpdate(
          mondayItemId,
          [
            `runId: ${runId ?? "(unknown)"}`,
            `finished: ${finishedAt.toISOString()}`,
            `final status: Failed (master catch)`,
            "",
            "Error:",
            msg,
            "",
            "Stack:",
            stack,
          ].join("\n")
        );
      } catch (innerErr) {
        console.error(
          `[sync-worker-bg] runId=${runId ?? "?"} master-catch postSyncRunUpdate failed:`,
          innerErr
        );
      }
    }
    return new Response(null, { status: 500 });
  } finally {
    // Defence-in-depth: if neither the success nor failure path stamped
    // a final state — e.g. the handler returned early via a 4xx after
    // learning mondayItemId — flip the row to Failed and stamp Finished
    // At so it never sticks in Running. This is what makes future
    // orphans detectable: status=Running AND finishedAt=null AND
    // startedAt > 30min ago = orphan candidate.
    if (!pipelineFinalized && mondayItemId) {
      const finishedAt = new Date();
      const durationSec = Math.round(
        (finishedAt.getTime() - startedAt.getTime()) / 1000
      );
      console.warn(
        `[sync-worker-bg] runId=${runId ?? "?"} finalize-in-finally — pipelineFinalized=false; stamping Finished At as a defence backstop`
      );
      try {
        await updateSyncRunItem(mondayItemId, {
          status: "Failed",
          finishedAt,
          durationSec,
          rowsUpdated: 0,
          jobsCreatedActive: 0,
          jobsCreatedApproved: 0,
          failedCount: 1,
          errorMessage:
            "Worker exited before runPipeline registered completion — likely an early return after audit-row creation (4xx). Check Netlify function logs around this runId.",
        });
      } catch (innerErr) {
        console.error(
          `[sync-worker-bg] runId=${runId ?? "?"} finally-block update failed:`,
          innerErr
        );
      }
    }
  }
};

async function runPipeline(
  fileBuffer: Buffer,
  filename: string,
  itemId: string,
  runId: string,
  startedAt: Date
): Promise<void> {
  let syncSummary: Awaited<ReturnType<typeof runSyncSor>> | null = null;
  let importSummary: Awaited<ReturnType<typeof runImportWorkOrders>> | null = null;
  let jobDataSummary: Awaited<ReturnType<typeof runSyncJobData>> | null = null;
  let reconcileSummary: ReconcileResult | null = null;
  let stage = "init";

  try {
    stage = "sync_sor_extract";
    console.log(`[sync-worker-bg] runId=${runId} stage=${stage} starting`);
    syncSummary = await runSyncSor(fileBuffer);
    console.log(
      `[sync-worker-bg] runId=${runId} stage=${stage} done updated=${syncSummary.updated} unchanged=${syncSummary.unchanged} unmatched=${syncSummary.unmatched} failed=${syncSummary.failed}`
    );

    stage = "import_work_orders";
    console.log(`[sync-worker-bg] runId=${runId} stage=${stage} starting`);
    importSummary = await runImportWorkOrders(fileBuffer);
    console.log(
      `[sync-worker-bg] runId=${runId} stage=${stage} done active=${importSummary.createdActive} jobComplete=${importSummary.createdJobComplete} submitted=${importSummary.createdSubmitted} approved=${importSummary.createdApproved} skipped=${importSummary.skipped} failed=${importSummary.failed}`
    );

    // Track J2: 3rd stage. Backfills per-job Primary Asset relations
    // and 6 revenue stored numerics across all 3 job boards. Idempotent
    // so this is safe to run on every upload — no-ops if nothing
    // changed. Typical run ~3-4 minutes (within bg 15-min budget).
    stage = "sync_job_data";
    console.log(`[sync-worker-bg] runId=${runId} stage=${stage} starting`);
    jobDataSummary = await runSyncJobData();
    console.log(
      `[sync-worker-bg] runId=${runId} stage=${stage} done writes=${jobDataSummary.totalWrites} failed=${jobDataSummary.totalFailed} elapsed=${Math.round(jobDataSummary.elapsedMs / 1000)}s`
    );

    // Stage 3 — reconcile row placement. Gated on ENABLE_STAGE_3 env
    // var so production stays no-op until the one-time migration has
    // run and Rowan flips the flag in Netlify. Idempotent / diff-only
    // — rows already on the correct board are skipped, blanks +
    // unknown statuses + TEST assets are skipped, so a stale ENABLE
    // flag doesn't cause drift.
    if (process.env.ENABLE_STAGE_3 === "true") {
      stage = "reconcile_row_placement";
      console.log(`[sync-worker-bg] runId=${runId} stage=${stage} starting`);
      try {
        reconcileSummary = await runReconcileRowPlacement({ dryRun: false });
        console.log(
          `[sync-worker-bg] runId=${runId} stage=${stage} done planned=${reconcileSummary.movesPlanned} succeeded=${reconcileSummary.movesSucceeded} failed=${reconcileSummary.movesFailed} unchanged=${reconcileSummary.unchanged}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[sync-worker-bg] runId=${runId} stage=${stage} threw:`,
          msg
        );
        // Stage 3 failure doesn't fail the pipeline — log it and
        // continue. The audit row will surface this in the failures
        // section but final status stays Success/Partial based on the
        // upstream stages.
        reconcileSummary = {
          totalChecked: 0,
          movesPlanned: 0,
          movesSucceeded: 0,
          movesFailed: 1,
          unchanged: 0,
          skippedBlankStatus: 0,
          skippedUnknownStatus: 0,
          skippedTest: 0,
          byDirection: {},
          failures: [
            {
              itemId: "(stage)",
              fromBoard: "active",
              toBoard: "active",
              error: `stage threw: ${msg.slice(0, 200)}`,
            },
          ],
        };
      }
    } else {
      console.log(
        `[sync-worker-bg] runId=${runId} stage=reconcile_row_placement SKIPPED (ENABLE_STAGE_3 != "true")`
      );
    }

    const finishedAt = new Date();
    const durationSec = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
    const failedCount =
      (syncSummary?.failed ?? 0) +
      (importSummary?.failed ?? 0) +
      (jobDataSummary?.totalFailed ?? 0) +
      (reconcileSummary?.movesFailed ?? 0);
    const status: "Success" | "Partial" =
      failedCount > 0 || (syncSummary?.unmatched ?? 0) > 0 ? "Partial" : "Success";

    await updateSyncRunItem(itemId, {
      status,
      finishedAt,
      durationSec,
      rowsUpdated: syncSummary?.updated ?? 0,
      jobsCreatedActive: importSummary?.createdActive ?? 0,
      jobsCreatedApproved: importSummary?.createdApproved ?? 0,
      failedCount,
      errorMessage: "",
    });

    const jdReport = (
      label: string,
      r: Awaited<ReturnType<typeof runSyncJobData>>["active"]
    ): string[] => [
      `  ${label} (${r.total}):`,
      `    primary writes:      ${r.primaryWrites}`,
      `    revenue writes:      ${r.revenueWrites}`,
      `    photo writes:        ${r.photoWrites}`,
      `    lifecycle writes:    ${r.lifecycleWrites}`,
      `    designMetres writes: ${r.designMetresWrites}`,
      `    actualMetres writes: ${r.actualMetresWrites}`,
      `    unchanged:           ${r.unchanged}`,
      `    TEST items:          ${r.testItems}`,
      `    unmatched:           ${r.unmatchedItems}`,
      `    failed:              ${r.failed}`,
      ...(r.failures.length > 0
        ? r.failures.slice(0, 5).map((f) => `      - ${f.slice(0, 250)}`)
        : []),
    ];

    const logLines: string[] = [
      `runId: ${runId}`,
      `filename: ${filename}`,
      `started: ${startedAt.toISOString()}`,
      `finished: ${finishedAt.toISOString()}`,
      `duration: ${durationSec}s`,
      `final status: ${status}`,
      "",
      "[runSyncSor]",
      `  rows processed: ${syncSummary.rowsProcessed}`,
      `  to update: ${syncSummary.toUpdate}`,
      `  updated: ${syncSummary.updated}`,
      `  unchanged: ${syncSummary.unchanged}`,
      `  unmatched: ${syncSummary.unmatched}`,
      `  failed: ${syncSummary.failed}`,
      `  new Field Complete: ${syncSummary.newFieldComplete.length}`,
      `  new Paid: ${syncSummary.newPaid.length}`,
      ...(syncSummary.failures.length > 0
        ? [
            "  failures:",
            ...syncSummary.failures.slice(0, 10).map((f) => `    - ${f.slice(0, 250)}`),
          ]
        : []),
      "",
      "[runImportWorkOrders]",
      `  unique assets: ${importSummary.uniqueAssets}`,
      `  network assets created: ${importSummary.networkAssetsCreated}`,
      `  created on Active Jobs: ${importSummary.createdActive}`,
      `  created on Job Complete: ${importSummary.createdJobComplete}`,
      `  created on Submitted Jobs: ${importSummary.createdSubmitted}`,
      `  created on Approved & Paid: ${importSummary.createdApproved}`,
      `  skipped (already imported): ${importSummary.skipped}`,
      `  failed: ${importSummary.failed}`,
      ...(importSummary.failures.length > 0
        ? [
            "  failures:",
            ...importSummary.failures.slice(0, 10).map((f) => `    - ${f.slice(0, 250)}`),
          ]
        : []),
      "",
      "[runSyncJobData]",
      `  total writes: ${jobDataSummary.totalWrites}`,
      `  total failed: ${jobDataSummary.totalFailed}`,
      `  elapsed: ${Math.round(jobDataSummary.elapsedMs / 1000)}s`,
      ...jdReport("Active Jobs", jobDataSummary.active),
      ...jdReport("Job Complete", jobDataSummary.jobComplete),
      ...jdReport("Submitted Jobs", jobDataSummary.submitted),
      ...jdReport("Approved & Paid", jobDataSummary.approved),
      ...jdReport("Cancelled Jobs", jobDataSummary.cancelled),
      "",
      "[runReconcileRowPlacement]",
      ...(reconcileSummary
        ? [
            `  total rows checked: ${reconcileSummary.totalChecked}`,
            `  moves planned:      ${reconcileSummary.movesPlanned}`,
            `  moves succeeded:    ${reconcileSummary.movesSucceeded}`,
            `  moves failed:       ${reconcileSummary.movesFailed}`,
            `  unchanged:          ${reconcileSummary.unchanged}`,
            `  skipped (blank):    ${reconcileSummary.skippedBlankStatus}`,
            `  skipped (unknown):  ${reconcileSummary.skippedUnknownStatus}`,
            `  skipped (TEST):     ${reconcileSummary.skippedTest}`,
            "  by direction:",
            ...Object.entries(reconcileSummary.byDirection)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => `    ${k}: ${n}`),
            ...(reconcileSummary.unknownStatusSamples &&
            reconcileSummary.unknownStatusSamples.length > 0
              ? [
                  "  unknown statuses (top 10):",
                  ...reconcileSummary.unknownStatusSamples.map(
                    (s) => `    ${s}`
                  ),
                ]
              : []),
            ...(reconcileSummary.failures.length > 0
              ? [
                  "  failures:",
                  ...reconcileSummary.failures
                    .slice(0, 10)
                    .map(
                      (f) =>
                        `    - item=${f.itemId} ${f.fromBoard}→${f.toBoard}: ${f.error.slice(0, 200)}`
                    ),
                ]
              : []),
          ]
        : ["  SKIPPED (ENABLE_STAGE_3 != 'true')"]),
    ];
    await postSyncRunUpdate(itemId, logLines.join("\n"));
    console.log(
      `[sync-worker-bg] runId=${runId} pipeline complete in ${durationSec}s status=${status}`
    );
  } catch (err) {
    const finishedAt = new Date();
    const durationSec = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? message : message;

    console.error(
      `[sync-worker-bg] runId=${runId} stage=${stage} FAILED:`,
      message
    );

    try {
      await updateSyncRunItem(itemId, {
        status: "Failed",
        finishedAt,
        durationSec,
        rowsUpdated: syncSummary?.updated ?? 0,
        jobsCreatedActive: importSummary?.createdActive ?? 0,
        jobsCreatedApproved: importSummary?.createdApproved ?? 0,
        failedCount: 1,
        errorMessage: `[stage=${stage}] ${message}`,
      });
    } catch (innerErr) {
      console.error(
        `[sync-worker-bg] runId=${runId} failure-state update also failed:`,
        innerErr
      );
    }

    try {
      await postSyncRunUpdate(
        itemId,
        [
          `runId: ${runId}`,
          `filename: ${filename}`,
          `started: ${startedAt.toISOString()}`,
          `finished: ${finishedAt.toISOString()}`,
          `duration: ${durationSec}s`,
          `final status: Failed (stage=${stage})`,
          "",
          "Error:",
          message,
          "",
          "Stack:",
          stack,
          "",
          ...(syncSummary
            ? [
                "[runSyncSor partial]",
                `  updated: ${syncSummary.updated}`,
                `  unchanged: ${syncSummary.unchanged}`,
                `  unmatched: ${syncSummary.unmatched}`,
              ]
            : ["[runSyncSor]", "  did not run"]),
          "",
          ...(importSummary
            ? [
                "[runImportWorkOrders partial]",
                `  created Active: ${importSummary.createdActive}`,
                `  created Job Complete: ${importSummary.createdJobComplete}`,
                `  created Submitted: ${importSummary.createdSubmitted}`,
                `  created Approved: ${importSummary.createdApproved}`,
              ]
            : ["[runImportWorkOrders]", "  did not run"]),
          "",
          ...(jobDataSummary
            ? [
                "[runSyncJobData partial]",
                `  total writes: ${jobDataSummary.totalWrites}`,
                `  total failed: ${jobDataSummary.totalFailed}`,
              ]
            : ["[runSyncJobData]", "  did not run"]),
        ].join("\n")
      );
    } catch (innerErr) {
      console.error(
        `[sync-worker-bg] runId=${runId} failure-update post also failed:`,
        innerErr
      );
    }
    // Don't re-throw — the 202 has long since been sent and Netlify
    // logs already capture the original via console.error above.
  }
}

export const config: Config = {
  path: "/api/sync-worker-background",
};
