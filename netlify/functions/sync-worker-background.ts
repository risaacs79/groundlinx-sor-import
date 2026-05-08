/**
 * POST /.netlify/functions/sync-worker-background — heavy-lifting worker.
 *
 * Track G2 (May 2026): the actual sync_sor_extract + import_work_orders
 * pipeline run, invoked by the synchronous wrapper at /api/sync. Netlify
 * v2 background function — 15-min budget, 202 auto-emitted with empty
 * body (caller doesn't read the response, it's fire-and-forget).
 *
 * Auth: rejects POSTs without the shared INTERNAL_SYNC_SECRET in the
 * body. Bg functions are reachable at their public URL and Netlify
 * doesn't gate them at the CDN, so the secret is the only thing
 * stopping a random POST from triggering arbitrary monday writes.
 *
 * Workflow:
 *  1. Parse JSON body — {runId, mondayItemId, filename, fileBase64, secret}
 *  2. Validate secret. Mismatch → 401 + log + exit (Netlify forces 202
 *     to caller anyway, but we abort the function before doing work).
 *  3. Decode fileBase64 → Buffer.
 *  4. Run runSyncSor → runImportWorkOrders sequentially.
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
  secret?: string;
}

export default async (req: Request): Promise<Response> => {
  // Netlify forces 202 once we return — the caller (our sync.ts wrapper)
  // is fire-and-forget so it doesn't read the response. We still
  // return early on 401 to short-circuit the function before any work
  // fires, which is the actual security mechanism here.
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  let payload: WorkerPayload;
  try {
    payload = (await req.json()) as WorkerPayload;
  } catch (err) {
    console.error("[sync-worker-bg] invalid JSON body:", err);
    return new Response(null, { status: 400 });
  }

  const expected = process.env.INTERNAL_SYNC_SECRET;
  if (!expected) {
    console.error("[sync-worker-bg] INTERNAL_SYNC_SECRET env var not set");
    return new Response(null, { status: 500 });
  }
  if (payload.secret !== expected) {
    console.warn(
      `[sync-worker-bg] rejected POST: secret mismatch (received ${payload.secret ? "<value>" : "<missing>"})`
    );
    return new Response(null, { status: 401 });
  }

  const { runId, mondayItemId, filename, fileBase64 } = payload;
  if (!runId || !mondayItemId || !fileBase64) {
    console.error(
      `[sync-worker-bg] rejected POST: missing required fields runId=${!!runId} mondayItemId=${!!mondayItemId} fileBase64=${!!fileBase64}`
    );
    return new Response(null, { status: 400 });
  }

  // We're committed to the work — log the start and run it. The 202
  // gets emitted to our caller (sync.ts) as soon as we return; the
  // function continues until runPipeline finishes (up to 15 min).
  const startedAt = new Date();
  console.log(
    `[sync-worker-bg] runId=${runId} mondayItemId=${mondayItemId} filename="${filename ?? "?"}" — pipeline starting`
  );

  // Decode buffer + run pipeline. Wrap in async IIFE so we can return
  // the 202 immediately while the work continues.
  void runPipeline(
    Buffer.from(fileBase64, "base64"),
    filename ?? "extract.xlsx",
    mondayItemId,
    runId,
    startedAt
  );

  // Returning here lets Netlify emit 202 to the caller. The runPipeline
  // promise keeps running until it resolves (up to 15 min budget).
  return new Response(null, { status: 202 });
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
      `[sync-worker-bg] runId=${runId} stage=${stage} done active=${importSummary.createdActive} approved=${importSummary.createdApproved} skipped=${importSummary.skipped} failed=${importSummary.failed}`
    );

    const finishedAt = new Date();
    const durationSec = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
    const failedCount =
      (syncSummary?.failed ?? 0) + (importSummary?.failed ?? 0);
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
      `  created on Approved & Paid: ${importSummary.createdApproved}`,
      `  skipped (already imported): ${importSummary.skipped}`,
      `  failed: ${importSummary.failed}`,
      ...(importSummary.failures.length > 0
        ? [
            "  failures:",
            ...importSummary.failures.slice(0, 10).map((f) => `    - ${f.slice(0, 250)}`),
          ]
        : []),
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
                `  created Approved: ${importSummary.createdApproved}`,
              ]
            : ["[runImportWorkOrders]", "  did not run"]),
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
