#!/usr/bin/env tsx
/**
 * Bulk-import 542 work orders from UGL's daily SOR Extract into monday's
 * Active Jobs (5028084872) and Approved & Paid Jobs (5028088229) boards
 * — the one-shot data import that completes Step 2 of the work order
 * setup. Run AFTER Step 1's schema PR (#30) has merged and Netlify has
 * deployed.
 *
 * Per-Asset workflow:
 *   1. Group all SOR Extract rows by Asset ID (one job per asset)
 *   2. Look up rate-card item names + descriptions per SOR code
 *   3. Compute the asset's "aggregated" UGL Payment Status (most-advanced
 *      across its SORs — Paid > Approved > etc., per Step 2 brief)
 *   4. Route to Active Jobs or Approved & Paid based on that status:
 *        Active Jobs:  Pending Construction, Pending Artefacts, In Review,
 *                      Disputed, Overpaid, Paid - Pending RCTI, Partial Paid
 *        Approved:     Approved, Paid, Descoped
 *   5. Build the canonical name via buildJobName() (Step 1.6)
 *   6. For Pending Construction only — create a bare Network Assets row
 *      and link Primary Asset
 *   7. Stage the create; batched-alias mutations apply ~25 per request
 *
 * Idempotent: pre-fetches both target boards and skips Asset IDs already
 * present (compares against the Asset ID text column).
 *
 * Usage:
 *   tsx scripts/import_work_orders.ts <path/to/extract.xlsx> [--dry-run]
 *   npm run import-jobs      <file>
 *   npm run import-jobs-dry  <file>
 */
import ExcelJS from "exceljs";
import { buildJobName } from "./build_job_name";

// ---------- Config ----------
const ACTIVE_JOBS_BOARD = 5028084872;
const APPROVED_JOBS_BOARD = 5028088229;
const NETWORK_ASSETS_BOARD = 5028087505;
const RATE_CARD_BOARD = 5028088248;

// Active Jobs columns (from src/lib/monday-ids.ts)
const ACTIVE_COL = {
  ASSET_TEXT: "text_mm2tmm57",
  SAM_ADA: "text_mm2tw65k",
  RCTI: "text_mm2tdrdk",
  JOB_STATUS: "color_mm2tff18",
  UGL_PAYMENT_STATUS: "color_mm32x3ga",
  PRIMARY_ASSET: "board_relation_mm2tyedq",
  JOB_START_DATE: "date_mm2t1bck",
  DATE_SUBMITTED: "date_mm2tm5wk",
  DATE_APPROVED: "date_mm2twe5z",
  DATE_PAID: "date_mm2tz2vv",
  QUICK_NOTE: "long_text_mm2t73fd",
};

// Approved & Paid Jobs columns (from src/lib/monday-ids.ts APPROVED_JOB_COLUMNS)
const APPROVED_COL = {
  ASSET_TEXT: "text_mm325kny",
  SAM_ADA: "text_mm32z5ej",
  RCTI: "text_mm32c4fj",
  JOB_STATUS: "color_mm329x8a",
  UGL_PAYMENT_STATUS: "color_mm322s90",
  PRIMARY_ASSET: "board_relation_mm32kh12",
  JOB_START_DATE: "date_mm32d4s9",
  DATE_SUBMITTED: "date_mm32cc9k",
  DATE_APPROVED: "date_mm32p2b7",
  DATE_PAID: "date_mm32cjpd",
  QUICK_NOTE: "long_text_mm3277sp",
};

// Network Assets columns
const NETWORK_COL = {
  ASSET_CLASS: "color_mm2tk5ca",
  PROJECT_ID: "text_mm2tm60t",
  SAM: "text_mm2tcgm",
  ADA: "text_mm2thpn1",
};

// Rate Card columns
const RATE_CARD_COL = {
  SOR_CODE: "text_mm2t5h7w",
  NAME: "name", // Rate Card row name = friendly Item Name
};

const BATCH_SIZE = 25;

