/**
 * Build the canonical monday item-name for an Active Jobs / Approved & Paid
 * Jobs row.
 *
 * Three cases (Priority 5 hybrid pattern, May 2026):
 *
 *   1. Single SOR, Design Qty > 1
 *        {qty}{UOM_short} - {Asset ID} - {SOR Friendly Name}
 *      e.g. "28m - 2URL-20-06-DCT-782 - DUCT - 50mm - Cat 1 - OTR"
 *
 *   2. Single SOR, Design Qty <= 1 (qty prefix dropped — "1 pit" adds no info)
 *        {Asset ID} - {SOR Friendly Name}
 *
 *   3. Multi-SOR (2+ SORs on the same asset)
 *        {Job Type} - {Asset ID} - {SOR1} + {SOR2} [+ {SOR3} ...]
 *      e.g. "ACM Pit + New Pit - 000000003206182624 - Pit Riser + Install P5 Pit + Removal ACM P2"
 *
 * Mirror of scripts/lib/build_job_name.ts in the main field-app repo.
 */

export interface JobNameInput {
  sorItemNames: string[];
  assetIdText: string;
  designQty?: number | null;
  uom?: string | null;
  jobType?: string | null;
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
    const prefix = input.jobType?.trim() || "Combined";
    return `${prefix} - ${asset} - ${sorNames.join(" + ")}`;
  }

  const sorName = sorNames[0];
  const qty = input.designQty ?? null;
  if (qty != null && qty > 1) {
    const uomShort = shortUom(input.uom);
    return `${qty}${uomShort} - ${asset} - ${sorName}`;
  }
  return `${asset} - ${sorName}`;
}
