/**
 * UGL Artefact catalogue (DATA) — auto-generated from
 * 2000-0505-SORA-DOC-NBN-N2P Atlas 6.0 'Artefacts - Requirements' sheet.
 *
 * 180 artefacts across 7 sections,
 * 63 distinct UGL SOR codes,
 * 564 (SOR × artefact) pairs.
 *
 * Source of truth is UGL. Regenerate via:
 *   python3 scripts/generate_ugl_artefacts.py
 * Don't hand-edit this file — change the source xlsx and re-run.
 *
 * Helpers (artefactsForSor, filterArtefactsByMethod, etc.) live in
 * the sibling hand-written ugl-artefacts.ts file, which re-exports
 * the UGL_ARTEFACTS array from here.
 */

export type UglArtefact = {
  /** UGL artefact number, e.g. "1.1.3". Stable across atlas revisions. */
  number: string;
  /** UGL section header text, verbatim, e.g. "1 - Conduit". */
  section: string;
  /** UGL item label, e.g. "Conduit Install". */
  item: string;
  /** UGL category label inside an item, verbatim, e.g. "Open Cut Excavation". */
  category: string;
  /** UGL artefact requirement text, e.g. "Depth of conduit shown with measuring tape". */
  description: string;
  /** UGL SOR codes this artefact is required for. */
  sorCodes: string[];
};

