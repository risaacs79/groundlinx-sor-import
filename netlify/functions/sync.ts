/**
 * POST /api/sync — VA-team SOR Extract upload endpoint (synchronous wrapper).
 *
 * Track G2 architecture (May 2026): two-function pattern.
 *
 *   1. THIS function (sync.ts) — synchronous, ≤26s budget:
 *        - Auth + rate-limit + multipart parse
 *        - Generate runId (UUID) + create Sync Run audit item on monday
 *        - Fire-and-forget POST to sync-worker-background with the file
 *          buffer + secret + audit-item id
 *        - Return 200 with {runId, monday_item_id, monday_item_url, board_url}
 *          so the upload page can deep-link to the running audit item
 *
 *   2. sync-worker-background.ts — Netlify v2 background function, 15-min budget:
 *        - Validate INTERNAL_SYNC_SECRET (rejects random POSTs)
 *        - Decode fileBase64 → Buffer
 *        - Run runSyncSor + runImportWorkOrders sequentially
 *        - Update audit item with final status + post detailed log
 *
 * Why two functions: Netlify v2 background functions emit 202 with an
 * EMPTY body, regardless of what the function returns — so the runId /
 * audit-item URL can't reach the client from a single bg function.
 * Track G1's single-function attempt was also independently broken
 * (Netlify killed the function ~2.9s after the 202, which is BEFORE
 * any sync_sor work fires). The two-function pattern fixes both
 * issues: the wrapper returns JSON normally, and the worker has the
 * full 15-min budget for the heavy work.
 *
 * Required env:
 *   UPLOAD_PASSWORD       — shared password sent in Authorization header
 *   MONDAY_API_TOKEN      — used by the wrapper to create the audit item
 *   INTERNAL_SYNC_SECRET  — bearer-style secret the wrapper sends to the
 *                           worker; the worker rejects POSTs without it.
 *                           Generate with: openssl rand -hex 32
 */
import type { Config } from "@netlify/functions";

// ---- Sync Runs board (Track G1) ----
const SYNC_RUNS_BOARD = 5028347145;
const SYNC_RUNS_COL = {
  status: "color_mm35ty8j",
  started_at: "date_mm35h5z",
};

// ---- Request limits ----
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

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

// ---- monday client ----
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

