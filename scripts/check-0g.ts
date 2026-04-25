import "../src/env.js";
import { checkStorageHealth } from "../src/storage.js";

const health = await checkStorageHealth();

console.error("\n0G Health Check");
console.error(
  `Storage backend healthy: ${health.kvHealthy}${health.kvEndpoint ? ` (${health.kvEndpoint})` : ""}`
);
console.error(
  `Indexer healthy: ${health.indexerHealthy}${health.indexerEndpoint ? ` (${health.indexerEndpoint})` : ""}`
);

if (health.issues.length > 0) {
  console.error("Issues:");
  health.issues.forEach((issue) => console.error(`- ${issue}`));
  process.exit(1);
}

console.error("0G endpoints look healthy.");
