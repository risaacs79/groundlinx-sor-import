/**
 * scripts/bulk_update_internal_statuses.ts — one-shot bulk reset of
 * Job Status + Field Status on every "past Pending Artefacts" row
 * across the 5 SOR job boards.
 *
 * Context: Job Status + Field Status are Groundlinx-internal columns
 * (not touched by SOR Sync). They currently carry stale placeholder
 * values from before the new workflow began. This script seeds them
 * with canonical values derived from UGL Payment Status so the team
 * starts from a clean slate.
 *
 * Rows in scope: UGL Payment Status ∈ { In Review, Submitted,
 * Approved, Paid, Paid - Pending RCTI, Partial Paid, Overpaid,
 * Cancelled }. Rows outside that set (Pending Construction, Not
 * Started, Pending Artefacts, Disputed, blank, Descoped) are
 * skipped — they're upstream of the lifecycle stage where Job Status
 * starts to matter, OR have been routed elsewhere (Descoped → moved
 * to Cancelled board where the status is now "Cancelled").
 *
 * Targets:
 *   Job Status:
 *     In Review            → Submitted
 *     Submitted            → Submitted
 *     Approved             → Approved
 *     Paid                 → Paid
 *     Paid - Pending RCTI  → Paid
 *     Partial Paid         → Paid
 *     Overpaid             → Paid
 *     Cancelled            → Cancelled
 *   Field Status:
 *     (all in-scope rows)  → Complete
 *
 * Per-board column IDs (the active-schema cluster vs Approved):
 *   active / jobComplete / submitted / cancelled
 *     UGL Payment Status: color_mm32x3ga
 *     Job Status:         color_mm2tff18
 *     Field Status:       color_mm2t81bv
 *   approved
 *     UGL Payment Status: color_mm322s90
 *     Job Status:         color_mm329x8a
 *     Field Status:       color_mm32f1n7
 *
 * Safety / idempotency:
 *   - Diff-only: only writes columns whose desired value differs from
 *     monday's current value. Re-running is a no-op.
 *   - TEST-prefixed assets/names are skipped.
 *   - Per-row try/catch; one failure doesn't abort the run.
 *   - 5 writes/sec rate limit (200ms sleep between mutations).
 *   - create_labels_if_missing on the mutation so "Submitted" /
 *     "Cancelled" labels get added if the destination column lacks
 *     them (e.g. active-cluster Job Status currently has "Submitted
 *     to UGL", not "Submitted" — Rowan's brief is explicit on "Submitted"
 *     as the target).
 *
 * Usage:
 *   # Dry-run first (mandatory — review the plan):
 *   MONDAY_API_TOKEN=xxx npm run bulk-update-internal-statuses -- --dry-run
 *
 *   # After Rowan reviews the dry-run plan and approves:
 *   MONDAY_API_TOKEN=xxx npm run bulk-update-internal-statuses
 *
 * Output:
 *   bulk-update-plan.json — always written, includes every planned write
 *   bulk-update-log.json  — written only on live run, executed results
 */

import { promises as fs } from "node:fs";

// ============================================================================
// Board + column config
// ============================================================================

type BoardKey = "active" | "jobComplete" | "submitted" | "approved" | "cancelled";

interface BoardCfg {
  id: number;
  uglPaymentStatusCol: string;
  jobStatusCol: string;
  fieldStatusCol: string;
}

const BOARDS: Record<BoardKey, BoardCfg> = {
  active: {
    id: 5028084872,
    uglPaymentStatusCol: "color_mm32x3ga",
    jobStatusCol: "color_mm2tff18",
    fieldStatusCol: "color_mm2t81bv",
  },
  jobComplete: {
    id: 5028375392,
    uglPaymentStatusCol: "color_mm32x3ga",
    jobStatusCol: "color_mm2tff18",
    fieldStatusCol: "color_mm2t81bv",
  },
  submitted: {
    id: 5028331769,
    uglPaymentStatusCol: "color_mm32x3ga",
    jobStatusCol: "color_mm2tff18",
    fieldStatusCol: "color_mm2t81bv",
  },
  cancelled: {
    id: 5028418115,
    uglPaymentStatusCol: "color_mm32x3ga",
    jobStatusCol: "color_mm2tff18",
    fieldStatusCol: "color_mm2t81bv",
  },
  approved: {
    id: 5028088229,
    uglPaymentStatusCol: "color_mm322s90",
    jobStatusCol: "color_mm329x8a",
    fieldStatusCol: "color_mm32f1n7",
  },
};

