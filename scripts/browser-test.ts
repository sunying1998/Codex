import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import assert from "node:assert/strict";

const directory = await mkdtemp(path.join(tmpdir(), "yingke-browser-"));
await mkdir("test-results", { recursive: true });
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = (socket.address() as { port: number }).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  YINGKE_DATA_DIR: path.join(directory, "data"),
  APP_ORIGIN: origin,
  NEXT_TELEMETRY_DISABLED: "1",
};
let log = "";
const children: ChildProcess[] = [];
function start(args: string[]) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data) => {
    log = (log + data).slice(-10_000);
  });
  child.stderr?.on("data", (data) => {
    log = (log + data).slice(-10_000);
  });
  children.push(child);
  return child;
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const fixture = path.join(directory, "browser-fixture.mp4");
  const photoFixture = path.join(directory, "reference.jpg");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=24",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    fixture,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=orange:s=400x600",
    "-frames:v",
    "1",
    "-threads",
    "1",
    photoFixture,
  ]);
  start([
    "node_modules/next/dist/bin/next",
    "start",
    "-H",
    "127.0.0.1",
    "-p",
    String(port),
  ]);
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(origin + "/api/auth/status")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  start(["--import", "tsx", "scripts/worker.ts"]);
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(origin);
  await expect(
    page.getByRole("heading", { name: "开启你的创作空间" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/auth-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("工作室账号", { exact: true }).fill("browser_owner");
  await page
    .locator('input[name="password"]')
    .fill("browser-test-only-long-passphrase");
  await page
    .locator('input[name="confirm"]')
    .fill("browser-test-only-long-passphrase");
  await page.getByRole("button", { name: "创建工作室", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "让想象，进入画面。" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page
    .getByLabel("项目名称", { exact: true })
    .pressSequentially("Browser test project", { delay: 25 });
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(
    "Browser test project",
  );
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "你的画面，即将在这里展开" }),
  ).toBeVisible();
  await page
    .getByLabel("上传源视频文件", { exact: true })
    .setInputFiles(fixture);
  await expect(page.getByText("源素材已就绪", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .evaluate((element) => (element as HTMLVideoElement).readyState),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(1);
  await page.getByLabel("片段入点（秒）").fill("0.5");
  await page.getByLabel("片段出点（秒）").fill("2.5");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.locator(".save-status")).toHaveText("已保存");
  await page.reload();
  await expect(page.getByLabel("片段入点（秒）")).toHaveValue("0.5");
  await expect(page.getByLabel("片段出点（秒）")).toHaveValue("2.5");
  await page.getByRole("button", { name: "导出片段", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "下载", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: "人物替换准备中" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "参考照片", exact: true }).click();
  await page
    .getByLabel("上传人物参考照片", { exact: true })
    .setInputFiles(photoFixture);
  await expect(page.locator(".reference-card img")).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.getByLabel("上传人物参考照片", { exact: true }).setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  const failedReference = page
    .locator(".asset-failure")
    .filter({ hasText: "broken.png" });
  await expect(failedReference).toBeVisible({ timeout: 30_000 });
  const currentProject = new URL(page.url()).searchParams.get("project");
  const failedDetail = await page.request.get(
    `${origin}/api/projects/${currentProject}`,
  );
  const failedData = (await failedDetail.json()) as {
    assets: { name: string; error: string | null }[];
  };
  const failureMessage = failedData.assets.find(
    (asset) => asset.name === "broken.png",
  )?.error;
  assert.ok(
    failureMessage,
    "Backend should provide a specific image failure reason",
  );
  await expect(failedReference).toContainText(failureMessage);
  await page.getByRole("button", { name: "源视频", exact: true }).click();
  await page.screenshot({
    path: "test-results/editor-desktop.png",
    fullPage: true,
  });
  const savedUrl = page.url();
  await page.getByRole("button", { name: "返回项目", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "打开项目 Browser test project",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("搜索项目", { exact: true }).fill("does not exist");
  await expect(
    page.getByRole("heading", { name: "没有找到相关项目" }),
  ).toBeVisible();
  await page.getByLabel("搜索项目", { exact: true }).fill("Browser");
  await expect(
    page.getByRole("button", {
      name: "打开项目 Browser test project",
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(savedUrl);
  await expect(
    page.getByRole("button", { name: "导出片段", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/editor-mobile.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(() =>
    Array.from(document.querySelectorAll("body *"))
      .filter(
        (element) =>
          element.getBoundingClientRect().right > window.innerWidth + 1,
      )
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        right: element.getBoundingClientRect().right,
      }))
      .slice(0, 20),
  );
  if (overflow.length) console.log("Mobile overflow:", overflow);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "test-results/editor-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "创作概览", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "让想象，进入画面。" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  assert.deepEqual(errors, [], "Browser console errors");
  console.log(
    "PASS 浏览器：首次建号、弹窗连续输入、创建项目、真实上传与可播放预览、编辑保存、刷新恢复、真实导出与下载入口、搜索过滤、390px 手机布局、手机导航、AI 未接入状态。",
  );
  console.log(
    "PASS 浏览器运行无 JavaScript / console 错误。截图位于 test-results/。",
  );
} catch (error) {
  console.error(log);
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
