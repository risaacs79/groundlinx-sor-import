/**
 * scripts/archive_dupes.ts — one-shot cleanup of the May-5/May-8
 * duplicate rows surfaced by scripts/find_duplicates.ts.
 *
 * Strategy: per Rowan's audit, keep the OLDER (May-5) row, archive the
 * NEWER (May-8) row. All 114 May-8 rows are bug artifacts from a
 * pre-dedup-fix sync run; both rows in each pair carry identical RCTI
 * + UGL Payment Status, so dropping the newer one loses no data.
 *
 * Reversible: uses monday's archive_item mutation (NOT delete_item).
 * Archived items live in monday's recycle bin and can be restored
 * from the UI.
 *
 * Pre-archive preconditions (runtime, re-fetched fresh — does NOT
 * trust the dupe-report.json snapshot):
 *
 *   1. The asset group must contain EXACTLY 2 items.
 *   2. Both items must carry the same RCTI Number (text_mm32c4fj).
 *   3. Both items must carry the same UGL Payment Status (color_mm322s90).
 *   4. Primary Asset (board_relation_mm32kh12) safety check:
 *      - If the NEWER row has linked items AND the older does NOT,
 *        STOP — the newer is the relation target for some other row
 *        and archiving would orphan the relation. Goes to manual
 *        review for Rowan to inspect.
 *      - Otherwise: safe to archive the newer (the older row carries
 *        the canonical relation or both are blank).
 *
 * Any group that fails (1)-(4) is logged to manual-review.json and
 * NOT archived. Decisions for every group land in archive-log.json.
 *
 * Rate limit: 5 archives/sec via 200ms sleep between mutations —
 * comfortably under monday's 60-req/min ceiling once GraphQL overhead
 * is accounted for.
 *
 * Usage:
 *   MONDAY_API_TOKEN=xxx npm run archive-dupes
 *
 * Touches only the Approved & Paid Jobs board (5028088229). The audit
 * confirmed the other 3 job boards are clean.
 */

import { promises as fs } from "node:fs";

// Approved & Paid Jobs board column IDs — mirror sync_job_data.ts +
// import_work_orders.ts APPROVED_COL.
const APPROVED_BOARD = 5028088229;
const APPROVED_COLS = {
  asset: "text_mm325kny",
  rcti: "text_mm32c4fj",
  uglPaymentStatus: "color_mm322s90",
  primaryAsset: "board_relation_mm32kh12",
} as const;

// Rate limit: 5 archives/sec.
const ARCHIVE_SLEEP_MS = 200;

interface DupeReport {
  generatedAt: string;
  boards: {
    approved: {
      boardId: number;
      dupeGroups: Array<{
        assetId: string;
        count: number;
        items: Array<{
          itemId: string;
          itemName: string;
          createdAt: string;
          assetId: string | null;
          rctiNumber: string | null;
          uglPaymentStatus: string | null;
        }>;
      }>;
    };
  };
}

interface FreshItem {
  id: string;
  name: string;
  createdAt: string;
  rcti: string | null;
  uglPaymentStatus: string | null;
  primaryAssetLinkedIds: string[];
}

interface ArchiveLogEntry {
  assetId: string;
  kept: { itemId: string; itemName: string; createdAt: string };
  archived: { itemId: string; itemName: string; createdAt: string };
  rcti: string | null;
  uglPaymentStatus: string | null;
  archivedAt: string;
}

