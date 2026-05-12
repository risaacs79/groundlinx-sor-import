/**
 * netlify/functions/lib/reconcile_row_placement.ts — Stage 3.
 *
 * UGL data is a state machine. import_work_orders CREATEs each job on
 * the board that matched its INITIAL status. When the status changes
 * later (e.g. Pending Artefacts → Approved → Paid), the row stays on
 * its original board. That wrong-board scattering is the root cause
 * of the cashflow dashboard's "Pending Artefacts: 2 jobs" undercount
 * — the actual pending-artefact rows are still sitting on Active /
 * Submitted / etc.
 *
 * This module:
 *   1. Walks all 4 job boards.
 *   2. Computes the EXPECTED board per row from its current UGL
 *      Payment Status using STATUS_TO_BOARD_KEY (canonical map).
 *   3. For each row whose current board ≠ expected board, plans a
 *      monday `move_item_to_board` mutation.
 *   4. Executes the plan with rate-limited retries.
 *
 * Idempotent: rows already on the right board are skipped.
 *
 * Move safety:
 *   - Every move uses the same call shape — no explicit
 *     columns_mapping. monday auto-matches columns across boards by
 *     TITLE, which handles BOTH the same-schema cluster (Asset ID etc
 *     have identical IDs across active/jobComplete/submitted/cancelled,
 *     all duplicate_board_with_structure children) AND the cross-
 *     schema crossings (TO/FROM Approved & Paid — Asset ID, Primary
 *     Asset, RCTI Number, UGL Payment Status all have identical
 *     TITLES on both schemas, so title-matching transfers them).
 *   - Columns with NO title match (revenue numerics, photo counters)
 *     drop on cross-schema moves; sync_job_data re-populates the 6
 *     SOR revenue numerics + Primary Asset relations + the lifecycle
 *     columns (RCTI + UGL Payment Status, PR #18) on the next
 *     pipeline run from the SOR Lines roll-up.
 *
 * Required env: MONDAY_API_TOKEN.
 *
 * Worker integration: gated on env var ENABLE_STAGE_3=true so the
 * worker doesn't move rows in production until Rowan flips the flag
 * after reviewing the migration script's dry-run output.
 */

// ============================================================================
// Board + column constants — mirrors sync_job_data.ts JOB_BOARDS.
// ============================================================================

const ACTIVE_JOBS_BOARD = 5028084872;
const JOB_COMPLETE_BOARD = 5028375392;
const SUBMITTED_JOBS_BOARD = 5028331769;
const APPROVED_JOBS_BOARD = 5028088229;
/** Track G3-fix5 (11 May 2026): destination for jobs UGL has descoped.
 *  Duplicated from Active board (5028084872) via
 *  duplicate_board_with_structure, so column IDs are byte-identical
 *  to Active and the board is part of the active-schema cluster.
 *  Lives in workspace 2977219 ("Groundlinx HQ") folder 6615544
 *  ("JOBS - Approved + Cancelled") alongside Approved & Paid Jobs.
 *
 *  G3-fix5a (11 May): the original duplicate (5028417160) landed in
 *  the wrong workspace (2889787) per the brief's stale-memory ID;
 *  that board was archived and replaced with this one in the correct
 *  workspace + folder. The bare placeholder 5028088232 that existed
 *  pre-fix was also archived (1 column "Name", 0 items). */
const CANCELLED_JOBS_BOARD = 5028418115;

// Note: previously a `ACTIVE_SCHEMA_BOARDS` Set lived here to drive
// which moves needed an explicit `columns_mapping` in the
// move_item_to_board mutation. G3-fix5b dropped the per-move mapping
// after the live migration proved that monday's title-based
// auto-matching handles both same-schema AND cross-schema moves
// correctly. The constant + its helper are gone.

export type BoardKey =
  | "active"
  | "jobComplete"
  | "submitted"
  | "approved"
  | "cancelled";

const BOARD_ID_OF: Record<BoardKey, number> = {
  active: ACTIVE_JOBS_BOARD,
  jobComplete: JOB_COMPLETE_BOARD,
  submitted: SUBMITTED_JOBS_BOARD,
  approved: APPROVED_JOBS_BOARD,
  cancelled: CANCELLED_JOBS_BOARD,
};

