/**
 * scripts/find_duplicates.ts — one-shot dupe-finder for the 4 SOR job boards.
 *
 * Walks each job board, groups items by their Asset ID column value, and
 * emits dupe-report.json with every asset-id group whose count > 1.
 *
 * Background — why we need this:
 *
 * Pre-PR #11 (merged 8 May 2026 19:59 AEST), runImportWorkOrders's dedup
 * step only checked Active + Approved boards. An asset that had been
 * moved to Submitted by Track B's automation but then flipped to
 * Approved/Paid in the next SOR Extract would route to "approved", miss
 * dedup, and create a fresh row on Approved & Paid alongside the
 * existing Submitted row. That bug ran every sync from board creation
 * until PR #11.
 *
 * Pre-PR #14 (merged 9 May 2026), Job Complete wasn't in the dedup walk
 * either — same class of bug, smaller blast radius.
 *
 * The CURRENT dedup logic (post-#11 + #14) checks all 4 boards. But the
 * worker that calls runImportWorkOrders was broken by the Track G2
 * void-runPipeline orphan from 8 May until G3 (#15/#16/#17) fixed it on
 * 11 May. So between 8 May and 11 May NO sync runs actually completed —
 * any dupes accumulated before then are still there.
 *
 * Usage:
 *   MONDAY_API_TOKEN=xxx npx tsx scripts/find_duplicates.ts
 *
 * Output:
 *   ./dupe-report.json (written to current working directory)
 *
 * Does NOT delete or archive anything — that decision needs the report
 * first.
 */

const BOARDS = {
  active: { id: 5028084872, assetCol: "text_mm2tmm57",
            rctiCol: "text_mm2tdrdk", statusCol: "color_mm32x3ga" },
  jobComplete: { id: 5028375392, assetCol: "text_mm2tmm57",
                 rctiCol: "text_mm2tdrdk", statusCol: "color_mm32x3ga" },
  submitted: { id: 5028331769, assetCol: "text_mm2tmm57",
               rctiCol: "text_mm2tdrdk", statusCol: "color_mm32x3ga" },
  approved: { id: 5028088229, assetCol: "text_mm325kny",
              rctiCol: "text_mm32c4fj", statusCol: "color_mm322s90" },
} as const;

type BoardKey = keyof typeof BOARDS;

interface RawItem {
  id: string;
  name: string;
  created_at: string;
  column_values: Array<{ id: string; text: string | null }>;
}

interface RawPage {
  cursor: string | null;
  items: RawItem[];
}

