/**
 * Sync UGL's daily SOR Extract spreadsheet into the SOR Lines board.
 *
 * Library export `runSyncSor(buffer)` is consumed by the serverless
 * handler at netlify/functions/sync.ts. The original CLI flow lives on
 * the main field-app repo at scripts/sync_sor_extract.ts (PR #27);
 * this version is the buffer-driven library variant.
 *
 * Reads the `Cons_Data` sheet, matches each row to an existing SOR
 * Lines item by (Asset ID, SOR code), diffs the values, and only
 * writes the columns that actually changed. Idempotent — safe to
 * re-run the same file. Never CREATES new SOR Lines rows — Heath /
 * UGL imports own row creation. Spreadsheet rows with no monday match
 * are logged and skipped. Empty cells in the spreadsheet are NEVER
 * written over a populated monday value.
 *
 * Required env: MONDAY_API_TOKEN
 */
import ExcelJS from "exceljs";

// ---------- Config (mirrors src/lib/monday-ids.ts SOR_COLUMNS) ----------
const SOR_BOARD_ID = 5028087610;
// RCTI Payment Cycles board (5028104633) — Sarah's twice-monthly UGL N2P
// Atlas payment cycle index. Each row carries Cut-off Date, RCTI Date,
// Payment Date, and a manually-managed Status (Open → Cut-off Passed →
// RCTI Issued → Paid). The cycle link drives the cashflow page's actual
// cash-received calc, distinct from UGL Status = "Paid" which only means
// UGL has approved + invoiced (money lands ~14 days later on a Thursday).
const RCTI_CYCLES_BOARD_ID = 5028104633;

const COLUMN = {
  ASSET_TEXT: "text_mm2tawd5",
  ITEM_CODE: "text_mm2tbsvs",
  PROJECT_ID: "text_mm2tx2kk",
  ADA: "text_mm2th5a5",
  DESCRIPTION: "long_text_mm2tz7vp",
  DESIGN_QTY: "numeric_mm2teaw2",
  ACTUAL_QTY: "numeric_mm2tb16d",
  ACCEPTED_QTY: "numeric_mm2tc70m",
  CONS_STATUS: "color_mm30cvg5",
  UGL_STATUS: "color_mm2tavfn",
  PAYMENT_STATUS: "color_mm2tktkr",
  INVOICE_ID: "text_mm2t3sb5",
  CONSTRUCTION_DATE: "date_mm30mc4k",
  REVIEW_DATE: "date_mm30n113",
  VA_COMMENTS: "long_text_mm304kjb",
  /** 🗓️ RCTI Payment Cycle — board_relation → RCTI Payment Cycles
   *  (5028104633). Added in the May 2026 RCTI integration migration via
   *  scripts/migrate_rcti_cycle_column.ts. Single link per row. */
  RCTI_CYCLE: "board_relation_mm3drkgn",
} as const;

const CYCLE_COLUMN = {
  RCTI_DATE: "date_mm2vmfgq",
  PAYMENT_DATE: "date_mm2vageh",
  STATUS: "color_mm2v5a45",
} as const;

/** Cycle statuses the policy table cares about. Sarah manages these
 *  manually on monday — read-only from the sync's side. */
type CycleStatus =
  | "Open"
  | "Cut-off Passed"
  | "RCTI Issued"
  | "Paid"
  | "Late/Disputed"
  | string; // defensive: unknown labels treated as Open-equivalent

/** Payment Status labels the sync OWNS. We never clobber Held/Submitted
 *  /Disputed values that Sarah has set manually — those are her overrides.
 *  Disputed CAN be written by the sync when transitioning from a state
 *  we own; the protection is on reading the CURRENT value. */
const PAYMENT_STATUS_OWNED = new Set<string | null>([
  null,
  "Pending",
  "Pending Receipt",
  "Paid",
]);

const PAYMENT_STATUS_INDEX: Record<string, number> = {
  Pending: 9, // existing
  "Pending Receipt": 1, // added by migration May 2026
  Paid: 6, // existing
  Disputed: 11, // existing
  Held: 0, // existing — Sarah's manual state, sync never writes
  Submitted: 158, // existing — historical, sync never writes
};

const CONS_STATUS_INDEX: Record<string, number> = {
  Pending: 0,
  "Field Complete": 1,
};

const UGL_STATUS_INDEX: Record<string, number> = {
  "Not Started": 17,
  "In Progress": 9,
  "Field Complete": 158,
  Submitted: 0,
  Approved: 8,
  Paid: 6,
  Rejected: 11,
  Cancelled: 1,
  "Pending Construction": 2,
  Disputed: 3,
  Descoped: 10,
  Overpaid: 12,
  "Paid - Pending RCTI": 15,
  "In Review": 102,
  "Pending Artefacts": 155,
  "Partial Paid": 160,
};

const BATCH_SIZE = 25; // GraphQL alias batches per request