/**
 * Status priority — most-advanced first. When an Asset has SORs in
 * different statuses, the asset's aggregated status is the LOWEST index
 * (most advanced) found among its SORs.
 *
 * Per the Step 2 brief: "Paid > Approved > Pending RCTI > etc."
 */
const STATUS_PRIORITY = [
  "Paid", // 0 — terminal, money in
  "Paid - Pending RCTI", // 1 — paid, RCTI not yet
  "Partial Paid", // 2 — some money in
  "Approved", // 3 — UGL approved, awaiting payment
  "In Review", // 4 — UGL reviewing
  "Pending Artefacts", // 5 — waiting on our photos
  "Pending Construction", // 6 — work not started
  "Overpaid", // 7 — anomaly: paid more than agreed
  "Disputed", // 8 — anomaly: rejected
  "Descoped", // 9 — terminal: cancelled
];

const TERMINAL_STATUSES = new Set(["Approved", "Paid", "Descoped"]);

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
  constructionDate: string | null; // ISO YYYY-MM-DD
  reviewDate: string | null;
  comments: string | null;
}

interface AssetGroup {
  assetId: string;
  rows: ExtractRow[];
  /** All SOR codes for this asset, deduped, in extract order */
  sorCodes: string[];
  /** Item names from rate card, in same order as sorCodes (filtered to non-empty) */
  itemNames: string[];
  /** Aggregated UGL Payment Status — most advanced across all SORs */
  aggregatedStatus: string;
  /** Most recent ISO date across SORs, or null */
  latestConstructionDate: string | null;
  latestReviewDate: string | null;
  /** First non-null invoice number we encounter */
  rctiNumber: string | null;
  /** Concatenated comments, deduped */
  comments: string;
  /** First non-null Project ID / SAM / ADA from rows */
  projectId: string | null;
  ada: string | null;
}

interface PlannedItem {
  asset: AssetGroup;
  /** Which board the row goes on */
  targetBoard: typeof ACTIVE_JOBS_BOARD | typeof APPROVED_JOBS_BOARD;
  /** "active" or "approved" — for log readability */
  targetName: "active" | "approved";
  /** Computed item name */
  name: string;
  /** Skip reason, when set the item is NOT applied */
  skipReason: string | null;
  /** When set, an existing Network Assets monday id we'll link via Primary Asset.
   *  null = no Network Assets link (archive imports + non-Pending-Construction
   *  Active Jobs rows). string = link this item id. */
  networkAssetId: string | null;
  /** When true, also create a new Network Assets row before the job row.
   *  Set only for Pending Construction assets that don't already exist on
   *  Network Assets. */
  needsNetworkAsset: boolean;
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

// ---------- Spreadsheet parser (mirrors sync_sor_extract.ts) ----------
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

/**
 * Header alias map — supports both the daily SOR Extract (sheet "Cons_Data",
 * Title Case headers) and work-allocation files like K-2CSN-21 (sheet "Sheet1",
 * snake_case headers). Required: only assetId + sor.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  assetId: ["Asset ID", "id"],
  sor: ["SOR", "item_code"],
  sorDescription: ["SOR Description", "description"],
  projectId: ["Project ID", "project_id"],
  ada: ["ADA", "ada"],
  designQty: ["Design Qty", "design_qty"],
  actualQty: ["Actual Qty", "actual_qty"],
  acceptedQty: ["accepted_qty", "Accepted Qty"],
  consStatus: ["Cons Status"],
  sorStatus: ["SOR Status", "ugl_sor_status"],
  invoiceNo: ["Invoice #", "invoice_id"],
  constructionDate: ["construction_date", "Construction Date", "build_date_sor"],
  reviewDate: ["review_date", "Review Date"],
  comments: ["comments", "Comments", "VA Comments"],
};

const REQUIRED_FIELDS = ["assetId", "sor"] as const;

interface ReadOptions {
  /** Override sheet name. If unset, tries "Cons_Data" then "Sheet1". */
  sheet?: string;
}