export const UGL_ARTEFACTS: UglArtefact[] = [
  { number: "1.1.1", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Before Photos", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.2", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Open trench with conduit installed", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.3", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Depth of conduit shown with measuring tape", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.4", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Marker tape installed", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.5", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Completed conduit entering pit, with rope installed and secured", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.6", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Conduit Entry (Bush) depth shown with measuring tape", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.7", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Trench measurement", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.8", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Site reinstated", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.9", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "More than 5m of rope inside pit showing pole riser in the background", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.10", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "Starter pipe not more than 100mm above ground level - bend must be buried below ground level.", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.1.11", section: "1 - Conduit", item: "Conduit Install", category: "Open Cut Excavation", description: "More than 5m of rope inside pit showing pole riser in the background", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.2.1", section: "1 - Conduit", item: "Conduit Install", category: "Directional Drilling/Grundo Mat", description: "Before  Photos", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.2.2", section: "1 - Conduit", item: "Conduit Install", category: "Directional Drilling/Grundo Mat", description: "Photo evidence of directional drill/Grundo completing boring", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.2.3", section: "1 - Conduit", item: "Conduit Install", category: "Directional Drilling/Grundo Mat", description: "Bore log (not required for Grundo-Mat)", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.2.4", section: "1 - Conduit", item: "Conduit Install", category: "Directional Drilling/Grundo Mat", description: "Completed conduit entering pit, with rope installed and secured", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.2.5", section: "1 - Conduit", item: "Conduit Install", category: "Directional Drilling/Grundo Mat", description: "Conduit Entry (Bush) depth shown with measuring tape", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.2.6", section: "1 - Conduit", item: "Conduit Install", category: "Directional Drilling/Grundo Mat", description: "Photo of site reinstatement", sorCodes: ["CW-01-01-03", "CW-01-01-04", "CW-01-01-22", "CW-01-01-23", "CW-01-01-24", "CW-01-01-25", "CW-01-01-26", "CW-01-01-27", "CW-01-01-28", "CW-01-01-29", "CW-01-01-30", "CW-01-01-31", "CW-01-01-32", "CW-01-01-33", "CW-01-01-34", "CW-01-01-35"] },
  { number: "1.3.1", section: "1 - Conduit", item: "Conduit Install", category: "Core Bore", description: "Photo of manhole duct face before core bore", sorCodes: ["CW-03-01-01"] },
  { number: "1.3.2", section: "1 - Conduit", item: "Conduit Install", category: "Core Bore", description: "Photo of duct bush installed and label attached.", sorCodes: ["CW-03-01-01"] },
  { number: "1.4.1", section: "1 - Conduit", item: "Conduit Install", category: "Pole riser", description: "Photo of pole before riser installation showing background", sorCodes: ["CW-01-01-05"] },
  { number: "1.4.2", section: "1 - Conduit", item: "Conduit Install", category: "Pole riser", description: "Photo of riser after installation showing background", sorCodes: ["CW-01-01-05"] },
  { number: "1.4.3", section: "1 - Conduit", item: "Conduit Install", category: "Pole riser", description: "Photo of mower guard installed", sorCodes: ["CW-01-01-05"] },
  { number: "1.4.4", section: "1 - Conduit", item: "Conduit Install", category: "Pole riser", description: "Photo of rope installed in pole riser", sorCodes: ["CW-01-01-05"] },
  { number: "1.4.5", section: "1 - Conduit", item: "Conduit Install", category: "Pole riser", description: "Photo of pole riser position in relation to direction of traffic - minimum of 5 saddles at 750mm maximum spacing", sorCodes: ["CW-01-01-05"] },
  { number: "1.4.6", section: "1 - Conduit", item: "Conduit Install", category: "Pole riser", description: "Pole ID", sorCodes: ["CW-01-01-05"] },
  { number: "1.4.7", section: "1 - Conduit", item: "Conduit Install", category: "Pole riser", description: "Last saddle is within 50~100mm of the top of the pole riser", sorCodes: ["CW-01-01-05"] },
  { number: "1.4.8", section: "1 - Conduit", item: "Conduit Install", category: "Pole riser", description: "Rope around zip tie with one loop and zip tie cut off", sorCodes: ["CW-01-01-05"] },
  { number: "2.1.1", section: "2 - Pits", item: "Pits", category: "Pit Riser", description: "Photo of existing pit/pole before installation", sorCodes: ["CW-02-01-05"] },
  { number: "2.1.2", section: "2 - Pits", item: "Pits", category: "Pit Riser", description: "Photo of plastic wrap around pit", sorCodes: ["CW-02-01-05"] },
  { number: "2.1.3", section: "2 - Pits", item: "Pits", category: "Pit Riser", description: "Photo of riser installed", sorCodes: ["CW-02-01-05"] },
  { number: "2.1.4", section: "2 - Pits", item: "Pits", category: "Pit Riser", description: "Photo of pit tag", sorCodes: ["CW-02-01-05"] },
  { number: "2.1.5", section: "2 - Pits", item: "Pits", category: "Pit Riser", description: "Photo of reinstatement (minimum 50mm top soil and seed)", sorCodes: ["CW-02-01-05"] },
  { number: "2.1.6", section: "2 - Pits", item: "Pits", category: "Pit Riser", description: "Photo of support bar for existing joints (fibre glass strap)", sorCodes: ["CW-02-01-05"] },
  { number: "2.1.7", section: "2 - Pits", item: "Pits", category: "Pit Riser", description: "Photo stainless steel screws every 100mm", sorCodes: ["CW-02-01-05"] },
  { number: "2.2.1", section: "2 - Pits", item: "Pits", category: "Pit Lids", description: "Photo evidence of the damaged pit lid to be removed", sorCodes: ["CW-02-01-06", "CW-02-01-08"] },
  { number: "2.2.2", section: "2 - Pits", item: "Pits", category: "Pit Lids", description: "Photo of the newly installed pit lid", sorCodes: ["CW-02-01-06", "CW-02-01-08"] },
  { number: "2.3.1", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Before Photos", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.2", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photos of pit bedding material (crusher dust) prior to pit installation", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.3", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photos of screw spacing every 100mm", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.4", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of stainless steel crews", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.5", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of Reinsatement (50mm top soil and seed at minimum)", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.6", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of bush faces flush with pit wall", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.7", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of bush split installaed at 3 olock or 9 oclock", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.8", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of pit level with ground and ground slope", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.9", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo showing alignment with fenceline or back of kerb", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.10", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of gasket installed the right way up", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.11", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of clean-cut back of acm with seal applied (pva or paint)", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.12", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "P35/P100 duct sleeving", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.13", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of split-conduit glued between acm cement duct and new pvc duct", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.14", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of internal duct with bush installed", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.15", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of existing devices hanged with support bar", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.16", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of black plastic wrap for split pits.", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.17", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of pit spreader bars (Only for P6, P8 & P9)", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.18", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of cross bars (Only for P6, P8 & P9)", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.3.19", section: "2 - Pits", item: "Pits", category: "Pit Installs\nOver existing duct or pit", description: "Photo of Tape measure confirming depth of Pit (Only for P6 and P8 Installs)", sorCodes: ["CW-02-01-30", "CW-02-01-31"] },
  { number: "2.4.1", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Before Photos", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.2", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photos of pit bedding material (crusher dust) prior to pit installation", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.3", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of Reinsatement (50mm top soil and seed at minimum)", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.4", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of bush faces flush with pit wall", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.5", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of bush split installaed at 3 olock or 9 oclock", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.6", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of pit level with ground and ground slope", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.7", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of gasket installed the right way up", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.8", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of pit internals", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.9", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo showing alignment with fenceline or back of kerb", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.10", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of gasket installed the right way up", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.11", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of pit spreader bars (Only for P6, P8 & P9)", sorCodes: ["CW-02-01-32"] },
  { number: "2.4.12", section: "2 - Pits", item: "Pits", category: "Pit Installs\nIn New Locations", description: "Photo of cross bars (Only for P6, P8 & P9)", sorCodes: ["CW-02-01-32"] },
  { number: "2.5.1", section: "2 - Pits", item: "Pits", category: "High Strength Pits", description: "Photo of high Strength pit installed", sorCodes: ["CW-02-01-33"] },
  { number: "2.7.1", section: "2 - Pits", item: "Pits", category: "Pits in Rock", description: "Before Photos", sorCodes: ["CW-02-02-01"] },
  { number: "2.7.2", section: "2 - Pits", item: "Pits", category: "Pits in Rock", description: "Photo of Rock Encountered", sorCodes: ["CW-02-02-01"] },
  { number: "2.8.1", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo evidence of ACM Pit", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.8.2", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo of area before removal", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.8.3", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo of ACM removal leter box drop completed", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.8.4", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo of site setup and worker in ppe", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.8.5", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo of acm bagged and labelled", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.8.6", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo of acm clearance certificate.", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.8.7", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo showing all acm removed", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.8.8", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo post acm removal showing no acm debris or fragments remaining", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.8.9", section: "2 - Pits", item: "Pits", category: "ACM Pit Removal", description: "Photo of disposal receipt", sorCodes: ["CW-02-03-01", "CW-02-03-02", "CW-02-03-03", "CW-02-03-04"] },
  { number: "2.9.1", section: "2 - Pits", item: "Pits", category: "Plastic Pit Removal", description: "Photo of area before removal", sorCodes: ["CW-02-04-01", "CW-02-04-02"] },
  { number: "2.9.2", section: "2 - Pits", item: "Pits", category: "Plastic Pit Removal", description: "Photo of area post removal", sorCodes: ["CW-02-04-01", "CW-02-04-02"] },
  { number: "2.10.1", section: "2 - Pits", item: "Pits", category: "Pit Repair", description: "Before and after photo", sorCodes: ["CW-02-05-01"] },
  { number: "2.11.1", section: "2 - Pits", item: "Pits", category: "Pit Repair", description: "Before and after photo", sorCodes: ["CW-02-05-02"] },
  { number: "2.12.1", section: "2 - Pits", item: "Pits", category: "Manhole Repair", description: "Before and after photo", sorCodes: ["CW-02-05-03"] },
  { number: "2.13.1", section: "2 - Pits", item: "Pits", category: "Manhole Repair", description: "Before and after photo", sorCodes: ["CW-02-05-04"] },
  { number: "2.14.1", section: "2 - Pits", item: "Pits", category: "Pit Repair", description: "Before and after photo", sorCodes: ["CW-02-05-05"] },
  { number: "3.1.1", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Flushing", description: "Photo evidence of blockage location", sorCodes: ["CW-05-01-02"] },
  { number: "3.1.2", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Flushing", description: "Photo of hose in duct", sorCodes: ["CW-05-01-02"] },
  { number: "3.1.3", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Flushing", description: "Photo of hose reel at pit", sorCodes: ["CW-05-01-02"] },
  { number: "3.1.4", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Flushing", description: "Photo of pedestrian signs", sorCodes: ["CW-05-01-02"] },
  { number: "3.2.1", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Vac-Flushing", description: "Photo evidence of blockage location", sorCodes: ["CW-05-01-06"] },
  { number: "3.2.2", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Vac-Flushing", description: "Photo of vacuum unit being utilised", sorCodes: ["CW-05-01-06"] },
  { number: "3.2.3", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Vac-Flushing", description: "Photo of hose reel at pit", sorCodes: ["CW-05-01-06"] },
  { number: "3.2.4", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Vac-Flushing", description: "Photos of vacuum unit in operation", sorCodes: ["CW-05-01-06"] },
  { number: "3.2.5", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Vac-Flushing", description: "Photo of pedestrian signs", sorCodes: ["CW-05-01-06"] },
  { number: "3.3.1", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo evidence of blockage location", sorCodes: ["CW-05-01-05", "CW-05-01-07"] },
  { number: "3.3.2", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo of pedestrian signs", sorCodes: ["CW-05-01-05", "CW-05-01-07"] },
  { number: "3.3.3", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo of blockage repair", sorCodes: ["CW-05-01-05", "CW-05-01-07"] },
  { number: "3.3.4", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Before & After Photos", sorCodes: ["CW-05-01-05", "CW-05-01-07"] },
  { number: "3.3.5", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Reinstatement of surface", sorCodes: ["CW-05-01-05", "CW-05-01-07"] },
  { number: "3.3.6", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo of blockage location once exposed", sorCodes: ["CW-05-01-05", "CW-05-01-07"] },
  { number: "3.4.1", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo evidence of blockage location", sorCodes: ["CW-05-01-04"] },
  { number: "3.4.2", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo of pedestrian signs", sorCodes: ["CW-05-01-04"] },
  { number: "3.4.3", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo of blockage repair", sorCodes: ["CW-05-01-04"] },
  { number: "3.4.4", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo of breakout surface", sorCodes: ["CW-05-01-04"] },
  { number: "3.4.5", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Reinstatement of surface", sorCodes: ["CW-05-01-04"] },
  { number: "3.4.6", section: "3 - Duct Remediation", item: "Duct Remediation", category: "Blockage Repair ", description: "Photo of blockage location once exposed", sorCodes: ["CW-05-01-04"] },
  { number: "4.1.1", section: "4 - Pipe Proving", item: "Pipe Proving", category: "Pipe Proving", description: "Photo of rope being installed, showing mandrel", sorCodes: ["CI-01-01-02"] },
  { number: "4.1.2", section: "4 - Pipe Proving", item: "Pipe Proving", category: "Pipe Proving", description: "Photo of tagged rope showing date, duct id and mandrel achieved", sorCodes: ["CI-01-01-02"] },
  { number: "4.1.3", section: "4 - Pipe Proving", item: "Pipe Proving", category: "Pipe Proving", description: "Photo of wheel measurement", sorCodes: ["CI-01-01-02"] },
  { number: "4.2.1", section: "4 - Pipe Proving", item: "Pipe Proving", category: "Pole Riser Proving", description: "Photo evidence pole riser with no rope", sorCodes: ["CI-01-02-01"] },
  { number: "4.2.2", section: "4 - Pipe Proving", item: "Pipe Proving", category: "Pole Riser Proving", description: "Photo of pole riser once rope installed", sorCodes: ["CI-01-02-01"] },
  { number: "4.2.3", section: "4 - Pipe Proving", item: "Pipe Proving", category: "Pole Riser Proving", description: "Photo of tagged rope", sorCodes: ["CI-01-02-01"] },
  { number: "4.2.4", section: "4 - Pipe Proving", item: "Pipe Proving", category: "Pole Riser Proving", description: "Photo of safety setup for ladder/ewp works", sorCodes: ["CI-01-02-01"] },
  { number: "5.1.1", section: "5 - Haulin", item: "Hauling", category: "Hauling", description: "Photo of cable/batch number printed on cable sheath.", sorCodes: ["CI-02-01-05", "CI-02-01-10", "CI-02-01-11", "CI-02-01-12", "CI-02-01-13"] },
  { number: "5.1.2", section: "5 - Haulin", item: "Hauling", category: "Hauling", description: "Photo of cable serial number", sorCodes: ["CI-02-01-05", "CI-02-01-10", "CI-02-01-11", "CI-02-01-12", "CI-02-01-13"] },
  { number: "5.1.3", section: "5 - Haulin", item: "Hauling", category: "Hauling", description: "Photo of cable labelled", sorCodes: ["CI-02-01-05", "CI-02-01-10", "CI-02-01-11", "CI-02-01-12", "CI-02-01-13"] },
  { number: "5.1.4", section: "5 - Haulin", item: "Hauling", category: "Hauling", description: "Photo of cable looped in pit and tailrope installed", sorCodes: ["CI-02-01-05", "CI-02-01-10", "CI-02-01-11", "CI-02-01-12", "CI-02-01-13"] },
  { number: "5.1.5", section: "5 - Haulin", item: "Hauling", category: "Hauling", description: "Photo of cable coiled in pit start and end", sorCodes: ["CI-02-01-05", "CI-02-01-10", "CI-02-01-11", "CI-02-01-12", "CI-02-01-13"] },
  { number: "5.1.6", section: "5 - Haulin", item: "Hauling", category: "Hauling", description: "Photo evidence of “warning optical fibre” tape (for single fibre cables only)", sorCodes: ["CI-02-01-05", "CI-02-01-10", "CI-02-01-11", "CI-02-01-12", "CI-02-01-13"] },
  { number: "5.1.7", section: "5 - Haulin", item: "Hauling", category: "Hauling", description: "Photo of cable correctly racked in manhole (only if passing through manhole)", sorCodes: ["CI-02-01-05", "CI-02-01-10", "CI-02-01-11", "CI-02-01-12", "CI-02-01-13"] },
  { number: "5.1.8", section: "5 - Haulin", item: "Hauling", category: "Hauling", description: "Photo of tail rope at start and end pit", sorCodes: ["CI-02-01-05", "CI-02-01-10", "CI-02-01-11", "CI-02-01-12", "CI-02-01-13"] },
  { number: "5.2.1", section: "5 - Haulin", item: "Hauling", category: "Hauling SDS", description: "Photo of cable/batch number printed on cable sheath.", sorCodes: ["CI-02-01-14"] },
  { number: "5.2.2", section: "5 - Haulin", item: "Hauling", category: "Hauling SDS", description: "Photo of cable serial number", sorCodes: ["CI-02-01-14"] },
  { number: "5.2.3", section: "5 - Haulin", item: "Hauling", category: "Hauling SDS", description: "Photo of cable labelled", sorCodes: ["CI-02-01-14"] },
  { number: "5.2.4", section: "5 - Haulin", item: "Hauling", category: "Hauling SDS", description: "Photo of cable looped in pit and tailrope installed", sorCodes: ["CI-02-01-14"] },
  { number: "5.2.5", section: "5 - Haulin", item: "Hauling", category: "Hauling SDS", description: "Photo of cable coiled in pit start and end", sorCodes: ["CI-02-01-14"] },
  { number: "5.2.6", section: "5 - Haulin", item: "Hauling", category: "Hauling SDS", description: "Photo evidence of “warning optical fibre” tape (for single fibre cables only)", sorCodes: ["CI-02-01-14"] },
  { number: "5.2.7", section: "5 - Haulin", item: "Hauling", category: "Hauling SDS", description: "Photo of cable correctly racked in manhole (only if passing through manhole)", sorCodes: ["CI-02-01-14"] },
  { number: "5.2.8", section: "5 - Haulin", item: "Hauling", category: "Hauling SDS", description: "Photo of cable with capped as per standards", sorCodes: ["CI-02-01-14"] },
  { number: "6.1.1", section: "6 - Jointing", item: "Fibre Termination", category: "Fibre Termination", description: "Photo of rack location clearly showing rack label", sorCodes: ["FB-05-03-03", "FB-05-03-06", "FB-05-03-07", "FB-05-03-08"] },
  { number: "6.1.2", section: "6 - Jointing", item: "Fibre Termination", category: "Fibre Termination", description: "Photo of telstra seos card & nbn id of the technician who accessed the exchange", sorCodes: ["FB-05-03-03", "FB-05-03-06", "FB-05-03-07", "FB-05-03-08"] },
  { number: "6.1.3", section: "6 - Jointing", item: "Fibre Termination", category: "Fibre Termination", description: "Photos of label on the patch lead packet", sorCodes: ["FB-05-03-03", "FB-05-03-06", "FB-05-03-07", "FB-05-03-08"] },
  { number: "6.1.4", section: "6 - Jointing", item: "Fibre Termination", category: "Fibre Termination", description: "Photo of odf ports showing on the patch lead labels", sorCodes: ["FB-05-03-03", "FB-05-03-06", "FB-05-03-07", "FB-05-03-08"] },
  { number: "6.1.5", section: "6 - Jointing", item: "Fibre Termination", category: "Fibre Termination", description: "Photo of rack location start and end, clearly showing rack label", sorCodes: ["FB-05-03-03", "FB-05-03-06", "FB-05-03-07", "FB-05-03-08"] },
  { number: "6.2.1", section: "6 - Jointing", item: "Jointing", category: "Re-Entry", description: "Photo of joint prior to splicing.", sorCodes: ["MR-01-01-01"] },
  { number: "6.2.2", section: "6 - Jointing", item: "Jointing", category: "Re-Entry", description: "Photo of joint in an existing pit or manhole before splicing", sorCodes: ["MR-01-01-01"] },
  { number: "6.2.3", section: "6 - Jointing", item: "Jointing", category: "Re-Entry", description: "Photo of splice tray with splice completed", sorCodes: ["MR-01-01-01"] },
  { number: "6.2.4", section: "6 - Jointing", item: "Jointing", category: "Re-Entry", description: "Photo of joint correctly remounted and cables coiled.", sorCodes: ["MR-01-01-01"] },
  { number: "6.3.1", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Photo of splice tray with splice completed", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.2", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Photo of joint correctly remounted and cables coiled.", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.3", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Cables coiled and insterted into joint", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.4", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Splice tray with splices completed", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.5", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Splices labelled", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.6", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Joint properly mounted and labelled", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.7", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Cables labelled and entering joint", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.8", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Splice tray showing splices", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.9", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Serial numbers", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.10", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Joint mounted and labelled", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.11", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Cables entering joint", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.12", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Sealant used on cable ports (only flat profile cables require GURO sealant, round profile cables do not require GURO sealant)", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.3.13", section: "6 - Jointing", item: "Jointing", category: "New Joint", description: "Dummy plug installed", sorCodes: ["MR-01-01-02", "MR-01-01-03", "MR-01-01-04"] },
  { number: "6.4.1", section: "6 - Jointing", item: "Jointing", category: "Multiport", description: "Photo of smp installed in pit", sorCodes: ["MR-01-02-01"] },
  { number: "6.4.2", section: "6 - Jointing", item: "Jointing", category: "Multiport", description: "Photo of cables labelled", sorCodes: ["MR-01-02-01"] },
  { number: "6.4.3", section: "6 - Jointing", item: "Jointing", category: "Multiport", description: "Photo of pon and buz test results", sorCodes: ["MR-01-02-01"] },
  { number: "6.4.4", section: "6 - Jointing", item: "Jointing", category: "Multiport", description: "Cable label", sorCodes: ["MR-01-02-01"] },
  { number: "6.4.5", section: "6 - Jointing", item: "Jointing", category: "Multiport", description: "Cable serial number", sorCodes: ["MR-01-02-01"] },
  { number: "6.4.6", section: "6 - Jointing", item: "Jointing", category: "Multiport", description: "SMP serial number", sorCodes: ["MR-01-02-01"] },
  { number: "9.1.1", section: "9- Provisional Sums", item: "Third Party Services", category: "Asset Standby", description: "Written UGL Approval", sorCodes: ["PS-01-01-04"] },
  { number: "9.1.2", section: "9- Provisional Sums", item: "Third Party Services", category: "Asset Standby", description: "DBYD showing requirement", sorCodes: ["PS-01-01-04"] },
  { number: "9.1.3", section: "9- Provisional Sums", item: "Third Party Services", category: "Asset Standby", description: "Invoice from Asset Standby", sorCodes: ["PS-01-01-04"] },
  { number: "9.2.1", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Manhole De-watering", description: "Written UGL Approval", sorCodes: ["PS-01-01-06"] },
  { number: "9.2.2", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Manhole De-watering", description: "Invoice for works", sorCodes: ["PS-01-01-06"] },
  { number: "9.2.3", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Manhole De-watering", description: "Before and after photos", sorCodes: ["PS-01-01-06"] },
  { number: "9.2.4", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Manhole De-watering", description: "Disposal Docket", sorCodes: ["PS-01-01-06"] },
  { number: "9.3.1", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Un-excpexted ACM", description: "Written UGL Approval", sorCodes: ["PS-01-01-06"] },
  { number: "9.3.2", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Un-excpexted ACM", description: "Photo evidence of ACM", sorCodes: ["PS-01-01-06"] },
  { number: "9.3.3", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Un-excpexted ACM", description: "Photo of area before removal", sorCodes: ["PS-01-01-06"] },
  { number: "9.3.4", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Un-excpexted ACM", description: "Photo of acm bagged and labelled", sorCodes: ["PS-01-01-06"] },
  { number: "9.3.5", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Un-excpexted ACM", description: "Photo of acm clearance certificate.", sorCodes: ["PS-01-01-06"] },
  { number: "9.3.6", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Un-excpexted ACM", description: "Photo showing all acm removed", sorCodes: ["PS-01-01-06"] },
  { number: "9.3.7", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Un-excpexted ACM", description: "Photo post acm removal showing no acm debris or fragments remaining", sorCodes: ["PS-01-01-06"] },
  { number: "9.3.8", section: "9- Provisional Sums", item: "Contaminated Waste Removal", category: "Un-excpexted ACM", description: "Photo of disposal receipt", sorCodes: ["PS-01-01-06"] },
  { number: "9.4.1", section: "9- Provisional Sums", item: "Non-standard Reinstatement", category: "Non-standard Reinstatement", description: "Written UGL Approval", sorCodes: ["PS-01-01-50"] },
  { number: "9.4.2", section: "9- Provisional Sums", item: "Non-standard Reinstatement", category: "Non-standard Reinstatement", description: "Invoice for works", sorCodes: ["PS-01-01-50"] },
  { number: "9.4.3", section: "9- Provisional Sums", item: "Non-standard Reinstatement", category: "Non-standard Reinstatement", description: "Before and after photos", sorCodes: ["PS-01-01-50"] },
  { number: "9.5.1", section: "9- Provisional Sums", item: "Manhole Install/Repair", category: "Manhole Install/Repair", description: "Written UGL Approval", sorCodes: ["PS-01-01-51"] },
  { number: "9.5.2", section: "9- Provisional Sums", item: "Manhole Install/Repair", category: "Manhole Install/Repair", description: "Invoice for works", sorCodes: ["PS-01-01-51"] },
  { number: "9.5.3", section: "9- Provisional Sums", item: "Manhole Install/Repair", category: "Manhole Install/Repair", description: "Before and after photos", sorCodes: ["PS-01-01-51"] },
  { number: "9.5.4", section: "9- Provisional Sums", item: "Manhole Install/Repair", category: "Manhole Install/Repair", description: "Structural Certificate", sorCodes: ["PS-01-01-51"] },
];

/**
 * Expected (SOR -> artefact count) for SORs whose coverage we want to
 * lock down. These were chosen because they exercise the prefix-block
 * forward-fill rule that previously broke (the parser used to drop 7 of
 * 9 ACM Pit Removal artefacts for medium/large/XL pit codes).
 *
 * Update this map when the source Atlas xlsx legitimately changes a SOR's
 * artefact count. If the assertion below fires unexpectedly, it means the
 * generator regressed — fix the parser, don't loosen the assertion.
 */
const EXPECTED_SOR_ARTEFACT_COUNTS: Record<string, number> = {
  // ACM Pit Removal — small/medium/large/XL all share 2.8.1..2.8.9.
  "CW-02-03-01": 9,
  "CW-02-03-02": 9,
  "CW-02-03-03": 9,
  "CW-02-03-04": 9,
  // Pit Installs Over existing duct or pit — 2.3.1..2.3.19, both codes.
  "CW-02-01-30": 19,
  "CW-02-01-31": 19,
  // Pit Installs In New Locations — 2.4.1..2.4.12.
  "CW-02-01-32": 12,
  // Hauling — 5.1.1..5.1.8 across 5 SOR codes.
  "CI-02-01-05": 8,
  "CI-02-01-13": 8,
  // New Joint — 6.3.1..6.3.13 across 3 SOR codes.
  "MR-01-01-02": 13,
  "MR-01-01-04": 13,
};

(function assertSorCoverage(): void {
  const actual = new Map<string, number>();
  for (const a of UGL_ARTEFACTS) {
    for (const code of a.sorCodes) {
      actual.set(code, (actual.get(code) ?? 0) + 1);
    }
  }
  const failures: string[] = [];
  for (const [code, expected] of Object.entries(EXPECTED_SOR_ARTEFACT_COUNTS)) {
    const got = actual.get(code) ?? 0;
    if (got !== expected) {
      failures.push(`  ${code}: expected ${expected}, got ${got}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      "UGL_ARTEFACTS coverage assertion failed — regenerate via\n" +
        "  python3 scripts/generate_ugl_artefacts.py\n" +
        "Mismatches:\n" +
        failures.join("\n")
    );
  }
})();

