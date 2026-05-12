/**
 * Library mirror of groundlinx-field-app/scripts/sync_job_data.ts —
 * called as the 3rd stage in the upload-page pipeline (Track J2, May
 * 2026) by netlify/functions/sync-worker-background.ts after
 * runSyncSor + runImportWorkOrders.
 *
 * Two write surfaces, one walk:
 *   1. Primary Asset board_relation — repaired when missing or wrong.
 *      Set on first run; re-set when items move boards (Track B's
 *      cross-board automation strips board_relation columns even with
 *      identical IDs, so this script reattaches the relation on the
 *      next sync run).
 *   2. 6 revenue stored numerics (SOR Forecast $, SOR Approved $,
 *      SOR Paid $, SOR In Review $, SOR Pending Artefacts $,
 *      SOR Disputed $) — recomputed every run from SOR Lines per-status
 *      formula display_values, summed by asset.
 *
 * Source of truth: SOR Lines per-status revenue formula columns. Reading
 * display_value and summing per asset keeps the per-job numerics
 * dollar-identical to the dashboard rollups by construction.
 *
 * Idempotent: writes only the columns whose desired value differs from
 * what's already on the item. Re-running is a no-op.
 *
 * Rate-limit hardening: aliased mutation batches of 25, 250ms inter-batch
 * sleep, 5-attempt exponential backoff on 429 (5s/10s/20s/40s/60s).
 *
 * Mirrors the canonical script. Keep this file in lockstep with
 * groundlinx-field-app/scripts/sync_job_data.ts — same pattern as
 * import_work_orders.ts and sync_sor_extract.ts.
 */

import {
  artefactsForSor,
  filterArtefactsByMethod,
} from "./ugl-artefacts";

// ============================================================================
// IDs — boards + columns
// ============================================================================

const ACTIVE_JOBS_BOARD = 5028084872;
const SUBMITTED_JOBS_BOARD = 5028331769;
// Job Complete (Track K, May 2026) — staging board between Active and
// Submitted in the 4-board flow. Same column IDs as Active (created via
// duplicate_board_with_structure). Used by K3 to walk this board's
// items in the 4-board sync — the Active board's per-job stored
// numerics + Primary Asset relations apply equally here.
const JOB_COMPLETE_BOARD = 5028375392;
const APPROVED_JOBS_BOARD = 5028088229;
// Cancelled Jobs (Track G3-fix5, 11 May 2026) — destination for rows
// whose UGL Payment Status is "Descoped". Duplicated from Active via
// duplicate_board_with_structure, so column IDs are byte-identical to
// Active; same JOB_BOARDS schema reuse pattern as Job Complete. Lives
// in workspace 2977219 / folder 6615544 alongside Approved & Paid Jobs.
// G3-fix5a: ID corrected from 5028417160 (wrong workspace) → 5028418115.
const CANCELLED_JOBS_BOARD = 5028418115;
const NETWORK_ASSETS_BOARD = 5028087505;
const SOR_LINES_BOARD = 5028087610;
const ASSET_PHOTOS_BOARD = 5028130740;

interface JobBoardCols {
  asset: string;
  primary: string;
  forecast: string;
  approved: string;
  paid: string;
  inReview: string;
  pendingArtefacts: string;
  disputed: string;
  // Photo-progress columns — Track E3, May 2026; extended to Job Complete
  // by Track K3, May 2026. Present on Active + Job Complete + Submitted;
  // null on Approved & Paid (terminal, no script writes there).
  photosRequired: string | null;
  photosTaken: string | null;
  // Lifecycle columns — Track G3-fix4, May 2026. Present on every job
  // board; differ between active-schema boards and Approved & Paid
  // because the Approved board has its own schema (APPROVED_COL in
  // import_work_orders.ts). These are the columns the CREATE path
  // writes; the UPDATE path now keeps them in sync after status moves.
  rcti: string;
  uglPaymentStatus: string;
  // Design Metres — May 2026 fix. Field app's "missing Design Metres"
  // warning was firing on ~650 of 657 rows because nothing populated
  // this column. import_work_orders' CREATE path never wrote it; sync
  // _job_data's UPDATE path never wrote it. Now both do, conditional
  // on the SOR line's UOM matching `metre/meter` (so non-metres jobs
  // like pit-installs stay null — they're not measured in metres).
  // active-cluster: numeric_mm2te6g2 ; approved: numeric_mm3233b7.
  designMetres: string;
  // Actual Metres — May 2026 (Bug C). Sister to Design Metres but
  // sourced from SOR Lines' Actual Qty (UGL-accepted measurement)
  // instead of Design Qty. Scope-filtered: only written when the
  // row's UGL Payment Status is at "Submitted to UGL" or later
  // (the work has actually been measured by UGL). Same metres-UOM
  // rule. active-cluster: numeric_mm2t9b8j ; approved: numeric_mm32ak31.
  // Note Approved's formula column Revenue $ = Rate × Actual Metres
  // recomputes once this column is populated — useful tripwire.
  actualMetres: string;
}

/**
 * Column IDs for the 6 SOR-revenue numerics drift across the boards
 * because they were created independently (Phase Ca) — even Submitted
 * Jobs got new IDs since these columns were added post-duplicate.
 *
 * Job Complete (Track K, May 2026) is the exception: it was duplicated
 * AFTER Phase Ca's revenue + photo columns landed on Active, so its
 * column IDs are byte-for-byte identical to Active.
 */
const ACTIVE_JOB_COL_IDS: JobBoardCols = {
  asset: "text_mm2tmm57",
  primary: "board_relation_mm2tyedq",
  forecast: "numeric_mm341c4r",
  approved: "numeric_mm349b99",
  paid: "numeric_mm34bqam",
  inReview: "numeric_mm34kr58",
  pendingArtefacts: "numeric_mm34r8h5",
  disputed: "numeric_mm346gsq",
  photosRequired: "numeric_mm34xwc1",
  photosTaken: "numeric_mm344bk5",
  // Mirrors import_work_orders.ts ACTIVE_COL.{RCTI,UGL_PAYMENT_STATUS}.
  // Active + Job Complete + Submitted share these IDs (duplicate-board
  // schema). Approved & Paid has its own ids — see below.
  rcti: "text_mm2tdrdk",
  uglPaymentStatus: "color_mm32x3ga",
  designMetres: "numeric_mm2te6g2",
  actualMetres: "numeric_mm2t9b8j",
};

const JOB_BOARDS: Record<
  "active" | "jobComplete" | "submitted" | "approved" | "cancelled",
  { id: number; cols: JobBoardCols }
