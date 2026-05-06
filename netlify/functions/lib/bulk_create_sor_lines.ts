/**
 * Bulk-create SOR Lines from a UGL daily Cons_Data extract.
 *
 * Library variant of `scripts/bulk_create_sor_lines.ts` from the main
 * field-app repo. Same logic, exported as `runBulkCreateSorLines(buffer)`
 * so the Netlify upload page can chain it after sync_sor_extract +
 * import_work_orders.
 *
 * Companion to `sync_sor_extract.ts`. Where sync only UPDATES existing
 * rows and skips unmatched extract rows, this script CREATES missing
 * rows so the SOR Lines board reflects the full UGL allocation surface.
 *
 * Per-row workflow:
 *   1. Read Cons_Data rows
 *   2. Rate Card lookup (SOR Code → friendly name + rate $ + UOM)
 *   3. Network Assets lookup (Asset ID → monday id) — bulk-creates
 *      Network Assets stubs for any extract assets not yet on monday
 *   4. Skip extract rows whose (Asset ID, SOR Code) already exists on
 *      SOR Lines (idempotent — safe to re-run)
 *   5. Bulk-create SOR Lines with all known columns populated, Asset
 *      relation linked, Rate Card relation linked, statuses written
 *      by label index
 *
 * NOT yet wired into the upload page handler — landed here so future
 * deploys can chain it. Wire-up is sub-step 6 follow-up.
 */
import ExcelJS from "exceljs";

// ---------- Config ----------
const SOR_BOARD = 5028087610;
const NETWORK_ASSETS_BOARD = 5028087505;
const RATE_CARD_BOARD = 5028088248;

const SOR_COL = {
  ASSET_TEXT: "text_mm2tawd5",
  ITEM_CODE: "text_mm2tbsvs",
  PROJECT_ID: "text_mm2tx2kk",
  ADA: "text_mm2th5a5",
  SAM: "text_mm2tjnzp",
  DESCRIPTION: "long_text_mm2tz7vp",
  UOM: "text_mm2thydc",
  DESIGN_QTY: "numeric_mm2teaw2",
  ACTUAL_QTY: "numeric_mm2tb16d",
  ACCEPTED_QTY: "numeric_mm2tc70m",
  RATE: "numeric_mm2tfdvn",
  CONS_STATUS: "color_mm30cvg5",
  UGL_STATUS: "color_mm2tavfn",
  INVOICE_ID: "text_mm2t3sb5",
  CONSTRUCTION_DATE: "date_mm30mc4k",
  REVIEW_DATE: "date_mm30n113",
  VA_COMMENTS: "long_text_mm304kjb",
  ASSET_RELATION: "board_relation_mm2tk7dv",
  RATE_CARD_RELATION: "board_relation_mm2tb3g8",
} as const;

const NETWORK_COL = {
  ASSET_CLASS: "color_mm2tk5ca",
  PROJECT_ID: "text_mm2tm60t",
  SAM: "text_mm2tcgm",
  ADA: "text_mm2thpn1",
} as const;

const RATE_CARD_COL = {
  SOR_CODE: "text_mm2t5h7w",
  RATE: "numeric_mm2tbzhd",
  UOM: "text_mm2t76yv",
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

const BATCH_SIZE = 25;

// ---------- Types ----------
interface ExtractRow {
  rowIndex: number;
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
  constructionDate: string | null;
  reviewDate: string | null;
  comments: string | null;
}

interface RateCardEntry {
  itemId: string;
  itemName: string;
  rate: number | null;
  uom: string | null;
}

interface PlannedSorLine {
  row: ExtractRow;
  itemName: string;
  rateCardEntry: RateCardEntry | null;
  skipReason: string | null;
  needsNetworkAsset: boolean;
  networkAssetId: string | null;
}

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

// ---------- Spreadsheet helpers ----------
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
    const t = v.trim().replace(/[$,\s]/g, "");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && "result" in v) {
    return cellNumber(v.result as ExcelJS.CellValue);
  }
  return null;
}
function cellDateIso(v: ExcelJS.CellValue): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const [, d, mo, y] = m;
      return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    return null;
  }
  if (typeof v === "object" && "result" in v) {
    return cellDateIso(v.result as ExcelJS.CellValue);
  }
  return null;
}

