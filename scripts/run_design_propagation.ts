/**
 * scripts/run_design_propagation.ts — LIVE run of the Design Metres
 * propagation pass (Bug B backfill).
 *
 * Mirror of dry_run_design_propagation.ts, but calls runSyncJobData()
 * WITHOUT the dryRun flag, so the planned writes actually land in
 * monday. Same code path as the worker uses on its scheduled run, so
 * what happens here is what production will repeat.
 *
 * Usage:
 *   MONDAY_API_TOKEN=xxx npm run live-design-propagation
 *
 * Run only after the dry-run has been reviewed and greenlit. Re-run
 * the dry-run script after this completes to confirm steady-state
 * (designMetresWrites=0 across the board on the second pass).
 */

import { runSyncJobData } from "../netlify/functions/lib/sync_job_data";

async function main(): Promise<void> {
  console.log("=== Design Metres propagation — LIVE run ===\n");
  const start = Date.now();
  const result = await runSyncJobData({ dryRun: false });
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
    "failed".padStart(7),
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
      String(r.failed).padStart(7),
      String(r.testItems).padStart(5)
    );
  }

  const totalDesignMetres =
    result.active.designMetresWrites +
    result.jobComplete.designMetresWrites +
    result.submitted.designMetresWrites +
    result.approved.designMetresWrites +
    result.cancelled.designMetresWrites;

  console.log("\n=== Totals ===");
  console.log(`  Design Metres writes landed:  ${totalDesignMetres}`);
  console.log(`  All-dimension writes landed:  ${result.totalWrites}`);
  console.log(`  Failed:                       ${result.totalFailed}`);
  console.log(`  Elapsed:                      ${Math.round(elapsed / 1000)}s`);

  if (result.totalFailed > 0) {
    console.log(
      `\n⚠️  ${result.totalFailed} writes failed — inspect the worker error log ` +
        `(or re-run the dry-run to see which assets remain).`
    );
    process.exit(2);
  }

  console.log(
    "\n✅ LIVE run complete. Re-run the dry-run to confirm steady state " +
      "(expect designMetresWrites=0 on a second pass)."
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