function formatUtcStamp(d: Date): string {
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

// ---- Background-worker invocation ----

/**
 * Resolve the URL of the bg worker function. Netlify v2 background
 * functions cannot be triggered by relative-path fetches from within
 * the same project — Netlify drops them silently. We need a fully-
 * qualified URL.
 *
 * Resolution order (G2-fix1 May 2026):
 *   1. process.env.URL — Netlify provides this in production
 *   2. process.env.DEPLOY_URL — branch / preview deploys
 *   3. (last resort) the incoming request's origin
 *
 * If none of the above resolve, the function logs an error and bails
 * so the wrapper returns 500 to the client rather than firing a fetch
 * to undefined.
 */
function resolveWorkerBase(req: Request): string | null {
  if (process.env.URL) return process.env.URL;
  if (process.env.DEPLOY_URL) return process.env.DEPLOY_URL;
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

interface WorkerPayload {
  runId: string;
  mondayItemId: string;
  filename: string;
  fileBase64: string;
}

// ---- Main handler ----

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const expected = process.env.UPLOAD_PASSWORD;
  const monday_token = process.env.MONDAY_API_TOKEN;
  const internal = process.env.INTERNAL_SYNC_SECRET;
  if (!expected) {
    return jsonResponse(500, {
      ok: false,
      error: "Server misconfigured: UPLOAD_PASSWORD env var not set",
    });
  }
  if (!monday_token) {
    return jsonResponse(500, {
      ok: false,
      error: "Server misconfigured: MONDAY_API_TOKEN env var not set",
    });
  }
  if (!internal) {
    return jsonResponse(500, {
      ok: false,
      error: "Server misconfigured: INTERNAL_SYNC_SECRET env var not set",
    });
  }

  const provided = req.headers.get("authorization");
  if (provided !== expected) {
    return jsonResponse(401, { ok: false, error: "Wrong password" });
  }

  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return jsonResponse(429, {
      ok: false,
      error: `Rate limit hit (max ${RATE_LIMIT_MAX} uploads/hour). Try again later.`,
    });
  }

  // Parse the multipart upload.
  let fileBuffer: Buffer;
  let filename: string;
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return jsonResponse(400, {
        ok: false,
        error: 'Upload must include a "file" field with the SOR Extract.',
      });
    }
    if (file.size === 0) {
      return jsonResponse(400, { ok: false, error: "Uploaded file is empty" });
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return jsonResponse(400, {
        ok: false,
        error: `File too large (${Math.round(file.size / 1024)} KB > ${MAX_FILE_SIZE_BYTES / 1024} KB cap).`,
      });
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return jsonResponse(400, {
        ok: false,
        error: ".xlsx file required (got " + file.name + ")",
      });
    }
    fileBuffer = Buffer.from(await file.arrayBuffer());
    filename = file.name;
  } catch (err) {
    return jsonResponse(400, {
      ok: false,
      error: `Failed to parse upload: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Generate runId (Node 20+ has crypto.randomUUID() globally).
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const itemName = `Sync Run ${formatUtcStamp(startedAt)} (${filename})`;

  // Create the audit item BEFORE the worker fires so the deep-link
  // URL we hand back to the client is real.
  let runItem: SyncRunItem;
  try {
    runItem = await createSyncRunItem(itemName, startedAt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[sync] runId=${runId} create-Sync-Run failed:`,
      message
    );
    return jsonResponse(500, {
      ok: false,
      error: `Couldn't create Sync Run audit item on monday: ${message}`,
      runId,
    });
  }

  // ---- Resolve worker URL (G2-fix1) ----
  // Netlify v2 background functions cannot be triggered by relative-
  // path fetches — Netlify drops them silently. Track G2's first
  // deploy showed 0 worker invocations despite successful wrapper
  // runs; root cause was the relative URL we were sending. Now we
  // require a fully-qualified URL via process.env.URL or DEPLOY_URL.
  console.log(
    `[sync] runId=${runId} env URL=${process.env.URL ?? "(undef)"} DEPLOY_URL=${process.env.DEPLOY_URL ?? "(undef)"}`
  );
  const workerBase = resolveWorkerBase(req);
  if (!workerBase) {
    console.error(
      `[sync] runId=${runId} couldn't resolve worker base URL — env URL/DEPLOY_URL undefined and req.url unparseable`
    );
    return jsonResponse(500, {
      ok: false,
      error:
        "Server misconfigured: couldn't resolve worker URL (env URL / DEPLOY_URL missing).",
      runId,
    });
  }
  const workerUrlFinal = `${workerBase}/.netlify/functions/sync-worker-background`;

  // Fire-and-forget POST to the bg worker. We don't await it — but we
  // DO chain .then/.catch so the worker invocation status (or fetch
  // failure) lands in Netlify function logs. The user-facing 200
  // response is not blocked on this fetch resolving.
  //
  // Secret moved from JSON body to x-internal-secret header (G2-fix1).
  // Header is the cleaner place for an auth-style credential and keeps
  // the body purely data.
  const payload: WorkerPayload = {
    runId,
    mondayItemId: runItem.id,
    filename,
    fileBase64: fileBuffer.toString("base64"),
  };
  console.log(
    `[sync] runId=${runId} mondayItemId=${runItem.id} filename="${filename}" — invoking worker at ${workerUrlFinal}`
  );
  fetch(workerUrlFinal, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": internal,
    },
    body: JSON.stringify(payload),
  })
    .then((r) =>
      console.log(
        `[sync] runId=${runId} worker trigger response: ${r.status} ${r.statusText}`
      )
    )
    .catch((err) => {
      console.error(
        `[sync] runId=${runId} worker invocation fetch failed:`,
        err
      );
    });

  // Return 200 with the full audit-item context so the client can
  // deep-link, render the filename badge, and stamp the runId.
  return jsonResponse(200, {
    ok: true,
    runId,
    monday_item_id: runItem.id,
    monday_item_url: runItem.url,
    board_url: `https://mv-civil-company.monday.com/boards/${SYNC_RUNS_BOARD}`,
    status: "started",
    filename,
    rateLimitRemaining: limit.remaining,
  });
};

export const config: Config = {
  path: "/api/sync",
};