async function readExtract(source: string | Buffer): Promise<ExtractRow[]> {
  const wb = new ExcelJS.Workbook();
  if (typeof source === "string") {
    await wb.xlsx.readFile(source);
  } else {
    // ExcelJS's typings reject the generic Node Buffer<ArrayBufferLike>
    // shape — copy into a fresh ArrayBuffer to satisfy strict mode.
    const ab = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength
    ) as ArrayBuffer;
    await wb.xlsx.load(ab);
  }
  const ws = wb.getWorksheet("Cons_Data");
  if (!ws) throw new Error("Cons_Data sheet not found");

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
    if (!header[name]) throw new Error(`Missing column "${name}" in Cons_Data`);
  }

  const rows: ExtractRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (name: string) => row.getCell(header[name]).value;
    const assetId = cellText(get("Asset ID"));
    const sor = cellText(get("SOR"));
    if (!assetId || !sor) continue;
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

// ---------- Lookups ----------
async function fetchRateCard(): Promise<Map<string, RateCardEntry>> {
  const data = await monday<{
    boards: Array<{
      items_page: {
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
        items_page(limit: 500) {
          items {
            id name
            column_values(ids: $colIds) { id text }
          }
        }
      }
    }`,
    {
      boardId: String(RATE_CARD_BOARD),
      colIds: [RATE_CARD_COL.SOR_CODE, RATE_CARD_COL.RATE, RATE_CARD_COL.UOM],
    }
  );
  const map = new Map<string, RateCardEntry>();
  for (const item of data.boards?.[0]?.items_page?.items ?? []) {
    const cv: Record<string, string | null> = {};
    for (const c of item.column_values) cv[c.id] = c.text;
    const sorCode = cv[RATE_CARD_COL.SOR_CODE];
    if (!sorCode || !item.name) continue;
    const rateText = cv[RATE_CARD_COL.RATE];
    const rate = rateText ? Number(rateText) : null;
    map.set(sorCode.trim().toUpperCase(), {
      itemId: item.id,
      itemName: item.name.trim(),
      rate: rate != null && Number.isFinite(rate) ? rate : null,
      uom: cv[RATE_CARD_COL.UOM]?.trim() || null,
    });
  }
  return map;
}

async function fetchNetworkAssetMap(): Promise<Map<string, string>> {
  const data = await monday<{
    boards: Array<{
      items_page: { items: Array<{ id: string; name: string }> };
    }>;
  }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) { items { id name } }
      }
    }`,
    { boardId: String(NETWORK_ASSETS_BOARD) }
  );
  const map = new Map<string, string>();
  for (const item of data.boards?.[0]?.items_page?.items ?? []) {
    if (item.name) map.set(item.name.trim(), item.id);
  }
  return map;
}

