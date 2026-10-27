import { existsSync } from "node:fs";
for (const file of [".env.local", ".env"])
  if (existsSync(file)) process.loadEnvFile(file);
const { startWorker } = await import("../src/lib/worker");
startWorker()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.connected) process.disconnect();
  });
