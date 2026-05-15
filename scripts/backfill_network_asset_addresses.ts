/**
 * scripts/backfill_network_asset_addresses.ts — Work C (May 2026)
 *
 * Most Network Assets imported recently have a null location_mm2tdnnh
 * (Address) — the upstream import pipeline didn't carry the address
 * through. The Active Jobs board's location_mm2tm61g column holds the
 * UGL-supplied address for each asset (set at job-creation time from
 * the work-orders xlsx). This script lifts that address up onto the
 * Network Assets row so downstream readers (defect detail page,
 * Work B defect backfill) can resolve a populated Address from the
 * Network Asset alone.
 *
 * Algorithm:
 *   Phase 1 — paginated walk over Active Jobs (5028084872) collecting
 *     each row's PRIMARY_ASSET relation + LOCATION column. Build a
 *     Map<networkAssetItemId, LocationParsed>. The brief mentions a
 *     reverse board_relation column on Network Assets pointing to
 *     Active Jobs — but it isn't in the existing constants and looks
 *     unverified. Walking Active Jobs once + grouping by PRIMARY_ASSET
 *     is the same join, executes in a single board walk, and lines up
 *     with import_work_orders.ts's existing ACTIVE_COL.PRIMARY_ASSET
 *     constant ("board_relation_mm2tyedq" verified live).
 *
 *   Phase 2 — paginated walk over Network Assets (5028087505); flag
 *     rows whose location_mm2tdnnh is null AND that have a match in
 *     the Phase-1 map.
 *
 *   Phase 3 — plan writes. Skip rows without a matching Active Job
 *     (orphan assets — likely unreleased work) and rows whose
 *     matching Active Job also has a null LOCATION (no upstream data
 *     to lift — log it).
 *
 *   Phase 4 — apply (only with --write). Rate-limited 100ms between
 *     mutations.
 *
 * Idempotency: rows with non-null location_mm2tdnnh skip in Phase 2,
 * so re-runs after a successful pass are no-ops.
 *
 * Usage:
 *   MONDAY_API_TOKEN=xxx npm run backfill-network-asset-addresses
 *   MONDAY_API_TOKEN=xxx npm run backfill-network-asset-addresses -- --write
 *
 * Recommended sequence: run THIS script first, then re-run Work B
 * (backfill_defect_asset_data.ts) to pick up the now-populated
 * Network Asset addresses on defect rows.
 */

const NETWORK_ASSETS_BOARD = 5028087505;
const ACTIVE_JOBS_BOARD = 5028084872;

const NETWORK_ASSET_COL = {
  ADDRESS: "location_mm2tdnnh", // WRITE target
} as const;

const ACTIVE_JOB_COL = {
  PRIMARY_ASSET: "board_relation_mm2tyedq", // → Network Assets relation
  LOCATION: "location_mm2tm61g", // source for the address
} as const;

const WRITE_RATE_LIMIT_MS = 100;

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
          `[backfill-na-addr] ${label}: 429, sleeping ${wait}ms (attempt ${attempt + 2}/5)`
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Types + helpers ----------

