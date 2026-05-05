/**
 * Build the canonical monday item-name for an Active Jobs / Approved & Paid
 * Jobs row from the rate-card SOR item names, asset id text, and address.
 *
 * Format (locked in Step 1.6):
 *
 *   <Item names joined with " - "> - <Asset ID> - <Address>
 *
 * Example with two SORs:
 *
 *   N2P - Install P5 Pit - N2P - Remove ACM P4/P5
 *     - 000000003200512558 - 15 LANCASTER AV CASINO
 *
 * Notes
 * -----
 * - Joiner is " - " (space, hyphen-minus, space). The brief uses hyphen
 *   for both the joiner and within the SOR labels themselves; the visual
 *   reads cleanly because the spacing is consistent across both.
 * - The field app's StackedAssetTitle stacks the same data spatially
 *   (Asset ID first, Item names below, Address at the bottom). The
 *   monday item name is a single string so it's ordered with item names
 *   first — that puts the work nature as the leading sortable token in
 *   monday's grid view.
 * - Empty / null parts are dropped so the result never has trailing or
 *   doubled separators ("X -  - Y", "X - " etc.).
 *
 * Used by:
 * - scripts/sync_sor_extract.ts (Step 2 work order import — names new
 *   Active Jobs and Approved rows)
 * - any future bulk-create utilities that need consistent item names
 */
export function buildJobName(
  sorItemNames: string[],
  assetIdText: string,
  address: string | null
): string {
  const parts: string[] = [];

  for (const name of sorItemNames) {
    if (name && name.trim()) parts.push(name.trim());
  }

  const trimmedAsset = assetIdText?.trim() ?? "";
  if (trimmedAsset) parts.push(trimmedAsset);

  const trimmedAddress = address?.trim() ?? "";
  if (trimmedAddress) parts.push(trimmedAddress);

  if (parts.length === 0) {
    // Defensive: should never happen because callers guard, but if all
    // three inputs are empty fall back to a sentinel rather than ""
    // (monday rejects empty item names).
    return "(unnamed)";
  }

  return parts.join(" - ");
}
