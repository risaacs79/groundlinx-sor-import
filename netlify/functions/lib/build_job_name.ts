/**
 * Build the canonical monday item-name for an Active Jobs / Approved & Paid
 * Jobs row.
 *
 * Three cases (Priority 5 Option Z, May 2026 — SOR-first, Asset ID last):
 *
 *   1. Single SOR, Design Qty > 1
 *        {qty}{UOM_short} - {SOR Friendly Name} - {Asset ID}
 *      e.g. "28m - DUCT - 50mm - Cat 1 - OTR - 2URL-20-06-DCT-782"
 *
 *   2. Single SOR, Design Qty <= 1 (qty prefix dropped — "1 pit" adds no info)
 *        {SOR Friendly Name} - {Asset ID}
 *
 *   3. Multi-SOR (2+ SORs on the same asset)
 *        {SOR1} + {SOR2} [+ {SOR3} ...] - {Asset ID}
 *      e.g. "Install P5 Pit + Removal ACM P4/P5 - 000000003206233104"
 *
 * Mirror of scripts/lib/build_job_name.ts in the main field-app repo.
 */

export interface JobNameInput {
  sorItemNames: string[];
  assetIdText: string;
  designQty?: number | null;
  uom?: string | null;
}

function shortUom(uom: string | null | undefined): string {
  if (!uom) return "";
  const u = uom.trim().toLowerCase();
  if (u.includes("metre") || u.includes("meter")) return "m";
  if (u.includes("pit")) return "pit";
  if (u.includes("core bore")) return "core bore";
  if (u.startsWith("each")) return "each";
  return u.replace(/^per\s+/, "");
}

export function buildJobName(input: JobNameInput): string {
  const sorNames = input.sorItemNames
    .filter((n) => n && n.trim())
    .map((n) => n.trim());
  const asset = input.assetIdText?.trim() ?? "";

  if (sorNames.length === 0 || !asset) {
    return asset || sorNames.join(" + ") || "(unnamed)";
  }

  if (sorNames.length > 1) {
    return `${sorNames.join(" + ")} - ${asset}`;
  }

  const sorName = sorNames[0];
  const qty = input.designQty ?? null;
  if (qty != null && qty > 1) {
    const uomShort = shortUom(input.uom);
    return `${qty}${uomShort} - ${sorName} - ${asset}`;
  }
  return `${sorName} - ${asset}`;
}
