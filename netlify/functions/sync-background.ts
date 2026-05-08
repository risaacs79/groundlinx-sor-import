/**
 * POST /api/sync-background — VA-team SOR Extract upload endpoint.
 *
 * Netlify v2 background function. The 26-second sync function ceiling
 * couldn't fit the full 2-3 min pipeline (sync_sor_extract +
 * import_work_orders), so today's sync was 504-killed mid-run on
 * 7 May 2026. This is the documented background-function upgrade
 * promised in the original sync.ts header.
 *
 * Workflow:
 *  1. Synchronous prelude (≤2s, errors surface to caller):
 *      - Auth: Authorization header == UPLOAD_PASSWORD env
 *      - Rate-limit: 20 uploads / hour / IP (in-memory per instance)
 *      - Multipart parse + xlsx validation
 *      - Generate runId (UUID)
 *  2. Create Sync Run audit item on monday with status=Running.
 *     Item exists within ~2s of the upload landing.
 *  3. Return 202 with no body. Netlify v2 background functions strip
 *     response bodies — runId / monday_item_id can't reach the client
 *     this way. They're logged server-side instead; the client links
 *     to the Sync Runs board where the just-created item appears at
 *     the top (sorted newest-first).
 *  4. Run runSyncSor → runImportWorkOrders sequentially. The 15-min
 *     background-function budget covers the worst case comfortably.
 *  5. On success: update Sync Run item with status=Success (or Partial
 *     if any sub-failures), Finished At=now, Duration sec, all count
 *     fields. Detailed pipeline log posted as a monday update on the
 *     same item.
 *  6. On exception anywhere post-prelude: update Sync Run item with
 *     status=Failed, Finished At=now, Duration sec, Error Message
 *     (truncated). Full stack trace posted as a monday update.
 *  7. Whole post-prelude flow is wrapped in try/catch so the item
 *     never gets stuck in Running.
 *
 * Track G1 (May 2026). See templates/README.md in the field-app repo
 * for the local CLI workflow used as a fallback when this function
 * misbehaves.
 */
import type { Config } from "@netlify/functions";
import { runSyncSor } from "./lib/sync_sor_extract";
import { runImportWorkOrders } from "./lib/import_work_orders";

// ---- Sync Runs board (Track G1) ----
const SYNC_RUNS_BOARD = 5028347145;
const SYNC_RUNS_COL = {
  status: "color_mm35ty8j",
  started_at: "date_mm35h5z",
  finished_at: "date_mm35hhn7",
  duration_sec: "numeric_mm35zbbe",
  rows_updated: "numeric_mm35pha8",
  jobs_created_active: "numeric_mm35j6z4",
  jobs_created_approved: "numeric_mm352zek",
  failed_count: "numeric_mm35aese",
  error_message: "long_text_mm35dhbn",
};

// ---- Request limits ----
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 20; // bumped from 5/hr (Track G1) — bg-function context
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — extracts are < 200 KB normally

// ---- Rate-limit state ----
const rateLimitMap = new Map<string, number[]>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function clientIp(req: Request): string {
  const nf = req.headers.get("x-nf-client-connection-ip");
  if (nf) return nf.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const recent = (rateLimitMap.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, recent);
    return { allowed: false, remaining: 0 };
  }
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return { allowed: true, remaining: RATE_LIMIT_MAX - recent.length };
}

