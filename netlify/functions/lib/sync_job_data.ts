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
};

const JOB_BOARDS: Record<"active" | "jobComplete" | "submitted" | "approved", { id: number; cols: JobBoardCols }> = {
  active: {
    id: ACTIVE_JOBS_BOARD,
    cols: ACTIVE_JOB_COL_IDS,
  },
  jobComplete: {
    id: JOB_COMPLETE_BOARD,
    // Track K1 verification confirmed 57/57 column IDs match Active.
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
  boardKey: "active" | "jobComplete" | "submitted" | "approved";
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
  | "isTest"
  | "unmatchedAsset"
>;

async function fetchJobBoardItems(
  boardKey: "active" | "jobComplete" | "submitted" | "approved"
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
  lifecycleByAsset: Map<string, Lifecycle>
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
  return {
    ...raw,
    isTest,
    unmatchedAsset,
    desiredPrimary: networkId,
    desiredRevenue,
    desiredPhotos,
    desiredRctiNumber: lifecycle.rctiNumber,
    desiredUglPaymentStatus: lifecycle.aggregatedStatus,
  };
}

function planNeedsWrite(p: JobItem): {
  primary: boolean;
  revenue: boolean;
  photos: boolean;
  lifecycle: boolean;
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
  return { primary, revenue, photos, lifecycle };
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
    unchanged: 0,
    testItems: plans.filter((p) => p.isTest).length,
    unmatchedItems: plans.filter((p) => p.unmatchedAsset).length,
    failed: 0,
    failures: [],
  };

  const writes: Array<{
    plan: JobItem;
    needs: { primary: boolean; revenue: boolean; photos: boolean; lifecycle: boolean };
  }> = [];
  for (const p of plans) {
    const needs = planNeedsWrite(p);
    if (!needs.primary && !needs.revenue && !needs.photos && !needs.lifecycle) {
      result.unchanged += 1;
      continue;
    }
    if (needs.primary) result.primaryWrites += 1;
    if (needs.revenue) result.revenueWrites += 1;
    if (needs.photos) result.photoWrites += 1;
    if (needs.lifecycle) result.lifecycleWrites += 1;
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
  /** Total elapsed wall time in milliseconds. */
  elapsedMs: number;
  /** Total writes across all 4 boards (primary + revenue + photo). */
  totalWrites: number;
  /** Total failures across all 4 boards. */
  totalFailed: number;
}

/**
 * Run the per-job data sync over Active + Job Complete + Submitted +
 * Approved boards. Always real (no dry-run path) — the worker invokes
 * this after a successful import. Idempotent: writes only what's
 * changed. Track K3 (May 2026): added Job Complete to the walk.
 */
export async function runSyncJobData(): Promise<SyncJobDataResult> {
  const start = Date.now();
  const [
    sorByAsset,
    sorMethodsByAsset,
    lifecycleByAsset,
    networkIdx,
    photosByAssetItemId,
    activeRaw,
    jobCompleteRaw,
    submittedRaw,
    approvedRaw,
  ] = await Promise.all([
    fetchSorRevenueByAsset(),
    fetchSorMethodsByAsset(),
    fetchSorLifecycleByAsset(),
    fetchNetworkAssetIndex(),
    fetchPhotosByAssetItemId(),
    fetchJobBoardItems("active"),
    fetchJobBoardItems("jobComplete"),
    fetchJobBoardItems("submitted"),
    fetchJobBoardItems("approved"),
  ]);
  const network = networkIdx.byName;

  const activePlans = activeRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset)
  );
  const jobCompletePlans = jobCompleteRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset)
  );
  const submittedPlans = submittedRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset)
  );
  const approvedPlans = approvedRaw.map((r) =>
    buildPlan(r, network, sorByAsset, sorMethodsByAsset, photosByAssetItemId, lifecycleByAsset)
  );

  // Sequential to keep monday rate-limit pressure bounded.
  const active = await applyForBoard(activePlans, false);
  const jobComplete = await applyForBoard(jobCompletePlans, false);
  const submitted = await applyForBoard(submittedPlans, false);
  const approved = await applyForBoard(approvedPlans, false);

  const totalWrites =
    active.primaryWrites + active.revenueWrites + active.photoWrites + active.lifecycleWrites +
    jobComplete.primaryWrites + jobComplete.revenueWrites + jobComplete.photoWrites + jobComplete.lifecycleWrites +
    submitted.primaryWrites + submitted.revenueWrites + submitted.photoWrites + submitted.lifecycleWrites +
    approved.primaryWrites + approved.revenueWrites + approved.photoWrites + approved.lifecycleWrites;
  const totalFailed = active.failed + jobComplete.failed + submitted.failed + approved.failed;

  return {
    active,
    jobComplete,
    submitted,
    approved,
    elapsedMs: Date.now() - start,
    totalWrites,
    totalFailed,
  };
}