> = {
  active: {
    id: ACTIVE_JOBS_BOARD,
    cols: ACTIVE_JOB_COL_IDS,
  },
  jobComplete: {
    id: JOB_COMPLETE_BOARD,
    // Track K1 verification confirmed 57/57 column IDs match Active.
    cols: ACTIVE_JOB_COL_IDS,
  },
  cancelled: {
    id: CANCELLED_JOBS_BOARD,
    // Duplicated from Active 11 May 2026 — column IDs byte-identical.
    cols: ACTIVE_JOB_COL_IDS,
  },
  submitted: {
    id: SUBMITTED_JOBS_BOARD,
    cols: {
      asset: "text_mm2tmm57",
      primary: "board_relation_mm2tyedq",
      forecast: "numeric_mm34meas",
      approved: "numeric_mm34sdw7",
      paid: "numeric_mm3455cm",
      inReview: "numeric_mm34t2s3",
      pendingArtefacts: "numeric_mm34ac47",
      disputed: "numeric_mm34d46f",
      photosRequired: "numeric_mm344z5c",
      photosTaken: "numeric_mm347j55",
      // RCTI + UGL Payment Status share IDs with Active (duplicate-board
      // origin; only the 6 SOR-revenue numerics drift per comment above).
      rcti: "text_mm2tdrdk",
      uglPaymentStatus: "color_mm32x3ga",
      // Submitted board's Design Metres shares Active's id (duplicate-board
      // schema; the per-status revenue numerics are the only Phase-Ca-
      // added columns that drift on this board).
      designMetres: "numeric_mm2te6g2",
      // Actual Metres — same duplicate-board origin → shared id with Active.
      actualMetres: "numeric_mm2t9b8j",
    },
  },
  approved: {
    id: APPROVED_JOBS_BOARD,
    cols: {
      asset: "text_mm325kny",
      primary: "board_relation_mm32kh12",
      forecast: "numeric_mm34emzh",
      approved: "numeric_mm34fz2w",
      paid: "numeric_mm34je20",
      inReview: "numeric_mm34ak0c",
      pendingArtefacts: "numeric_mm34w1w8",
      disputed: "numeric_mm34fwt5",
      // Approved & Paid is terminal — no photo progress tracking.
      photosRequired: null,
      photosTaken: null,
      // Approved board has its own schema (APPROVED_COL in
      // import_work_orders.ts) — different RCTI + status column IDs.
      rcti: "text_mm32c4fj",
      uglPaymentStatus: "color_mm322s90",
      // Approved's Design Metres column has its own id (board was
      // not duplicated from Active; columns named identically but
      // with different ids per board metadata).
      designMetres: "numeric_mm3233b7",
      // Approved's Actual Metres also has its own id. Feeds into the
      // approved-board formula Revenue $ = numeric_mm32n8w4 ×
      // numeric_mm32ak31 (Rate × Actual Metres), so populating this
      // column will cause Revenue $ to recompute downstream.
      actualMetres: "numeric_mm32ak31",
    },
  },
};

/** SOR Lines source columns (read-only). */
const SOR_COLS = {
  assetText: "text_mm2tawd5",
  itemCode: "text_mm2tbsvs",
  workMethod: "color_mm2tcsyn",
  forecast: "formula_mm2t4w81",
  approved: "formula_mm33j3n9",
  paid: "formula_mm3388dv",
  inReview: "formula_mm33z0sv",
  pendingArtefacts: "formula_mm338jtj",
  disputed: "formula_mm33f2bc",
  // Track G3-fix4 (May 2026) — used to derive per-asset
  // aggregatedStatus + rctiNumber for the lifecycle UPDATE path so
  // existing job rows reflect the latest SOR Extract data, not the
  // create-time snapshot.
  uglStatus: "color_mm2tavfn",
  invoiceNo: "text_mm2t3sb5",
  // Design Metres propagation (May 2026 field-app fix). SOR Lines
  // stores Design Qty per line plus the UOM string ("Per linear metre"
  // / "Each ACM Pit" / etc). We sum design_qty over the metres-UOM
  // lines per asset and write the total to Design Metres on the job
  // boards. Non-metres lines (pit installs, link-ups, lid replacements)
  // contribute nothing — their Design Metres stays null on the job
  // board, which is the correct semantic since they're counted by
  // "each", not measured in metres.
  designQty: "numeric_mm2teaw2",
  uom: "text_mm2thydc",
  // Actual Metres propagation (May 2026 — Bug C, sibling to Bug B).
  // SOR Lines' Actual Qty (UGL-accepted measurement) summed across
  // the asset's metres-UOM lines becomes the job board's Actual
  // Metres. Same metres-UOM rule as Design Metres; same per-asset
  // sum. Distinct from Design Metres which is the planned figure.
  actualQty: "numeric_mm2tb16d",
} as const;

/**
 * Status priority — most-advanced first (lowest index wins on aggregation).
 * Mirrors STATUS_PRIORITY in import_work_orders.ts so the lifecycle
 * UPDATE path picks the same rollup value the CREATE path would have
 * picked. Keep these two lists in lockstep.
 *
 * Per the Step 2 brief: "Paid > Approved > Pending RCTI > etc."
 */
const STATUS_PRIORITY = [
  "Paid",
  "Paid - Pending RCTI",
  "Partial Paid",
  "Approved",
  "In Review",
  "Pending Artefacts",
  "Pending Construction",
  "Overpaid",
  "Disputed",
  "Descoped",
] as const;

function priorityOf(status: string | null): number {
  if (!status) return 999;
  const idx = STATUS_PRIORITY.indexOf(status as (typeof STATUS_PRIORITY)[number]);
  return idx === -1 ? 999 : idx;
}

/**
 * Per-asset lifecycle aggregation — the UPDATE path's mirror of
 * import_work_orders.ts aggregateAsset() for the two columns the
 * CREATE path writes but no current stage updates.
 *
 * aggregatedStatus: lowest-priority-index UGL Status across the
 *   asset's SOR lines. null when every SOR line for this asset has
 *   no UGL Status text (defensive — would only fire on freshly-seeded
 *   assets with no extract data yet; we DON'T downgrade existing rows
 *   to "Pending Construction" in that case).
 * rctiNumber: first non-null Invoice # encountered in iteration order
 *   over the asset's SOR lines. Matches the CREATE-path "first
 *   non-null" semantic; for the common case where all lines share
 *   one RCTI, this is unambiguous.
 */
interface Lifecycle {
  aggregatedStatus: string | null;
  rctiNumber: string | null;
}

const EMPTY_LIFECYCLE: Lifecycle = { aggregatedStatus: null, rctiNumber: null };

/** Asset Photos source columns (read-only). Mirrors ASSET_PHOTO_COLUMNS in src/lib/monday-ids.ts. */
const PHOTO_COLS = {
  asset: "board_relation_mm2wb8yw", // → Network Assets
  photoType: "text_mm2wn7xr", // UGL artefact number, e.g. "1.1.1"
  status: "color_mm2wrcvc",
  qcNotes: "long_text_mm2w5jr9", // populated when crew marks N/A
  fileColumn: "file_mm2wx83m", // photo file column id (used in `assets` sub-query)
} as const;

const REVENUE_KEYS = [
  "forecast",
  "approved",
  "paid",
  "inReview",
  "pendingArtefacts",
  "disputed",
] as const;
type RevenueKey = (typeof REVENUE_KEYS)[number];

interface Revenue {
  forecast: number;
  approved: number;
  paid: number;
  inReview: number;
  pendingArtefacts: number;
  disputed: number;
}

const ZERO_REVENUE: Revenue = {
  forecast: 0,
  approved: 0,
  paid: 0,
  inReview: 0,
  pendingArtefacts: 0,
  disputed: 0,
};

/**
 * Per-asset photo progress. Counts required UGL artefacts via
 * artefactsForSor() filtered by workMethod, vs Asset Photos rows that
 * pass an "is uploaded" check (mirrors src/lib/types.ts isPhotoUploaded).
 *
 * Note: "taken" today counts ANY uploaded photo. When Track E4's QA
 * Status workflow ships, a sibling "Photos Approved" column may count
 * only QA-approved photos. The current Photos Taken stays as the
 * "uploaded" semantic so existing reports don't shift under us.
 */
interface PhotoProgress {
  required: number;
  taken: number;
}
const ZERO_PHOTO_PROGRESS: PhotoProgress = { required: 0, taken: 0 };

const BATCH_SIZE = 25;

// ============================================================================
// monday helper — same shape as backfill_job_names.ts (matches house style)
// ============================================================================

