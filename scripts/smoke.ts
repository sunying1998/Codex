import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Job, ProjectDetail } from "../src/lib/types";

const directory = await mkdtemp(path.join(tmpdir(), "yingke-smoke-"));
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
let cookie = "",
  web: ChildProcess | undefined,
  worker: ChildProcess | undefined;
let log = "";
const capture = (child: ChildProcess) => {
  child.stdout?.on("data", (chunk) => {
    log = (log + chunk).slice(-16_000);
  });
  child.stderr?.on("data", (chunk) => {
    log = (log + chunk).slice(-16_000);
  });
  return child;
};
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}
async function request(route: string, options?: RequestInit) {
  return fetch(origin + route, {
    ...options,
    headers: {
      cookie,
      origin,
      ...(typeof options?.body === "string"
        ? { "Content-Type": "application/json" }
        : {}),
      ...options?.headers,
    },
  });
}
async function json<T = Record<string, unknown>>(
  route: string,
  options?: RequestInit,
  status = 200,
): Promise<T> {
  const response = await request(route, options);
  const body = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(body)}`);
  return body as T;
}
async function waitJob(id: string, expected: string) {
  for (let count = 0; count < 160; count++) {
    const { job } = await json<{ job: Job }>(`/api/jobs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      assert.equal(job.status, expected, job.error || job.status);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`任务 ${id} 未在 40 秒内结束。`);
}
async function waitRunning(id: string) {
  for (let count = 0; count < 300; count++) {
    const { job } = await json<{ job: Job }>(`/api/jobs/${id}`);
    if (job.status === "running") return;
    assert.equal(job.status, "queued", "任务在运行状态检查前已终结");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Worker 未领取任务");
}
async function upload(
  projectId: string,
  name: string,
  content: Uint8Array,
  kind = "source",
  status = 202,
) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(content)]), name);
  return json<{ assetId: string; jobId: string }>(
    `/api/projects/${projectId}/assets?kind=${kind}`,
    { method: "POST", body: form },
    status,
  );
}
const checks: string[] = [];
try {
  await stat(".next/BUILD_ID");
  const videoPath = path.join(directory, "fixture.mp4"),
    imagePath = path.join(directory, "reference.png");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "12",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ]);
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=orange:s=200x240",
    "-frames:v",
    "1",
    "-threads",
    "1",
    imagePath,
  ]);
  const jpegPath = path.join(directory, "baseline.jpg");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    imagePath,
    "-frames:v",
    "1",
    "-threads",
    "1",
    jpegPath,
  ]);
  const highBitPng = path.join(directory, "rgba16.png");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    imagePath,
    "-vf",
    "format=rgba64be",
    "-frames:v",
    "1",
    "-threads",
    "1",
    highBitPng,
  ]);
  const oversizedPng = path.join(directory, "too-wide.png");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=8200x4",
    "-frames:v",
    "1",
    "-threads",
    "1",
    oversizedPng,
  ]);
  web = capture(
    spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        String(port),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  let ready = false;
  for (let count = 0; count < 120; count++) {
    try {
      if ((await fetch(origin + "/api/auth/status")).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (web.exitCode !== null) throw new Error("Web 服务提前退出。");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, "Web service did not start");
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /映刻/);
  await json("/api/projects", undefined, 401);
  const blocked = await fetch(origin + "/api/auth/setup", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(blocked.status, 403);
  const password = "smoke-test-only-long-passphrase";
  const setup = await request("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ username: "test_owner", password }),
  });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get("set-cookie")!.split(";")[0];
  assert.match(setup.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(setup.headers.get("set-cookie")!, /SameSite=strict/i);
  await json(
    "/api/auth/setup",
    { method: "POST", body: JSON.stringify({ username: "other", password }) },
    409,
  );
  checks.push("首次初始化、会话与重复注册保护、跨站请求拦截");
  const { project } = await json<{ project: { id: string } }>(
    "/api/projects",
    { method: "POST", body: JSON.stringify({ title: "完整流程验证" }) },
    201,
  );
  const invalid = await upload(
    project.id,
    "broken.mp4",
    Buffer.from("not a video"),
  );
  worker = capture(
    spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  await waitJob(invalid.jobId, "failed");
  await upload(
    project.id,
    "blocked.html",
    Buffer.from("not a video"),
    "source",
    415,
  );
  const two = new FormData();
  two.append("file", new Blob(["one"]), "a.mp4");
  two.append("file", new Blob(["two"]), "b.mp4");
  await json(
    `/api/projects/${project.id}/assets?kind=source`,
    { method: "POST", body: two },
    400,
  );
  const video = await upload(
    project.id,
    "fixture.mp4",
    await readFile(videoPath),
  );
  await waitJob(video.jobId, "succeeded");
  const reference = await upload(
    project.id,
    "reference.png",
    await readFile(imagePath),
    "reference",
  );
  await waitJob(reference.jobId, "succeeded");
  for (const [name, file, expectedMime] of [
    ["普通照片.JPG", jpegPath, "image/jpeg"],
    ["透明高位深.png", highBitPng, "image/png"],
    ["actual-jpeg.png", jpegPath, "image/jpeg"],
  ]) {
    const photo = await upload(
      project.id,
      name,
      await readFile(file),
      "reference",
    );
    await waitJob(photo.jobId, "succeeded");
    const photoDetail = await json<ProjectDetail>(
      `/api/projects/${project.id}`,
    );
    assert.equal(
      photoDetail.assets.find((asset) => asset.id === photo.assetId)?.mime,
      expectedMime,
    );
    const response = await request(`/api/assets/${photo.assetId}/thumbnail`);
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
  }
  const oversized = await upload(
    project.id,
    "too-wide.png",
    await readFile(oversizedPng),
    "reference",
  );
  const rejectedSize = await waitJob(oversized.jobId, "failed");
  assert.match(rejectedSize.error || "", /8200.*8192.*32 MP/);
  const brokenImage = await upload(
    project.id,
    "broken.png",
    Buffer.from("not an image"),
    "reference",
  );
  await waitJob(brokenImage.jobId, "failed");
  checks.push(
    "普通 JPG / 大写后缀 / 中文文件名 / PNG / 16 位透明 PNG 上传与缩略图、真实 MIME、超尺寸与损坏图片拒绝",
  );
  let detail = await json<ProjectDetail>(`/api/projects/${project.id}`);
  assert.equal(detail.assets.find((a) => a.id === video.assetId)?.width, 1280);
  assert.equal(
    detail.assets.find((a) => a.id === reference.assetId)?.height,
    240,
  );
  const thumb = await request(`/api/assets/${video.assetId}/thumbnail`);
  assert.equal(thumb.status, 200);
  assert.ok((await thumb.arrayBuffer()).byteLength > 100);
  checks.push(
    "无效视频失败可诊断、拒绝不支持的类型和多文件请求、真实视频和参考照片解析、缩略图生成",
  );
  const range = await request(`/api/assets/${video.assetId}`, {
    headers: { range: "bytes=0-31" },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  const suffix = await request(`/api/assets/${video.assetId}`, {
    headers: { range: "bytes=-16" },
  });
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, 16);
  assert.equal(
    (
      await request(`/api/assets/${video.assetId}`, {
        headers: { range: "bytes=999999999-" },
      })
    ).status,
    416,
  );
  const unauthorized = await fetch(origin + `/api/assets/${video.assetId}`);
  assert.equal(unauthorized.status, 401);
  // Seed another owner only in this isolated test database to exercise ownership boundaries.
  const fixtureDb = new DatabaseSync(
    path.join(env.YINGKE_DATA_DIR, "studio.sqlite"),
  );
  fixtureDb.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  const otherOwner = randomUUID(),
    token = randomBytes(32).toString("hex");
  fixtureDb
    .prepare(
      "INSERT INTO users(id,username,password,created_at) SELECT ?,'other_fixture',password,? FROM users LIMIT 1",
    )
    .run(otherOwner, Date.now());
  fixtureDb
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(
      createHash("sha256").update(token).digest("hex"),
      otherOwner,
      Date.now() + 60_000,
    );
  const otherHeaders = { cookie: `yingke_session=${token}` };
  for (const route of [
    `/api/projects/${project.id}`,
    `/api/assets/${video.assetId}`,
    `/api/assets/${video.assetId}/thumbnail`,
    `/api/jobs/${video.jobId}`,
  ])
    await json(route, { headers: otherHeaders }, 404);
  const otherProjects = await json<{ projects: unknown[] }>("/api/projects", {
    headers: otherHeaders,
  });
  assert.equal(otherProjects.projects.length, 0);
  fixtureDb.prepare("DELETE FROM users WHERE id=?").run(otherOwner);
  fixtureDb.close();
  const update = {
    title: "已保存的片段",
    trim_start: 0.5,
    trim_end: 2,
    version: detail.project.version,
  };
  await json(`/api/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
  await json(
    `/api/projects/${project.id}`,
    { method: "PATCH", body: JSON.stringify(update) },
    409,
  );
  detail = await json<ProjectDetail>(`/api/projects/${project.id}`);
  assert.equal(detail.project.trim_start, 0.5);
  assert.equal(detail.project.trim_end, 2);
  checks.push(
    "视频 Range / 后缀请求 / 越界处理、未登录与跨账号素材隔离、项目持久化与并发版本冲突检测",
  );
  await stop(worker);
  worker = undefined;
  const makeExport = (key: string) =>
    json<{ job: Job }>(
      `/api/projects/${project.id}/export`,
      { method: "POST", headers: { "Idempotency-Key": key } },
      202,
    );
  const cancelled = await makeExport("cancel-request-001");
  await json(`/api/projects/${project.id}`, { method: "DELETE" }, 409);
  await json(`/api/jobs/${cancelled.job.id}/cancel`, { method: "POST" });
  await waitJob(cancelled.job.id, "cancelled");
  const pending = await makeExport("export-request-001");
  const duplicate = await makeExport("export-request-001");
  assert.equal(pending.job.id, duplicate.job.id);
  await stop(web);
  web = undefined;
  web = capture(
    spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        String(port),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  for (let count = 0; count < 120; count++) {
    try {
      if ((await fetch(origin + "/api/auth/status")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  detail = await json<ProjectDetail>(`/api/projects/${project.id}`);
  assert.equal(detail.project.title, "已保存的片段");
  assert.equal(
    (await json<{ job: Job }>(`/api/jobs/${pending.job.id}`)).job.status,
    "queued",
  );
  worker = capture(
    spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  await waitJob(pending.job.id, "succeeded");
  const download = await request(`/api/jobs/${pending.job.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition")!, /attachment/);
  const { writeFile } = await import("node:fs/promises");
  const outputPath = path.join(directory, "output.mp4");
  await writeFile(outputPath, Buffer.from(await download.arrayBuffer()));
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type",
        "-of",
        "json",
        outputPath,
      ],
      { encoding: "utf8" },
    ),
  ) as { format: { duration: string }; streams: { codec_name: string }[] };
  assert.ok(
    Math.abs(Number(probe.format.duration) - 1.5) < 0.15,
    probe.format.duration,
  );
  assert.ok(probe.streams.some((s) => s.codec_name === "h264"));
  assert.ok(probe.streams.some((s) => s.codec_name === "aac"));
  checks.push(
    "排队取消、忙碌项目删除保护、重复提交去重、服务与 Worker 重启后继续任务、真实 1.5 秒 H.264 / AAC 导出",
  );
  detail = await json<ProjectDetail>(`/api/projects/${project.id}`);
  await json(`/api/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: detail.project.title,
      trim_start: 0,
      trim_end: 10,
      version: detail.project.version,
    }),
  });
  const runningCancel = await makeExport("cancel-running-001");
  await waitRunning(runningCancel.job.id);
  await json(`/api/jobs/${runningCancel.job.id}/cancel`, { method: "POST" });
  await waitJob(runningCancel.job.id, "cancelled");
  const interrupted = await makeExport("interrupt-running-001");
  await waitRunning(interrupted.job.id);
  await stop(worker);
  worker = undefined;
  assert.equal(
    (await json<{ job: Job }>(`/api/jobs/${interrupted.job.id}`)).job.status,
    "queued",
  );
  worker = capture(
    spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const recovered = await waitJob(interrupted.job.id, "succeeded");
  assert.equal(recovered.attempts, 2);
  checks.push("运行中的 FFmpeg 任务取消、Worker 正常关机中断后重新领取并完成");
  await json(`/api/assets/${reference.assetId}`, { method: "DELETE" });
  assert.equal((await request(`/api/assets/${reference.assetId}`)).status, 404);
  await json(`/api/projects/${project.id}`, { method: "DELETE" });
  await json(`/api/projects/${project.id}`, undefined, 404);
  assert.equal(
    (await request(`/api/jobs/${pending.job.id}/download`)).status,
    404,
  );
  await json("/api/auth/logout", { method: "POST" });
  await json("/api/projects", undefined, 401);
  await json(
    "/api/auth/login",
    {
      method: "POST",
      body: JSON.stringify({
        username: "test_owner",
        password: "wrong-long-password",
      }),
    },
    401,
  );
  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "test_owner", password }),
  });
  assert.equal(login.status, 200);
  checks.push(
    "参考照片与项目删除、关联结果失效、登出会话撤销、错误密码拦截与重新登录",
  );
  for (const check of checks) console.log(`PASS ${check}`);
  console.log(`\n${checks.length} 组端到端检查通过。测试数据与账号已清理。`);
} catch (error) {
  console.error(log);
  throw error;
} finally {
  await stop(worker);
  await stop(web);
  await rm(directory, { recursive: true, force: true });
}
