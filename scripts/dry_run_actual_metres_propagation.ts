/**
 * scripts/dry_run_actual_metres_propagation.ts — preview the Actual
 * Metres propagation pass before running it live in the worker
 * pipeline. Sibling to dry_run_design_propagation.ts.
 *
 * Re-uses runSyncJobData({ dryRun: true }) so the dry-run and the
 * live worker run exercise the same code path. The script highlights
 * the Actual-Metres-relevant counters (per-board + totals) and
 * suppresses the other diagnostic noise that the worker's full audit
 * log produces. Design Metres counters are shown too as a sanity-check
 * column — steady-state expects 0 there after PR #22 merged.
 *
 * Usage:
 *   MONDAY_API_TOKEN=xxx npm run dry-run-actual-metres-propagation
 *
 * Output: stdout summary only — no file written. Re-run the script
 * after merge+deploy to confirm steady-state (actualMetresWrites=0
 * across the board on a re-run).
 */

import { runSyncJobData } from "../netlify/functions/lib/sync_job_data";

async function main(): Promise<void> {
  console.log("=== Actual Metres propagation — dry-run ===\n");
  const start = Date.now();
  const result = await runSyncJobData({ dryRun: true });
  const elapsed = Date.now() - start;

  console.log("\n=== Per-board summary ===");
  console.log(
    "board".padEnd(12),
    "total".padStart(6),
    "AM-writes".padStart(10),
    "DM-writes".padStart(10),
    "primary".padStart(8),
    "revenue".padStart(8),
    "photo".padStart(6),
    "lifecycle".padStart(10),
    "unchanged".padStart(10),
    "TEST".padStart(5)
  );
  for (const key of [
    "active",
    "jobComplete",
    "submitted",
    "approved",
    "cancelled",
  ] as const) {
    const r = result[key];
    console.log(
      key.padEnd(12),
      String(r.total).padStart(6),
      String(r.actualMetresWrites).padStart(10),
      String(r.designMetresWrites).padStart(10),
      String(r.primaryWrites).padStart(8),
      String(r.revenueWrites).padStart(8),
      String(r.photoWrites).padStart(6),
      String(r.lifecycleWrites).padStart(10),
      String(r.unchanged).padStart(10),
      String(r.testItems).padStart(5)
    );
  }

  const totalActualMetres =
    result.active.actualMetresWrites +
    result.jobComplete.actualMetresWrites +
    result.submitted.actualMetresWrites +
    result.approved.actualMetresWrites +
    result.cancelled.actualMetresWrites;
  const totalDesignMetres =
    result.active.designMetresWrites +
    result.jobComplete.designMetresWrites +
    result.submitted.designMetresWrites +
    result.approved.designMetresWrites +
    result.cancelled.designMetresWrites;

  console.log("\n=== Totals ===");
  console.log(`  Actual Metres writes planned: ${totalActualMetres}`);
  console.log(`  Design Metres writes planned: ${totalDesignMetres}  (expect 0 in steady state)`);
  console.log(`  All-dimension writes planned: ${result.totalWrites}`);
  console.log(`  Failed:                       ${result.totalFailed}`);
  console.log(`  Elapsed:                      ${Math.round(elapsed / 1000)}s`);

  if (totalActualMetres === 0) {
    console.log(
      "\nActual Metres writes = 0 — steady state. Either nothing has " +
        "changed since the last successful run, OR no rows are in-scope " +
        "(no row with UGL Payment Status ∈ {Submitted to UGL, In Review, " +
        "Approved, Paid, Partial Paid, Overpaid, Paid - Pending RCTI} " +
        "AND a metres-UOM Actual Qty value on its SOR Lines)."
    );
  } else {
    console.log(
      `\nDRY-RUN complete — ${totalActualMetres} Actual Metres writes would land if this were live.`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
