#!/usr/bin/env tsx
/**
 * Sync UGL's daily SOR Extract spreadsheet into the SOR Lines board.
 *
 * Replaces the row-by-row VA workflow. Reads the `Cons_Data` sheet,
 * matches each row to an existing SOR Lines item by (Asset ID, SOR
 * code), diffs the values, and only writes the columns that actually
 * changed. Idempotent — safe to re-run the same file.
 *
 * Usage:
 *   tsx scripts/sync_sor_extract.ts <path/to/extract.xlsx> [--dry-run]
 *
 * Required env: MONDAY_API_TOKEN
 *
 * The script never CREATES new SOR Lines rows — Heath / UGL imports own
 * row creation. Spreadsheet rows with no monday match are logged and
 * skipped. Empty cells in the spreadsheet are NEVER written over a
 * populated monday value.
 */
import ExcelJS from "exceljs";
import * as path from "path";

// ---------- Config (mirrors src/lib/monday-ids.ts SOR_COLUMNS) ----------
const SOR_BOARD_ID = 5028087610;

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
  INVOICE_ID: "text_mm2t3sb5",
  CONSTRUCTION_DATE: "date_mm30mc4k",
  REVIEW_DATE: "date_mm30n113",
  VA_COMMENTS: "long_text_mm304kjb",
} as const;

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
}

interface MondayRow {
  id: string;
  name: string;
  values: Record<string, MondayCellValue>;
}

interface MondayCellValue {
  text: string | null;
  value: string | null;
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

async function readExtract(filePath: string): Promise<ExtractRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
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

  const rows: ExtractRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
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
    });
  }
  return rows;
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
              items { id name column_values(ids: $colIds) { id text value } }
            }
          }`
        : `query ($boardId: ID!, $colIds: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor
                items { id name column_values(ids: $colIds) { id text value } }
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
        values[cv.id] = { text: cv.text, value: cv.value };
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
  column_values: Array<{ id: string; text: string | null; value: string | null }>;
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
  return `${assetId.trim()} ${sor.trim().toUpperCase()}`;
}

// ---------- Diff a single row ----------
interface RowDiff {
  itemId: string;
  changes: ChangeMap;
  changedFields: string[];
}

function diffRow(extract: ExtractRow, current: MondayRow): RowDiff {
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
  setIfChangedNumber(COLUMN.DESIGN_QTY, "Design Qty", extract.designQty);
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

  return { itemId: current.id, changes, changedFields };
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

  for (let i = 0; i < toApply.length; i += BATCH_SIZE) {
    const batch = toApply.slice(i, i + BATCH_SIZE);
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

    try {
      await monday(query, variables);
      updated += batch.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed += batch.length;
      failures.push(
        `batch starting at row ${i}: ${msg.slice(0, 250)} (item ids: ${batch
          .map((d) => d.itemId)
          .join(",")})`
      );
    }
  }
  return { updated, failed, failures };
}

// ---------- Main ----------
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    console.error(
      "Usage: tsx scripts/sync_sor_extract.ts <path/to/extract.xlsx> [--dry-run]"
    );
    process.exit(1);
  }

  const start = Date.now();
  console.log(
    `[sor-sync] reading ${path.basename(filePath)}${dryRun ? " (dry-run)" : ""}`
  );

  const extract = await readExtract(filePath);
  console.log(`[sor-sync] parsed ${extract.length} rows from Cons_Data`);

  console.log(`[sor-sync] fetching SOR Lines from monday`);
  const monday_rows = await fetchAllSorLines();
  console.log(`[sor-sync] fetched ${monday_rows.length} monday rows`);

  const index = indexMondayRows(monday_rows);
  console.log(`[sor-sync] indexed ${index.size} (Asset ID, SOR) pairs`);

  // Diff each extract row against monday
  const diffs: RowDiff[] = [];
  let unmatched = 0;
  let unchanged = 0;
  const newFieldComplete: string[] = [];
  const newPaid: string[] = [];

  for (const ex of extract) {
    const current = index.get(joinKey(ex.assetId, ex.sor));
    if (!current) {
      unmatched++;
      console.log(
        `[skip] no monday match: ${ex.assetId} / ${ex.sor} (sheet row ${ex.rowIndex})`
      );
      continue;
    }
    const diff = diffRow(ex, current);
    if (diff.changedFields.length === 0) {
      unchanged++;
      continue;
    }
    diffs.push(diff);

    // High-signal change tracking
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

    console.log(
      `[diff] ${current.id} ${ex.assetId} / ${ex.sor}: ${diff.changedFields.join(", ")}`
    );
  }

  console.log(
    `\n[sor-sync] diff summary: ${diffs.length} to update, ${unchanged} unchanged, ${unmatched} unmatched`
  );

  const result = await applyDiffs(diffs, dryRun);

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n[sor-sync] ${dryRun ? "DRY-RUN" : "APPLIED"} in ${elapsedSec}s` +
      `\n  rows processed: ${extract.length}` +
      `\n  monday updated: ${result.updated}` +
      `\n  unchanged:      ${unchanged}` +
      `\n  unmatched:      ${unmatched}` +
      `\n  failed:         ${result.failed}` +
      (newFieldComplete.length > 0
        ? `\n\n  New "Field Complete" rows (${newFieldComplete.length}):\n    ${newFieldComplete.slice(0, 20).join("\n    ")}${newFieldComplete.length > 20 ? `\n    ...${newFieldComplete.length - 20} more` : ""}`
        : "") +
      (newPaid.length > 0
        ? `\n\n  New "Paid" rows (${newPaid.length}):\n    ${newPaid.slice(0, 20).join("\n    ")}${newPaid.length > 20 ? `\n    ...${newPaid.length - 20} more` : ""}`
        : "")
  );

  if (result.failures.length > 0) {
    console.log(`\n[sor-sync] failures:`);
    for (const f of result.failures) console.log(`  ${f}`);
  }

  if (result.failed > 0 && !dryRun) process.exit(2);
}

main().catch((err) => {
  console.error("[sor-sync] FATAL:", err);
  process.exit(1);
});