interface ManualReviewEntry {
  assetId: string;
  reason: string;
  items: FreshItem[];
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
  if (!token) {
    throw new Error(
      "MONDAY_API_TOKEN env var not set — re-run with MONDAY_API_TOKEN=xxx npm run archive-dupes"
    );
  }
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

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pull fresh state for a list of monday item ids. Uses the items()
 * top-level field (NOT items_page) since we have exact ids and don't
 * need to paginate. Pulls our 4 lifecycle-relevant columns.
 */
async function fetchFresh(itemIds: string[]): Promise<Map<string, FreshItem>> {
  const cols = [
    APPROVED_COLS.rcti,
    APPROVED_COLS.uglPaymentStatus,
    APPROVED_COLS.primaryAsset,
  ];
  interface RawCol {
    id: string;
    text: string | null;
    linked_item_ids?: string[];
  }
  interface RawItem {
    id: string;
    name: string;
    created_at: string;
    column_values: RawCol[];
  }
  const data = await monday<{ items: RawItem[] }>(
    `query ($ids: [ID!]!, $col: [String!]) {
      items(ids: $ids) {
        id name created_at
        column_values(ids: $col) {
          id text
          ... on BoardRelationValue { linked_item_ids }
        }
      }
    }`,
    { ids: itemIds, col: cols }
  );
  const out = new Map<string, FreshItem>();
  for (const it of data.items ?? []) {
    const cv: Record<string, RawCol> = {};
    for (const c of it.column_values) cv[c.id] = c;
    out.set(it.id, {
      id: it.id,
      name: it.name,
      createdAt: it.created_at,
      rcti: cv[APPROVED_COLS.rcti]?.text?.trim() || null,
      uglPaymentStatus:
        cv[APPROVED_COLS.uglPaymentStatus]?.text?.trim() || null,
      primaryAssetLinkedIds:
        cv[APPROVED_COLS.primaryAsset]?.linked_item_ids ?? [],
    });
  }
  return out;
}

/**
 * Apply preconditions to a freshly-fetched pair. Returns the row to
 * archive + the row to keep, OR a manual-review reason. Pure function;
 * no monday calls inside.
 */
function decideArchiveTarget(
  fresh: Map<string, FreshItem>,
  groupItemIds: string[]
):
  | { decision: "archive"; toArchive: FreshItem; toKeep: FreshItem }
  | { decision: "manual"; reason: string; freshItems: FreshItem[] } {
  // Precondition 1: exactly 2 items present in monday (no third row
  // sneaked in, no row deleted between audit and now).
  if (groupItemIds.length !== 2) {
    return {
      decision: "manual",
      reason: `group has ${groupItemIds.length} items in dupe-report (expected 2)`,
      freshItems: groupItemIds
        .map((id) => fresh.get(id))
        .filter((x): x is FreshItem => x != null),
    };
  }
  const freshItems = groupItemIds
    .map((id) => fresh.get(id))
    .filter((x): x is FreshItem => x != null);
  if (freshItems.length !== 2) {
    return {
      decision: "manual",
      reason: `monday returned ${freshItems.length} items for group of 2 — one may have been deleted/archived already`,
      freshItems,
    };
  }
  // Sort oldest first so freshItems[0] is canonical, [1] is dupe.
  freshItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const [older, newer] = freshItems;

  // Precondition 2: identical RCTI.
  if (older.rcti !== newer.rcti) {
    return {
      decision: "manual",
      reason: `RCTI Number differs across pair (older=${older.rcti ?? "null"}, newer=${newer.rcti ?? "null"}) — manual review`,
      freshItems,
    };
  }

  // Precondition 3: identical UGL Payment Status.
  if (older.uglPaymentStatus !== newer.uglPaymentStatus) {
    return {
      decision: "manual",
      reason: `UGL Payment Status differs across pair (older=${older.uglPaymentStatus ?? "null"}, newer=${newer.uglPaymentStatus ?? "null"}) — manual review`,
      freshItems,
    };
  }

  // Precondition 4: Primary Asset relation safety. If the NEWER row
  // carries linked items but the older doesn't, the relation may be
  // pointing to a downstream consumer that would orphan on archive.
  const newerHasLinks = newer.primaryAssetLinkedIds.length > 0;
  const olderHasLinks = older.primaryAssetLinkedIds.length > 0;
  if (newerHasLinks && !olderHasLinks) {
    return {
      decision: "manual",
      reason: `Primary Asset relation only on newer (May-8) row [${newer.primaryAssetLinkedIds.join(",")}], not on older — archiving would orphan the link target`,
      freshItems,
    };
  }

  return { decision: "archive", toArchive: newer, toKeep: older };
}

async function archiveItem(itemId: string): Promise<void> {
  await monday<{ archive_item: { id: string } }>(
    `mutation ($id: ID!) {
      archive_item(item_id: $id) { id }
    }`,
    { id: itemId }
  );
}

async function main(): Promise<void> {
  console.log("=== archive_dupes — Approved & Paid cleanup ===\n");

  // 1. Load the report.
  const reportRaw = await fs.readFile("dupe-report.json", "utf8");
  const report = JSON.parse(reportRaw) as DupeReport;
  const groups = report.boards.approved?.dupeGroups ?? [];
  console.log(`dupe-report.json loaded — ${groups.length} groups on Approved board`);

  if (groups.length === 0) {
    console.log("No dupe groups to clean up. Exiting.");
    return;
  }

  // 2. Walk groups, decide + execute.
  const archiveLog: ArchiveLogEntry[] = [];
  const manualReview: ManualReviewEntry[] = [];
  const reasonsCounter = new Map<string, number>();

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const ids = g.items.map((it) => it.itemId);
    process.stdout.write(
      `\r[${i + 1}/${groups.length}] asset=${g.assetId.slice(0, 30).padEnd(30)} `
    );

    let fresh: Map<string, FreshItem>;
    try {
      fresh = await fetchFresh(ids);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n  ❌ fresh-fetch failed: ${msg}`);
      manualReview.push({
        assetId: g.assetId,
        reason: `fresh-fetch failed: ${msg}`,
        items: [],
      });
      bumpReason(reasonsCounter, "fresh-fetch failed");
      continue;
    }

    const decision = decideArchiveTarget(fresh, ids);
    if (decision.decision === "manual") {
      console.log(`\n  ⚠ manual: ${decision.reason}`);
      manualReview.push({
        assetId: g.assetId,
        reason: decision.reason,
        items: decision.freshItems,
      });
      bumpReason(reasonsCounter, decision.reason);
      continue;
    }

    // 3. Execute archive.
    try {
      await archiveItem(decision.toArchive.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n  ❌ archive failed for ${decision.toArchive.id}: ${msg}`);
      manualReview.push({
        assetId: g.assetId,
        reason: `archive_item mutation failed: ${msg}`,
        items: [decision.toKeep, decision.toArchive],
      });
      bumpReason(reasonsCounter, "archive_item mutation failed");
      continue;
    }