async function fetchExistingSorLineKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | null = null;
  for (let pg = 1; pg <= 20; pg++) {
    const data = await monday<{
      boards?: Array<{
        items_page: {
          cursor: string | null;
          items: Array<{
            column_values: Array<{ id: string; text: string | null }>;
          }>;
        };
      }>;
      next_items_page?: {
        cursor: string | null;
        items: Array<{
          column_values: Array<{ id: string; text: string | null }>;
        }>;
      };
    }>(
      cursor
        ? `query ($cursor: String!, $colIds: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor
              items { column_values(ids: $colIds) { id text } }
            }
          }`
        : `query ($boardId: ID!, $colIds: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor
                items { column_values(ids: $colIds) { id text } }
              }
            }
          }`,
      cursor
        ? { cursor, colIds: [SOR_COL.ASSET_TEXT, SOR_COL.ITEM_CODE] }
        : {
            boardId: String(SOR_BOARD),
            colIds: [SOR_COL.ASSET_TEXT, SOR_COL.ITEM_CODE],
          }
    );
    type Page = {
      cursor: string | null;
      items: Array<{
        column_values: Array<{ id: string; text: string | null }>;
      }>;
    };
    const page: Page = cursor
      ? data.next_items_page!
      : data.boards![0]!.items_page;
    for (const item of page.items) {
      const cv: Record<string, string | null> = {};
      for (const c of item.column_values) cv[c.id] = c.text;
      const asset = cv[SOR_COL.ASSET_TEXT];
      const code = cv[SOR_COL.ITEM_CODE];
      if (asset && code) keys.add(joinKey(asset, code));
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return keys;
}

function joinKey(assetId: string, sor: string): string {
  return `${assetId.trim()} ${sor.trim().toUpperCase()}`;
}

function deriveAssetClass(assetId: string): string | null {
  const a = assetId.toUpperCase();
  if (a.includes("PIT")) return "PIT (Pit)";
  if (a.includes("DCT")) return "DCT (Duct)";
  if (a.includes("MH")) return "MH (Manhole)";
  if (/^0{5,}/.test(a)) return "Existing Infrastructure";
  return null;
}

function planSorLines(
  rows: ExtractRow[],
  rateCard: Map<string, RateCardEntry>,
  networkMap: Map<string, string>,
  existingKeys: Set<string>
): PlannedSorLine[] {
  const planned: PlannedSorLine[] = [];
  for (const row of rows) {
    const sorKey = row.sor.trim().toUpperCase();
    const key = joinKey(row.assetId, sorKey);
    const rcEntry = rateCard.get(sorKey) ?? null;
    const fallbackName = `${row.assetId} — ${row.sor.trim()}`;

    if (existingKeys.has(key)) {
      planned.push({
        row,
        itemName: rcEntry ? `${row.assetId} — ${rcEntry.itemName}` : fallbackName,
        rateCardEntry: rcEntry,
        skipReason: "exists",
        needsNetworkAsset: false,
        networkAssetId: networkMap.get(row.assetId) ?? null,
      });
      continue;
    }
    if (!rcEntry) {
      planned.push({
        row,
        itemName: fallbackName,
        rateCardEntry: null,
        skipReason: `no rate card for ${row.sor}`,
        needsNetworkAsset: false,
        networkAssetId: null,
      });
      continue;
    }
    const networkId = networkMap.get(row.assetId) ?? null;
    planned.push({
      row,
      itemName: `${row.assetId} — ${rcEntry.itemName}`,
      rateCardEntry: rcEntry,
      skipReason: null,
      needsNetworkAsset: networkId == null,
      networkAssetId: networkId,
    });
  }
  return planned;
}

// ---------- Public result type ----------
export interface BulkCreateResult {
  rowsProcessed: number;
  toCreate: number;
  createdNetworkAssets: number;
  createdSorLines: number;
  skippedExisting: number;
  skippedNoRate: number;
  failed: number;
  failures: string[];
  unknownStatuses: string[];
  unknownSorCodes: string[];
  elapsedMs: number;
}

export async function runBulkCreateSorLines(
  buffer: Buffer
): Promise<BulkCreateResult> {
  const start = Date.now();
  const rows = await readExtract(buffer);
  const rateCard = await fetchRateCard();
  const networkMap = await fetchNetworkAssetMap();
  const existingKeys = await fetchExistingSorLineKeys();

  const planned = planSorLines(rows, rateCard, networkMap, existingKeys);
  const skipExisting = planned.filter((p) => p.skipReason === "exists").length;
  const skipNoRate = planned.filter(
    (p) => p.skipReason && p.skipReason.startsWith("no rate")
  ).length;
  const toCreate = planned.filter((p) => !p.skipReason).length;
  const unknownSorCodes = Array.from(
    new Set(
      planned
        .filter((p) => p.skipReason && p.skipReason.startsWith("no rate"))
        .map((p) => p.row.sor.trim().toUpperCase())
    )
  );

  // Phase 1 — Network Assets bulk-create.
  const netToCreate = new Map<string, ExtractRow>();
  for (const p of planned) {
    if (p.skipReason === null && p.needsNetworkAsset) {
      if (!netToCreate.has(p.row.assetId)) netToCreate.set(p.row.assetId, p.row);
    }
  }
  const failures: string[] = [];
  const unknownStatuses = new Set<string>();
  let createdNetworkAssets = 0;
  let createdSorLines = 0;
  let failed = 0;

  const netList = Array.from(netToCreate.values());
  for (let i = 0; i < netList.length; i += BATCH_SIZE) {
    const batch = netList.slice(i, i + BATCH_SIZE);
    const aliases: string[] = [];
    const variables: Record<string, unknown> = {
      boardId: String(NETWORK_ASSETS_BOARD),
    };
    batch.forEach((row, j) => {
      const colVals: Record<string, unknown> = {};
      const cls = deriveAssetClass(row.assetId);
      if (cls) colVals[NETWORK_COL.ASSET_CLASS] = { label: cls };
      if (row.projectId) colVals[NETWORK_COL.PROJECT_ID] = row.projectId;
      if (row.ada) {
        colVals[NETWORK_COL.SAM] = row.ada;
        colVals[NETWORK_COL.ADA] = row.ada;
      }
      aliases.push(
        `n${j}: create_item(
          board_id: $boardId,
          item_name: $name${j},
          column_values: $cv${j},
          create_labels_if_missing: false
        ) { id name }`
      );
      variables[`name${j}`] = row.assetId;
      variables[`cv${j}`] = JSON.stringify(colVals);
    });
    const argsList = batch
      .map((_, j) => `$name${j}: String!, $cv${j}: JSON!`)
      .join(", ");
    const query = `mutation ($boardId: ID!, ${argsList}) { ${aliases.join("\n")} }`;
    try {
      const data = await monday<Record<string, { id: string; name: string }>>(
        query,
        variables
      );
      batch.forEach((row, j) => {
        const newId = data[`n${j}`]?.id;
        if (newId) {
          createdNetworkAssets++;
          for (const p of planned) {
            if (
              p.skipReason === null &&
              p.row.assetId === row.assetId &&
              p.networkAssetId == null
            ) {
              p.networkAssetId = newId;
            }
          }
        }
      });
    } catch (err) {
      failed += batch.length;
      failures.push(
        `network-asset batch ${i}: ${(err instanceof Error ? err.message : String(err)).slice(0, 250)}`
      );
    }
  }

  // Phase 2 — SOR Lines bulk-create.
  const toCreateList = planned.filter((p) => p.skipReason === null);
  for (let i = 0; i < toCreateList.length; i += BATCH_SIZE) {
    const batch = toCreateList.slice(i, i + BATCH_SIZE);
    const aliases: string[] = [];
    const variables: Record<string, unknown> = { boardId: String(SOR_BOARD) };
    batch.forEach((p, j) => {
      const r = p.row;
      const rc = p.rateCardEntry!;
      const colVals: Record<string, unknown> = {
        [SOR_COL.ASSET_TEXT]: r.assetId,
        [SOR_COL.ITEM_CODE]: r.sor.trim().toUpperCase(),
      };
      if (r.projectId) colVals[SOR_COL.PROJECT_ID] = r.projectId;
      if (r.ada) {
        colVals[SOR_COL.ADA] = r.ada;
        colVals[SOR_COL.SAM] = r.ada;
      }
      if (r.sorDescription) colVals[SOR_COL.DESCRIPTION] = r.sorDescription;
      if (rc.uom) colVals[SOR_COL.UOM] = rc.uom;
      if (r.designQty != null) colVals[SOR_COL.DESIGN_QTY] = String(r.designQty);
      if (r.actualQty != null) colVals[SOR_COL.ACTUAL_QTY] = String(r.actualQty);
      if (r.acceptedQty != null)
        colVals[SOR_COL.ACCEPTED_QTY] = String(r.acceptedQty);
      if (rc.rate != null) colVals[SOR_COL.RATE] = String(rc.rate);

      if (r.consStatus) {
        const idx = CONS_STATUS_INDEX[r.consStatus];
        if (idx != null) colVals[SOR_COL.CONS_STATUS] = { index: idx };
        else unknownStatuses.add(`Cons:${r.consStatus}`);
      }
      if (r.sorStatus) {
        const idx = UGL_STATUS_INDEX[r.sorStatus];
        if (idx != null) colVals[SOR_COL.UGL_STATUS] = { index: idx };
        else unknownStatuses.add(`UGL:${r.sorStatus}`);
      }

      if (r.invoiceNo) colVals[SOR_COL.INVOICE_ID] = r.invoiceNo;
      if (r.constructionDate)
        colVals[SOR_COL.CONSTRUCTION_DATE] = { date: r.constructionDate };
      if (r.reviewDate) colVals[SOR_COL.REVIEW_DATE] = { date: r.reviewDate };
      if (r.comments) colVals[SOR_COL.VA_COMMENTS] = r.comments;

      if (p.networkAssetId) {
        colVals[SOR_COL.ASSET_RELATION] = {
          item_ids: [parseInt(p.networkAssetId, 10)],
        };
      }
      if (rc.itemId) {
        colVals[SOR_COL.RATE_CARD_RELATION] = {
          item_ids: [parseInt(rc.itemId, 10)],
        };
      }

      aliases.push(
        `s${j}: create_item(
          board_id: $boardId,
          item_name: $name${j},
          column_values: $cv${j},
          create_labels_if_missing: false
        ) { id }`
      );
      variables[`name${j}`] = p.itemName;
      variables[`cv${j}`] = JSON.stringify(colVals);
    });
    const argsList = batch
      .map((_, j) => `$name${j}: String!, $cv${j}: JSON!`)
      .join(", ");
    const query = `mutation ($boardId: ID!, ${argsList}) { ${aliases.join("\n")} }`;
    try {
      await monday(query, variables);
      createdSorLines += batch.length;
    } catch (err) {
      failed += batch.length;
      failures.push(
        `sor-line batch ${i}: ${(err instanceof Error ? err.message : String(err)).slice(0, 250)}`
      );
    }
  }

  return {
    rowsProcessed: rows.length,
    toCreate,
    createdNetworkAssets,
    createdSorLines,
    skippedExisting: skipExisting,
    skippedNoRate: skipNoRate,
    failed,
    failures,
    unknownStatuses: Array.from(unknownStatuses),
    unknownSorCodes,
    elapsedMs: Date.now() - start,
  };
}