/**
 * Track F2 (May 2026): when UGL's daily extract leaves Design Qty
 * blank for a per-unit SOR (Install P5 Pit, ACM Removal, Composite
 * Lid, Manhole Lid, Core Bore — anything where one-per-asset is the
 * only meaningful value), default to 1. Per-metre SORs (duct install
 * CW-01-*, duct repair CW-05-*, Pipe Proving CI-*) leave null and
 * log a warning so operators can fill in from UGL source data.
 *
 * Categorisation by SOR code prefix mirrors scripts/import_work_orders.ts
 * categorizeSor() — single source of truth lives there; this is a
 * sync-time guard that doesn't require a Rate Card fetch.
 */
function defaultDesignQty(
  rawQty: number | null,
  sorCode: string,
  ctx: { assetId: string }
): number | null {
  if (rawQty != null) return rawQty;
  const code = sorCode.trim().toUpperCase();
  // Per-unit SORs — default 1
  if (code === "CW-02-01-08" || code === "CW-02-01-06") return 1; // lids
  if (code.startsWith("CW-02-05-")) return 1; // manhole lids + accessories
  if (code.startsWith("CW-02-03-") || code.startsWith("CW-02-04-")) return 1; // ACM removal
  if (code.startsWith("CW-02-")) return 1; // pit install (CW-02-01-*, CW-02-02-*)
  if (code.startsWith("CW-03-")) return 1; // Core Bore
  // Per-metre / unrecognised — leave blank, log warning
  console.warn(
    `[sync-sor-extract] WARNING: Design Qty blank for non-unit SOR — assetId=${ctx.assetId} sor=${sorCode} (left null; needs manual fill from UGL source)`
  );
  return null;
}

// ---------- Types ----------
interface ExtractRow {
  rowIndex: number; // 2..N (1-indexed sheet row, header on 1)
  projectId: string | null;
  ada: string | null;
  assetId: string;
  sor: string;
  sorDescription: string | null;
  designQty: number | null;
  actualQty: number | null;
  acceptedQty: number | null;
  consStatus: string | null;
  sorStatus: string | null;
  invoiceNo: string | null;
  constructionDate: string | null; // ISO YYYY-MM-DD
  reviewDate: string | null; // ISO YYYY-MM-DD
  comments: string | null;
  /** RCTI Date as supplied by UGL on the extract row. OPTIONAL — UGL
   *  hasn't shipped this column at time of writing (May 2026); when
   *  present it's the primary signal for resolving the SOR Line's
   *  RCTI Payment Cycle. Falls back to Invoice-ID-grouping propagation.
   *  ISO YYYY-MM-DD, null when the column is absent or the cell is blank. */
  rctiDate: string | null;
}

interface MondayRow {
  id: string;
  name: string;
  values: Record<string, MondayCellValue>;
}

interface MondayCellValue {
  text: string | null;
  value: string | null;
  /** Populated only for board_relation columns (RCTI_CYCLE). Array of
   *  linked item ids. monday returns it via the BoardRelationValue
   *  inline fragment on column_values. */
  linked_item_ids?: string[];
}

/** Parsed shape of an RCTI Payment Cycle row — what diffRow needs to
 *  apply the Payment Status policy table. */
interface CycleInfo {
  itemId: string;
  name: string;
  rctiDateIso: string | null;
  paymentDateIso: string | null;
  status: CycleStatus;
}

type ChangeMap = Record<string, unknown>;

