/**
 * scripts/migrate_rcti_cycle_column.ts — one-shot schema migration.
 *
 * Two changes:
 *   1. Add a 🗓️ RCTI Payment Cycle column on SOR Lines (5028087610).
 *      board_relation → RCTI Payment Cycles (5028104633), single link.
 *   2. Add a "Pending Receipt" label to the existing Payment Status
 *      column (color_mm2tktkr) on SOR Lines.
 *
 * Why both in one script: they're a coupled migration — neither makes
 * sense without the other. The new sync code path in sync_sor_extract.ts
 * reads the cycle relation + writes the new label. Running this script
 * is a prerequisite to deploying the sync code.
 *
 * Idempotency:
 *   - Column creation: scans existing columns for one whose title is
 *     "🗓️ RCTI Payment Cycle" and whose settings link to
 *     boardId 5028104633. If found, reports the existing id and skips.
 *   - Label add: reads the current Payment Status label set, looks for
 *     "Pending Receipt", skips if already present.
 *
 * Usage:
 *   MONDAY_API_TOKEN=xxx npm run migrate-rcti-cycle-column            # dry-run
 *   MONDAY_API_TOKEN=xxx npm run migrate-rcti-cycle-column -- --write
 *
 * On successful --write, prints the new column id so it can be wired
 * into the sync code's constants.
 */

const SOR_LINES_BOARD = 5028087610;
const RCTI_CYCLES_BOARD = 5028104633;
const PAYMENT_STATUS_COL = "color_mm2tktkr";
const NEW_COLUMN_TITLE = "🗓️ RCTI Payment Cycle";
const NEW_LABEL = "Pending Receipt";