async function readExtract(
  source: string | Buffer,
  opts: ReadOptions = {}
): Promise<ExtractRow[]> {
  const wb = new ExcelJS.Workbook();
  if (typeof source === "string") {
    await wb.xlsx.readFile(source);
  } else {
    const ab = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength
    ) as ArrayBuffer;
    await wb.xlsx.load(ab);
  }

  let ws: ExcelJS.Worksheet | undefined;
  if (opts.sheet) {
    ws = wb.getWorksheet(opts.sheet);
    if (!ws) throw new Error(`Sheet "${opts.sheet}" not found`);
  } else {
    ws = wb.getWorksheet("Cons_Data") ?? wb.getWorksheet("Sheet1");
    if (!ws) {
      throw new Error(
        `No "Cons_Data" or "Sheet1" sheet found — pass sheet override`
      );
    }
  }

  const header: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, col) => {
    const t = cellText(cell.value);
    if (t) header[t] = col;
  });

  const colByField: Record<string, number | null> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    let col: number | null = null;
    for (const alias of aliases) {
      if (header[alias]) {
        col = header[alias];
        break;
      }
    }
    colByField[field] = col;
  }

  for (const field of REQUIRED_FIELDS) {
    if (colByField[field] == null) {
      const aliases = HEADER_ALIASES[field].join(" / ");
      throw new Error(
        `No column found for "${field}" — accepted aliases: ${aliases}. Sheet "${ws.name}" headers: ${Object.keys(header).slice(0, 25).join(", ")}${Object.keys(header).length > 25 ? ", ..." : ""}`
      );
    }
  }

  const rows: ExtractRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const getCell = (field: string) => {
      const col = colByField[field];
      return col == null ? null : row.getCell(col).value;
    };
    const assetId = cellText(getCell("assetId"));
    const sor = cellText(getCell("sor"));
    if (!assetId || !sor) continue;
    rows.push({
      rowIndex: r,
      projectId: cellText(getCell("projectId")),
      ada: cellText(getCell("ada")),
      assetId,
      sor,
      sorDescription: cellText(getCell("sorDescription")),
      designQty: cellNumber(getCell("designQty")),
      actualQty: cellNumber(getCell("actualQty")),
      acceptedQty: cellNumber(getCell("acceptedQty")),
      consStatus: cellText(getCell("consStatus")),
      sorStatus: cellText(getCell("sorStatus")),
      invoiceNo: cellText(getCell("invoiceNo")),
      constructionDate: cellDateIso(getCell("constructionDate")),
      reviewDate: cellDateIso(getCell("reviewDate")),
      comments: cellText(getCell("comments")),
    });
  }
  return rows;
}