// ---------- Monday client ----------
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
  if (json.errors) {
    throw new Error(`monday errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

/** Wrap monday() with 5-attempt exponential backoff on 429s. Mirrors
 *  the pattern already in sync_job_data.ts. Used by applyDiffs for the
 *  bulk-write phase where rate-limit collisions are likely. */
async function mondayWithRetry<T>(
  query: string,
  variables: Record<string, unknown> = {},
  label = "monday"
): Promise<T> {
  let attempt = 0;
  // 5 total attempts → waits 5s/10s/20s/40s/60s (60s cap on last).
  while (true) {
    try {
      return await monday<T>(query, variables);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429") && attempt < 4) {
        const wait = Math.min(60_000, 5000 * Math.pow(2, attempt));
        console.warn(
          `[sync_sor_extract] ${label}: 429 rate-limited, sleeping ${wait}ms (attempt ${attempt + 2}/5)`
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

// ---------- Spreadsheet reader ----------
function cellText(v: ExcelJS.CellValue): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "text" in v && typeof v.text === "string") {
    return v.text.trim() || null;
  }
  if (typeof v === "object" && "result" in v) {
    return cellText(v.result as ExcelJS.CellValue);
  }
  return String(v).trim() || null;
}

function cellNumber(v: ExcelJS.CellValue): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && "result" in v) {
    return cellNumber(v.result as ExcelJS.CellValue);
  }
  return null;
}

/**
 * Spreadsheet date columns are typed as Date by ExcelJS most of the
 * time, but show up as DD/MM/YYYY strings on some rows. Normalise to
 * ISO YYYY-MM-DD; reject anything else so we never write garbage.
 */
function cellDateIso(v: ExcelJS.CellValue): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    // DD/MM/YYYY
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const [, d, mo, y] = m;
      return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    // YYYY-MM-DD passthrough
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    return null;
  }
  if (typeof v === "object" && "result" in v) {
    return cellDateIso(v.result as ExcelJS.CellValue);
  }
  return null;
}

interface ExtractReadResult {
  rows: ExtractRow[];
  /** Per-row parse failures. A bad cell in one row no longer kills
   *  the whole read — failures land here for the worker to surface in
   *  the Sync Run update. */
  rowErrors: Array<{ row: number; error: string }>;
}

async function readExtract(source: string | Buffer): Promise<ExtractReadResult> {
  const wb = new ExcelJS.Workbook();
  if (typeof source === "string") {
    await wb.xlsx.readFile(source);
  } else {
    // See note in import_work_orders.ts — convert Node Buffer to a
    // fresh ArrayBuffer so ExcelJS.load type-checks under strict mode.
    const ab = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength
    ) as ArrayBuffer;
    await wb.xlsx.load(ab);
  }
  const ws = wb.getWorksheet("Cons_Data");
  if (!ws) throw new Error("Cons_Data sheet not found in workbook");

  // 1-indexed column lookup by header text — defensive against UGL
  // reordering columns in a future revision.
  const header: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, col) => {
    const t = cellText(cell.value);
    if (t) header[t] = col;
  });
  const required = [
    "Asset ID",
    "SOR",
    "SOR Description",
    "Project ID",
    "ADA",
    "Design Qty",
    "Actual Qty",
    "accepted_qty",
    "Cons Status",
    "SOR Status",
    "Invoice #",
    "construction_date",
    "review_date",
    "comments",
  ];
  for (const name of required) {
    if (!header[name]) {
      throw new Error(`Missing column "${name}" in Cons_Data header`);
    }
  }
  // OPTIONAL: RCTI Date column. UGL may or may not ship this; if absent
  // the sync falls back to Invoice-ID propagation for cycle resolution.
  // Probe a handful of plausible header spellings.
  const rctiDateColIdx =
    header["RCTI Date"] ??
    header["rcti_date"] ??
    header["RCTI_Date"] ??
    header["rctiDate"] ??
    null;
  if (rctiDateColIdx == null) {
    console.log(
      `[sync_sor_extract] readExtract: no RCTI Date column found in header — cycle resolution will fall back to Invoice-ID-grouping propagation.`
    );
  } else {
    console.log(
      `[sync_sor_extract] readExtract: RCTI Date column found at index ${rctiDateColIdx} — primary cycle matcher will use it.`
    );
  }

  const rows: ExtractRow[] = [];
  const rowErrors: ExtractReadResult["rowErrors"] = [];
  // Per-row try/catch — one bad cell shouldn't kill the whole stage.
  // Track G3 (May 2026): part of the diagnostic-layer push.
  for (let r = 2; r <= ws.rowCount; r++) {
    try {
      const row = ws.getRow(r);
      const get = (name: string) => row.getCell(header[name]).value;
      const assetId = cellText(get("Asset ID"));
      const sor = cellText(get("SOR"));
      if (!assetId || !sor) continue; // skip blank rows
      rows.push({
        rowIndex: r,
        projectId: cellText(get("Project ID")),
        ada: cellText(get("ADA")),
        assetId,
        sor,
        sorDescription: cellText(get("SOR Description")),
        designQty: cellNumber(get("Design Qty")),
        actualQty: cellNumber(get("Actual Qty")),
        acceptedQty: cellNumber(get("accepted_qty")),
        consStatus: cellText(get("Cons Status")),
        sorStatus: cellText(get("SOR Status")),
        invoiceNo: cellText(get("Invoice #")),
        constructionDate: cellDateIso(get("construction_date")),
        reviewDate: cellDateIso(get("review_date")),
        comments: cellText(get("comments")),
        rctiDate:
          rctiDateColIdx != null
            ? cellDateIso(row.getCell(rctiDateColIdx).value)
            : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rowErrors.push({ row: r, error: msg.slice(0, 250) });
      console.warn(`[sync_sor_extract] row ${r} parse failed: ${msg}`);
    }
  }
  console.log(
    `[sync_sor_extract] readExtract done — rows=${rows.length} rowErrors=${rowErrors.length}`
  );
  return { rows, rowErrors };
}

// ---------- Monday SOR Lines fetch (paged) ----------
async function fetchAllSorLines(): Promise<MondayRow[]> {
  const all: MondayRow[] = [];
  let cursor: string | null = null;
  // First page uses items_page; subsequent pages use next_items_page(cursor:).
  // monday's max page size is 500.
  // We only ask for the columns the script reads/writes so the response
  // payload stays small — full board is ~150 rows, no big deal, but also
  // no point pulling 30+ columns we don't need.
  const colIds = JSON.stringify(Object.values(COLUMN));

  for (let pageNum = 1; pageNum <= 50; pageNum++) {
    console.log(
      `[sync_sor_extract] fetchAllSorLines page=${pageNum} cumulative=${all.length}`
    );
    const data = await monday<{
      boards?: Array<{
        items_page: { cursor: string | null; items: RawItem[] };
      }>;
      next_items_page?: { cursor: string | null; items: RawItem[] };
    }>(
      cursor
        ? `query ($cursor: String!, $colIds: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor
              items {
                id name
                column_values(ids: $colIds) {
                  id text value
                  ... on BoardRelationValue { linked_item_ids }
                }
              }
            }
          }`
        : `query ($boardId: ID!, $colIds: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor
                items {
                  id name
                  column_values(ids: $colIds) {
                    id text value
                    ... on BoardRelationValue { linked_item_ids }
                  }
                }
              }
            }
          }`,
      cursor
        ? { cursor, colIds: Object.values(COLUMN) }
        : { boardId: String(SOR_BOARD_ID), colIds: Object.values(COLUMN) }
    );

    const page: { cursor: string | null; items: RawItem[] } = cursor
      ? data.next_items_page!
      : data.boards![0]!.items_page;
    for (const item of page.items) {
      const values: Record<string, MondayCellValue> = {};
      for (const cv of item.column_values) {
        values[cv.id] = {
          text: cv.text,
          value: cv.value,
          linked_item_ids: cv.linked_item_ids,
        };
      }
      all.push({ id: item.id, name: item.name, values });
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return all;
}

interface RawItem {
  id: string;
  name: string;
  column_values: Array<{
    id: string;
    text: string | null;
    value: string | null;
    linked_item_ids?: string[];
  }>;
}

// ---------- RCTI Payment Cycles fetch ----------
async function fetchAllCycles(): Promise<CycleInfo[]> {
  const data = await monday<{
    boards: Array<{
      items_page: {
        cursor: string | null;
        items: Array<{
          id: string;
          name: string;
          column_values: Array<{ id: string; text: string | null }>;
        }>;
      };
    }>;
  }>(
    `query ($boardId: ID!, $colIds: [String!]) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          cursor
          items {
            id name
            column_values(ids: $colIds) { id text }
          }
        }
      }
    }`,
    {
      boardId: String(RCTI_CYCLES_BOARD_ID),
      colIds: Object.values(CYCLE_COLUMN),
    }
  );
  const items = data.boards[0]?.items_page?.items ?? [];
  return items.map((it) => {
    const cv: Record<string, string | null> = {};
    for (const c of it.column_values) cv[c.id] = c.text;
    return {
      itemId: it.id,
      name: it.name,
      rctiDateIso: cv[CYCLE_COLUMN.RCTI_DATE]?.trim() || null,
      paymentDateIso: cv[CYCLE_COLUMN.PAYMENT_DATE]?.trim() || null,
      status: (cv[CYCLE_COLUMN.STATUS]?.trim() || "Open") as CycleStatus,
    };
  });
}

// ---------- Cycle resolution helpers ----------

/** Build a lookup from ISO RCTI date → cycle id. Used by the primary
 *  matcher when UGL's extract carries an "RCTI Date" column. */
function indexCyclesByRctiDate(cycles: CycleInfo[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of cycles) {
    if (c.rctiDateIso) m.set(c.rctiDateIso, c.itemId);
  }
  return m;
}

/** Build a lookup from cycle id → CycleInfo for fast policy resolution. */
function indexCyclesById(cycles: CycleInfo[]): Map<string, CycleInfo> {
  const m = new Map<string, CycleInfo>();
  for (const c of cycles) m.set(c.itemId, c);
  return m;
}

/** Walk the SOR Lines we just fetched and build a propagation map:
 *  Invoice ID → existing linked cycle id. Used as the secondary matcher
 *  when UGL's extract doesn't include an RCTI Date — any SOR Line
 *  already manually linked to a cycle seeds the link for its siblings
 *  with the same Invoice ID. First-link-wins on ties (rare; would mean
 *  Sarah mis-tagged) with a logged warning. */
function indexInvoiceToCycle(rows: MondayRow[]): Map<string, string> {
  const m = new Map<string, string>();
  const seenCollision = new Set<string>();
  for (const r of rows) {
    const invoice = r.values[COLUMN.INVOICE_ID]?.text?.trim();
    if (!invoice) continue;
    const linked = r.values[COLUMN.RCTI_CYCLE]?.linked_item_ids ?? [];
    const cycleId = linked[0];
    if (!cycleId) continue;
    const prior = m.get(invoice);
    if (prior && prior !== cycleId && !seenCollision.has(invoice)) {
      console.warn(
        `[sync_sor_extract] invoice ${invoice} has conflicting cycle links: ${prior} vs ${cycleId} — using ${prior} (first-link-wins). Investigate.`
      );
      seenCollision.add(invoice);
      continue;
    }
    if (!prior) m.set(invoice, cycleId);
  }
  return m;
}

/** Resolve the cycle id for an SOR Line given the available signals.
 *  Returns null when neither primary nor fallback match resolves. */
function resolveCycleId(
  extract: ExtractRow,
  cycleByRctiDate: Map<string, string>,
  invoiceToCycle: Map<string, string>
): string | null {
  // Primary: extract carries explicit RCTI Date → cycle by date_mm2vmfgq
  if (extract.rctiDate) {
    const byDate = cycleByRctiDate.get(extract.rctiDate);
    if (byDate) return byDate;
  }
  // Fallback: by Invoice ID propagation from already-linked siblings
  const invoice = extract.invoiceNo?.trim();
  if (invoice) {
    const byInvoice = invoiceToCycle.get(invoice);
    if (byInvoice) return byInvoice;
  }
  return null;
}

// ---------- Payment Status policy table ----------

/** Apply the May 2026 Payment Status policy. Returns the target label
 *  (or null when the row should be cleared / left alone). Caller is
 *  responsible for the "don't clobber Held / Disputed / Submitted"
 *  guard — this function only computes the target.
 *
 *  Policy (per the brief):
 *    UGL Status              Cycle Status            Target
 *    -------------------------------------------------------------
 *    Approved                (any)                   Pending
 *    Paid - Pending RCTI     (any)                   Pending
 *    Paid / Partial Paid     Open / Cut-off Passed   Pending
 *    Paid / Partial Paid     RCTI Issued             Pending Receipt
 *    Paid / Partial Paid     Paid                    Paid
 *    Disputed                (any)                   Disputed
 *    Cancelled               (any)                   (clear, returns "" sentinel)
 *    other                                           null (no opinion) */
function computePaymentStatusTarget(
  uglStatus: string | null,
  cycle: CycleInfo | null
): string | "" | null {
  if (!uglStatus) return null;
  switch (uglStatus) {
    case "Approved":
    case "Paid - Pending RCTI":
      return "Pending";
    case "Paid":
    case "Partial Paid": {
      const cs = cycle?.status ?? null;
      if (cs === "Paid") return "Paid";
      if (cs === "RCTI Issued") return "Pending Receipt";
      // Open, Cut-off Passed, Late/Disputed, unknown → Pending (the
      // safest "not yet in our bank" bucket).
      return "Pending";
    }
    case "Disputed":
      return "Disputed";
    case "Cancelled":
      return ""; // clear sentinel
    default:
      // Not Started / In Progress / Field Complete / Submitted / In
      // Review / Pending Artefacts / Pending Construction / Descoped /
      // Overpaid / Rejected — sync has no opinion, leave Payment Status
      // alone.
      return null;
  }
}

// ---------- Index by (asset id, item code) ----------
function indexMondayRows(
  rows: MondayRow[]
): Map<string, MondayRow> {
  const map = new Map<string, MondayRow>();
  for (const r of rows) {
    const assetText = r.values[COLUMN.ASSET_TEXT]?.text;
    const itemCode = r.values[COLUMN.ITEM_CODE]?.text;
    if (!assetText || !itemCode) continue;
    map.set(joinKey(assetText, itemCode), r);
  }
  return map;
}

function joinKey(assetId: string, sor: string): string {
  return `${assetId.trim()}|||${sor.trim().toUpperCase()}`;
}

// ---------- Diff a single row ----------
interface RowDiff {
  itemId: string;
  changes: ChangeMap;
  changedFields: string[];
  /** True when this row's diff includes a 🗓️ RCTI Payment Cycle write.
   *  Counted separately in SyncResult.rctiCycleLinkWrites. */
  rctiCycleLinkWritten: boolean;
  /** True when this row's diff includes a Payment Status write. Counted
   *  separately in SyncResult.paymentStatusMirrorWrites. */
  paymentStatusMirrorWritten: boolean;
}

function diffRow(
  extract: ExtractRow,
  current: MondayRow,
  cycleByRctiDate: Map<string, string>,
  invoiceToCycle: Map<string, string>,
  cyclesById: Map<string, CycleInfo>
): RowDiff {
  const changes: ChangeMap = {};
  const changedFields: string[] = [];
  const cur = current.values;

  function setIfChangedText(colId: string, fieldName: string, next: string | null) {
    if (next == null || next === "") return; // never overwrite with null
    const existing = cur[colId]?.text ?? null;
    if (existing === next) return;
    changes[colId] = next;
    changedFields.push(fieldName);
  }

  function setIfChangedNumber(
    colId: string,
    fieldName: string,
    next: number | null
  ) {
    if (next == null) return;
    const existingText = cur[colId]?.text;
    const existing = existingText != null && existingText !== "" ? Number(existingText) : null;
    if (existing != null && Number.isFinite(existing) && existing === next) return;
    changes[colId] = String(next);
    changedFields.push(fieldName);
  }

  function setIfChangedDate(
    colId: string,
    fieldName: string,
    nextIso: string | null
  ) {
    if (!nextIso) return;
    const existing = cur[colId]?.text || null;
    // monday returns dates as "YYYY-MM-DD" in text
    if (existing === nextIso) return;
    changes[colId] = { date: nextIso };
    changedFields.push(fieldName);
  }

  function setIfChangedStatus(
    colId: string,
    fieldName: string,
    nextLabel: string | null,
    indexMap: Record<string, number>
  ) {
    if (!nextLabel) return;
    const labelId = indexMap[nextLabel];
    if (labelId == null) {
      console.warn(
        `[warn] Unknown ${fieldName} value "${nextLabel}" — skip (not in label map)`
      );
      return;
    }
    const existing = cur[colId]?.text || null;
    if (existing === nextLabel) return;
    changes[colId] = { index: labelId };
    changedFields.push(fieldName);
  }

  setIfChangedText(COLUMN.PROJECT_ID, "Project ID", extract.projectId);
  setIfChangedText(COLUMN.ADA, "ADA", extract.ada);
  setIfChangedText(COLUMN.DESCRIPTION, "SOR Description", extract.sorDescription);
  setIfChangedNumber(
    COLUMN.DESIGN_QTY,
    "Design Qty",
    defaultDesignQty(extract.designQty, extract.sor, { assetId: extract.assetId })
  );
  setIfChangedNumber(COLUMN.ACTUAL_QTY, "Actual Qty", extract.actualQty);
  setIfChangedNumber(COLUMN.ACCEPTED_QTY, "Accepted Qty", extract.acceptedQty);
  setIfChangedStatus(
    COLUMN.CONS_STATUS,
    "Cons Status",
    extract.consStatus,
    CONS_STATUS_INDEX
  );
  setIfChangedStatus(
    COLUMN.UGL_STATUS,
    "SOR Status",
    extract.sorStatus,
    UGL_STATUS_INDEX
  );
  setIfChangedText(COLUMN.INVOICE_ID, "Invoice #", extract.invoiceNo);
  setIfChangedDate(
    COLUMN.CONSTRUCTION_DATE,
    "Construction Date",
    extract.constructionDate
  );
  setIfChangedDate(COLUMN.REVIEW_DATE, "Review Date", extract.reviewDate);
  setIfChangedText(COLUMN.VA_COMMENTS, "VA Comments", extract.comments);

  // ----- RCTI Payment Cycle link (May 2026) -----
  // Resolve the target cycle from extract signals (RCTI Date primary,
  // Invoice-ID-grouping fallback). Write only when it actually differs
  // from the current linked id — idempotent on re-runs.
  const targetCycleId = resolveCycleId(extract, cycleByRctiDate, invoiceToCycle);
  const currentLinkedIds = cur[COLUMN.RCTI_CYCLE]?.linked_item_ids ?? [];
  const currentCycleId = currentLinkedIds[0] ?? null;
  let rctiCycleLinkWritten = false;
  if (targetCycleId && targetCycleId !== currentCycleId) {
    // board_relation write shape: { item_ids: [<itemId>] }
    changes[COLUMN.RCTI_CYCLE] = { item_ids: [Number(targetCycleId)] };
    changedFields.push("RCTI Payment Cycle");
    rctiCycleLinkWritten = true;
  }
  // Effective cycle after this run's diff lands.
  const effectiveCycleId = targetCycleId ?? currentCycleId;
  const effectiveCycle = effectiveCycleId
    ? cyclesById.get(effectiveCycleId) ?? null
    : null;

  // ----- Payment Status mirror (May 2026) -----
  // Three-gate guard (mirrors sync_job_data.ts's Job Status mirror in
  // PR #26):
  //   1. Only fire when something material changed this run — either
  //      the row's UGL Status updated OR the cycle link is being set/
  //      changed. Avoids churn on no-op syncs.
  //   2. Don't clobber Held / Submitted / Disputed — Sarah's manual
  //      overrides. Only write when current Payment Status is in the
  //      sync-owned set { null, Pending, Pending Receipt, Paid }.
  //   3. Only emit the change when target differs from current.
  const uglStatusChanged = changedFields.includes("SOR Status");
  const cycleLinkChanged = rctiCycleLinkWritten;
  const currentPaymentStatus = cur[COLUMN.PAYMENT_STATUS]?.text ?? null;
  let paymentStatusMirrorWritten = false;
  if (
    (uglStatusChanged || cycleLinkChanged) &&
    PAYMENT_STATUS_OWNED.has(currentPaymentStatus)
  ) {
    // Use the EFFECTIVE UGL Status after this run's diff lands — same
    // pattern as Actual Metres scope filter in sync_job_data.ts.
    const effectiveUglStatus = uglStatusChanged
      ? extract.sorStatus
      : cur[COLUMN.UGL_STATUS]?.text ?? null;
    const target = computePaymentStatusTarget(effectiveUglStatus, effectiveCycle);
    if (target === "") {
      // Clear sentinel — Cancelled UGL Status. monday accepts the empty
      // string to clear a status column.
      if (currentPaymentStatus != null) {
        changes[COLUMN.PAYMENT_STATUS] = { label: "" };
        changedFields.push("Payment Status");
        paymentStatusMirrorWritten = true;
      }
    } else if (target != null && target !== currentPaymentStatus) {
      const labelId = PAYMENT_STATUS_INDEX[target];
      if (labelId == null) {
        console.warn(
          `[sync_sor_extract] unknown Payment Status target "${target}" — skip (not in label map)`
        );
      } else {
        changes[COLUMN.PAYMENT_STATUS] = { index: labelId };
        changedFields.push("Payment Status");
        paymentStatusMirrorWritten = true;
      }
    }
  }

  return {
    itemId: current.id,
    changes,
    changedFields,
    rctiCycleLinkWritten,
    paymentStatusMirrorWritten,
  };
}

// ---------- Apply mutations in batches via GraphQL aliases ----------
async function applyDiffs(
  diffs: RowDiff[],
  dryRun: boolean
): Promise<{ updated: number; failed: number; failures: string[] }> {
  const toApply = diffs.filter((d) => Object.keys(d.changes).length > 0);
  if (dryRun) return { updated: toApply.length, failed: 0, failures: [] };

  let updated = 0;
  let failed = 0;
  const failures: string[] = [];
  const totalBatches = Math.ceil(toApply.length / BATCH_SIZE);

  for (let i = 0; i < toApply.length; i += BATCH_SIZE) {
    const batch = toApply.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
    const aliases: string[] = [];
    const variables: Record<string, unknown> = {
      boardId: String(SOR_BOARD_ID),
    };
    batch.forEach((d, j) => {
      aliases.push(
        `m${j}: change_multiple_column_values(
          board_id: $boardId,
          item_id: $i${j},
          column_values: $cv${j}
        ) { id }`
      );
      variables[`i${j}`] = String(d.itemId);
      variables[`cv${j}`] = JSON.stringify(d.changes);
    });

    const argsList = batch
      .map((_, j) => `$i${j}: ID!, $cv${j}: JSON!`)
      .join(", ");

    const query = `mutation ($boardId: ID!, ${argsList}) {
      ${aliases.join("\n")}
    }`;

    const batchStart = Date.now();
    console.log(
      `[sync_sor_extract] applyDiffs batch ${batchIndex}/${totalBatches} size=${batch.length} items=${batch.map((d) => d.itemId).join(",")}`
    );
    try {
      await mondayWithRetry(query, variables, `applyDiffs-batch-${batchIndex}`);
      updated += batch.length;
      console.log(
        `[sync_sor_extract] applyDiffs batch ${batchIndex}/${totalBatches} done in ${Date.now() - batchStart}ms (cumulative updated=${updated})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed += batch.length;
      failures.push(
        `batch ${batchIndex}/${totalBatches} (rows starting at ${i}): ${msg.slice(0, 250)} (item ids: ${batch
          .map((d) => d.itemId)
          .join(",")})`
      );
      console.error(
        `[sync_sor_extract] applyDiffs batch ${batchIndex}/${totalBatches} FAILED after ${Date.now() - batchStart}ms: ${msg}`
      );
    }
    // 250ms inter-batch breather — same as sync_job_data.ts. Smooths
    // out rate-limit-hit probability without lengthening a healthy run
    // noticeably (250ms × ~6 batches = 1.5s overhead per full sync).
    if (i + BATCH_SIZE < toApply.length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { updated, failed, failures };
}

