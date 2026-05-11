/**
 * scripts/migrate_row_placement.ts — one-time migration to move rows
 * to their correct board based on current UGL Payment Status.
 *
 * Strategy: re-uses runReconcileRowPlacement() in
 * netlify/functions/lib/reconcile_row_placement.ts so the migration
 * and the future Stage-3 pipeline step exercise identical move
 * semantics + column-mapping + retry logic.
 *
 * Usage:
 *   # Dry-run first (mandatory — review the plan before live):
 *   MONDAY_API_TOKEN=xxx npm run migrate-row-placement -- --dry-run
 *
 *   # After Rowan reviews the plan and approves:
 *   MONDAY_API_TOKEN=xxx npm run migrate-row-placement
 *
 * Output files (gitignored):
 *   migration-plan.json — every planned move + skip counters
 *                         (always written, both modes)
 *   migration-log.json  — every executed move + outcome
 *                         (only written when NOT --dry-run)
 */

import { promises as fs } from "node:fs";
import {
  runReconcileRowPlacement,
  type ReconcileResult,
  type PlannedMove,
} from "../netlify/functions/lib/reconcile_row_placement";

function parseArgs(): { dryRun: boolean } {
  const dryRun = process.argv.slice(2).some((a) => a === "--dry-run");
  return { dryRun };
}

interface PlanFile {
  generatedAt: string;
  mode: "dry-run" | "live";
  summary: Pick<
    ReconcileResult,
    | "totalChecked"
    | "movesPlanned"
    | "unchanged"
    | "skippedBlankStatus"
    | "skippedUnknownStatus"
    | "skippedTest"
    | "byDirection"
    | "unknownStatusSamples"
  >;
  plannedMoves: PlannedMove[];
}

interface LogFile {
  ranAt: string;
  result: ReconcileResult;
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs();
  console.log(
    `=== migrate_row_placement — mode=${dryRun ? "DRY-RUN (no monday writes)" : "LIVE (will move rows)"} ===\n`
  );

  const result = await runReconcileRowPlacement({
    dryRun,
    includePlannedMoves: true,
  });

  // Always write the plan file — same shape for dry-run + live so
  // Rowan can diff "what we planned" vs "what ran" if a later live
  // run differs from an earlier dry-run.
  const planFile: PlanFile = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? "dry-run" : "live",
    summary: {
      totalChecked: result.totalChecked,
      movesPlanned: result.movesPlanned,
      unchanged: result.unchanged,
      skippedBlankStatus: result.skippedBlankStatus,
      skippedUnknownStatus: result.skippedUnknownStatus,
      skippedTest: result.skippedTest,
      byDirection: result.byDirection,
      unknownStatusSamples: result.unknownStatusSamples ?? [],
    },
    plannedMoves: result.plannedMoves ?? [],
  };
  await fs.writeFile(
    "migration-plan.json",
    JSON.stringify(planFile, null, 2)
  );

  // Only write the execution log on a live run — for dry-run there's
  // nothing executed worth logging beyond the plan.
  if (!dryRun) {
    const logFile: LogFile = {
      ranAt: new Date().toISOString(),
      result,
    };
    await fs.writeFile(
      "migration-log.json",
      JSON.stringify(logFile, null, 2)
    );
  }

  // Summary print.
  console.log("\n=== Summary ===");
  console.log(`Total rows checked:           ${result.totalChecked}`);
  console.log(`Moves planned:                ${result.movesPlanned}`);
  if (!dryRun) {
    console.log(`Moves succeeded:              ${result.movesSucceeded}`);
    console.log(`Moves failed:                 ${result.movesFailed}`);
  }
  console.log(`Unchanged (correct board):    ${result.unchanged}`);
  console.log(`Skipped — blank status:       ${result.skippedBlankStatus}`);
  console.log(`Skipped — unknown status:     ${result.skippedUnknownStatus}`);
  console.log(`Skipped — TEST asset:         ${result.skippedTest}`);
  if (result.unknownStatusSamples && result.unknownStatusSamples.length > 0) {
    console.log("\nUnknown statuses (top 10):");
    for (const s of result.unknownStatusSamples) console.log(`  ${s}`);
  }
  if (Object.keys(result.byDirection).length > 0) {
    console.log("\nBy direction:");
    const entries = Object.entries(result.byDirection).sort(
      (a, b) => b[1] - a[1]
    );
    for (const [k, n] of entries) {
      console.log(`  ${k}: ${n}`);
    }
  }
  if (result.failures.length > 0) {
    console.log(`\nFailures (showing up to 10):`);
    for (const f of result.failures.slice(0, 10)) {
      console.log(`  item=${f.itemId} ${f.fromBoard}→${f.toBoard}: ${f.error}`);
    }
  }
  console.log("\nFiles written:");
  console.log("  migration-plan.json");
  if (!dryRun) console.log("  migration-log.json");
  if (dryRun) {
    console.log(
      "\nDRY-RUN complete — review migration-plan.json, then re-run WITHOUT --dry-run to execute."
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
