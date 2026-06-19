/**
 * One-off: run the models.dev price sync against the real DB and report.
 * Run:  npx tsx scripts/syncModelPricesOnce.ts
 */
import { defaultDbPath } from "../src/config.js";
import { openDatabase } from "../src/store/open.js";
import { syncModelPrices } from "../src/cost/modelsDevSync.js";
import { latestSyncedAt, listModelPrices } from "../src/cost/priceStore.js";

async function main() {
  const db = openDatabase(defaultDbPath());
  console.log("syncing from models.dev ...");
  const r = await syncModelPrices(db);
  console.log("result:", r);
  console.log("latest synced_at:", latestSyncedAt(db));
  const rows = listModelPrices(db);
  console.log(`stored ${rows.length} prices`);
  for (const id of ["gpt-5.5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-opus-4-7"]) {
    const m = rows.find((x) => x.model_id === id);
    console.log(`  ${id}: ${m ? `in=${m.input} out=${m.output} cr=${m.cache_read} cc=${m.cache_creation}` : "(not found)"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
