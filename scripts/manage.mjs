import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  project,
  delay,
  git,
  prerequisites,
  waitWorkerStopped,
  assertClean,
} from "./lib/project.mjs";
import { control, stopRuntime } from "./lib/control.mjs";
import { withUpdateLock, ensureBuild, updateProject } from "./lib/update.mjs";

const ctx = project(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const action = process.argv[2] || "status";
async function start() {
  assertClean(ctx.root);
  let status = await control(ctx);
  if (status?.ready) return status;
  if (status) {
    await stopRuntime(ctx);
    await waitWorkerStopped(ctx);
  }
  await waitWorkerStopped(ctx);
  prerequisites();
  const commit = git(ctx.root, ["rev-parse", "HEAD"]);
  await ensureBuild(ctx, { commit });
  fs.mkdirSync(ctx.runtime, { recursive: true, mode: 0o700 });
  const log = path.join(ctx.runtime, "service-" + Date.now() + ".log");
  const fd = fs.openSync(log, "a", 0o600);
  const child = spawn(
    process.execPath,
    [path.join(ctx.root, "scripts/runtime.mjs")],
    {
      cwd: ctx.root,
      env: { ...process.env, YINGKE_PROJECT_ROOT: ctx.root },
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    },
  );
  fs.closeSync(fd);
  child.unref();
  let failure;
  child.once("error", (error) => {
    failure = error;
  });
  for (let i = 0; i < 200; i++) {
    if (failure) throw failure;
    status = await control(ctx);
    if (status?.ready) return status;
    if (child.exitCode !== null) break;
    await delay(300);
  }
  throw new Error("服务未就绪，请查看 " + log);
}
function openBrowser(port) {
  const url = `http://127.0.0.1:${port}`;
  const child =
    process.platform === "win32"
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
      : process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.once("error", () => console.log("请在本机浏览器访问端口 " + port));
  child.unref();
}
try {
  if (action === "status") {
    const state = await control(ctx);
    console.log(
      state?.ready
        ? "网页与 Worker 已就绪，端口 " + state.port
        : "当前没有已就绪的托管服务。",
    );
  } else if (action === "stop") {
    await withUpdateLock(ctx, async () => {
      const stopped = await stopRuntime(ctx);
      console.log(
        stopped
          ? "已停止本项目托管的网页与 Worker。"
          : "没有本工具启动的服务；未停止其他程序。",
      );
    });
  } else if (action === "start" || action === "update") {
    await withUpdateLock(ctx, async () => {
      if (action === "update") await updateProject(ctx);
      const status = await start();
      console.log(
        "映刻已启动，端口 " +
          status.port +
          "。关闭此窗口后服务继续运行；使用 Stop-Yingke.cmd 停止。",
      );
      if (process.argv.includes("--open")) openBrowser(status.port);
    });
  } else throw new Error("支持 start、update、stop、status。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