// ---------- Rate Card lookup ----------
async function fetchRateCard(): Promise<Map<string, string>> {
  // SOR Code -> Item Name
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
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) {
          items {
            id name
            column_values(ids: ["${RATE_CARD_COL.SOR_CODE}"]) { id text }
          }
        }
      }
    }`,
    { boardId: String(RATE_CARD_BOARD) }
  );
  const map = new Map<string, string>();
  for (const item of data.boards?.[0]?.items_page?.items ?? []) {
    const sorCode = item.column_values.find((c) => c.id === RATE_CARD_COL.SOR_CODE)
      ?.text;
    if (sorCode && item.name) {
      map.set(sorCode.trim().toUpperCase(), item.name.trim());
    }
  }
  return map;
}

// ---------- Existing Asset IDs on target boards (for idempotency) ----------
async function fetchExistingAssetIds(
  boardId: number,
  assetIdColId: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let pg = 1; pg <= 10; pg++) {
    const data = await monday<{
      boards?: Array<{ items_page: { cursor: string | null; items: Array<{ column_values: Array<{ text: string | null }> }> } }>;
      next_items_page?: { cursor: string | null; items: Array<{ column_values: Array<{ text: string | null }> }> };
    }>(
      cursor
        ? `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items { column_values(ids: $col) { text } }
            }
          }`
        : `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items { column_values(ids: $col) { text } }
              }
            }
          }`,
      cursor ? { cursor, col: [assetIdColId] } : { boardId: String(boardId), col: [assetIdColId] }
    );
    type Page = { cursor: string | null; items: Array<{ column_values: Array<{ text: string | null }> }> };
    const page: Page = cursor ? data.next_items_page! : data.boards![0]!.items_page;
    for (const item of page.items) {
      const t = item.column_values[0]?.text;
      if (t) ids.add(t.trim());
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return ids;
}

async function fetchNetworkAssetMap(): Promise<Map<string, string>> {
  // Asset ID (row name) -> monday item id. PAGINATES — Network Assets has
  // 683 rows on 7 May after bulk_create_sor_lines ran; the previous
  // single-page-of-500 fetch missed 183 rows and would have caused
  // duplicate creates.
  const map = new Map<string, string>();
  let cursor: string | null = null;
  for (let pg = 1; pg <= 20; pg++) {
    const data = await monday<{
      boards?: Array<{
        items_page: {
          cursor: string | null;
          items: Array<{ id: string; name: string }>;
        };
      }>;
      next_items_page?: {
        cursor: string | null;
        items: Array<{ id: string; name: string }>;
      };
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
    type Page = {
      cursor: string | null;
      items: Array<{ id: string; name: string }>;
    };
    const page: Page = cursor
      ? data.next_items_page!
      : data.boards![0]!.items_page;
    for (const item of page.items) {
      if (item.name) map.set(item.name.trim(), item.id);
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return map;
}

// ---------- Aggregation per Asset ----------
function priorityOf(status: string | null): number {
  if (!status) return 999;
  const idx = STATUS_PRIORITY.indexOf(status);
  return idx === -1 ? 999 : idx;
}

function deriveAssetClass(assetId: string): string | null {
  // Asset names like 2CSN-21-07-DCT-652 / 2MAC-22-06-PIT-708 / 2URL-20-06-MH-...
  // Numeric-only ids (000000003200512558) we leave class null — those are
  // legacy infrastructure and Heath's normal import sets the class.
  // Label names match the live Network Assets `Asset Class` column —
  // they're "DCT (Duct)" / "PIT (Pit)" / "MH (Manhole)" verbatim, not
  // the bare class abbreviations. The first-pass import attempted to
  // write the bare strings and monday rejected every Network Assets
  // create with "This status label doesn't exist".
  const m = assetId.match(/-(DCT|PIT|MH)-/i);
  if (m) {
    const t = m[1].toUpperCase();
    if (t === "DCT") return "DCT (Duct)";
    if (t === "PIT") return "PIT (Pit)";
    if (t === "MH") return "MH (Manhole)";
  }
  return null;
}

function aggregateAsset(
  assetId: string,
  rows: ExtractRow[],
  rateCard: Map<string, string>
): AssetGroup {
  const sorCodes: string[] = [];
  const seenSor = new Set<string>();
  const itemNames: string[] = [];
  const seenName = new Set<string>();
  const commentParts: string[] = [];
  let aggStatus = "";
  let aggIdx = 999;
  let latestConstr: string | null = null;
  let latestReview: string | null = null;
  let rctiNumber: string | null = null;
  let projectId: string | null = null;
  let ada: string | null = null;

  for (const r of rows) {
    if (!seenSor.has(r.sor)) {
      seenSor.add(r.sor);
      sorCodes.push(r.sor);
      const name = rateCard.get(r.sor.trim().toUpperCase());
      if (name && !seenName.has(name)) {
        seenName.add(name);
        itemNames.push(name);
      }
    }
    const idx = priorityOf(r.sorStatus);
    if (idx < aggIdx) {
      aggIdx = idx;
      aggStatus = r.sorStatus ?? "";
    }
    if (r.constructionDate && (!latestConstr || r.constructionDate > latestConstr)) {
      latestConstr = r.constructionDate;
    }
    if (r.reviewDate && (!latestReview || r.reviewDate > latestReview)) {
      latestReview = r.reviewDate;
    }
    if (!rctiNumber && r.invoiceNo) rctiNumber = r.invoiceNo;
    if (!projectId && r.projectId) projectId = r.projectId;
    if (!ada && r.ada) ada = r.ada;
    if (r.comments && r.comments.trim()) {
      const tagged = `[${r.sor}] ${r.comments.trim()}`;
      if (!commentParts.includes(tagged)) commentParts.push(tagged);
    }
  }

  // Empty SOR Status → fall back to "Pending Construction" (a valid label on
  // both UGL Payment Status columns). Previously fell back to "Pending" which
  // monday's create_item silently rejects, dropping rows on the floor. This is
  // why ~103 of 113 K-2CSN-21 Casino assets ended up missing from both job
  // boards after the 27 Apr import — see fix/import-jobs-pending-construction-default.
  if (!aggStatus) aggStatus = "Pending Construction";

  return {
    assetId,
    rows,
    sorCodes,
    itemNames,
    aggregatedStatus: aggStatus,
    latestConstructionDate: latestConstr,
    latestReviewDate: latestReview,
    rctiNumber,
    comments: commentParts.join("\n\n"),
    projectId,
    ada,
  };
}

// ---------- Routing & planning ----------
function routeAsset(asset: AssetGroup): "active" | "approved" {
  return TERMINAL_STATUSES.has(asset.aggregatedStatus) ? "approved" : "active";
}

function planAssets(
  groups: AssetGroup[],
  existingActive: Set<string>,
  existingApproved: Set<string>,
  networkAssetMap: Map<string, string>
): PlannedItem[] {
  const planned: PlannedItem[] = [];
  for (const a of groups) {
    const target = routeAsset(a);
    const targetBoard = target === "active" ? ACTIVE_JOBS_BOARD : APPROVED_JOBS_BOARD;
    const existingSet = target === "active" ? existingActive : existingApproved;

    const networkAssetId = networkAssetMap.get(a.assetId) ?? null;
    const isPendingCons = a.aggregatedStatus === "Pending Construction";
    const needsNetworkAsset = isPendingCons && !networkAssetId;

    const name = buildJobName(a.itemNames, a.assetId, null);

    let skipReason: string | null = null;
    if (existingSet.has(a.assetId)) {
      skipReason = `already on ${target} board`;
    }

    planned.push({
      asset: a,
      targetBoard,
      targetName: target,
      name,
      skipReason,
      networkAssetId,
      needsNetworkAsset,
    });
  }
  return planned;
}

// ---------- Apply (batched) ----------
interface ApplyResult {
  createdNetworkAssets: number;
  createdActive: number;
  createdApproved: number;
  failed: number;
  failures: string[];
}

async function applyPlan(
  planned: PlannedItem[],
  dryRun: boolean
): Promise<ApplyResult> {
  const result: ApplyResult = {
    createdNetworkAssets: 0,
    createdActive: 0,
    createdApproved: 0,
    failed: 0,
    failures: [],
  };
  const toCreate = planned.filter((p) => !p.skipReason);

  if (dryRun) {
    result.createdNetworkAssets = toCreate.filter((p) => p.needsNetworkAsset).length;
    result.createdActive = toCreate.filter((p) => p.targetName === "active").length;
    result.createdApproved = toCreate.filter((p) => p.targetName === "approved").length;
    return result;
  }

  // Phase 1 — create Network Assets rows for Pending Construction items
  // that don't have one. Need to capture the new monday IDs so we can
  // link Primary Asset on the Active Jobs row in Phase 2.
  const needsNetwork = toCreate.filter((p) => p.needsNetworkAsset);
  for (let i = 0; i < needsNetwork.length; i += BATCH_SIZE) {
    const batch = needsNetwork.slice(i, i + BATCH_SIZE);
    const aliases: string[] = [];
    const variables: Record<string, unknown> = {
      boardId: String(NETWORK_ASSETS_BOARD),
    };
    batch.forEach((p, j) => {
      const colVals: Record<string, unknown> = {};
      const cls = deriveAssetClass(p.asset.assetId);
      if (cls) colVals[NETWORK_COL.ASSET_CLASS] = { label: cls };
      if (p.asset.projectId) colVals[NETWORK_COL.PROJECT_ID] = p.asset.projectId;
      if (p.asset.ada) {
        colVals[NETWORK_COL.SAM] = p.asset.ada; // SAM mirrors ADA when no separate SAM
        colVals[NETWORK_COL.ADA] = p.asset.ada;
      }
      aliases.push(
        `n${j}: create_item(
          board_id: $boardId,
          item_name: $name${j},
          column_values: $cv${j},
          create_labels_if_missing: false
        ) { id }`
      );
      variables[`name${j}`] = p.asset.assetId;
      variables[`cv${j}`] = JSON.stringify(colVals);
    });
    const argsList = batch
      .map((_, j) => `$name${j}: String!, $cv${j}: JSON!`)
      .join(", ");
    const query = `mutation ($boardId: ID!, ${argsList}) { ${aliases.join("\n")} }`;
    try {
      const data = await monday<Record<string, { id: string }>>(query, variables);
      batch.forEach((p, j) => {
        const newId = data[`n${j}`]?.id;
        if (newId) {
          p.networkAssetId = newId;
          result.createdNetworkAssets++;
        }
      });
    } catch (err) {
      result.failed += batch.length;
      result.failures.push(
        `network-asset batch ${i}: ${(err instanceof Error ? err.message : String(err)).slice(0, 250)}`
      );
    }
  }

  // Phase 2 — create job rows on the appropriate target board.
  // We use change_simple_column_value-style JSON for status by name and
  // dates. Primary Asset relation only set when networkAssetId is known.
  for (const target of ["active", "approved"] as const) {
    const items = toCreate.filter((p) => p.targetName === target);
    const boardId = target === "active" ? ACTIVE_JOBS_BOARD : APPROVED_JOBS_BOARD;
    const COL = target === "active" ? ACTIVE_COL : APPROVED_COL;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const aliases: string[] = [];
      const variables: Record<string, unknown> = { boardId: String(boardId) };
      batch.forEach((p, j) => {
        const a = p.asset;
        const colVals: Record<string, unknown> = {
          [COL.ASSET_TEXT]: a.assetId,
          [COL.UGL_PAYMENT_STATUS]: { label: a.aggregatedStatus },
        };
        // Default Job Status. Active Jobs → "Imported / New" (the existing
        // default). Approved & Paid → mirror aggregated status when it matches
        // a Job Status label there ("Approved" / "Paid"), else "Imported / New".
        if (target === "active") {
          colVals[COL.JOB_STATUS] = { label: "Imported / New" };
        } else if (a.aggregatedStatus === "Approved" || a.aggregatedStatus === "Paid") {
          colVals[COL.JOB_STATUS] = { label: a.aggregatedStatus };
        } else {
          colVals[COL.JOB_STATUS] = { label: "Imported / New" };
        }
        if (a.ada) colVals[COL.SAM_ADA] = a.ada;
        if (a.rctiNumber) colVals[COL.RCTI] = a.rctiNumber;
        if (a.latestConstructionDate) {
          colVals[COL.JOB_START_DATE] = { date: a.latestConstructionDate };
        }
        if (a.latestReviewDate) {
          colVals[COL.DATE_SUBMITTED] = { date: a.latestReviewDate };
          // Approved/Paid both populate Date Approved at review_date.
          // Date Paid only when status is Paid (and we have a date — the
          // extract doesn't include a separate paid_date, so review_date
          // is the closest signal).
          if (
            a.aggregatedStatus === "Approved" ||
            a.aggregatedStatus === "Paid"
          ) {
            colVals[COL.DATE_APPROVED] = { date: a.latestReviewDate };
          }
          if (a.aggregatedStatus === "Paid") {
            colVals[COL.DATE_PAID] = { date: a.latestReviewDate };
          }
        }
        if (a.comments) colVals[COL.QUICK_NOTE] = a.comments;
        if (target === "active" && p.networkAssetId) {
          colVals[COL.PRIMARY_ASSET] = {
            item_ids: [parseInt(p.networkAssetId, 10)],
          };
        }
        aliases.push(
          `j${j}: create_item(
            board_id: $boardId,
            item_name: $name${j},
            column_values: $cv${j},
            create_labels_if_missing: false
          ) { id }`
        );
        variables[`name${j}`] = p.name;
        variables[`cv${j}`] = JSON.stringify(colVals);
      });
      const argsList = batch
        .map((_, j) => `$name${j}: String!, $cv${j}: JSON!`)
        .join(", ");
      const query = `mutation ($boardId: ID!, ${argsList}) { ${aliases.join("\n")} }`;
      try {
        await monday(query, variables);
        if (target === "active") result.createdActive += batch.length;
        else result.createdApproved += batch.length;
      } catch (err) {
        result.failed += batch.length;
        result.failures.push(
          `${target}-job batch ${i}: ${(err instanceof Error ? err.message : String(err)).slice(0, 250)}`
        );
      }
    }
  }
  return result;
}

// ---------- Library entry point ----------
export interface ImportResult {
  uniqueAssets: number;
  networkAssetsCreated: number;
  createdActive: number;
  createdApproved: number;
  skipped: number;
  failed: number;
  failures: string[];
  /** Status -> { active, approved, skip } breakdown for the response card */
  byStatus: Record<string, { active: number; approved: number; skip: number }>;
  elapsedMs: number;
}

/**
 * Import a SOR Extract `.xlsx` (loaded into memory as a Buffer) onto
 * the Active Jobs / Approved & Paid Jobs boards plus Network Assets.
 * Returns a structured summary the serverless handler serialises to
 * JSON for the browser. No console output.
 */
export interface RunImportOptions {
  /** Override sheet name. Defaults: "Cons_Data" then "Sheet1". */
  sheet?: string;
}

export async function runImportWorkOrders(
  buffer: Buffer,
  opts: RunImportOptions = {}
): Promise<ImportResult> {
  const start = Date.now();
  const extract = await readExtract(buffer, { sheet: opts.sheet });
  const rateCard = await fetchRateCard();
  const [existingActive, existingApproved, networkAssets] = await Promise.all([
    fetchExistingAssetIds(ACTIVE_JOBS_BOARD, ACTIVE_COL.ASSET_TEXT),
    fetchExistingAssetIds(APPROVED_JOBS_BOARD, APPROVED_COL.ASSET_TEXT),
    fetchNetworkAssetMap(),
  ]);

  const byAsset = new Map<string, ExtractRow[]>();
  for (const r of extract) {
    const list = byAsset.get(r.assetId);
    if (list) list.push(r);
    else byAsset.set(r.assetId, [r]);
  }
  const groups = Array.from(byAsset.entries()).map(([id, rows]) =>
    aggregateAsset(id, rows, rateCard)
  );
  const planned = planAssets(
    groups,
    existingActive,
    existingApproved,
    networkAssets
  );

  const byStatus: Record<string, { active: number; approved: number; skip: number }> = {};
  for (const p of planned) {
    const k = p.asset.aggregatedStatus;
    const cur = byStatus[k] ?? { active: 0, approved: 0, skip: 0 };
    if (p.skipReason) cur.skip++;
    else if (p.targetName === "active") cur.active++;
    else cur.approved++;
    byStatus[k] = cur;
  }

  const skipped = planned.filter((p) => p.skipReason);
  const result = await applyPlan(planned, false);

  return {
    uniqueAssets: groups.length,
    networkAssetsCreated: result.createdNetworkAssets,
    createdActive: result.createdActive,
    createdApproved: result.createdApproved,
    skipped: skipped.length,
    failed: result.failed,
    failures: result.failures,
    byStatus,
    elapsedMs: Date.now() - start,
  };
}