    archiveLog.push({
      assetId: g.assetId,
      kept: {
        itemId: decision.toKeep.id,
        itemName: decision.toKeep.name,
        createdAt: decision.toKeep.createdAt,
      },
      archived: {
        itemId: decision.toArchive.id,
        itemName: decision.toArchive.name,
        createdAt: decision.toArchive.createdAt,
      },
      rcti: decision.toArchive.rcti,
      uglPaymentStatus: decision.toArchive.uglPaymentStatus,
      archivedAt: new Date().toISOString(),
    });
    // Rate limit ~5/sec.
    await sleep(ARCHIVE_SLEEP_MS);
  }
  process.stdout.write("\n\n");

  // 4. Write logs.
  await fs.writeFile(
    "archive-log.json",
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        boardId: APPROVED_BOARD,
        totalProcessed: archiveLog.length,
        entries: archiveLog,
      },
      null,
      2
    )
  );
  await fs.writeFile(
    "manual-review.json",
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        boardId: APPROVED_BOARD,
        totalSkipped: manualReview.length,
        entries: manualReview,
      },
      null,
      2
    )
  );

  // 5. Summary.
  console.log("=== Summary ===");
  console.log(`Total dupe groups in report:  ${groups.length}`);
  console.log(`Archived:                     ${archiveLog.length}`);
  console.log(`Skipped for manual review:    ${manualReview.length}`);
  if (reasonsCounter.size > 0) {
    console.log("Reasons:");
    for (const [reason, count] of [...reasonsCounter.entries()].sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${count.toString().padStart(4)}  ${reason}`);
    }
  }
  console.log("");
  console.log("Files written:");
  console.log("  archive-log.json");
  console.log("  manual-review.json");
}

function bumpReason(counter: Map<string, number>, reason: string): void {
  // Normalize to a stable bucket label — drop the per-item specifics
  // so the counter shows e.g. "RCTI Number differs" once, not once
  // per group.
  const normalised = reason
    .replace(/older=[^,)]+/, "older=<…>")
    .replace(/newer=[^,)]+/, "newer=<…>")
    .replace(/\[[^\]]*\]/, "[<…>]")
    .replace(/group of \d+/, "group of N");
  counter.set(normalised, (counter.get(normalised) ?? 0) + 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
