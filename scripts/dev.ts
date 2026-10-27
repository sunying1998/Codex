import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
for (const file of [".env.local", ".env"])
  if (existsSync(file)) process.loadEnvFile(file);
for (const binary of ["ffmpeg", "ffprobe"]) {
  try {
    execFileSync(binary, ["-version"], { stdio: "ignore" });
  } catch {
    console.error(`缺少 ${binary}，请先安装 FFmpeg。`);
    process.exit(1);
  }
}
const children = [
  spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--hostname", "0.0.0.0"],
    { stdio: "inherit", env: process.env },
  ),
  spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000);
  timer.unref();
}
children.forEach((child) => child.on("exit", (code) => stop(code || 0)));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