interface MondayResponse<T> {
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
  const json = (await res.json()) as MondayResponse<T>;
  if (json.errors) {
    throw new Error(`monday errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

interface BoardColumn {
  id: string;
  title: string;
  type: string;
  settings_str: string;
}

async function fetchColumns(boardId: number): Promise<BoardColumn[]> {
  const data = await monday<{
    boards: Array<{ columns: BoardColumn[] }>;
  }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id title type settings_str }
      }
    }`,
    { boardId: String(boardId) }
  );
  return data.boards[0]?.columns ?? [];
}

interface StatusLabel {
  id: number;
  label: string;
}

interface StatusColumnSettings {
  /** monday returns status `settings_str` with labels as an object map
   *  `{ "<id>": "<label>", … }`, NOT an array — different shape from what
   *  `get_board_info` returns via the wrapper. Parse both shapes
   *  defensively. */
  labels: Record<string, string> | Array<{ id: number; label: string }>;
}

function parseStatusLabels(settings_str: string): StatusLabel[] {
  try {
    const parsed = JSON.parse(settings_str) as StatusColumnSettings;
    if (Array.isArray(parsed.labels)) {
      return parsed.labels.map((l) => ({ id: l.id, label: l.label }));
    }
    if (parsed.labels && typeof parsed.labels === "object") {
      return Object.entries(parsed.labels).map(([id, label]) => ({
        id: Number(id),
        label: String(label),
      }));
    }
    return [];
  } catch {
    return [];
  }
}

interface Flags {
  write: boolean;
}

function parseFlags(): Flags {
  return { write: process.argv.slice(2).some((a) => a === "--write") };
}

// ---------- Migration steps ----------

async function ensureBoardRelationColumn(write: boolean): Promise<string | null> {
  const cols = await fetchColumns(SOR_LINES_BOARD);
  // Idempotency check: title + relation target matches.
  for (const c of cols) {
    if (c.type !== "board_relation") continue;
    if (c.title.trim() !== NEW_COLUMN_TITLE) continue;
    try {
      const s = JSON.parse(c.settings_str) as {
        boardIds?: number[];
      };
      if (s.boardIds?.includes(RCTI_CYCLES_BOARD)) {
        console.log(
          `  [skip] column already exists: id=${c.id} title="${c.title}"`
        );
        return c.id;
      }
    } catch {
      /* fall through to create */
    }
  }

  if (!write) {
    console.log(
      `  [dry-run] would create board_relation column on board ${SOR_LINES_BOARD}: ` +
        `title="${NEW_COLUMN_TITLE}" → boardIds=[${RCTI_CYCLES_BOARD}] allowMultipleItems=false`
    );
    return null;
  }

  // create_column does not accept settings on the same mutation for
  // board_relation — the boardIds get set via the dedicated
  // create_column input. Use create_column with explicit settings_str.
  const data = await monday<{
    create_column: { id: string; title: string; type: string };
  }>(
    `mutation (
      $boardId: ID!,
      $title: String!,
      $description: String!,
      $defaults: JSON!
    ) {
      create_column(
        board_id: $boardId,
        title: $title,
        description: $description,
        column_type: board_relation,
        defaults: $defaults
      ) { id title type }
    }`,
    {
      boardId: String(SOR_LINES_BOARD),
      title: NEW_COLUMN_TITLE,
      description:
        "Which RCTI Payment Cycle this SOR Line is paid by. Set by sync_sor_extract.ts when UGL issues the RCTI for the line's invoice. Drives the cashflow page's actual-cash-received calculation (distinct from UGL Status = Paid, which fires 14 days before the money lands).",
      defaults: JSON.stringify({
        boardIds: [RCTI_CYCLES_BOARD],
        allowMultipleItems: false,
      }),
    }
  );
  console.log(
    `  [created] column id=${data.create_column.id} title="${data.create_column.title}"`
  );
  return data.create_column.id;
}

async function ensurePendingReceiptLabel(write: boolean): Promise<void> {
  const cols = await fetchColumns(SOR_LINES_BOARD);
  const col = cols.find((c) => c.id === PAYMENT_STATUS_COL);
  if (!col) {
    throw new Error(
      `Payment Status column ${PAYMENT_STATUS_COL} not found on board ${SOR_LINES_BOARD}`
    );
  }
  const labels = parseStatusLabels(col.settings_str);
  const existing = labels.find((l) => l.label === NEW_LABEL);
  if (existing) {
    console.log(
      `  [skip] label "${NEW_LABEL}" already present (id=${existing.id})`
    );
    return;
  }

  if (!write) {
    console.log(
      `  [dry-run] would add label "${NEW_LABEL}" to ${PAYMENT_STATUS_COL}. ` +
        `Current labels: ${labels.map((l) => `${l.id}=${l.label}`).join(", ")}`
    );
    return;
  }

  // change_simple_column_value can't add labels. Use change_column_value
  // (deprecated for status writes but still works) — or better, use
  // managed_column / status_label_create style. The cleanest API path
  // is change_metadata_column_value-style which doesn't exist; the
  // realistic approach is to use the column-settings update via
  // change_column_metadata. monday's documented path for adding labels
  // is to write a column_value with `create_labels_if_missing: true`.
  // We do that on a dummy write with a no-op item — but we'd need a
  // target item. Cleanest: use the dedicated `create_or_get_tag`?
  // Actually monday has no public API to add a status label outside
  // of writing a value that references it with create_labels_if_missing.
  //
  // So: pick the first SOR Line item, write Payment Status = "Pending
  // Receipt" with create_labels_if_missing=true, IMMEDIATELY clear it
  // back to its prior value (or leave clear if it was null). This is
  // the documented bootstrap path — same trick monday's own UI uses
  // when a user types a new label into a status field.
  //
  // To minimise side-effects, find an item whose Payment Status is
  // currently null/blank. Set to "Pending Receipt" (create_labels_if_
  // missing=true), then clear back to null.
  // Find an item whose Payment Status is currently blank — needed so the
  // post-write revert restores the original value (null) without
  // requiring us to remember the prior label. monday's items_page rule
  // filter on a status column with "is blank" is awkward; just grab the
  // first 25 and pick the first blank one.
  const probeItems = await monday<{
    boards: Array<{
      items_page: {
        items: Array<{
          id: string;
          column_values: Array<{ id: string; text: string | null }>;
        }>;
      };
    }>;
  }>(
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 25) {
          items {
            id
            column_values(ids: ["${PAYMENT_STATUS_COL}"]) { id text }
          }
        }
      }
    }`,
    { boardId: String(SOR_LINES_BOARD) }
  );
  const probeId = probeItems.boards[0]?.items_page?.items.find(
    (it) => !it.column_values.find((c) => c.id === PAYMENT_STATUS_COL)?.text
  )?.id;
  if (!probeId) {
    throw new Error(
      "No SOR Line with null Payment Status found in the first 25 items — " +
        "can't bootstrap the new label without a target item. Manually add the label in monday UI."
    );
  }
  console.log(
    `  [bootstrap] using item ${probeId} to seed the new label, will revert immediately`
  );

  // Write the new label
  await monday(
    `mutation ($boardId: ID!, $itemId: ID!, $col: String!, $value: JSON!) {
      change_column_value(
        board_id: $boardId,
        item_id: $itemId,
        column_id: $col,
        value: $value,
        create_labels_if_missing: true
      ) { id }
    }`,
    {
      boardId: String(SOR_LINES_BOARD),
      itemId: probeId,
      col: PAYMENT_STATUS_COL,
      value: JSON.stringify({ label: NEW_LABEL }),
    }
  );

  // Verify the label landed
  const colsAfter = await fetchColumns(SOR_LINES_BOARD);
  const colAfter = colsAfter.find((c) => c.id === PAYMENT_STATUS_COL);
  const labelsAfter = colAfter ? parseStatusLabels(colAfter.settings_str) : [];
  const added = labelsAfter.find((l) => l.label === NEW_LABEL);
  if (!added) {
    throw new Error("Pending Receipt label did not appear after write");
  }
  console.log(
    `  [created] label "${NEW_LABEL}" id=${added.id} on ${PAYMENT_STATUS_COL}`
  );

  // Revert the probe item back to blank
  await monday(
    `mutation ($boardId: ID!, $itemId: ID!, $col: String!) {
      change_simple_column_value(
        board_id: $boardId,
        item_id: $itemId,
        column_id: $col,
        value: ""
      ) { id }
    }`,
    {
      boardId: String(SOR_LINES_BOARD),
      itemId: probeId,
      col: PAYMENT_STATUS_COL,
    }
  );
  console.log(`  [revert] probe item ${probeId} Payment Status cleared`);
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const mode = flags.write ? "WRITE" : "DRY-RUN";
  console.log(`=== migrate_rcti_cycle_column — ${mode} ===\n`);

  console.log("Step 1 — ensure 🗓️ RCTI Payment Cycle column on SOR Lines");
  const newColId = await ensureBoardRelationColumn(flags.write);

  console.log("\nStep 2 — ensure Pending Receipt label on Payment Status");
  await ensurePendingReceiptLabel(flags.write);

  console.log("\n=== Migration complete ===");
  if (newColId) {
    console.log(
      `\nWire the new column id into sync_sor_extract.ts COLUMN map:\n` +
        `  RCTI_CYCLE: "${newColId}",`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