const BOARD_KEY_OF: Record<number, BoardKey> = {
  [ACTIVE_JOBS_BOARD]: "active",
  [JOB_COMPLETE_BOARD]: "jobComplete",
  [SUBMITTED_JOBS_BOARD]: "submitted",
  [APPROVED_JOBS_BOARD]: "approved",
  [CANCELLED_JOBS_BOARD]: "cancelled",
};

/** Asset ID column ID per board. Active-schema cluster (Active /
 *  JobComplete / Submitted / Cancelled) shares text_mm2tmm57; Approved
 *  has text_mm325kny. */
const ASSET_COL_OF: Record<BoardKey, string> = {
  active: "text_mm2tmm57",
  jobComplete: "text_mm2tmm57",
  submitted: "text_mm2tmm57",
  cancelled: "text_mm2tmm57",
  approved: "text_mm325kny",
};

/** UGL Payment Status column ID per board. Active-schema cluster
 *  shares color_mm32x3ga; Approved has color_mm322s90. */
const STATUS_COL_OF: Record<BoardKey, string> = {
  active: "color_mm32x3ga",
  jobComplete: "color_mm32x3ga",
  submitted: "color_mm32x3ga",
  cancelled: "color_mm32x3ga",
  approved: "color_mm322s90",
};

// ============================================================================
// Status → destination board mapping.
// Source of truth: Rowan's brief (May 11). Order matches the brief's
// table; values are the LIVE board IDs from import_work_orders.ts /
// sync_job_data.ts. Two of Rowan's brief IDs (5027589893,
// 5027591819) were from a different workspace; the live code uses
// 5028084872 + 5028331769.
// ============================================================================

const STATUS_TO_BOARD_KEY = new Map<string, BoardKey>([
  // Pending Artefacts + Pending Submission → Job Complete
  ["Pending Artefacts", "jobComplete"],
  ["Pending Submission", "jobComplete"],
  // In Review + Submitted → SUBMITTED
  ["In Review", "submitted"],
  ["Submitted", "submitted"],
  // Approved family → Approved & Paid
  ["Approved", "approved"],
  ["Paid", "approved"],
  ["Partial Paid", "approved"],
  ["Overpaid", "approved"],
  // "Paid - Pending RCTI" — not in Rowan's explicit list but it's
  // semantically "Paid" family per import_work_orders.ts STATUS_PRIORITY.
  // Routing to Approved keeps it consistent with other paid statuses.
  ["Paid - Pending RCTI", "approved"],
  // Active-lifecycle statuses → Active
  ["Pending Construction", "active"],
  ["Not Started", "active"],
  // Disputed → Active (gets reworked, stays in lifecycle view)
  ["Disputed", "active"],
  // Descoped → Cancelled (Track G3-fix5). UGL "Descoped" maps to our
  // internal "Cancelled" status; sync_job_data also transforms the
  // status text on write. Both labels route to the same board so a
  // row mid-transform still ends up at the right destination.
  ["Descoped", "cancelled"],
  ["Cancelled", "cancelled"],
]);

/** Status text transform applied at write time. UGL emits "Descoped";
 *  we display + store "Cancelled". Applied by:
 *    - reconcile_row_placement.executeOneMove (post-move status write
 *      when destination is the Cancelled board)
 *    - sync_job_data.runSyncJobData (lifecycle write path; transforms
 *      the desired status BEFORE the diff-and-write check, so already-
 *      "Cancelled" rows don't keep flipping back to "Descoped"). */
export function transformStatusForWrite(status: string | null): string | null {
  if (status === "Descoped") return "Cancelled";
  return status;
}

// ============================================================================
// Types
// ============================================================================

/** One row's pre-reconcile state. */
export interface ReconcileItem {
  itemId: string;
  itemName: string;
  asset: string;
  uglPaymentStatus: string | null;
  currentBoard: BoardKey;
}

/** A planned move (not yet executed). */
export interface PlannedMove {
  itemId: string;
  itemName: string;
  asset: string;
  status: string;
  fromBoard: BoardKey;
  toBoard: BoardKey;
}