interface RawCol {
  id: string;
  text: string | null;
  value: string | null;
  linked_item_ids?: string[];
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

function colMap(values: RawCol[]): Record<string, RawCol> {
  const m: Record<string, RawCol> = {};
  for (const c of values) m[c.id] = c;
  return m;
}

interface LocationParsed {
  address: string | null;
  lat: number | null;
  lng: number | null;
  raw: Record<string, unknown> | null;
}

function parseLocationCol(col: RawCol | undefined): LocationParsed {
  const empty: LocationParsed = { address: null, lat: null, lng: null, raw: null };
  if (!col) return empty;
  const text = col.text?.trim() || null;
  if (!col.value) return { ...empty, address: text };
  try {
    const parsed = JSON.parse(col.value) as Record<string, unknown>;
    const lat =
      typeof parsed.lat === "number"
        ? parsed.lat
        : typeof parsed.lat === "string"
          ? parseFloat(parsed.lat) || null
          : null;
    const lng =
      typeof parsed.lng === "number"
        ? parsed.lng
        : typeof parsed.lng === "string"
          ? parseFloat(parsed.lng) || null
          : null;
    return { address: text, lat, lng, raw: parsed };
  } catch {
    return { ...empty, address: text };
  }
}

async function fetchAllItems(
  boardId: number,
  colIds: string[],
  label: string
): Promise<RawItem[]> {
  const all: RawItem[] = [];
  let cursor: string | null = null;
  for (let pg = 1; pg <= 50; pg++) {
    interface FirstPageResp {
      boards?: Array<{ items_page: RawPage }>;
    }
    interface NextPageResp {
      next_items_page?: RawPage;
    }
    // Note: we need linked_item_ids on BoardRelationValue so the
    // PRIMARY_ASSET column resolves to its linked Network Asset id.
    // Use a typed fragment via `... on BoardRelationValue`.
    const data: FirstPageResp & NextPageResp = cursor
      ? await mondayWithRetry<NextPageResp>(
          `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor
              items {
                id name
                column_values(ids: $col) {
                  id text value
                  ... on BoardRelationValue { linked_item_ids }
                }
              }
            }
          }`,
          { cursor, col: colIds },
          `${label}-page${pg}`
        )
      : await mondayWithRetry<FirstPageResp>(
          `query ($boardId: ID!, $col: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor
                items {
                  id name
                  column_values(ids: $col) {
                    id text value
                    ... on BoardRelationValue { linked_item_ids }
                  }
                }
              }
            }
          }`,
          { boardId: String(boardId), col: colIds },
          `${label}-page${pg}`
        );

    const page: RawPage = cursor
      ? (data as NextPageResp).next_items_page!
      : (data as FirstPageResp).boards![0]!.items_page;

    all.push(...page.items);
    console.log(
      `  ${label} page ${pg}: +${page.items.length} (cumulative ${all.length})`
    );
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return all;
}

// ---------- Planning + apply ----------

interface PlannedWrite {
  networkAssetId: string;
  networkAssetName: string;
  sourceActiveJobId: string;
  /** Will write { [NETWORK_ASSET_COL.ADDRESS]: rawLocationJson }. */
  cols: Record<string, unknown>;
  summary: string;
}

async function applyWrite(
  itemId: string,
  cols: Record<string, unknown>,
  label: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await mondayWithRetry<{ change_multiple_column_values: { id: string } }>(
      `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
        change_multiple_column_values(
          board_id: $boardId,
          item_id: $itemId,
          column_values: $cols
        ) { id }
      }`,
      {
        boardId: String(NETWORK_ASSETS_BOARD),
        itemId,
        cols: JSON.stringify(cols),
      },
      label
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- CLI ----------

interface Flags {
  write: boolean;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  return { write: argv.some((a) => a === "--write") };
}

// ---------- Main ----------

async function main(): Promise<void> {
  const flags = parseFlags();
  const mode = flags.write ? "WRITE" : "DRY-RUN";
  console.log(`=== backfill_network_asset_addresses — ${mode} ===\n`);

  // --- Phase 1: Active Jobs walk → naId → location map ---
  console.log("Phase 1 — fetching Active Jobs board…");
  const jobItems = await fetchAllItems(
    ACTIVE_JOBS_BOARD,
    [ACTIVE_JOB_COL.PRIMARY_ASSET, ACTIVE_JOB_COL.LOCATION],
    "active-jobs"
  );

  // One Active Job may link to one Network Asset (1:1 in practice).
  // When multiple jobs share the same Network Asset, keep the first
  // job with a non-empty location — first-write-wins, logged.
  const addressByNetworkAssetId = new Map<
    string,
    { activeJobId: string; location: LocationParsed }
  >();
  let jobsWithRelation = 0;
  let jobsWithLocation = 0;
  let collisions = 0;
  for (const it of jobItems) {
    const cv = colMap(it.column_values);
    const linked = cv[ACTIVE_JOB_COL.PRIMARY_ASSET]?.linked_item_ids ?? [];
    if (linked.length === 0) continue;
    jobsWithRelation += 1;
    const loc = parseLocationCol(cv[ACTIVE_JOB_COL.LOCATION]);
    if (!loc.raw && !loc.address) continue;
    jobsWithLocation += 1;
    const naId = linked[0]; // 1:1 in practice
    if (addressByNetworkAssetId.has(naId)) {
      collisions += 1;
      continue;
    }
    addressByNetworkAssetId.set(naId, { activeJobId: it.id, location: loc });
  }
  console.log(
    `  active jobs scanned: ${jobItems.length}\n` +
      `  jobs with PRIMARY_ASSET set: ${jobsWithRelation}\n` +
      `  jobs with non-empty LOCATION: ${jobsWithLocation}\n` +
      `  unique network-asset → location entries: ${addressByNetworkAssetId.size}\n` +
      `  jobs ignored due to NA collision: ${collisions}`
  );

  // --- Phase 2: Network Assets walk ---
  console.log("\nPhase 2 — fetching Network Assets board…");
  const naItems = await fetchAllItems(
    NETWORK_ASSETS_BOARD,
    [NETWORK_ASSET_COL.ADDRESS],
    "network-assets"
  );

  // --- Phase 3: plan writes ---
  console.log("\nPhase 3 — planning writes…");
  const plans: PlannedWrite[] = [];
  let alreadyPopulated = 0;
  let noMatch = 0;
  for (const it of naItems) {
    const cv = colMap(it.column_values);
    const current = parseLocationCol(cv[NETWORK_ASSET_COL.ADDRESS]);
    if (current.address || current.raw) {
      alreadyPopulated += 1;
      continue;
    }
    const source = addressByNetworkAssetId.get(it.id);
    if (!source) {
      noMatch += 1;
      continue;
    }
    // Prefer monday's raw JSON for write (preserves lat/lng/place_id);
    // fall back to text-only when raw is null.
    const cols: Record<string, unknown> = {};
    if (source.location.raw) {
      cols[NETWORK_ASSET_COL.ADDRESS] = source.location.raw;
    } else if (source.location.address) {
      cols[NETWORK_ASSET_COL.ADDRESS] = { address: source.location.address };
    } else {
      // Shouldn't be reachable — we filtered empty-location jobs in
      // Phase 1 — but be defensive.
      noMatch += 1;
      continue;
    }
    plans.push({
      networkAssetId: it.id,
      networkAssetName: it.name,
      sourceActiveJobId: source.activeJobId,
      cols,
      summary: `[matched] na=${it.id} (${it.name}) ← job=${source.activeJobId} addr="${source.location.address ?? "(coords only)"}"`,
    });
  }
  console.log(
    `  network assets scanned: ${naItems.length}\n` +
      `  already populated (skip): ${alreadyPopulated}\n` +
      `  no Active Job match (skip): ${noMatch}\n` +
      `  matched (will-write): ${plans.length}`
  );

  console.log("\nSample plans:");
  for (const p of plans.slice(0, 5)) {
    console.log(`  ${p.summary}`);
  }

  if (!flags.write) {
    console.log(
      `\nDRY-RUN complete — ${plans.length} writes would land if this were live. ` +
        `Re-run with --write to apply.`
    );
    return;
  }

  // --- Phase 4: apply ---
  console.log(`\nPhase 4 — applying ${plans.length} writes (${WRITE_RATE_LIMIT_MS}ms between calls)…`);
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    const r = await applyWrite(p.networkAssetId, p.cols, `na-${p.networkAssetId}`);
    if (r.ok) {
      ok += 1;
      if ((i + 1) % 20 === 0 || i === plans.length - 1) {
        console.log(`  progress: ${i + 1}/${plans.length} (ok=${ok} failed=${failed})`);
      }
    } else {
      failed += 1;
      console.error(`  FAILED na=${p.networkAssetId}: ${r.error}`);
    }
    if (i < plans.length - 1) await sleep(WRITE_RATE_LIMIT_MS);
  }

  console.log("\n=== Summary ===");
  console.log(`  network assets scanned:       ${naItems.length}`);
  console.log(`  already populated (no-op):    ${alreadyPopulated}`);
  console.log(`  no Active Job match (skip):   ${noMatch}`);
  console.log(`  matched candidates:           ${plans.length}`);
  console.log(`  backfilled (ok):              ${ok}`);
  console.log(`  backfill failed:              ${failed}`);
  console.log(
    `\nNext step: re-run \`npm run backfill-defect-asset-data\` (Work B) to ` +
      `cascade the newly-populated Network Asset addresses onto Defect rows.`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
