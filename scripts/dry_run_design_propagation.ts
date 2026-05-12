/**
 * scripts/dry_run_design_propagation.ts — preview the Design Metres
 * propagation pass before running it live in the worker pipeline.
 *
 * Re-uses runSyncJobData({ dryRun: true }) so the dry-run and the
 * live worker run exercise the same code path. The script highlights
 * the Design-Metres-relevant counters (per-board + totals) and
 * suppresses the other diagnostic noise that the worker's full audit
 * log produces.
 *
 * Usage:
 *   MONDAY_API_TOKEN=xxx npm run dry-run-design-propagation
 *
 * Output: stdout summary only — no file written. Re-run the script
 * after merge+deploy to confirm steady-state (designMetresWrites=0
 * across the board on a re-run).
 */

import { runSyncJobData } from "../netlify/functions/lib/sync_job_data";

async function main(): Promise<void> {
  console.log("=== Design Metres propagation — dry-run ===\n");
  const start = Date.now();
  const result = await runSyncJobData({ dryRun: true });
  const elapsed = Date.now() - start;

  console.log("\n=== Per-board summary ===");
  console.log(
    "board".padEnd(12),
    "total".padStart(6),
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
      String(r.designMetresWrites).padStart(10),
      String(r.primaryWrites).padStart(8),
      String(r.revenueWrites).padStart(8),
      String(r.photoWrites).padStart(6),
      String(r.lifecycleWrites).padStart(10),
      String(r.unchanged).padStart(10),
      String(r.testItems).padStart(5)
    );
  }

  const totalDesignMetres =
    result.active.designMetresWrites +
    result.jobComplete.designMetresWrites +
    result.submitted.designMetresWrites +
    result.approved.designMetresWrites +
    result.cancelled.designMetresWrites;
  const totalAllWrites =
    result.totalWrites; // already sums every dimension across boards

  console.log("\n=== Totals ===");
  console.log(`  Design Metres writes planned: ${totalDesignMetres}`);
  console.log(`  All-dimension writes planned: ${totalAllWrites}`);
  console.log(`  Failed:                       ${result.totalFailed}`);
  console.log(`  Elapsed:                      ${Math.round(elapsed / 1000)}s`);

  if (totalDesignMetres === 0) {
    console.log(
      "\nDesign Metres writes = 0 — steady state. Either nothing has " +
        "changed since the last successful run, OR the propagation has " +
        "not yet been deployed."
    );
  } else {
    console.log(
      `\nDRY-RUN complete — ${totalDesignMetres} Design Metres writes would land if this were live.`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