/** Per-row outcome — used in plan summaries + post-run logs. */
export type RowOutcome =
  | "unchanged"
  | "movePlanned"
  | "moveExecuted"
  | "moveFailed"
  | "skippedBlankStatus"
  | "skippedUnknownStatus"
  | "skippedTest";

export interface ReconcileResult {
  totalChecked: number;
  movesPlanned: number;
  movesSucceeded: number;
  movesFailed: number;
  unchanged: number;
  skippedBlankStatus: number;
  skippedUnknownStatus: number;
  skippedTest: number;
  /** Counters for each fromBoard→toBoard pair (e.g. "active→approved"). */
  byDirection: Record<string, number>;
  failures: Array<{
    itemId: string;
    fromBoard: BoardKey;
    toBoard: BoardKey;
    error: string;
  }>;
  /** When the caller wants the underlying records — populated only
   *  by the migration CLI's --dry-run path; the worker doesn't need it. */
  plannedMoves?: PlannedMove[];
  /** Labels we DIDN'T recognise. The migration script prints these so
   *  Rowan can decide whether to extend STATUS_TO_BOARD_KEY. */
  unknownStatusSamples?: string[];
}

// ============================================================================
// monday client (matches house style in sync_sor_extract.ts +
// import_work_orders.ts + sync_job_data.ts).
// ============================================================================

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
  if (!res.ok) throw new Error(`monday HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as MondayQueryResponse<T>;
  if (json.errors) throw new Error(`monday errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

/** 5-attempt exponential backoff on 429 — mirrors sync_job_data.ts. */
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
          `[reconcile] ${label}: 429 rate-limited, sleeping ${wait}ms (attempt ${attempt + 2}/5)`
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

// ============================================================================
// Phase A — fetch
// ============================================================================

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

async function fetchBoardItems(boardKey: BoardKey): Promise<ReconcileItem[]> {
  const boardId = BOARD_ID_OF[boardKey];
  const assetCol = ASSET_COL_OF[boardKey];
  const statusCol = STATUS_COL_OF[boardKey];
  const cols = [assetCol, statusCol];
  const out: ReconcileItem[] = [];
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
          { boardId: String(boardId), col: cols }
        );

    const page: RawPage = cursor
      ? (data as NextResp).next_items_page!
      : (data as FirstResp).boards![0]!.items_page;

    for (const it of page.items) {
      const cv: Record<string, RawCol> = {};
      for (const c of it.column_values) cv[c.id] = c;
      const asset = (cv[assetCol]?.text ?? "").trim();
      const status = cv[statusCol]?.text?.trim() || null;
      out.push({
        itemId: it.id,
        itemName: it.name,
        asset,
        uglPaymentStatus: status,
        currentBoard: boardKey,
      });
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

/** Walk every job board; return all items with their current board. */
export async function fetchReconcileSnapshot(): Promise<ReconcileItem[]> {
  console.log("[reconcile] fetchReconcileSnapshot starting");
  const start = Date.now();
  // Sequential to be gentle on monday's complexity budget.
  const allItems: ReconcileItem[] = [];
  for (const key of ["active", "jobComplete", "submitted", "approved"] as const) {
    const items = await fetchBoardItems(key);
    console.log(`[reconcile]   board=${key} fetched ${items.length} items`);
    allItems.push(...items);
  }
  console.log(
    `[reconcile] fetchReconcileSnapshot done — ${allItems.length} total items in ${Date.now() - start}ms`
  );
  return allItems;
}

// ============================================================================
// Phase B — plan
// ============================================================================

function isTestAsset(asset: string): boolean {
  const u = asset.toUpperCase();
  return u.startsWith("TEST_") || u.startsWith("TEST-") || u.startsWith("TEST ");
}

interface PlanOutput {
  moves: PlannedMove[];
  unchanged: number;
  skippedBlankStatus: number;
  skippedUnknownStatus: number;
  skippedTest: number;
  unknownStatusSamples: string[];
}

/** Pure planning step — given a snapshot, decide which rows need to
 *  move. No monday calls inside. */
export function planMoves(items: ReconcileItem[]): PlanOutput {
  const moves: PlannedMove[] = [];
  let unchanged = 0;
  let skippedBlankStatus = 0;
  let skippedUnknownStatus = 0;
  let skippedTest = 0;
  const unknownSeen = new Map<string, number>(); // status → count
  for (const it of items) {
    if (it.asset && isTestAsset(it.asset)) {
      skippedTest += 1;
      continue;
    }
    if (!it.uglPaymentStatus) {
      skippedBlankStatus += 1;
      continue;
    }
    const expected = STATUS_TO_BOARD_KEY.get(it.uglPaymentStatus);
    if (!expected) {
      skippedUnknownStatus += 1;
      unknownSeen.set(
        it.uglPaymentStatus,
        (unknownSeen.get(it.uglPaymentStatus) ?? 0) + 1
      );
      continue;
    }
    if (expected === it.currentBoard) {
      unchanged += 1;
      continue;
    }
    moves.push({
      itemId: it.itemId,
      itemName: it.itemName,
      asset: it.asset,
      status: it.uglPaymentStatus,
      fromBoard: it.currentBoard,
      toBoard: expected,
    });
  }
  const unknownStatusSamples = [...unknownSeen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([s, n]) => `${s} (×${n})`);
  return {
    moves,
    unchanged,
    skippedBlankStatus,
    skippedUnknownStatus,
    skippedTest,
    unknownStatusSamples,
  };
}

// ============================================================================
// Phase C — execute
// ============================================================================

/** Execute one move with retries. After a successful move, apply any
 *  status-text transformation (e.g. UGL "Descoped" → our "Cancelled")
 *  via a follow-up change_simple_column_value. Returns nothing — the
 *  caller doesn't need the id (move_item_to_board preserves it).
 *
 *  G3-fix5b (11 May): two API-shape corrections discovered during the
 *  one-shot migration run via monday MCP:
 *    1. move_item_to_board REQUIRES `group_id`. monday's docs make
 *       it look optional but the API rejects calls without it. We
 *       pass "topics" — the default group_id on every active-schema
 *       board (Active was the duplicate source, and every duplicate
 *       inherits "topics" as its default group).
 *    2. Explicit `columns_mapping` with {source, target} structs was
 *       rejected with "not in the expected format" against the live
 *       API. Falling back to NO columns_mapping let monday auto-match
 *       columns by TITLE across schemas — verified during the
 *       migration: item 2686589503 carried Asset ID + status from
 *       Active into Approved correctly. The auto-match handles the
 *       active-schema ↔ approved-schema crossings we care about
 *       (Asset ID, Primary Asset, RCTI Number, UGL Payment Status
 *       all have identical column TITLES on both schemas).
 *       Therefore we drop columnsMappingFor() entirely — same call
 *       shape for every move, monday handles the schema bridge. */
async function executeOneMove(move: PlannedMove): Promise<void> {
  const variables: Record<string, unknown> = {
    itemId: move.itemId,
    boardId: String(BOARD_ID_OF[move.toBoard]),
    groupId: "topics",
  };
  const query = `mutation ($itemId: ID!, $boardId: ID!, $groupId: ID!) {
    move_item_to_board(item_id: $itemId, board_id: $boardId, group_id: $groupId) { id }
  }`;
  await mondayWithRetry<{ move_item_to_board: { id: string } }>(
    query,
    variables,
    `move-${move.itemId}`
  );

  // Status-text transform after move: when UGL says "Descoped" and
  // the row has landed on the Cancelled board, write our internal
  // "Cancelled" label. Uses create_labels_if_missing because the
  // Cancelled label may not yet exist on the destination column.
  const transformed = transformStatusForWrite(move.status);
  if (transformed !== move.status) {
    const targetCol = STATUS_COL_OF[move.toBoard];
    await mondayWithRetry<{ change_simple_column_value: { id: string } }>(
      `mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: String!) {
        change_simple_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $colId,
          value: $val,
          create_labels_if_missing: true
        ) { id }
      }`,
      {
        boardId: String(BOARD_ID_OF[move.toBoard]),
        itemId: move.itemId,
        colId: targetCol,
        val: transformed ?? "",
      },
      `status-transform-${move.itemId}`
    );
  }
}

interface ExecuteOptions {
  dryRun: boolean;
  /** Inter-move sleep in ms. Default 200ms = 5 moves/sec. */
  rateLimitMs?: number;
  /** Optional progress callback — fired after each move attempt. */
  onProgress?: (move: PlannedMove, idx: number, total: number, ok: boolean) => void;
}

interface ExecuteOutput {
  succeeded: number;
  failed: number;
  failures: Array<{
    itemId: string;
    fromBoard: BoardKey;
    toBoard: BoardKey;
    error: string;
  }>;
}

/** Apply a list of planned moves. Sequential with rate-limit sleep.
 *  Per-move try/catch so one failure doesn't abort the run. */
export async function executeMoves(
  moves: PlannedMove[],
  opts: ExecuteOptions
): Promise<ExecuteOutput> {
  const out: ExecuteOutput = { succeeded: 0, failed: 0, failures: [] };
  const sleepMs = opts.rateLimitMs ?? 200;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (opts.dryRun) {
      out.succeeded += 1;
      opts.onProgress?.(m, i, moves.length, true);
      continue;
    }
    try {
      await executeOneMove(m);
      out.succeeded += 1;
      opts.onProgress?.(m, i, moves.length, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.failed += 1;
      out.failures.push({
        itemId: m.itemId,
        fromBoard: m.fromBoard,
        toBoard: m.toBoard,
        error: msg.slice(0, 250),
      });
      opts.onProgress?.(m, i, moves.length, false);
      console.error(
        `[reconcile] move ${m.itemId} ${m.fromBoard}→${m.toBoard} FAILED: ${msg}`
      );
    }
    if (i < moves.length - 1) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
  return out;
}

// ============================================================================
// Phase D — orchestrator
// ============================================================================

export interface RunOptions {
  /** When true, plan but never call move_item_to_board. */
  dryRun?: boolean;
  /** Inter-move sleep in ms. Default 200 = 5/sec. */
  rateLimitMs?: number;
  /** When true, return plannedMoves on the result for downstream logging. */
  includePlannedMoves?: boolean;
}

/** Public entry. The worker calls this with dryRun=false; the
 *  migration script offers both dry-run and live modes via CLI flag. */
export async function runReconcileRowPlacement(
  opts: RunOptions = {}
): Promise<ReconcileResult> {
  const items = await fetchReconcileSnapshot();
  const plan = planMoves(items);
  const direction = (m: PlannedMove): string => `${m.fromBoard}→${m.toBoard}`;
  const byDirection: Record<string, number> = {};
  for (const m of plan.moves) {
    const k = direction(m);
    byDirection[k] = (byDirection[k] ?? 0) + 1;
  }
  console.log(
    `[reconcile] planned: total=${items.length} moves=${plan.moves.length} unchanged=${plan.unchanged} skippedBlank=${plan.skippedBlankStatus} skippedUnknown=${plan.skippedUnknownStatus} skippedTest=${plan.skippedTest}`
  );
  for (const [k, n] of Object.entries(byDirection)) {
    console.log(`[reconcile]   ${k}: ${n}`);
  }
  if (plan.unknownStatusSamples.length > 0) {
    console.warn(
      `[reconcile] unknown statuses (sampled top 10): ${plan.unknownStatusSamples.join(", ")}`
    );
  }

  const exec = await executeMoves(plan.moves, {
    dryRun: opts.dryRun ?? false,
    rateLimitMs: opts.rateLimitMs,
  });

  const result: ReconcileResult = {
    totalChecked: items.length,
    movesPlanned: plan.moves.length,
    movesSucceeded: exec.succeeded,
    movesFailed: exec.failed,
    unchanged: plan.unchanged,
    skippedBlankStatus: plan.skippedBlankStatus,
    skippedUnknownStatus: plan.skippedUnknownStatus,
    skippedTest: plan.skippedTest,
    byDirection,
    failures: exec.failures,
    unknownStatusSamples: plan.unknownStatusSamples,
  };
  if (opts.includePlannedMoves) {
    result.plannedMoves = plan.moves;
  }
  return result;
}