async function monday<T>(
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

function parseFormula(text: string | null | undefined): number {
  if (!text) return 0;
  const n = Number(String(text).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function approxEqual(a: number, b: number): boolean {
  // Money — within half a cent is the same number for our purposes.
  return Math.abs(a - b) < 0.005;
}

// ============================================================================
// Source-of-truth fetchers
// ============================================================================

interface SorLineRaw {
  asset: string;
  formulas: Record<RevenueKey, number>;
}

/**
 * Read SOR Lines and per-asset roll up UGL Status + first RCTI. Mirror
 * of import_work_orders.ts aggregateAsset() for the two lifecycle
 * columns the CREATE path writes. Track G3-fix4 (May 2026).
 *
 * Aggregation rules — same as the CREATE path:
 *   aggregatedStatus = lowest STATUS_PRIORITY index across the asset's
 *     SOR lines. Empty/unknown statuses contribute priority 999 so they
 *     never win a non-empty row. If EVERY SOR line for an asset is
 *     empty/unknown, aggregatedStatus stays null (defensive — we don't
 *     downgrade existing rows to "Pending Construction" the way CREATE
 *     does, because we don't know the existing row's history).
 *   rctiNumber = first non-null Invoice # encountered in iteration
 *     order. monday returns SOR Lines in insertion order, which is
 *     stable for a given board state.
 *
 * Both fields are best-effort: nulls signal "don't write" downstream.
 */
async function fetchSorLifecycleByAsset(): Promise<Map<string, Lifecycle>> {
  const cols = [SOR_COLS.assetText, SOR_COLS.uglStatus, SOR_COLS.invoiceNo];
  type RawCol = { id: string; text: string | null };
  type RawItem = { column_values: RawCol[] };

  // Per-asset accumulators.
  const aggIdx = new Map<string, number>(); // asset → current best priority idx
  const aggStatus = new Map<string, string>(); // asset → label corresponding to aggIdx
  const aggRcti = new Map<string, string>(); // asset → first non-null invoice #

  let cursor: string | null = null;
  let pages = 0;
  let rowsSeen = 0;
  for (let pg = 1; pg <= 20; pg++) {
    pages = pg;
    const data = await monday<{
      boards?: Array<{ items_page: { cursor: string | null; items: RawItem[] } }>;
      next_items_page?: { cursor: string | null; items: RawItem[] };
    }>(
      cursor
        ? `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items { column_values(ids: $col) { id text } }
            }
          }`
        : `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items { column_values(ids: $col) { id text } }
              }
            }
          }`,
      cursor ? { cursor, col: cols } : { boardId: String(SOR_LINES_BOARD), col: cols }
    );
    const page: { cursor: string | null; items: RawItem[] } = cursor
      ? data.next_items_page!
      : data.boards![0].items_page;
    for (const it of page.items) {
      rowsSeen += 1;
      const cv: Record<string, RawCol> = {};
      for (const c of it.column_values) cv[c.id] = c;
      const asset = (cv[SOR_COLS.assetText]?.text ?? "").trim();
      if (!asset) continue;
      const statusText = cv[SOR_COLS.uglStatus]?.text?.trim() || null;
      const invoiceText = cv[SOR_COLS.invoiceNo]?.text?.trim() || null;
      // Status — keep the lowest-priority-index seen so far.
      const idx = priorityOf(statusText);
      const currentIdx = aggIdx.get(asset);
      if (currentIdx == null || idx < currentIdx) {
        if (statusText) {
          aggIdx.set(asset, idx);
          aggStatus.set(asset, statusText);
        } else if (currentIdx == null) {
          // Record the 999 so subsequent empty rows don't keep retrying.
          aggIdx.set(asset, 999);
        }
      }
      // RCTI — first non-null wins.
      if (invoiceText && !aggRcti.has(asset)) {
        aggRcti.set(asset, invoiceText);
      }
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  console.log(
    `[sync-job-data] fetchSorLifecycleByAsset: ${rowsSeen} SOR Lines across ${pages} pages → ${aggStatus.size} assets with status, ${aggRcti.size} with RCTI`
  );
  const byAsset = new Map<string, Lifecycle>();
  // Build the result over the union of seen assets so null fields are
  // explicit rather than missing.
  const allAssets = new Set<string>([...aggStatus.keys(), ...aggRcti.keys()]);
  for (const asset of allAssets) {
    byAsset.set(asset, {
      aggregatedStatus: aggStatus.get(asset) ?? null,
      rctiNumber: aggRcti.get(asset) ?? null,
    });
  }
  return byAsset;
}

// ============================================================================
// Design Metres propagation (May 2026 field-app fix).
//
// SOR Lines source columns: numeric_mm2teaw2 (Design Qty) +
// text_mm2thydc (Unit of Measure). Each asset has one or more SOR
// lines; only the lines whose UOM string is metres-like contribute
// to the job-board "Design Metres" value. Non-metres lines (pit
// installs, lid replacements, etc) stay out of the sum entirely —
// their Design Metres value on the job board stays null, which is
// the correct semantic (those jobs aren't measured in metres).
//
// Real-world UOM values observed on SOR Lines (sampled May 12):
//   "Per linear metre"  ← metres-like
//   "Each ACM Pit"
//   "Each core bore"
//   "Each Pit"
//   "Each pit lids"
//
// The whole-word regex `/\b(metre|meter)s?\b/` matches "Per linear
// metre" without false-positives on "metric"/"metropolitan". Bare
// "m" / "per m" / "/m" are caught as separate fallbacks for future
// UOM-string variants.
// ============================================================================

/** Whole-word match on "metre"/"meter" + a few common short forms.
 *  Returns true when the UOM string indicates the line is measured
 *  in metres; false otherwise (including for null/empty input). */
export function isMetresUOM(uom: string | null | undefined): boolean {
  if (!uom) return false;
  const s = uom.toLowerCase().trim();
  if (s === "m") return true;
  if (/\b(metre|meter)s?\b/.test(s)) return true;
  if (/^per\s+m\b/.test(s)) return true;
  if (/^\/m\b/.test(s)) return true;
  return false;
}

/** Generic per-asset metres-UOM sum helper. Walks SOR Lines once,
 *  filters by metres-UOM, sums the named numeric column per asset.
 *
 *  Returns Map<asset, totalMetres>. Assets with no metres-UOM lines
 *  (or with metres-UOM lines but null qty values) are absent from the
 *  map — callers treat absence as "no value to write" so the
 *  corresponding monday column stays null. This preserves the
 *  semantic distinction between "not a metres-measured job" (null)
 *  and "metres-measured but 0" (0).
 *
 *  Used by fetchSorDesignMetresByAsset (qtyCol = designQty) and
 *  fetchSorActualMetresByAsset (qtyCol = actualQty). */
async function fetchSorMetresSumByAsset(
  qtyColId: string,
  label: string
): Promise<Map<string, number>> {
  const cols = [SOR_COLS.assetText, qtyColId, SOR_COLS.uom];
  type RawCol = { id: string; text: string | null };
  type RawItem = { column_values: RawCol[] };
  const byAsset = new Map<string, number>();
  let cursor: string | null = null;
  let pages = 0;
  let rowsSeen = 0;
  let metresLinesSeen = 0;
  for (let pg = 1; pg <= 20; pg++) {
    pages = pg;
    const data = await monday<{
      boards?: Array<{ items_page: { cursor: string | null; items: RawItem[] } }>;
      next_items_page?: { cursor: string | null; items: RawItem[] };
    }>(
      cursor
        ? `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items { column_values(ids: $col) { id text } }
            }
          }`
        : `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items { column_values(ids: $col) { id text } }
              }
            }
          }`,
      cursor ? { cursor, col: cols } : { boardId: String(SOR_LINES_BOARD), col: cols }
    );
    const page: { cursor: string | null; items: RawItem[] } = cursor
      ? data.next_items_page!
      : data.boards![0].items_page;
    for (const it of page.items) {
      rowsSeen += 1;
      const cv: Record<string, RawCol> = {};
      for (const c of it.column_values) cv[c.id] = c;
      const asset = (cv[SOR_COLS.assetText]?.text ?? "").trim();
      if (!asset) continue;
      const uom = cv[SOR_COLS.uom]?.text ?? null;
      if (!isMetresUOM(uom)) continue;
      const qtyText = cv[qtyColId]?.text ?? null;
      if (!qtyText) continue;
      const qty = Number(qtyText.replace(/[^0-9.\-]/g, ""));
      if (!Number.isFinite(qty)) continue;
      metresLinesSeen += 1;
      byAsset.set(asset, (byAsset.get(asset) ?? 0) + qty);
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  console.log(
    `[sync-job-data] fetchSor${label}MetresByAsset: ${rowsSeen} SOR Lines across ${pages} pages → ${metresLinesSeen} metres-UOM lines summed into ${byAsset.size} assets`
  );
  return byAsset;
}

/** Per-asset sum of design_qty across SOR lines whose UOM is metres-
 *  like. Thin wrapper over fetchSorMetresSumByAsset. */
async function fetchSorDesignMetresByAsset(): Promise<Map<string, number>> {
  return fetchSorMetresSumByAsset(SOR_COLS.designQty, "Design");
}

/** Per-asset sum of actual_qty across SOR lines whose UOM is metres-
 *  like — UGL-accepted measurement, populated as the SOR Extract
 *  reflects UGL processing. Thin wrapper over fetchSorMetresSumByAsset.
 *
 *  Bug C (May 2026): semantic mirror of Design Metres but sourced
 *  from "Actual Qty" (`numeric_mm2tb16d`) on SOR Lines. Same metres-
 *  UOM rule. Asset absence in the map = "no actual data yet for any
 *  metres-UOM line" → caller skips the write (preserves null). */
async function fetchSorActualMetresByAsset(): Promise<Map<string, number>> {
  return fetchSorMetresSumByAsset(SOR_COLS.actualQty, "Actual");
}

// ============================================================================
// Actual Metres scope filter — UGL Payment Status set
// ============================================================================
// Only write Actual Metres when the row's UGL Payment Status indicates
// the work has been submitted to (or processed by) UGL. Pre-submission
// rows shouldn't surface an Actual yet — the field-app's variance
// reports (design vs actual) read these columns and would mis-interpret
// pre-submission values as "UGL accepted 0 metres".
//
// Statuses excluded from this set deliberately:
//   - "Pending Construction" / "Pending Artefacts" → not yet submitted
//   - "Disputed" → submitted but figures contested; Actual is unsafe
//   - "Cancelled" (renamed from "Descoped") → not relevant
//   - null/empty → no status yet
//
// We use the EFFECTIVE status (this run's `desiredUglPaymentStatus`
// from SOR Lines aggregation, falling back to `currentUglPaymentStatus`
// when no SOR data refreshes the row this run). That way a row whose
// status transitions to in-scope during the same run also gets its
// Actual Metres written in the same mutation — atomic per row.
const ACTUAL_METRES_PAYMENT_STATUSES = new Set<string>([
  "Submitted to UGL",
  "In Review",
  "Approved",
  "Paid",
  "Partial Paid",
  "Overpaid",
  "Paid - Pending RCTI",
]);

async function fetchSorRevenueByAsset(): Promise<Map<string, Revenue>> {
  const cols = [
    SOR_COLS.assetText,
    SOR_COLS.forecast,
    SOR_COLS.approved,
    SOR_COLS.paid,
    SOR_COLS.inReview,
    SOR_COLS.pendingArtefacts,
    SOR_COLS.disputed,
  ];
  const rows: SorLineRaw[] = [];
  let cursor: string | null = null;
  for (let pg = 1; pg <= 20; pg++) {
    const data = await monday<{
      boards?: Array<{ items_page: { cursor: string | null; items: RawItem[] } }>;
      next_items_page?: { cursor: string | null; items: RawItem[] };
    }>(
      cursor
        ? `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items {
                column_values(ids: $col) {
                  id text
                  ... on FormulaValue { display_value }
                }
              }
            }
          }`
        : `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items {
                  column_values(ids: $col) {
                    id text
                    ... on FormulaValue { display_value }
                  }
                }
              }
            }
          }`,
      cursor ? { cursor, col: cols } : { boardId: String(SOR_LINES_BOARD), col: cols }
    );
    type RawCol = { id: string; text: string | null; display_value?: string | null };
    type RawItem = { column_values: RawCol[] };
    const page: { cursor: string | null; items: RawItem[] } = cursor
      ? data.next_items_page!
      : data.boards![0].items_page;
    for (const it of page.items) {
      const cv: Record<string, RawCol> = {};
      for (const c of it.column_values) cv[c.id] = c;
      const asset = cv[SOR_COLS.assetText]?.text?.trim() ?? "";
      if (!asset) continue;
      const formulas: Record<RevenueKey, number> = {
        forecast: parseFormula(cv[SOR_COLS.forecast]?.display_value),
        approved: parseFormula(cv[SOR_COLS.approved]?.display_value),
        paid: parseFormula(cv[SOR_COLS.paid]?.display_value),
        inReview: parseFormula(cv[SOR_COLS.inReview]?.display_value),
        pendingArtefacts: parseFormula(cv[SOR_COLS.pendingArtefacts]?.display_value),
        disputed: parseFormula(cv[SOR_COLS.disputed]?.display_value),
      };
      rows.push({ asset, formulas });
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  // Sum per asset
  const byAsset = new Map<string, Revenue>();
  for (const r of rows) {
    const cur = byAsset.get(r.asset) ?? { ...ZERO_REVENUE };
    for (const k of REVENUE_KEYS) cur[k] += r.formulas[k];
    byAsset.set(r.asset, cur);
  }
  return byAsset;
}

async function fetchNetworkAssetIndex(): Promise<{
  byName: Map<string, string>;
  byId: Map<string, string>;
}> {
  // byName: asset name (Asset ID) → monday item id
  // byId:   monday item id → asset name (used to join photos→asset-name→SORs)
  const byName = new Map<string, string>();
  const byId = new Map<string, string>();
  let cursor: string | null = null;
  for (let pg = 1; pg <= 5; pg++) {
    const data = await monday<{
      boards?: Array<{ items_page: { cursor: string | null; items: Array<{ id: string; name: string }> } }>;
      next_items_page?: { cursor: string | null; items: Array<{ id: string; name: string }> };
    }>(
      cursor
        ? `query ($cursor: String!) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items { id name }
            }
          }`
        : `query ($boardId: ID!) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items { id name }
              }
            }
          }`,
      cursor ? { cursor } : { boardId: String(NETWORK_ASSETS_BOARD) }
    );
    type NetPage = { cursor: string | null; items: Array<{ id: string; name: string }> };
    const page: NetPage = cursor ? data.next_items_page! : data.boards![0].items_page;
    for (const it of page.items) {
      if (it.name) {
        byName.set(it.name.trim(), it.id);
        byId.set(it.id, it.name.trim());
      }
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return { byName, byId };
}

interface SorMethodRow {
  asset: string;
  itemCode: string;
  workMethod: string | null;
}

/**
 * Fetch all SOR Lines with itemCode + workMethod (for photo computation).
 * Separate from fetchSorRevenueByAsset so callers that don't need photos
 * can skip this read.
 */
async function fetchSorMethodsByAsset(): Promise<Map<string, SorMethodRow[]>> {
  const cols = [SOR_COLS.assetText, SOR_COLS.itemCode, SOR_COLS.workMethod];
  const rows: SorMethodRow[] = [];
  let cursor: string | null = null;
  for (let pg = 1; pg <= 20; pg++) {
    const data = await monday<{
      boards?: Array<{ items_page: { cursor: string | null; items: RawItem[] } }>;
      next_items_page?: { cursor: string | null; items: RawItem[] };
    }>(
      cursor
        ? `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items { column_values(ids: $col) { id text } }
            }
          }`
        : `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items { column_values(ids: $col) { id text } }
              }
            }
          }`,
      cursor ? { cursor, col: cols } : { boardId: String(SOR_LINES_BOARD), col: cols }
    );
    type RawCol = { id: string; text: string | null };
    type RawItem = { column_values: RawCol[] };
    const page: { cursor: string | null; items: RawItem[] } = cursor
      ? data.next_items_page!
      : data.boards![0].items_page;
    for (const it of page.items) {
      const cv: Record<string, string | null> = {};
      for (const c of it.column_values) cv[c.id] = c.text;
      const asset = cv[SOR_COLS.assetText]?.trim() ?? "";
      const code = cv[SOR_COLS.itemCode]?.trim() ?? "";
      if (!asset || !code) continue;
      rows.push({
        asset,
        itemCode: code,
        workMethod: cv[SOR_COLS.workMethod]?.trim() ?? null,
      });
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  const byAsset = new Map<string, SorMethodRow[]>();
  for (const r of rows) {
    const list = byAsset.get(r.asset);
    if (list) list.push(r);
    else byAsset.set(r.asset, [r]);
  }
  return byAsset;
}

interface PhotoRow {
  /** Network Assets monday id this photo points to (board_relation linked id). */
  assetItemId: string;
  /** UGL artefact number stamped on the photo row, e.g. "1.1.1". */
  photoType: string;
  /** True iff the photo passes the "is uploaded" check (file attached, OR
   *  N/A reason set, OR Photo Status is anything but "Not Taken"). */
  uploaded: boolean;
}

async function fetchPhotosByAssetItemId(): Promise<Map<string, PhotoRow[]>> {
  const cols = [
    PHOTO_COLS.asset,
    PHOTO_COLS.photoType,
    PHOTO_COLS.status,
    PHOTO_COLS.qcNotes,
  ];
  const rows: PhotoRow[] = [];
  let cursor: string | null = null;
  for (let pg = 1; pg <= 20; pg++) {
    const data = await monday<{
      boards?: Array<{
        items_page: { cursor: string | null; items: RawPhotoItem[] };
      }>;
      next_items_page?: { cursor: string | null; items: RawPhotoItem[] };
    }>(
      cursor
        ? `query ($cursor: String!, $col: [String!], $files: [String!]!) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items {
                assets(column_ids: $files) { id }
                column_values(ids: $col) {
                  id text
                  ... on BoardRelationValue { linked_item_ids }
                }
              }
            }
          }`
        : `query ($boardId: ID!, $col: [String!], $files: [String!]!) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items {
                  assets(column_ids: $files) { id }
                  column_values(ids: $col) {
                    id text
                    ... on BoardRelationValue { linked_item_ids }
                  }
                }
              }
            }
          }`,
      cursor
        ? { cursor, col: cols, files: [PHOTO_COLS.fileColumn] }
        : { boardId: String(ASSET_PHOTOS_BOARD), col: cols, files: [PHOTO_COLS.fileColumn] }
    );
    type RawCol = { id: string; text: string | null; linked_item_ids?: string[] };
    type RawPhotoItem = {
      assets?: Array<{ id: string }>;
      column_values: RawCol[];
    };
    const page: { cursor: string | null; items: RawPhotoItem[] } = cursor
      ? data.next_items_page!
      : data.boards![0].items_page;
    for (const it of page.items) {
      const cv: Record<string, RawCol> = {};
      for (const c of it.column_values) cv[c.id] = c;
      const linked = cv[PHOTO_COLS.asset]?.linked_item_ids ?? [];
      const photoType = cv[PHOTO_COLS.photoType]?.text?.trim() ?? "";
      if (!photoType || linked.length === 0) continue;
      // isUploaded: file present, OR N/A reason set, OR Photo Status is
      // anything other than "Not Taken" (mirrors src/lib/types.ts).
      const hasFile = (it.assets?.length ?? 0) > 0;
      const naReason = (cv[PHOTO_COLS.qcNotes]?.text ?? "").trim();
      const status = (cv[PHOTO_COLS.status]?.text ?? "").trim();
      const statusUploaded =
        status !== "" && status !== "Not Taken" && status !== "⚪ Not Taken";
      const uploaded = hasFile || !!naReason || statusUploaded;
      // Photo can link to multiple assets in theory; in practice always 1.
      for (const aid of linked) {
        rows.push({ assetItemId: aid, photoType, uploaded });
      }
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  const byAsset = new Map<string, PhotoRow[]>();
  for (const r of rows) {
    const list = byAsset.get(r.assetItemId);
    if (list) list.push(r);
    else byAsset.set(r.assetItemId, [r]);
  }
  return byAsset;
}

/**
 * Compute photo progress for a single asset.
 *
 * Required = sum of artefactsForSor(itemCode) filtered by workMethod
 * across every SOR linked to the asset.
 *
 * Taken = count of those required artefacts whose Asset Photos row
 * (matched by photoType = artefact number) passes the uploaded check.
 *
 * Returns { required: 0, taken: 0 } when the asset has no SORs or the
 * SORs map to no recognised UGL artefacts.
 */
function computePhotoProgress(
  sorRows: SorMethodRow[] | undefined,
  photos: PhotoRow[] | undefined
): PhotoProgress {
  if (!sorRows || sorRows.length === 0) return { ...ZERO_PHOTO_PROGRESS };
  const photoByType = new Map<string, PhotoRow>();
  for (const p of photos ?? []) {
    // If duplicate rows exist for the same photoType, prefer the
    // uploaded one so downstream count is accurate.
    const existing = photoByType.get(p.photoType);
    if (!existing || (!existing.uploaded && p.uploaded)) {
      photoByType.set(p.photoType, p);
    }
  }
  let required = 0;
  let taken = 0;
  for (const sor of sorRows) {
    const all = artefactsForSor(sor.itemCode);
    const requiredArts = filterArtefactsByMethod(all, sor.workMethod);
    required += requiredArts.length;
    for (const a of requiredArts) {
      const p = photoByType.get(a.number);
      if (p && p.uploaded) taken += 1;
    }
  }
  return { required, taken };
}

interface JobItem {
  boardKey: "active" | "jobComplete" | "submitted" | "approved" | "cancelled";
  boardId: number;
  cols: JobBoardCols;
  itemId: string;
  itemName: string;
  asset: string;
  currentPrimary: string[];
  currentRevenue: Revenue;
  /** Current photo progress (only meaningful for active+jobComplete+submitted; null on approved). */
  currentPhotos: PhotoProgress | null;
  /** Current RCTI Number column value on monday (null when blank). */
  currentRctiNumber: string | null;
  /** Current UGL Payment Status label on monday (null when blank). */
  currentUglPaymentStatus: string | null;
  desiredPrimary: string | null;
  desiredRevenue: Revenue;
  /** Desired photo progress for active+jobComplete+submitted; null on approved (no writes). */
  desiredPhotos: PhotoProgress | null;
  /** Desired RCTI Number from the SOR Lines roll-up. null = no write. */
  desiredRctiNumber: string | null;
  /** Desired UGL Payment Status from the SOR Lines roll-up. null = no write
   *  (defensive — only set when at least one SOR line has a status). */
  desiredUglPaymentStatus: string | null;
  /** Current Design Metres column value (null when blank). */
  currentDesignMetres: number | null;
  /** Desired Design Metres — summed from SOR Lines whose UOM is
   *  metres-like. null = no metres-UOM lines for this asset → don't
   *  write (preserves null on non-metres jobs like pit installs). */
  desiredDesignMetres: number | null;
  /** Current Actual Metres column value (null when blank). */
  currentActualMetres: number | null;
  /** Desired Actual Metres — summed from SOR Lines' Actual Qty over
   *  metres-UOM lines, scope-filtered by UGL Payment Status. null =
   *  either no metres-UOM lines, or no actual data yet, or row's
   *  effective status is pre-submission → don't write. */
  desiredActualMetres: number | null;
  isTest: boolean;
  unmatchedAsset: boolean;
}

type JobItemRaw = Omit<
  JobItem,
  | "desiredPrimary"
  | "desiredRevenue"
  | "desiredPhotos"
  | "desiredRctiNumber"
  | "desiredUglPaymentStatus"
  | "desiredDesignMetres"
  | "desiredActualMetres"
  | "isTest"
  | "unmatchedAsset"
>;

async function fetchJobBoardItems(
  boardKey: "active" | "jobComplete" | "submitted" | "approved" | "cancelled"
): Promise<JobItemRaw[]> {
  const board = JOB_BOARDS[boardKey];
  const cols = [
    board.cols.asset,
    board.cols.primary,
    board.cols.forecast,
    board.cols.approved,
    board.cols.paid,
    board.cols.inReview,
    board.cols.pendingArtefacts,
    board.cols.disputed,
    ...(board.cols.photosRequired ? [board.cols.photosRequired] : []),
    ...(board.cols.photosTaken ? [board.cols.photosTaken] : []),
    board.cols.rcti,
    board.cols.uglPaymentStatus,
    board.cols.designMetres,
    board.cols.actualMetres,
  ];
  const out: JobItemRaw[] = [];
  let cursor: string | null = null;
  for (let pg = 1; pg <= 5; pg++) {
    const data = await monday<{
      boards?: Array<{ items_page: { cursor: string | null; items: RawItem[] } }>;
      next_items_page?: { cursor: string | null; items: RawItem[] };
    }>(
      cursor
        ? `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items {
                id name
                column_values(ids: $col) {
                  id text
                  ... on BoardRelationValue { linked_item_ids }
                }
              }
            }
          }`
        : `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items {
                  id name
                  column_values(ids: $col) {
                    id text
                    ... on BoardRelationValue { linked_item_ids }
                  }
                }
              }
            }
          }`,
      cursor ? { cursor, col: cols } : { boardId: String(board.id), col: cols }
    );
    type RawCol = { id: string; text: string | null; linked_item_ids?: string[] };
    type RawItem = { id: string; name: string; column_values: RawCol[] };
    const page: { cursor: string | null; items: RawItem[] } = cursor
      ? data.next_items_page!
      : data.boards![0].items_page;
    for (const it of page.items) {
      const cv: Record<string, RawCol> = {};
      for (const c of it.column_values) cv[c.id] = c;
      const currentPhotos: PhotoProgress | null =
        board.cols.photosRequired && board.cols.photosTaken
          ? {
              required: parseFormula(cv[board.cols.photosRequired]?.text),
              taken: parseFormula(cv[board.cols.photosTaken]?.text),
            }
          : null;
      const rctiText = cv[board.cols.rcti]?.text?.trim() || null;
      const statusText = cv[board.cols.uglPaymentStatus]?.text?.trim() || null;
      // Design Metres: numeric column. Parse via the existing
      // parseFormula helper (handles "" / null / non-numeric safely)
      // but treat empty-string as null instead of 0 — the script's
      // diff check needs to distinguish "row has no value" from
      // "row has 0 metres" so we don't keep overwriting a deliberate
      // zero with our desired-null.
      const dmRaw = cv[board.cols.designMetres]?.text?.trim();
      const currentDesignMetres =
        dmRaw == null || dmRaw === ""
          ? null
          : (() => {
              const n = Number(dmRaw.replace(/[^0-9.\-]/g, ""));
              return Number.isFinite(n) ? n : null;
            })();
      // Actual Metres: same null-preserving parse as Design Metres
      // above. Empty-string → null, not 0, so the diff check doesn't
      // overwrite a genuine null with a desired-null in steady state.
      const amRaw = cv[board.cols.actualMetres]?.text?.trim();
      const currentActualMetres =
        amRaw == null || amRaw === ""
          ? null
          : (() => {
              const n = Number(amRaw.replace(/[^0-9.\-]/g, ""));
              return Number.isFinite(n) ? n : null;
            })();
      out.push({
        boardKey,
        boardId: board.id,
        cols: board.cols,
        itemId: it.id,
        itemName: it.name,
        asset: (cv[board.cols.asset]?.text ?? "").trim(),
        currentPrimary: cv[board.cols.primary]?.linked_item_ids ?? [],
        currentRevenue: {
          forecast: parseFormula(cv[board.cols.forecast]?.text),
          approved: parseFormula(cv[board.cols.approved]?.text),
          paid: parseFormula(cv[board.cols.paid]?.text),
          inReview: parseFormula(cv[board.cols.inReview]?.text),
          pendingArtefacts: parseFormula(cv[board.cols.pendingArtefacts]?.text),
          disputed: parseFormula(cv[board.cols.disputed]?.text),
        },
        currentPhotos,
        currentRctiNumber: rctiText,
        currentUglPaymentStatus: statusText,
        currentDesignMetres,
        currentActualMetres,
      });
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

// ============================================================================
// Plan + apply
// ============================================================================

function isTestAssetText(asset: string): boolean {
  const u = asset.toUpperCase();
  return u.startsWith("TEST_") || u.startsWith("TEST-") || u.startsWith("TEST ");
}

function buildPlan(
  raw: JobItemRaw,
  network: Map<string, string>,
  sorByAsset: Map<string, Revenue>,
  sorMethodsByAsset: Map<string, SorMethodRow[]>,
  photosByAssetItemId: Map<string, PhotoRow[]>,
  lifecycleByAsset: Map<string, Lifecycle>,
  designMetresByAsset: Map<string, number>,
  actualMetresByAsset: Map<string, number>
): JobItem {
  const isTest = isTestAssetText(raw.asset);
  const networkId = raw.asset ? network.get(raw.asset) ?? null : null;
  const unmatchedAsset = !!raw.asset && !networkId;
  const desiredRevenue = sorByAsset.get(raw.asset) ?? { ...ZERO_REVENUE };
  // Photo progress only computed for boards that store the columns
  // (active + submitted, not approved). When networkId is null we
  // can't look up photos, so progress falls to zeros.
  let desiredPhotos: PhotoProgress | null = null;
  if (raw.cols.photosRequired && raw.cols.photosTaken) {
    const sorRows = sorMethodsByAsset.get(raw.asset);
    const photos = networkId ? photosByAssetItemId.get(networkId) : undefined;
    desiredPhotos = computePhotoProgress(sorRows, photos);
  }
  const lifecycle = lifecycleByAsset.get(raw.asset) ?? EMPTY_LIFECYCLE;
  // Track G3-fix5: transform UGL "Descoped" → our internal "Cancelled"
  // at write time. The transform is applied here (not in
  // fetchSorLifecycleByAsset) so the rollup source-of-truth stays
  // aligned with SOR Lines' UGL Status; only the job-board displayed
  // status is rebranded. Idempotent: rows already showing "Cancelled"
  // get desired="Cancelled" → diff-check skips.
  const desiredUglPaymentStatus =
    lifecycle.aggregatedStatus === "Descoped"
      ? "Cancelled"
      : lifecycle.aggregatedStatus;
  // Design Metres — undefined in the map means "no metres-UOM SOR
  // lines for this asset", which we surface as null so planNeedsWrite
  // knows not to write. We do NOT write a 0 in that case — the
  // semantic of null on the job board is "this job isn't measured in
  // metres" (e.g., pit installs), not "0 metres designed".
  const desiredDesignMetres = designMetresByAsset.get(raw.asset) ?? null;
  // Actual Metres — Bug C scope filter. Use the EFFECTIVE status
  // (this run's desired ?? current) so a row whose status
  // transitions to in-scope this same run also gets its Actual
  // Metres written in the same mutation. Out-of-scope = null.
  // Asset absence from actualMetresByAsset (no metres-UOM lines
  // OR all metres-UOM lines have null actual qty) = null = no write.
  const effectiveStatus = desiredUglPaymentStatus ?? raw.currentUglPaymentStatus;
  const inActualScope =
    effectiveStatus != null && ACTUAL_METRES_PAYMENT_STATUSES.has(effectiveStatus);
  const desiredActualMetres = inActualScope
    ? actualMetresByAsset.get(raw.asset) ?? null
    : null;
  return {
    ...raw,
    isTest,
    unmatchedAsset,
    desiredPrimary: networkId,
    desiredRevenue,
    desiredPhotos,
    desiredRctiNumber: lifecycle.rctiNumber,
    desiredUglPaymentStatus,
    desiredDesignMetres,
    desiredActualMetres,
  };
}

function planNeedsWrite(p: JobItem): {
  primary: boolean;
  revenue: boolean;
  photos: boolean;
  lifecycle: boolean;
  designMetres: boolean;
  actualMetres: boolean;
} {
  const wantPrimary = p.desiredPrimary != null;
  const havePrimary = p.currentPrimary.length === 1 && p.currentPrimary[0] === p.desiredPrimary;
  const primary = wantPrimary && !havePrimary;
  const revenue = REVENUE_KEYS.some(
    (k) => !approxEqual(p.currentRevenue[k], p.desiredRevenue[k])
  );
  // Photos: only check when both desired and current sides are present
  // (active+submitted boards). Approved & Paid has both sides null →
  // photos write is always false.
  let photos = false;
  if (p.desiredPhotos && p.currentPhotos) {
    photos =
      p.desiredPhotos.required !== p.currentPhotos.required ||
      p.desiredPhotos.taken !== p.currentPhotos.taken;
  }
  // Lifecycle: only flag a write when we have a definite desired value
  // AND it differs from the current monday value. null desired means
  // "we don't have SOR Lines data for this asset" — leave the row
  // alone (the create-path's "Pending Construction" fallback is for
  // initial CREATE, not for downgrading existing rows).
  const rctiChanged =
    p.desiredRctiNumber != null &&
    p.desiredRctiNumber !== p.currentRctiNumber;
  const statusChanged =
    p.desiredUglPaymentStatus != null &&
    p.desiredUglPaymentStatus !== p.currentUglPaymentStatus;
  const lifecycle = rctiChanged || statusChanged;
  // Design Metres: only write when we have a concrete desired value
  // (i.e. at least one metres-UOM SOR line for this asset). null
  // desired = "this job isn't metres-measured" → leave current value
  // alone, even if current happens to be populated with stale data.
  // Approx-equal check absorbs floating-point noise (e.g. 25.0 vs 25).
  const designMetres =
    p.desiredDesignMetres != null &&
    (p.currentDesignMetres == null ||
      !approxEqual(p.currentDesignMetres, p.desiredDesignMetres));
  // Actual Metres: same diff semantics as Design Metres — only write
  // when we have a desired value AND it differs from current. null
  // desired means either out-of-scope status OR no actual data yet
  // OR no metres-UOM lines → leave current value alone (whether null
  // or stale).
  const actualMetres =
    p.desiredActualMetres != null &&
    (p.currentActualMetres == null ||
      !approxEqual(p.currentActualMetres, p.desiredActualMetres));
  return { primary, revenue, photos, lifecycle, designMetres, actualMetres };
}

interface ApplyResult {
  total: number;
  primaryWrites: number;
  revenueWrites: number;
  photoWrites: number;
  /** Items that had RCTI or UGL Payment Status updated this run. Diff-
   *  only — only counts assets whose desired value differed from the
   *  current monday value. Added in Track G3-fix4 (May 2026). */
  lifecycleWrites: number;
  /** Items that had Design Metres written this run. Diff-only — only
   *  counts assets with at least one metres-UOM SOR line AND whose
   *  current Design Metres differs from the summed desired value.
   *  Added in May 2026 to fix the field-app "missing Design Metres"
   *  warning on metres-based jobs. */
  designMetresWrites: number;
  /** Items that had Actual Metres written this run. Diff-only — only
   *  counts assets that are (a) in-scope for the UGL Payment Status
   *  set above AND (b) have at least one metres-UOM SOR line with
   *  non-null Actual Qty AND (c) whose current Actual Metres differs
   *  from the summed desired value. Added in May 2026 (Bug C) to
   *  unlock design-vs-actual variance reporting per swing/crew/project. */
  actualMetresWrites: number;
  unchanged: number;
  testItems: number;
  unmatchedItems: number;
  failed: number;
  failures: string[];
}

async function applyForBoard(
  plans: JobItem[],
  dryRun: boolean
): Promise<ApplyResult> {
  const result: ApplyResult = {
    total: plans.length,
    primaryWrites: 0,
    revenueWrites: 0,
    photoWrites: 0,
    lifecycleWrites: 0,
    designMetresWrites: 0,
    actualMetresWrites: 0,
    unchanged: 0,
    testItems: plans.filter((p) => p.isTest).length,
    unmatchedItems: plans.filter((p) => p.unmatchedAsset).length,
    failed: 0,
    failures: [],
  };

  const writes: Array<{
    plan: JobItem;
    needs: {
      primary: boolean;
      revenue: boolean;
      photos: boolean;
      lifecycle: boolean;
      designMetres: boolean;
      actualMetres: boolean;
    };
  }> = [];
  for (const p of plans) {
    const needs = planNeedsWrite(p);
    if (
      !needs.primary &&
      !needs.revenue &&
      !needs.photos &&
      !needs.lifecycle &&
      !needs.designMetres &&
      !needs.actualMetres
    ) {
      result.unchanged += 1;
      continue;
    }
    if (needs.primary) result.primaryWrites += 1;
    if (needs.revenue) result.revenueWrites += 1;
    if (needs.photos) result.photoWrites += 1;
    if (needs.lifecycle) result.lifecycleWrites += 1;
    if (needs.designMetres) result.designMetresWrites += 1;
    if (needs.actualMetres) result.actualMetresWrites += 1;
    writes.push({ plan: p, needs });
  }
  if (dryRun) return result;

  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = writes.slice(i, i + BATCH_SIZE);
    const aliases: string[] = [];
    const variables: Record<string, unknown> = {};
    batch.forEach((w, j) => {
      const colValues: Record<string, unknown> = {};
      if (w.needs.primary) {
        colValues[w.plan.cols.primary] = {
          item_ids: [Number(w.plan.desiredPrimary)],
        };
      }
      if (w.needs.revenue) {
        colValues[w.plan.cols.forecast] = w.plan.desiredRevenue.forecast;
        colValues[w.plan.cols.approved] = w.plan.desiredRevenue.approved;
        colValues[w.plan.cols.paid] = w.plan.desiredRevenue.paid;
        colValues[w.plan.cols.inReview] = w.plan.desiredRevenue.inReview;
        colValues[w.plan.cols.pendingArtefacts] = w.plan.desiredRevenue.pendingArtefacts;
        colValues[w.plan.cols.disputed] = w.plan.desiredRevenue.disputed;
      }
      if (w.needs.photos && w.plan.desiredPhotos && w.plan.cols.photosRequired && w.plan.cols.photosTaken) {
        colValues[w.plan.cols.photosRequired] = w.plan.desiredPhotos.required;
        colValues[w.plan.cols.photosTaken] = w.plan.desiredPhotos.taken;
      }
      if (w.needs.lifecycle) {
        // Diff-only: write each column only when its desired value
        // differs from the current monday value. Skip null desireds.
        if (
          w.plan.desiredRctiNumber != null &&
          w.plan.desiredRctiNumber !== w.plan.currentRctiNumber
        ) {
          colValues[w.plan.cols.rcti] = w.plan.desiredRctiNumber;
        }
        if (
          w.plan.desiredUglPaymentStatus != null &&
          w.plan.desiredUglPaymentStatus !== w.plan.currentUglPaymentStatus
        ) {
          colValues[w.plan.cols.uglPaymentStatus] = {
            label: w.plan.desiredUglPaymentStatus,
          };
        }
      }
      if (w.needs.designMetres && w.plan.desiredDesignMetres != null) {
        // Numeric column write — monday accepts a JS number.
        colValues[w.plan.cols.designMetres] = w.plan.desiredDesignMetres;
      }
      if (w.needs.actualMetres && w.plan.desiredActualMetres != null) {
        // Same payload shape as Design Metres above. The diff check in
        // planNeedsWrite guarantees we never overwrite null with null
        // or push the same value twice.
        colValues[w.plan.cols.actualMetres] = w.plan.desiredActualMetres;
      }
      aliases.push(
        `m${j}: change_multiple_column_values(
          board_id: $bid${j},
          item_id: $iid${j},
          column_values: $val${j},
          create_labels_if_missing: true
        ) { id }`
      );
      variables[`bid${j}`] = String(w.plan.boardId);
      variables[`iid${j}`] = String(w.plan.itemId);
      variables[`val${j}`] = JSON.stringify(colValues);
    });
    const argsList = batch
      .map((_, j) => `$bid${j}: ID!, $iid${j}: ID!, $val${j}: JSON!`)
      .join(", ");
    const query = `mutation (${argsList}) { ${aliases.join("\n")} }`;

    let attempt = 0;
    while (true) {
      try {
        await monday(query, variables);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("429") && attempt < 4) {
          const wait = 5000 * Math.pow(2, attempt);
          console.warn(
            `[sync-job-data] batch ${i}: 429 rate-limited, sleeping ${wait}ms (attempt ${attempt + 2}/5)`
          );
          await new Promise((r) => setTimeout(r, wait));
          attempt += 1;
          continue;
        }
        result.failed += batch.length;
        result.failures.push(`batch ${i}: ${msg.slice(0, 250)}`);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return result;
}

// ============================================================================
// Public entry point — called by sync-worker-background.ts as 3rd stage.
// ============================================================================

export interface SyncJobDataResult {
  active: ApplyResult;
  jobComplete: ApplyResult;
  submitted: ApplyResult;
  approved: ApplyResult;
  /** Track G3-fix5: Cancelled Jobs board added 11 May 2026. */
  cancelled: ApplyResult;
  /** Total elapsed wall time in milliseconds. */
  elapsedMs: number;
  /** Total writes across all 5 boards (primary + revenue + photo + lifecycle). */
  totalWrites: number;
  /** Total failures across all 5 boards. */
  totalFailed: number;
}

export interface RunSyncJobDataOptions {
  /** When true, plan but don't call monday's write mutations. Default
   *  false. Worker invocations never pass this — they always go live.
   *  CLI scripts (scripts/dry_run_design_propagation.ts etc) use this
   *  for preview. */
  dryRun?: boolean;
}

/**
 * Run the per-job data sync over Active + Job Complete + Submitted +
 * Approved + Cancelled boards. Idempotent: writes only what's changed.
 *
 *  Track K3 (May 2026): added Job Complete to the walk.
 *  Track G3-fix5 (11 May 2026): added Cancelled.
 *  Design Metres fix (12 May 2026): added the SOR-Lines→job-board
 *    Design Metres propagation. Also added the `opts.dryRun` knob so
 *    CLI scripts can preview without writing.
 */
export async function runSyncJobData(
  opts: RunSyncJobDataOptions = {}
): Promise<SyncJobDataResult> {
  const start = Date.now();
  const dryRun = opts.dryRun ?? false;
  const [
    sorByAsset,
    sorMethodsByAsset,
    lifecycleByAsset,
    designMetresByAsset,
    actualMetresByAsset,
    networkIdx,
    photosByAssetItemId,
    activeRaw,
    jobCompleteRaw,
    submittedRaw,
    approvedRaw,
    cancelledRaw,
  ] = await Promise.all([
    fetchSorRevenueByAsset(),
    fetchSorMethodsByAsset(),
    fetchSorLifecycleByAsset(),
    fetchSorDesignMetresByAsset(),
    fetchSorActualMetresByAsset(),
    fetchNetworkAssetIndex(),
    fetchPhotosByAssetItemId(),
    fetchJobBoardItems("active"),
    fetchJobBoardItems("jobComplete"),
    fetchJobBoardItems("submitted"),
    fetchJobBoardItems("approved"),
    fetchJobBoardItems("cancelled"),
  ]);
  const network = networkIdx.byName;

  const activePlans = activeRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset, designMetresByAsset, actualMetresByAsset)
  );
  const jobCompletePlans = jobCompleteRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset, designMetresByAsset, actualMetresByAsset)
  );
  const submittedPlans = submittedRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset, designMetresByAsset, actualMetresByAsset)
  );
  const approvedPlans = approvedRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset, designMetresByAsset, actualMetresByAsset)
  );
  const cancelledPlans = cancelledRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset, designMetresByAsset, actualMetresByAsset)
  );

  // Sequential to keep monday rate-limit pressure bounded.
  const active = await applyForBoard(activePlans, dryRun);
  const jobComplete = await applyForBoard(jobCompletePlans, dryRun);
  const submitted = await applyForBoard(submittedPlans, dryRun);
  const approved = await applyForBoard(approvedPlans, dryRun);
  const cancelled = await applyForBoard(cancelledPlans, dryRun);

  const totalWrites =
    active.primaryWrites + active.revenueWrites + active.photoWrites + active.lifecycleWrites + active.designMetresWrites + active.actualMetresWrites +
    jobComplete.primaryWrites + jobComplete.revenueWrites + jobComplete.photoWrites + jobComplete.lifecycleWrites + jobComplete.designMetresWrites + jobComplete.actualMetresWrites +
    submitted.primaryWrites + submitted.revenueWrites + submitted.photoWrites + submitted.lifecycleWrites + submitted.designMetresWrites + submitted.actualMetresWrites +
    approved.primaryWrites + approved.revenueWrites + approved.photoWrites + approved.lifecycleWrites + approved.designMetresWrites + approved.actualMetresWrites +
    cancelled.primaryWrites + cancelled.revenueWrites + cancelled.photoWrites + cancelled.lifecycleWrites + cancelled.designMetresWrites + cancelled.actualMetresWrites;
  const totalFailed =
    active.failed + jobComplete.failed + submitted.failed + approved.failed + cancelled.failed;

  return {
    active,
    jobComplete,
    submitted,
    approved,
    cancelled,
    elapsedMs: Date.now() - start,
    totalWrites,
    totalFailed,
  };
}