interface MondayQueryResponse<T> {
  data?: T;
  errors?: unknown;
}

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
  if (!res.ok) {
    throw new Error(`monday HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as MondayQueryResponse<T>;
  if (json.errors) {
    throw new Error(`monday errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

/** Paginated walk over a board pulling id + name + created_at + the 3
 *  diagnostic columns. Identical pagination pattern to
 *  fetchExistingAssetIds in import_work_orders.ts so we exercise the
 *  same code path that the production dedup uses. */
async function fetchAllItems(
  boardId: number,
  colIds: string[]
): Promise<RawItem[]> {
  const all: RawItem[] = [];
  let cursor: string | null = null;
  for (let pg = 1; pg <= 20; pg++) {
    interface FirstPageResp {
      boards?: Array<{ items_page: RawPage }>;
    }
    interface NextPageResp {
      next_items_page?: RawPage;
    }
    const data: FirstPageResp & NextPageResp = cursor
      ? await monday<NextPageResp>(
          `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor
              items {
                id name created_at
                column_values(ids: $col) { id text }
              }
            }
          }`,
          { cursor, col: colIds }
        )
      : await monday<FirstPageResp>(
          `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor
                items {
                  id name created_at
                  column_values(ids: $col) { id text }
                }
              }
            }
          }`,
          { boardId: String(boardId), col: colIds }
        );

    const page: RawPage = cursor
      ? (data as NextPageResp).next_items_page!
      : (data as FirstPageResp).boards![0]!.items_page;

    all.push(...page.items);
    console.log(
      `  page ${pg} of board ${boardId}: +${page.items.length} (cumulative ${all.length})`
    );
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return all;
}

interface ItemSummary {
  itemId: string;
  itemName: string;
  createdAt: string;
  assetId: string | null;
  rctiNumber: string | null;
  uglPaymentStatus: string | null;
}

interface DupeGroup {
  assetId: string;
  count: number;
  items: ItemSummary[];
}

interface BoardReport {
  boardKey: BoardKey;
  boardId: number;
  totalItems: number;
  itemsWithAssetId: number;
  itemsWithoutAssetId: number;
  uniqueAssetIds: number;
  dupeGroups: DupeGroup[];
  totalDuplicates: number; // sum of (group.count - 1)
}

function summarize(boardKey: BoardKey, items: RawItem[]): BoardReport {
  const board = BOARDS[boardKey];
  const byAsset = new Map<string, ItemSummary[]>();
  let itemsWithAssetId = 0;
  let itemsWithoutAssetId = 0;
  for (const it of items) {
    const cv: Record<string, string | null> = {};
    for (const c of it.column_values) cv[c.id] = c.text;
    const rawAsset = cv[board.assetCol];
    const assetTrimmed = rawAsset?.trim() || null;
    const rcti = cv[board.rctiCol]?.trim() || null;
    const status = cv[board.statusCol]?.trim() || null;
    const summary: ItemSummary = {
      itemId: it.id,
      itemName: it.name,
      createdAt: it.created_at,
      assetId: assetTrimmed,
      rctiNumber: rcti,
      uglPaymentStatus: status,
    };
    if (assetTrimmed) {
      itemsWithAssetId += 1;
      const list = byAsset.get(assetTrimmed) ?? [];
      list.push(summary);
      byAsset.set(assetTrimmed, list);
    } else {
      itemsWithoutAssetId += 1;
    }
  }
  const dupeGroups: DupeGroup[] = [];
  for (const [assetId, list] of byAsset) {
    if (list.length > 1) {
      // Sort by created_at ascending so the oldest row is first — that's
      // the natural canonical-row candidate for cleanup.
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      dupeGroups.push({ assetId, count: list.length, items: list });
    }
  }
  // Sort groups by count desc, then alphabetically — biggest issues first.
  dupeGroups.sort((a, b) => b.count - a.count || a.assetId.localeCompare(b.assetId));
  const totalDuplicates = dupeGroups.reduce(
    (s, g) => s + (g.count - 1),
    0
  );
  return {
    boardKey,
    boardId: board.id,
    totalItems: items.length,
    itemsWithAssetId,
    itemsWithoutAssetId,
    uniqueAssetIds: byAsset.size,
    dupeGroups,
    totalDuplicates,
  };
}

interface FullReport {
  generatedAt: string;
  boards: Record<BoardKey, BoardReport>;
  totals: {
    totalItems: number;
    totalUniqueAssetIds: number;
    totalDupeGroups: number;
    totalDuplicates: number; // extra rows beyond the canonical one
  };
}

async function main(): Promise<void> {
  console.log("=== SOR Job Boards — dupe finder ===");
  console.log(`generatedAt: ${new Date().toISOString()}\n`);

  const boardReports: Partial<Record<BoardKey, BoardReport>> = {};
  for (const [key, cfg] of Object.entries(BOARDS) as Array<[BoardKey, (typeof BOARDS)[BoardKey]]>) {
    console.log(`board=${key} (id=${cfg.id})`);
    const items = await fetchAllItems(
      cfg.id,
      [cfg.assetCol, cfg.rctiCol, cfg.statusCol]
    );
    const report = summarize(key, items);
    boardReports[key] = report;
    console.log(
      `  → totalItems=${report.totalItems} uniqueAssetIds=${report.uniqueAssetIds} dupeGroups=${report.dupeGroups.length} extraRows=${report.totalDuplicates}\n`
    );
  }

  const totals = {
    totalItems: 0,
    totalUniqueAssetIds: 0,
    totalDupeGroups: 0,
    totalDuplicates: 0,
  };
  for (const r of Object.values(boardReports)) {
    if (!r) continue;
    totals.totalItems += r.totalItems;
    totals.totalUniqueAssetIds += r.uniqueAssetIds;
    totals.totalDupeGroups += r.dupeGroups.length;
    totals.totalDuplicates += r.totalDuplicates;
  }

  const report: FullReport = {
    generatedAt: new Date().toISOString(),
    boards: boardReports as Record<BoardKey, BoardReport>,
    totals,
  };

  const outPath = "dupe-report.json";
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(outPath, JSON.stringify(report, null, 2))
  );

  console.log("=== Summary ===");
  console.log(`Total items across 4 boards: ${totals.totalItems}`);
  console.log(`Unique asset IDs (within each board): ${totals.totalUniqueAssetIds}`);
  console.log(`Duplicate groups: ${totals.totalDupeGroups}`);
  console.log(`Extra rows to clean up: ${totals.totalDuplicates}`);
  for (const [key, r] of Object.entries(boardReports) as Array<[BoardKey, BoardReport]>) {
    console.log(
      `  ${key.padEnd(12)} board ${r.boardId} → ${r.dupeGroups.length} dupe groups, ${r.totalDuplicates} extra rows`
    );
  }
  console.log(`\nFull report saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
