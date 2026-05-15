/**
 * scripts/backfill_defect_asset_data.ts — Work B (May 2026)
 *
 * Defect rows imported by the (still-unfixed) upstream pipeline land
 * with the long-form zero-padded UGL asset number in text_mm0y9gt4
 * (Asset ID) and a null location_mm12kbq5 (Address). Older defects
 * have the structured Asset ID ("2URL-20-06-PIT-743") and full
 * Address populated. This script lifts new defects up to that older
 * shape by joining against the Network Assets board where the
 * long-form number lives in the item NAME and the structured Asset
 * ID + Address sit on dedicated columns.
 *
 * Algorithm:
 *   Phase 1 — paginated walk over Defects (5027567416)
 *     Collect rows where text_mm0y9gt4 matches /^0+\d+$/ (i.e. the
 *     19-digit zero-padded number, NOT the structured 2URL-… format).
 *     Strip leading zeros to get the canonical UGL number.
 *
 *   Phase 2 — paginated walk over Network Assets (5028087505)
 *     Build a Map<canonicalUglNumber, { structuredAssetId, address,
 *     lat, lng }>. The canonical key matches each Network Asset's
 *     item NAME after a leading-zero strip — which is how the brief
 *     describes the join.
 *
 *   Phase 3 — plan writes
 *     For each candidate Defect, look up its match in the Network
 *     Asset map. Three outcomes:
 *       • matched + Network Asset has populated fields → write both
 *         text_mm0y9gt4 + location_mm12kbq5
 *       • matched but Network Asset's fields are ALSO empty (the
 *         Network Asset itself wasn't enriched yet — that's Work C)
 *         → skip with "network-asset-empty" reason
 *       • no Network Asset found at all → skip with "no-match" reason
 *
 *   Phase 4 — apply (only when --write flag set)
 *     change_multiple_column_values per row, rate-limited 100ms
 *     between writes (10 writes/sec, well under monday's 60/min
 *     soft limit on complex queries).
 *
 * Idempotency: rows whose text_mm0y9gt4 is already structured (does
 * NOT match the zero-padded regex) are skipped in Phase 1, so
 * re-runs after a successful pass are no-ops. Phase 2 + 4 still
 * execute the read walk + the (empty) write loop — cheap.
 *
 * Usage:
 *   MONDAY_API_TOKEN=xxx npm run backfill-defect-asset-data            # dry-run
 *   MONDAY_API_TOKEN=xxx npm run backfill-defect-asset-data -- --write
 *
 * Does NOT touch text_mm0ymh1q (Defect ID) — Asset ID + Address only.
 */

const DEFECTS_BOARD = 5027567416;
const NETWORK_ASSETS_BOARD = 5028087505;

const DEFECT_COL = {
  DEFECT_ID: "text_mm0ymh1q", // read-only here — never written
  ASSET_ID: "text_mm0y9gt4", // WRITE target
  ADDRESS: "location_mm12kbq5", // WRITE target
} as const;

const NETWORK_ASSET_COL = {
  STRUCTURED_ASSET_ID: "text_mm2tmm57",
  ADDRESS: "location_mm2tdnnh",
} as const;

const WRITE_RATE_LIMIT_MS = 100; // 10 writes/sec; monday allows 60/min complex

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
          `[backfill-defects] ${label}: 429, sleeping ${wait}ms (attempt ${attempt + 2}/5)`
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

// ---------- Phase 1: Defects walk ----------