/** Rowan's mapping from UGL Payment Status → target Job Status. */
const UGL_STATUS_TO_JOB_STATUS = new Map<string, string>([
  ["In Review", "Submitted"],
  ["Submitted", "Submitted"],
  ["Approved", "Approved"],
  ["Paid", "Paid"],
  ["Paid - Pending RCTI", "Paid"],
  ["Partial Paid", "Paid"],
  ["Overpaid", "Paid"],
  ["Cancelled", "Cancelled"],
]);

const FIELD_STATUS_TARGET = "Complete";

// ============================================================================
// monday helpers — matches house style.
// ============================================================================

interface MondayResponse<T> {
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
      "MONDAY_API_TOKEN env var not set — re-run with MONDAY_API_TOKEN=xxx ..."
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
  const json = (await res.json()) as MondayResponse<T>;
  if (json.errors) {
    throw new Error(`monday errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

async function mondayWithRetry<T>(
  query: string,
  variables: Record<string, unknown> = {},
  label = "monday"
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await monday<T>(query, variables);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429") && attempt < 4) {
        const wait = Math.min(60_000, 5000 * Math.pow(2, attempt));
        console.warn(
          `[bulk-status] ${label}: 429, sleeping ${wait}ms (attempt ${attempt + 2}/5)`
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Phase A — fetch
// ============================================================================

interface RowSnapshot {
  itemId: string;
  itemName: string;
  boardKey: BoardKey;
  uglPaymentStatus: string | null;
  jobStatus: string | null;
  fieldStatus: string | null;
}

interface RawCol {
  id: string;
  text: string | null;
}
interface RawItem {
  id: string;
  name: string;
  column_values: RawCol[];
}
interface RawPage {
  cursor: string | null;
  items: RawItem[];
}

async function fetchBoardSnapshot(boardKey: BoardKey): Promise<RowSnapshot[]> {
  const cfg = BOARDS[boardKey];
  const cols = [
    cfg.uglPaymentStatusCol,
    cfg.jobStatusCol,
    cfg.fieldStatusCol,
  ];
  const out: RowSnapshot[] = [];
  let cursor: string | null = null;
  for (let pg = 1; pg <= 20; pg++) {
    interface FirstResp {
      boards?: Array<{ items_page: RawPage }>;
    }
    interface NextResp {
      next_items_page?: RawPage;
    }
    const data: FirstResp & NextResp = cursor
      ? await monday<NextResp>(
          `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor items {
                id name
                column_values(ids: $col) { id text }
              }
            }
          }`,
          { cursor, col: cols }
        )
      : await monday<FirstResp>(
          `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor items {
                  id name
                  column_values(ids: $col) { id text }
                }
              }
            }
          }`,
          { boardId: String(cfg.id), col: cols }
        );
    const page: RawPage = cursor
      ? (data as NextResp).next_items_page!
      : (data as FirstResp).boards![0]!.items_page;
    for (const it of page.items) {
      const cv: Record<string, RawCol> = {};
      for (const c of it.column_values) cv[c.id] = c;
      out.push({
        itemId: it.id,
        itemName: it.name,
        boardKey,
        uglPaymentStatus:
          cv[cfg.uglPaymentStatusCol]?.text?.trim() || null,
        jobStatus: cv[cfg.jobStatusCol]?.text?.trim() || null,
        fieldStatus: cv[cfg.fieldStatusCol]?.text?.trim() || null,
      });
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

// ============================================================================
// Phase B — plan
// ============================================================================

function isTest(itemName: string): boolean {
  const u = itemName.toUpperCase().trim();
  return (
    u.startsWith("TEST_") ||
    u.startsWith("TEST-") ||
    u.startsWith("TEST ") ||
    u.includes(" TEST_") ||
    u.includes(" TEST-")
  );
}

interface PlannedWrite {
  itemId: string;
  itemName: string;
  boardKey: BoardKey;
  uglPaymentStatus: string;
  /** Desired vs current. When desired === current → not in this list. */
  jobStatus: { current: string | null; desired: string } | null;
  fieldStatus: { current: string | null; desired: string } | null;
}

interface PlanOutput {
  /** Rows that need at least one write. */
  writes: PlannedWrite[];
  /** Rows in scope (UGL Payment Status in the map) but already
   *  matching both target values — no write needed. */
  alreadyCorrect: number;
  /** Rows out of scope (UGL Payment Status not in map / blank). */
  outOfScope: number;
  /** TEST-prefixed rows. */
  skippedTest: number;
  /** Anomaly: rows on a board where their UGL Payment Status doesn't
   *  match Rowan's post-migration routing rules. Logged but still
   *  processed — they get the Job/Field status canonical write
   *  regardless of board. */
  anomaliesUglOnWrongBoard: Array<{
    itemId: string;
    itemName: string;
    boardKey: BoardKey;
    uglPaymentStatus: string;
  }>;
  /** Per-(board, ugl-status, target-Job-Status) bucket counts. */
  byBucket: Record<
    string,
    {
      board: BoardKey;
      uglStatus: string;
      jobStatusDesired: string;
      itemsToUpdate: number;
      alreadyCorrect: number;
    }
  >;
}

/** Post-migration canonical-board rule: which UGL Payment Status
 *  values are EXPECTED on which board. Used only to flag anomalies —
 *  doesn't alter the write plan. */
const EXPECTED_BOARDS_FOR_UGL_STATUS = new Map<string, BoardKey[]>([
  ["In Review", ["submitted"]],
  ["Submitted", ["submitted"]],
  ["Approved", ["approved"]],
  ["Paid", ["approved"]],
  ["Paid - Pending RCTI", ["approved"]],
  ["Partial Paid", ["approved"]],
  ["Overpaid", ["approved"]],
  ["Cancelled", ["cancelled"]],
]);

function planRows(rows: RowSnapshot[]): PlanOutput {
  const writes: PlannedWrite[] = [];
  let alreadyCorrect = 0;
  let outOfScope = 0;
  let skippedTest = 0;
  const anomalies: PlanOutput["anomaliesUglOnWrongBoard"] = [];
  const byBucket: PlanOutput["byBucket"] = {};

  for (const r of rows) {
    if (isTest(r.itemName)) {
      skippedTest += 1;
      continue;
    }
    if (!r.uglPaymentStatus) {
      outOfScope += 1;
      continue;
    }
    const desiredJobStatus = UGL_STATUS_TO_JOB_STATUS.get(r.uglPaymentStatus);
    if (!desiredJobStatus) {
      outOfScope += 1;
      continue;
    }

    // Anomaly detection: post-migration canonical-board check.
    const expectedBoards = EXPECTED_BOARDS_FOR_UGL_STATUS.get(
      r.uglPaymentStatus
    );
    if (expectedBoards && !expectedBoards.includes(r.boardKey)) {
      anomalies.push({
        itemId: r.itemId,
        itemName: r.itemName,
        boardKey: r.boardKey,
        uglPaymentStatus: r.uglPaymentStatus,
      });
    }

    // Diff vs current.
    const jobDiff =
      r.jobStatus !== desiredJobStatus
        ? { current: r.jobStatus, desired: desiredJobStatus }
        : null;
    const fieldDiff =
      r.fieldStatus !== FIELD_STATUS_TARGET
        ? { current: r.fieldStatus, desired: FIELD_STATUS_TARGET }
        : null;

    const bucketKey = `${r.boardKey} / ${r.uglPaymentStatus} → ${desiredJobStatus}`;
    if (!byBucket[bucketKey]) {
      byBucket[bucketKey] = {
        board: r.boardKey,
        uglStatus: r.uglPaymentStatus,
        jobStatusDesired: desiredJobStatus,
        itemsToUpdate: 0,
        alreadyCorrect: 0,
      };
    }

    if (!jobDiff && !fieldDiff) {
      alreadyCorrect += 1;
      byBucket[bucketKey].alreadyCorrect += 1;
      continue;
    }
    byBucket[bucketKey].itemsToUpdate += 1;
    writes.push({
      itemId: r.itemId,
      itemName: r.itemName,
      boardKey: r.boardKey,
      uglPaymentStatus: r.uglPaymentStatus,
      jobStatus: jobDiff,
      fieldStatus: fieldDiff,
    });
  }
  return {
    writes,
    alreadyCorrect,
    outOfScope,
    skippedTest,
    anomaliesUglOnWrongBoard: anomalies,
    byBucket,
  };
}

// ============================================================================
// Phase C — execute (live only)
// ============================================================================

interface WriteOutcome {
  itemId: string;
  boardKey: BoardKey;
  boardId: number;
  jobStatus: { current: string | null; desired: string } | null;
  fieldStatus: { current: string | null; desired: string } | null;
  ok: boolean;
  error?: string;
  appliedAt: string;
}

async function executeOneWrite(
  write: PlannedWrite
): Promise<WriteOutcome> {
  const cfg = BOARDS[write.boardKey];
  const columnValues: Record<string, unknown> = {};
  if (write.jobStatus) {
    columnValues[cfg.jobStatusCol] = { label: write.jobStatus.desired };
  }
  if (write.fieldStatus) {
    columnValues[cfg.fieldStatusCol] = { label: write.fieldStatus.desired };
  }
  try {
    await mondayWithRetry<{ change_multiple_column_values: { id: string } }>(
      `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
        change_multiple_column_values(
          board_id: $boardId,
          item_id: $itemId,
          column_values: $cols,
          create_labels_if_missing: true
        ) { id }
      }`,
      {
        boardId: String(cfg.id),
        itemId: write.itemId,
        cols: JSON.stringify(columnValues),
      },
      `bulk-write-${write.itemId}`
    );
    return {
      itemId: write.itemId,
      boardKey: write.boardKey,
      boardId: cfg.id,
      jobStatus: write.jobStatus,
      fieldStatus: write.fieldStatus,
      ok: true,
      appliedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      itemId: write.itemId,
      boardKey: write.boardKey,
      boardId: cfg.id,
      jobStatus: write.jobStatus,
      fieldStatus: write.fieldStatus,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      appliedAt: new Date().toISOString(),
    };
  }
}

// ============================================================================
// Main
// ============================================================================

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.slice(2).some((a) => a === "--dry-run") };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs();
  console.log(
    `=== bulk_update_internal_statuses — mode=${dryRun ? "DRY-RUN" : "LIVE"} ===\n`
  );

  // Walk every board sequentially to keep monday rate-limit pressure
  // bounded. Each board read is ~1 page (max board size ~500 items).
  const allRows: RowSnapshot[] = [];
  for (const key of ["active", "jobComplete", "submitted", "approved", "cancelled"] as const) {
    const rows = await fetchBoardSnapshot(key);
    console.log(`  board=${key} fetched ${rows.length} items`);
    allRows.push(...rows);
  }
  console.log(`Total items across 5 boards: ${allRows.length}\n`);

  const plan = planRows(allRows);

  // Per-board counters for the summary.
  const perBoard: Record<
    BoardKey,
    {
      total: number;
      inScope: number;
      toUpdate: number;
      alreadyCorrect: number;
      outOfScope: number;
      skippedTest: number;
    }
  > = {
    active: zeroBoardStats(),
    jobComplete: zeroBoardStats(),
    submitted: zeroBoardStats(),
    approved: zeroBoardStats(),
    cancelled: zeroBoardStats(),
  };
  for (const r of allRows) {
    perBoard[r.boardKey].total += 1;
    if (isTest(r.itemName)) {
      perBoard[r.boardKey].skippedTest += 1;
      continue;
    }
    const desired = r.uglPaymentStatus
      ? UGL_STATUS_TO_JOB_STATUS.get(r.uglPaymentStatus)
      : undefined;
    if (!desired) {
      perBoard[r.boardKey].outOfScope += 1;
      continue;
    }
    perBoard[r.boardKey].inScope += 1;
  }
  for (const w of plan.writes) {
    perBoard[w.boardKey].toUpdate += 1;
  }
  // alreadyCorrect = inScope − toUpdate per board.
  for (const k of Object.keys(perBoard) as BoardKey[]) {
    perBoard[k].alreadyCorrect = perBoard[k].inScope - perBoard[k].toUpdate;
  }

  // Always write the plan file — same shape for dry-run + live.
  const planFile = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? "dry-run" : "live",
    summary: {
      totalRows: allRows.length,
      planned: plan.writes.length,
      alreadyCorrect: plan.alreadyCorrect,
      outOfScope: plan.outOfScope,
      skippedTest: plan.skippedTest,
      anomaliesCount: plan.anomaliesUglOnWrongBoard.length,
    },
    perBoard,
    byBucket: plan.byBucket,
    anomaliesUglOnWrongBoard: plan.anomaliesUglOnWrongBoard,
    writes: plan.writes,
  };
  await fs.writeFile(
    "bulk-update-plan.json",
    JSON.stringify(planFile, null, 2)
  );

  // ---- summary print ----
  console.log("=== Per-board summary ===");
  console.log(
    "board".padEnd(12),
    "total".padStart(6),
    "inScope".padStart(8),
    "toUpdate".padStart(9),
    "alreadyOK".padStart(10),
    "outOfScope".padStart(11),
    "TEST".padStart(5)
  );
  for (const k of ["active", "jobComplete", "submitted", "approved", "cancelled"] as BoardKey[]) {
    const s = perBoard[k];
    console.log(
      k.padEnd(12),
      String(s.total).padStart(6),
      String(s.inScope).padStart(8),
      String(s.toUpdate).padStart(9),
      String(s.alreadyCorrect).padStart(10),
      String(s.outOfScope).padStart(11),
      String(s.skippedTest).padStart(5)
    );
  }

  console.log("\n=== By bucket (board × UGL → target Job Status) ===");
  const buckets = Object.values(plan.byBucket).sort((a, b) =>
    b.itemsToUpdate - a.itemsToUpdate
  );
  for (const b of buckets) {
    console.log(
      `  ${b.board.padEnd(12)} ${b.uglStatus.padEnd(20)} → ${b.jobStatusDesired.padEnd(12)} | update=${b.itemsToUpdate} alreadyOK=${b.alreadyCorrect}`
    );
  }

  if (plan.anomaliesUglOnWrongBoard.length > 0) {
    console.log(
      `\n⚠ Anomalies (UGL status doesn't match board's canonical assignment): ${plan.anomaliesUglOnWrongBoard.length}`
    );
    for (const a of plan.anomaliesUglOnWrongBoard.slice(0, 10)) {
      console.log(
        `  ${a.itemId} on ${a.boardKey} board has UGL=${a.uglPaymentStatus} (expected on ${EXPECTED_BOARDS_FOR_UGL_STATUS.get(a.uglPaymentStatus)?.join("/")})`
      );
    }
    if (plan.anomaliesUglOnWrongBoard.length > 10) {
      console.log(`  …+${plan.anomaliesUglOnWrongBoard.length - 10} more in bulk-update-plan.json`);
    }
  }

  console.log("\n=== Totals ===");
  console.log(`  total rows checked:      ${allRows.length}`);
  console.log(`  writes planned:          ${plan.writes.length}`);
  console.log(`  already correct:         ${plan.alreadyCorrect}`);
  console.log(`  out of scope (UGL):      ${plan.outOfScope}`);
  console.log(`  TEST-skipped:            ${plan.skippedTest}`);

  if (dryRun) {
    console.log(
      "\nDRY-RUN complete — review bulk-update-plan.json, then re-run WITHOUT --dry-run."
    );
    return;
  }

  // ---- live run ----
  console.log(`\n=== Executing ${plan.writes.length} writes (5/sec) ===`);
  const outcomes: WriteOutcome[] = [];
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < plan.writes.length; i++) {
    const w = plan.writes[i];
    const outcome = await executeOneWrite(w);
    outcomes.push(outcome);
    if (outcome.ok) {
      succeeded += 1;
    } else {
      failed += 1;
      console.error(
        `  ✗ ${w.itemId} on ${w.boardKey}: ${outcome.error}`
      );
    }
    if ((i + 1) % 10 === 0) {
      process.stdout.write(`\r  ${i + 1}/${plan.writes.length} processed `);
    }
    if (i < plan.writes.length - 1) {
      await sleep(200);
    }
  }
  process.stdout.write("\n");
  console.log(`Succeeded: ${succeeded}, Failed: ${failed}`);

  const logFile = {
    ranAt: new Date().toISOString(),
    summary: {
      totalProcessed: outcomes.length,
      succeeded,
      failed,
    },
    outcomes,
  };
  await fs.writeFile(
    "bulk-update-log.json",
    JSON.stringify(logFile, null, 2)
  );
  console.log("\nFiles written:");
  console.log("  bulk-update-plan.json");
  console.log("  bulk-update-log.json");
}

function zeroBoardStats(): {
  total: number;
  inScope: number;
  toUpdate: number;
  alreadyCorrect: number;
  outOfScope: number;
  skippedTest: number;
} {
  return {
    total: 0,
    inScope: 0,
    toUpdate: 0,
    alreadyCorrect: 0,
    outOfScope: 0,
    skippedTest: 0,
  };
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