// ---------- Library entry point ----------
export interface SyncResult {
  rowsProcessed: number;
  toUpdate: number;
  updated: number;
  unchanged: number;
  unmatched: number;
  failed: number;
  failures: string[];
  /** "<assetId> / <sor>" keys whose Cons Status flipped to "Field Complete" on this run */
  newFieldComplete: string[];
  /** "<assetId> / <sor>" keys whose SOR Status flipped to "Paid" on this run */
  newPaid: string[];
  /** Count of SOR Lines whose 🗓️ RCTI Payment Cycle link was set/changed
   *  on this run (May 2026). Surfaced in the Sync Run audit log. */
  rctiCycleLinkWrites: number;
  /** Count of SOR Lines whose Payment Status was updated by the
   *  Pending → Pending Receipt → Paid mirror on this run. */
  paymentStatusMirrorWrites: number;
  /** Count of SOR Lines for which cycle resolution failed despite an
   *  Invoice ID being present — meaning there's no extract RCTI Date
   *  AND no sibling SOR Line is linked yet. These are bootstrap-blocked;
   *  Sarah needs to seed at least one link per Invoice ID, or UGL needs
   *  to add the RCTI Date column. Logged for visibility. */
  rctiCycleResolutionMisses: number;
  elapsedMs: number;
}