interface RawCol {
  id: string;
  text: string | null;
  value: string | null;
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
    const data: FirstPageResp & NextPageResp = cursor
      ? await mondayWithRetry<NextPageResp>(
          `query ($cursor: String!, $col: [String!]) {
            next_items_page(limit: 500, cursor: $cursor) {
              cursor
              items {
                id name
                column_values(ids: $col) { id text value }
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
                  column_values(ids: $col) { id text value }
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

// ---------- Helpers ----------

const ZERO_PADDED_RE = /^0+\d+$/;

function isZeroPadded(value: string | null | undefined): boolean {
  if (!value) return false;
  return ZERO_PADDED_RE.test(value.trim());
}

function stripLeadingZeros(value: string): string {
  return value.trim().replace(/^0+/, "");
}

/** Parse the monday location column's value JSON into {address, lat, lng}.
 *  The raw `text` field is the human-readable address; `value` is the
 *  JSON object monday's column-mutation API also expects on write, so
 *  we round-trip the same shape. */
interface LocationParsed {
  address: string | null;
  lat: number | null;
  lng: number | null;
  /** The raw JSON parsed from `value` — what monday expects back on write
   *  (it accepts `address` / `lat` / `lng` / `place_id` etc). */
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

function colMap(values: RawCol[]): Record<string, RawCol> {
  const m: Record<string, RawCol> = {};
  for (const c of values) m[c.id] = c;
  return m;
}

// ---------- Planning + apply ----------

interface DefectCandidate {
  itemId: string;
  itemName: string;
  /** Raw text_mm0y9gt4 value — the zero-padded number we'll join on. */
  paddedAssetId: string;
  /** stripLeadingZeros(paddedAssetId) — the canonical UGL number used
   *  as the lookup key against the Network Assets map. */
  canonicalKey: string;
  /** Whether the defect's current location is empty (true) or already
   *  populated (false). We still re-write Asset ID even when the
   *  address is non-empty — see brief. */
  addressEmpty: boolean;
}

interface NetworkAssetEntry {
  itemId: string;
  itemName: string;
  /** text_mm2tmm57 — structured Asset ID ("2URL-20-06-PIT-743"). */
  structuredAssetId: string | null;
  /** Parsed location_mm2tdnnh. */
  location: LocationParsed;
}

interface PlannedWrite {
  defectItemId: string;
  defectName: string;
  paddedAssetId: string;
  matchedNetworkAssetId: string | null;
  /** Reason for skipping when applicable. */
  skipReason: "no-match" | "network-asset-empty" | null;
  /** Will write these column values when applied. Empty when skipped. */
  cols: Record<string, unknown>;
  /** Sample of human-readable change summary for the dry-run log. */
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
        boardId: String(DEFECTS_BOARD),
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
  console.log(`=== backfill_defect_asset_data — ${mode} ===\n`);

  // --- Phase 1: Defects walk ---
  console.log("Phase 1 — fetching Defects board…");
  const defectItems = await fetchAllItems(
    DEFECTS_BOARD,
    [DEFECT_COL.ASSET_ID, DEFECT_COL.ADDRESS, DEFECT_COL.DEFECT_ID],
    "defects"
  );

  const candidates: DefectCandidate[] = [];
  let alreadyStructured = 0;
  let blankAssetId = 0;
  for (const it of defectItems) {
    const cv = colMap(it.column_values);
    const padded = cv[DEFECT_COL.ASSET_ID]?.text?.trim() ?? null;
    if (!padded) {
      blankAssetId += 1;
      continue;
    }
    if (!isZeroPadded(padded)) {
      alreadyStructured += 1;
      continue;
    }
    const addressEmpty = !cv[DEFECT_COL.ADDRESS]?.text?.trim();
    candidates.push({
      itemId: it.id,
      itemName: it.name,
      paddedAssetId: padded,
      canonicalKey: stripLeadingZeros(padded),
      addressEmpty,
    });
  }

  console.log(
    `  defects scanned: ${defectItems.length}\n` +
      `  already structured (skip): ${alreadyStructured}\n` +
      `  blank Asset ID (skip): ${blankAssetId}\n` +
      `  candidates needing backfill: ${candidates.length}`
  );

  if (candidates.length === 0) {
    console.log("\nNothing to do — every defect already has a structured Asset ID.");
    return;
  }

  // --- Phase 2: Network Assets walk + map build ---
  console.log("\nPhase 2 — fetching Network Assets board…");
  const naItems = await fetchAllItems(
    NETWORK_ASSETS_BOARD,
    [NETWORK_ASSET_COL.STRUCTURED_ASSET_ID, NETWORK_ASSET_COL.ADDRESS],
    "network-assets"
  );

  const naByCanonical = new Map<string, NetworkAssetEntry>();
  for (const it of naItems) {
    const cv = colMap(it.column_values);
    const canonical = stripLeadingZeros(it.name);
    if (!canonical) continue;
    // Skip if duplicate canonical key — first-write-wins, log the
    // collision so the operator can disambiguate later. Should be
    // rare; the Network Assets board's item.name comes from the same
    // UGL feed so cross-asset collisions on the canonical key would
    // signal upstream data quality issues.
    if (naByCanonical.has(canonical)) {
      console.warn(
        `  [collision] duplicate Network Asset canonical key "${canonical}" — keeping ${naByCanonical.get(canonical)!.itemId}, ignoring ${it.id}`
      );
      continue;
    }
    naByCanonical.set(canonical, {
      itemId: it.id,
      itemName: it.name,
      structuredAssetId: cv[NETWORK_ASSET_COL.STRUCTURED_ASSET_ID]?.text?.trim() || null,
      location: parseLocationCol(cv[NETWORK_ASSET_COL.ADDRESS]),
    });
  }
  console.log(`  Network Assets indexed: ${naByCanonical.size}`);

  // --- Phase 3: plan writes ---
  console.log("\nPhase 3 — planning writes…");
  const plans: PlannedWrite[] = [];
  for (const c of candidates) {
    const na = naByCanonical.get(c.canonicalKey);
    if (!na) {
      plans.push({
        defectItemId: c.itemId,
        defectName: c.itemName,
        paddedAssetId: c.paddedAssetId,
        matchedNetworkAssetId: null,
        skipReason: "no-match",
        cols: {},
        summary: `[no-match] canonical=${c.canonicalKey}`,
      });
      continue;
    }
    const naEmpty = !na.structuredAssetId && !na.location.address;
    if (naEmpty) {
      plans.push({
        defectItemId: c.itemId,
        defectName: c.itemName,
        paddedAssetId: c.paddedAssetId,
        matchedNetworkAssetId: na.itemId,
        skipReason: "network-asset-empty",
        cols: {},
        summary: `[network-asset-empty] canonical=${c.canonicalKey} (run Work C first)`,
      });
      continue;
    }

    const cols: Record<string, unknown> = {};
    const changes: string[] = [];
    if (na.structuredAssetId) {
      cols[DEFECT_COL.ASSET_ID] = na.structuredAssetId;
      changes.push(`assetId=${na.structuredAssetId}`);
    }
    if (na.location.raw) {
      // Round-trip monday's raw location shape so lat/lng/place_id all
      // survive. monday's column-mutation API accepts the same JSON
      // shape it returns on read.
      cols[DEFECT_COL.ADDRESS] = na.location.raw;
      changes.push(`address="${na.location.address ?? "(coords only)"}"`);
    } else if (na.location.address) {
      // Fallback: only the human-readable text is available — monday
      // accepts { address: "<text>" } and re-geocodes server-side.
      cols[DEFECT_COL.ADDRESS] = { address: na.location.address };
      changes.push(`address="${na.location.address}" (text-only, will re-geocode)`);
    }

    if (Object.keys(cols).length === 0) {
      // Shouldn't happen given the naEmpty gate above, but defensive.
      plans.push({
        defectItemId: c.itemId,
        defectName: c.itemName,
        paddedAssetId: c.paddedAssetId,
        matchedNetworkAssetId: na.itemId,
        skipReason: "network-asset-empty",
        cols: {},
        summary: `[network-asset-empty-late] canonical=${c.canonicalKey}`,
      });
      continue;
    }

    plans.push({
      defectItemId: c.itemId,
      defectName: c.itemName,
      paddedAssetId: c.paddedAssetId,
      matchedNetworkAssetId: na.itemId,
      skipReason: null,
      cols,
      summary: `[matched] na=${na.itemId} ${changes.join(" ")}`,
    });
  }

  const matched = plans.filter((p) => p.skipReason === null);
  const skippedNoMatch = plans.filter((p) => p.skipReason === "no-match");
  const skippedEmptyNa = plans.filter(
    (p) => p.skipReason === "network-asset-empty"
  );
  console.log(`  matched (will-write): ${matched.length}`);
  console.log(`  skipped — no Network Asset match: ${skippedNoMatch.length}`);
  console.log(`  skipped — Network Asset has empty fields: ${skippedEmptyNa.length}`);

  // Sample the first 5 of each bucket for the dry-run log.
  console.log("\nSample plans:");
  for (const p of matched.slice(0, 5)) {
    console.log(`  defect=${p.defectItemId} ${p.summary}`);
  }
  for (const p of skippedNoMatch.slice(0, 5)) {
    console.log(`  defect=${p.defectItemId} ${p.summary}`);
  }
  for (const p of skippedEmptyNa.slice(0, 5)) {
    console.log(`  defect=${p.defectItemId} ${p.summary}`);
  }

  if (!flags.write) {
    console.log(
      `\nDRY-RUN complete — ${matched.length} writes would land if this were live. ` +
        `Re-run with --write to apply.`
    );
    return;
  }

  // --- Phase 4: apply ---
  console.log(`\nPhase 4 — applying ${matched.length} writes (${WRITE_RATE_LIMIT_MS}ms between calls)…`);
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < matched.length; i++) {
    const p = matched[i];
    const r = await applyWrite(
      p.defectItemId,
      p.cols,
      `defect-${p.defectItemId}`
    );
    if (r.ok) {
      ok += 1;
      if ((i + 1) % 20 === 0 || i === matched.length - 1) {
        console.log(`  progress: ${i + 1}/${matched.length} (ok=${ok} failed=${failed})`);
      }
    } else {
      failed += 1;
      console.error(`  FAILED defect=${p.defectItemId}: ${r.error}`);
    }
    if (i < matched.length - 1) await sleep(WRITE_RATE_LIMIT_MS);
  }

  console.log("\n=== Summary ===");
  console.log(`  defects scanned:           ${defectItems.length}`);
  console.log(`  candidates:                ${candidates.length}`);
  console.log(`  backfilled (ok):           ${ok}`);
  console.log(`  backfill failed:           ${failed}`);
  console.log(`  skipped (no NA match):     ${skippedNoMatch.length}`);
  console.log(`  skipped (NA empty fields): ${skippedEmptyNa.length}`);
  console.log(
    `  already structured (no-op): ${alreadyStructured}`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