// ---- monday client (kept inline; mirrors lib/*.ts pattern) ----
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
  if (json.errors) {
    throw new Error(`monday errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

// ---- Sync Runs item helpers ----
function formatUtcStamp(d: Date): string {
  // "2026-05-07 23:45 UTC" — concise and grep-able for Sync Run names
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoTime(d: Date): string {
  return d.toISOString().slice(11, 19);
}

interface SyncRunItem {
  id: string;
  url: string;
}

async function createSyncRunItem(
  name: string,
  startedAt: Date
): Promise<SyncRunItem> {
  const columnValues: Record<string, unknown> = {
    [SYNC_RUNS_COL.status]: { label: "Running" },
    [SYNC_RUNS_COL.started_at]: {
      date: isoDate(startedAt),
      time: isoTime(startedAt),
    },
  };
  const data = await monday<{ create_item: { id: string } }>(
    `mutation ($boardId: ID!, $name: String!, $cols: JSON!) {
      create_item(
        board_id: $boardId,
        item_name: $name,
        column_values: $cols,
        create_labels_if_missing: true
      ) { id }
    }`,
    {
      boardId: String(SYNC_RUNS_BOARD),
      name,
      cols: JSON.stringify(columnValues),
    }
  );
  const id = data.create_item.id;
  return {
    id,
    url: `https://mv-civil-company.monday.com/boards/${SYNC_RUNS_BOARD}/pulses/${id}`,
  };
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

async function updateSyncRunItem(
  itemId: string,
  upd: SyncRunUpdate
): Promise<void> {
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
  // monday update bodies accept light HTML; strip risky chars and cap
  // length so a runaway stack doesn't fail the create_update mutation.
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

// ---- Pre-flight (synchronous; errors surface to caller as proper status) ----

interface PreFlightOk {
  ok: true;
  fileBuffer: Buffer;
  filename: string;
  ip: string;
  rateRemaining: number;
}
interface PreFlightFail {
  ok: false;
  response: Response;
}

async function preFlight(req: Request): Promise<PreFlightOk | PreFlightFail> {
  if (req.method !== "POST") {
    return {
      ok: false,
      response: jsonResponse(405, { ok: false, error: "Method not allowed" }),
    };
  }
  const expected = process.env.UPLOAD_PASSWORD;
  if (!expected) {
    return {
      ok: false,
      response: jsonResponse(500, {
        ok: false,
        error: "Server misconfigured: UPLOAD_PASSWORD env var not set",
      }),
    };
  }
  if (!process.env.MONDAY_API_TOKEN) {
    return {
      ok: false,
      response: jsonResponse(500, {
        ok: false,
        error: "Server misconfigured: MONDAY_API_TOKEN env var not set",
      }),
    };
  }
  const provided = req.headers.get("authorization");
  if (provided !== expected) {
    return {
      ok: false,
      response: jsonResponse(401, { ok: false, error: "Wrong password" }),
    };
  }

  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return {
      ok: false,
      response: jsonResponse(429, {
        ok: false,
        error: `Rate limit hit (max ${RATE_LIMIT_MAX} uploads/hour). Try again later.`,
      }),
    };
  }

  let fileBuffer: Buffer;
  let filename: string;
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return {
        ok: false,
        response: jsonResponse(400, {
          ok: false,
          error: 'Upload must include a "file" field with the SOR Extract.',
        }),
      };
    }
    if (file.size === 0) {
      return {
        ok: false,
        response: jsonResponse(400, { ok: false, error: "Uploaded file is empty" }),
      };
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return {
        ok: false,
        response: jsonResponse(400, {
          ok: false,
          error: `File too large (${Math.round(file.size / 1024)} KB > ${MAX_FILE_SIZE_BYTES / 1024} KB cap).`,
        }),
      };
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return {
        ok: false,
        response: jsonResponse(400, {
          ok: false,
          error: ".xlsx file required (got " + file.name + ")",
        }),
      };
    }
    fileBuffer = Buffer.from(await file.arrayBuffer());
    filename = file.name;
  } catch (err) {
    return {
      ok: false,
      response: jsonResponse(400, {
        ok: false,
        error: `Failed to parse upload: ${err instanceof Error ? err.message : String(err)}`,
      }),
    };
  }

  return { ok: true, fileBuffer, filename, ip, rateRemaining: limit.remaining };
}

// ---- Main handler ----

export default async (req: Request): Promise<Response> => {
  // Synchronous prelude — errors here propagate to the caller as the
  // appropriate HTTP status (Netlify forwards them despite the bg-fn
  // suffix because the function returns BEFORE entering the long path).
  const pre = await preFlight(req);
  if (!pre.ok) return pre.response;

  // Crypto.randomUUID is on the global scope in Node 20+ (Netlify default).
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const itemName = `Sync Run ${formatUtcStamp(startedAt)} (${pre.filename})`;

  // Create the audit item BEFORE starting the work so it's visible
  // immediately on the Sync Runs board. If this fails (rare), surface
  // the failure synchronously — better than a silent 202 with no record.
  let runItem: SyncRunItem;
  try {
    runItem = await createSyncRunItem(itemName, startedAt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, {
      ok: false,
      error: `Couldn't create Sync Run audit item on monday: ${message}`,
      runId,
    });
  }

  // Kick off the long-running pipeline. Netlify's background-function
  // semantics keep the function alive up to 15 min after we return the
  // 202; the work continues even though the caller has long since
  // received the response. Wrap in try/catch INSIDE runPipeline so an
  // exception never leaves the audit item stuck in Running.
  void runPipeline(pre.fileBuffer, pre.filename, runItem.id, runId, startedAt);

  // Return 202 Accepted with no body. Netlify v2 background functions
  // strip response bodies for bg-function invocations regardless of
  // what we return — only the status is preserved. The runId and
  // monday_item_id are logged server-side (Netlify function logs) for
  // audit / triage; the user finds their just-started run by visiting
  // the Sync Runs board (linked from the success card on the upload page).
  console.log(
    `[sync-bg] runId=${runId} mondayItemId=${runItem.id} filename="${pre.filename}" — pipeline started`
  );
  return new Response(null, {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  });
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
    syncSummary = await runSyncSor(fileBuffer);

    stage = "import_work_orders";
    importSummary = await runImportWorkOrders(fileBuffer);

    // Done — write the final state.
    const finishedAt = new Date();
    const durationSec = Math.round(
      (finishedAt.getTime() - startedAt.getTime()) / 1000
    );
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
  } catch (err) {
    const finishedAt = new Date();
    const durationSec = Math.round(
      (finishedAt.getTime() - startedAt.getTime()) / 1000
    );
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? message : message;

    // Best-effort: attempt the failure-state update. If THIS also throws
    // (e.g. monday API down), we've at least logged to Netlify; the item
    // stays in Running and an operator triages from logs.
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
      console.error("Sync Run failure-state update also failed:", innerErr);
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
      console.error("Sync Run failure-update post also failed:", innerErr);
    }

    // Re-throw so Netlify logs capture the original. (The 202 has long
    // since been sent to the caller.)
    throw err;
  }
}

export const config: Config = {
  path: "/api/sync-background",
};
