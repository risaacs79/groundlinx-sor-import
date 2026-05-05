/**
 * POST /api/sync — VA-team SOR Extract upload endpoint.
 *
 * Workflow:
 *  1. Verify HTTP method + Authorization header against UPLOAD_PASSWORD
 *  2. Rate-limit: max 5 requests / hour / IP (in-memory map per
 *     Netlify function instance — best-effort, not strict)
 *  3. Parse multipart upload (Web standard `req.formData()`)
 *  4. Validate file is a real `.xlsx`
 *  5. Run `runSyncSor(buffer)` then `runImportWorkOrders(buffer)`
 *  6. Return JSON summary the browser renders in the success card
 *
 * Both pipeline functions are the proven library variants from
 * netlify/functions/lib/, originally CLI scripts in the main field-app
 * repo (PR #27 / #31 / #34) refactored to take a Buffer + return
 * structured results.
 *
 * Caveat: Netlify sync function timeouts are 10s (Free) / 26s (Pro).
 * The full first-run pipeline takes ~2-3 minutes (~152 SOR updates +
 * ~542 imports + monday round trips). Idempotent re-runs (no writes)
 * fit comfortably. If first-run hits the timeout, the script is
 * idempotent — the next run picks up where the timed-out one left off.
 * Background-function or streaming-progress upgrade is a sub-step 6
 * follow-up.
 */
import type { Config } from "@netlify/functions";
import { runSyncSor } from "./lib/sync_sor_extract";
import { runImportWorkOrders } from "./lib/import_work_orders";

// ---- Config ----
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — extracts are < 200 KB normally

// ---- Rate-limit state ----
// In-memory per Netlify function instance. Multi-instance scale isn't
// guaranteed (a determined attacker could fan out across cold starts) —
// good enough for v1 paired with the password gate + obscure subdomain.
const rateLimitMap = new Map<string, number[]>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Lock down: this endpoint is only ever called from our index.html
      // on the same origin. No CORS preflight needed; reject any other
      // origin with a generic body.
      "Cache-Control": "no-store",
    },
  });
}

function clientIp(req: Request): string {
  // Netlify forwards the real client IP via x-nf-client-connection-ip
  // (most reliable) or x-forwarded-for (standard).
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

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  // ---- Auth ----
  const expected = process.env.UPLOAD_PASSWORD;
  const monday = process.env.MONDAY_API_TOKEN;
  if (!expected) {
    return jsonResponse(500, {
      ok: false,
      error: "Server misconfigured: UPLOAD_PASSWORD env var not set",
    });
  }
  if (!monday) {
    return jsonResponse(500, {
      ok: false,
      error: "Server misconfigured: MONDAY_API_TOKEN env var not set",
    });
  }
  const provided = req.headers.get("authorization");
  if (provided !== expected) {
    return jsonResponse(401, { ok: false, error: "Wrong password" });
  }

  // ---- Rate limit ----
  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return jsonResponse(429, {
      ok: false,
      error: `Rate limit hit (max ${RATE_LIMIT_MAX} uploads/hour). Try again later.`,
    });
  }

  // ---- Parse multipart upload ----
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

  // ---- Run the pipeline ----
  // sync_sor_extract validates the workbook structure (Cons_Data sheet,
  // expected columns) and throws a meaningful error if it's not a real
  // SOR Extract — that surfaces back as a 500 below.
  const start = Date.now();
  try {
    const syncResults = await runSyncSor(fileBuffer);
    const importResults = await runImportWorkOrders(fileBuffer);
    return jsonResponse(200, {
      ok: true,
      filename,
      fileSizeKB: Math.round(fileBuffer.length / 1024),
      uploaderIp: ip,
      syncResults,
      importResults,
      totalRuntimeMs: Date.now() - start,
      rateLimitRemaining: limit.remaining,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish "file is malformed" from runtime / monday errors so
    // the browser can surface different copy.
    const looksLikeBadFile =
      message.includes("Cons_Data sheet not found") ||
      message.includes("Missing column");
    return jsonResponse(looksLikeBadFile ? 400 : 500, {
      ok: false,
      filename,
      error: message,
      stage:
        "Pipeline aborted mid-run. The script is idempotent — re-running the same file picks up where this run stopped.",
      partialRuntimeMs: Date.now() - start,
    });
  }
};

export const config: Config = {
  path: "/api/sync",
};
