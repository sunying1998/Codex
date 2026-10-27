import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fork, spawn } from "node:child_process";
import { project, delay, writeJson, workerOnline } from "./lib/project.mjs";
import { removeOwnedState } from "./lib/control.mjs";

const ctx = project(process.env.YINGKE_PROJECT_ROOT || process.cwd());
process.chdir(ctx.root);
const token = randomBytes(32).toString("hex");
const stateFile = path.join(ctx.runtime, "control.json");
let closing = false,
  ready = false,
  web,
  worker,
  port = 0,
  server;
function authenticated(value) {
  const actual = Buffer.from(value || ""),
    expected = Buffer.from("Bearer " + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function alive(child) {
  return child && child.exitCode === null && child.signalCode === null;
}
async function stopChild(child, graceful = false) {
  if (!alive(child)) return;
  if (graceful && child.connected) child.send({ type: "yingke:shutdown" });
  else child.kill("SIGTERM");
  const end = Date.now() + 8000;
  while (alive(child) && Date.now() < end) await delay(100);
  if (alive(child)) {
    child.kill("SIGKILL");
    const final = Date.now() + 2000;
    while (alive(child) && Date.now() < final) await delay(50);
  }
}
async function shutdown() {
  if (closing) return;
  closing = true;
  ready = false;
  await Promise.allSettled([stopChild(worker, true), stopChild(web)]);
  removeOwnedState(stateFile, token);
  if (server) await new Promise((resolve) => server.close(resolve));
}
async function freePort() {
  const requested = process.env.PORT ? Number(process.env.PORT) : null;
  if (
    requested !== null &&
    (!Number.isInteger(requested) || requested < 1 || requested > 65535)
  )
    throw new Error("PORT 配置无效。");
  for (const candidate of requested
    ? [requested]
    : Array.from({ length: 11 }, (_, i) => 3000 + i)) {
    const socket = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(candidate, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => socket.close(resolve));
      return candidate;
    } catch {
      socket.close();
    }
  }
  throw new Error("本机端口被占用，未停止其他程序。");
}
try {
  if (workerOnline(ctx))
    throw new Error("另一个 Worker 正在运行，请先关闭旧启动器。");
  port = await freePort();
  server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (!authenticated(request.headers.authorization)) {
      response.writeHead(403);
      response.end('{"error":"forbidden"}');
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.end(
        JSON.stringify({
          protocol: 1,
          root: ctx.root,
          pid: process.pid,
          ready,
          port,
          worker: workerOnline(ctx),
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/stop") {
      response.end(
        JSON.stringify({
          protocol: 1,
          root: ctx.root,
          pid: process.pid,
          stopping: true,
        }),
      );
      setImmediate(() => void shutdown());
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  writeJson(stateFile, {
    protocol: 1,
    root: ctx.root,
    pid: process.pid,
    controlPort: server.address().port,
    port,
    token,
  });
  const env = {
    ...process.env,
    NODE_ENV: "production",
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  web = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: ctx.root,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );
  worker = fork(path.join(ctx.root, "scripts/worker.ts"), [], {
    cwd: ctx.root,
    env,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
  for (const child of [web, worker]) {
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
      void shutdown();
    });
    child.on("exit", (code) => {
      if (!closing) {
        console.error("服务意外退出：" + code);
        process.exitCode = 1;
        void shutdown();
      }
    });
  }
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  for (let i = 0; i < 180 && !closing; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && workerOnline(ctx)) {
        const page = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (page.ok && (await page.text()).includes("YINGKE")) {
          ready = true;
          console.log("映刻网页与 Worker 已就绪，端口 " + port);
          break;
        }
      }
    } catch {}
    await delay(300);
  }
  if (!ready && !closing) throw new Error("启动验证超时。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await shutdown();
}