/**
 * Sync the supplied SOR Extract `.xlsx` (loaded into memory as a Buffer)
 * into the SOR Lines board. Returns a structured summary the serverless
 * handler serialises to JSON for the browser. No console output —
 * everything goes into the returned object.
 */
export async function runSyncSor(buffer: Buffer): Promise<SyncResult> {
  const start = Date.now();
  console.log(`[sync_sor_extract] runSyncSor start — buffer=${buffer.byteLength}b`);
  const { rows: extract, rowErrors } = await readExtract(buffer);
  console.log(
    `[sync_sor_extract] runSyncSor extracted ${extract.length} rows (${rowErrors.length} row-parse failures)`
  );

  console.log(`[sync_sor_extract] runSyncSor fetching SOR Lines from monday…`);
  const monday_rows = await fetchAllSorLines();
  console.log(
    `[sync_sor_extract] runSyncSor monday SOR Lines fetched: ${monday_rows.length} rows`
  );
  const index = indexMondayRows(monday_rows);

  // ---- May 2026 RCTI Payment Cycles integration ----
  // Parallel fetch of the (small, ~18-row) cycles board + build the two
  // lookup maps used by resolveCycleId + the Payment Status policy.
  console.log(`[sync_sor_extract] runSyncSor fetching RCTI Payment Cycles…`);
  const cycles = await fetchAllCycles();
  console.log(
    `[sync_sor_extract] runSyncSor cycles fetched: ${cycles.length} rows`
  );
  const cycleByRctiDate = indexCyclesByRctiDate(cycles);
  const cyclesById = indexCyclesById(cycles);
  const invoiceToCycle = indexInvoiceToCycle(monday_rows);
  console.log(
    `[sync_sor_extract] runSyncSor cycle indices ready — byRctiDate=${cycleByRctiDate.size} byInvoiceId=${invoiceToCycle.size}`
  );

  const diffs: RowDiff[] = [];
  let unmatched = 0;
  let unchanged = 0;
  let rctiCycleResolutionMisses = 0;
  const newFieldComplete: string[] = [];
  const newPaid: string[] = [];

  for (const ex of extract) {
    const current = index.get(joinKey(ex.assetId, ex.sor));
    if (!current) {
      unmatched++;
      continue;
    }
    const diff = diffRow(ex, current, cycleByRctiDate, invoiceToCycle, cyclesById);

    // Resolution miss tracking — Invoice ID set but neither matcher
    // resolved AND we didn't already have a cycle linked. Surfaced as
    // a Sync Run counter so Sarah / operators can spot bootstrap gaps.
    if (
      ex.invoiceNo &&
      !diff.rctiCycleLinkWritten &&
      !(current.values[COLUMN.RCTI_CYCLE]?.linked_item_ids ?? []).length
    ) {
      rctiCycleResolutionMisses++;
    }

    if (diff.changedFields.length === 0) {
      unchanged++;
      continue;
    }
    diffs.push(diff);

    if (
      diff.changedFields.includes("Cons Status") &&
      ex.consStatus === "Field Complete" &&
      current.values[COLUMN.CONS_STATUS]?.text !== "Field Complete"
    ) {
      newFieldComplete.push(`${ex.assetId} / ${ex.sor}`);
    }
    if (
      diff.changedFields.includes("SOR Status") &&
      ex.sorStatus === "Paid" &&
      current.values[COLUMN.UGL_STATUS]?.text !== "Paid"
    ) {
      newPaid.push(`${ex.assetId} / ${ex.sor}`);
    }
  }
  const rctiCycleLinkWrites = diffs.filter((d) => d.rctiCycleLinkWritten).length;
  const paymentStatusMirrorWrites = diffs.filter(
    (d) => d.paymentStatusMirrorWritten
  ).length;

  console.log(
    `[sync_sor_extract] runSyncSor diffs=${diffs.length} unmatched=${unmatched} unchanged=${unchanged} newFieldComplete=${newFieldComplete.length} newPaid=${newPaid.length}`
  );

  const result = await applyDiffs(diffs, false);

  // Fold per-row parse failures into the SyncResult failures array so
  // they surface in the Sync Run update.
  const allFailures = [
    ...result.failures,
    ...rowErrors.map((e) => `row ${e.row} parse: ${e.error}`),
  ];

  console.log(
    `[sync_sor_extract] runSyncSor done in ${Date.now() - start}ms updated=${result.updated} failed=${result.failed + rowErrors.length} rctiCycleLinkWrites=${rctiCycleLinkWrites} paymentStatusMirrorWrites=${paymentStatusMirrorWrites} rctiCycleResolutionMisses=${rctiCycleResolutionMisses}`
  );

  return {
    rowsProcessed: extract.length,
    toUpdate: diffs.length,
    updated: result.updated,
    unchanged,
    unmatched,
    failed: result.failed + rowErrors.length,
    failures: allFailures,
    newFieldComplete,
    newPaid,
    rctiCycleLinkWrites,
    paymentStatusMirrorWrites,
    rctiCycleResolutionMisses,
    elapsedMs: Date.now() - start,
  };
}
