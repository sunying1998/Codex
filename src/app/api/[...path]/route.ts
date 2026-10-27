import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  currentUser,
  requireUser,
  initialized,
  createOwner,
  loginUser,
  sessionResponse,
  logout,
  throttle,
} from "@/lib/auth";
import {
  db,
  transaction,
  projectFor,
  assetFor,
  jobFor,
  storagePath,
} from "@/lib/db";
import { endpoint, sameOrigin, ApiError, readJson } from "@/lib/http";
import {
  credentials,
  projectInput,
  projectUpdate,
  validTrim,
} from "@/lib/validation";
import { receiveUpload } from "@/lib/uploads";
import { serveFile } from "@/lib/files";
import { capabilities } from "@/lib/ai";
import type { Asset, Job, ProjectSummary } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
const cleanAsset = (a: Asset) => ({ ...a, path: "" });
const cleanJob = (j: Job) => ({ ...j, output: j.output ? "available" : null });

const handle = endpoint(async (request) => {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const method = request.method;
  if (["POST", "PATCH", "DELETE"].includes(method)) sameOrigin(request);
  if (parts.join("/") === "auth/status" && method === "GET")
    return json({
      initialized: initialized(),
      user: currentUser(request) || null,
    });
  if (parts[0] === "auth" && parts.length === 2 && method === "POST") {
    if (parts[1] === "logout") return logout(request);
    if (["setup", "login"].includes(parts[1])) {
      if (parts[1] === "setup") {
        if (initialized())
          throw new ApiError(409, "工作室已初始化，请直接登录。");
        throttle("setup");
      }
      const input = credentials.parse(await readJson(request));
      return sessionResponse(
        parts[1] === "setup"
          ? createOwner(input.username, input.password)
          : loginUser(input.username, input.password),
        request,
      );
    }
  }
  const user = requireUser(request);
  if (parts.join("/") === "capabilities" && method === "GET")
    return json(capabilities);
  if (parts.join("/") === "overview" && method === "GET") {
    const usage = db()
      .prepare(
        `SELECT COALESCE(SUM(a.bytes),0) AS source_bytes, COUNT(a.id) AS assets
      FROM assets a JOIN projects p ON p.id=a.project_id WHERE p.owner_id=?`,
      )
      .get(user.id);
    const tasks = db()
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status='succeeded' AND kind='export' THEN 1 ELSE 0 END) AS exports,
      SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS active,
      COALESCE(SUM(CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL THEN MAX(0,finished_at-started_at) ELSE 0 END),0) AS processing_ms
      FROM jobs WHERE owner_id=?`,
      )
      .get(user.id);
    const worker = db()
      .prepare("SELECT expires_at FROM worker_lock WHERE id=1")
      .get() as { expires_at: number } | undefined;
    return json({
      usage,
      tasks,
      worker_online: !!worker && worker.expires_at > Date.now(),
    });
  }
  if (parts[0] === "projects" && parts.length === 1) {
    if (method === "GET") {
      const projects = db()
        .prepare(
          `SELECT p.*,
        (SELECT COUNT(*) FROM assets WHERE project_id=p.id) AS asset_count,
        (SELECT id FROM assets WHERE project_id=p.id AND kind='source' AND status='ready' ORDER BY created_at DESC LIMIT 1) AS thumbnail_id,
        (SELECT duration FROM assets WHERE project_id=p.id AND kind='source' AND status!='failed' LIMIT 1) AS duration,
        (SELECT status FROM assets WHERE project_id=p.id AND kind='source' AND status!='failed' LIMIT 1) AS source_status,
        (SELECT COUNT(*) FROM jobs WHERE project_id=p.id AND status IN ('queued','running')) AS active_jobs
        FROM projects p WHERE owner_id=? ORDER BY updated_at DESC`,
        )
        .all(user.id) as ProjectSummary[];
      return json({ projects });
    }
    if (method === "POST") {
      const { title } = projectInput.parse(await readJson(request));
      const id = randomUUID(),
        now = Date.now();
      transaction(() => {
        const count = db()
          .prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id=?")
          .get(user.id) as { n: number };
        if (count.n >= 100)
          throw new ApiError(
            409,
            "内测版最多保存 100 个项目，请先清理不用的项目。",
          );
        db()
          .prepare(
            "INSERT INTO projects(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)",
          )
          .run(id, user.id, title, now, now);
      });
      return json({ project: projectFor(id, user.id) }, 201);
    }
  }
  if (parts[0] === "projects" && parts[1]) {
    const project = projectFor(parts[1], user.id);
    if (!project) throw new ApiError(404, "项目不存在。");
    if (parts.length === 2) {
      if (method === "GET")
        return json({
          project,
          assets: (
            db()
              .prepare(
                "SELECT * FROM assets WHERE project_id=? ORDER BY created_at",
              )
              .all(project.id) as Asset[]
          ).map(cleanAsset),
          jobs: (
            db()
              .prepare(
                "SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
              )
              .all(project.id) as Job[]
          ).map(cleanJob),
        });
      if (method === "PATCH") {
        const input = projectUpdate.parse(await readJson(request));
        const source = db()
          .prepare(
            "SELECT * FROM assets WHERE project_id=? AND kind='source' AND status='ready'",
          )
          .get(project.id) as Asset | undefined;
        if (
          source
            ? !validTrim(input.trim_start, input.trim_end, source.duration!)
            : input.trim_start !== 0 || input.trim_end !== 0
        )
          throw new ApiError(400, "片段时间超出范围，或短于 0.1 秒。");
        const result = db()
          .prepare(
            "UPDATE projects SET title=?,trim_start=?,trim_end=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND version=?",
          )
          .run(
            input.title,
            input.trim_start,
            input.trim_end,
            Date.now(),
            project.id,
            user.id,
            input.version,
          );
        if (!result.changes)
          throw new ApiError(409, "项目已在其他页面更新，请刷新后重试。");
        return json({ project: projectFor(project.id, user.id) });
      }
      if (method === "DELETE") {
        transaction(() => {
          if (
            db()
              .prepare(
                "SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')",
              )
              .get(project.id)
          )
            throw new ApiError(
              409,
              "请先取消正在排队或处理的任务，再删除项目。",
            );
          db()
            .prepare("DELETE FROM projects WHERE id=? AND owner_id=?")
            .run(project.id, user.id);
        });
        await rm(storagePath(`media/${project.id}`), {
          recursive: true,
          force: true,
        });
        return json({ ok: true });
      }
    }
    if (parts[2] === "assets" && parts.length === 3 && method === "POST") {
      const kind = url.searchParams.get("kind");
      if (kind !== "source" && kind !== "reference")
        throw new ApiError(400, "请选择素材类型。");
      const check = (extraBytes = 0) => {
        if (!projectFor(project.id, user.id))
          throw new ApiError(404, "项目已被删除。");
        const assets = db()
          .prepare(
            "SELECT kind FROM assets WHERE project_id=? AND status!='failed'",
          )
          .all(project.id) as { kind: string }[];
        if (kind === "source" && assets.some((a) => a.kind === "source"))
          throw new ApiError(
            409,
            "每个项目支持一个源视频，请新建项目上传其他视频。",
          );
        if (
          kind === "reference" &&
          assets.filter((a) => a.kind === "reference").length >= 8
        )
          throw new ApiError(409, "每个项目最多保存 8 张参考照片。");
        const usage = db()
          .prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM assets")
          .get() as { n: number };
        if (usage.n + extraBytes > 10 * 1024 ** 3 || usage.n >= 10 * 1024 ** 3)
          throw new ApiError(409, "内测素材已达到 10 GB，请清理后重试。");
      };
      check();
      const file = await receiveUpload(request, project.id, kind);
      const jobId = randomUUID(),
        now = Date.now();
      try {
        transaction(() => {
          check(file.bytes);
          db()
            .prepare(
              "INSERT INTO assets(id,project_id,kind,name,path,mime,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              file.id,
              project.id,
              kind,
              file.name,
              file.path,
              file.mime,
              file.bytes,
              now,
            );
          db()
            .prepare(
              "INSERT INTO jobs(id,project_id,owner_id,kind,payload,created_at,updated_at) VALUES(?,?,?,'analyze',?,?,?)",
            )
            .run(
              jobId,
              project.id,
              user.id,
              JSON.stringify({ assetId: file.id }),
              now,
              now,
            );
          db()
            .prepare("UPDATE projects SET updated_at=? WHERE id=?")
            .run(now, project.id);
        });
      } catch (error) {
        await rm(storagePath(file.path), { force: true });
        throw error;
      }
      return json({ assetId: file.id, jobId }, 202);
    }
    if (parts[2] === "export" && parts.length === 3 && method === "POST") {
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
        throw new ApiError(400, "请提供有效的任务请求标识。");
      const job = transaction(() => {
        const existing = db()
          .prepare("SELECT * FROM jobs WHERE owner_id=? AND request_key=?")
          .get(user.id, key) as Job | undefined;
        if (existing) {
          if (existing.project_id !== project.id || existing.kind !== "export")
            throw new ApiError(409, "请求标识已用于其他任务。");
          return existing;
        }
        const current = projectFor(project.id, user.id)!;
        const source = db()
          .prepare(
            "SELECT * FROM assets WHERE project_id=? AND kind='source' AND status='ready'",
          )
          .get(project.id) as Asset | undefined;
        if (
          !source ||
          !validTrim(current.trim_start, current.trim_end, source.duration!)
        )
          throw new ApiError(409, "请等待视频解析完成并保存有效片段。");
        const queued = db()
          .prepare(
            "SELECT COUNT(*) AS n FROM jobs WHERE owner_id=? AND status IN ('queued','running')",
          )
          .get(user.id) as { n: number };
        if (queued.n >= 10)
          throw new ApiError(429, "当前任务较多，请等待完成后再提交。");
        const id = randomUUID(),
          now = Date.now();
        db()
          .prepare(
            "INSERT INTO jobs(id,project_id,owner_id,kind,payload,request_key,created_at,updated_at) VALUES(?,?,?,'export',?,?,?,?)",
          )
          .run(
            id,
            project.id,
            user.id,
            JSON.stringify({
              assetId: source.id,
              start: current.trim_start,
              end: current.trim_end,
            }),
            key,
            now,
            now,
          );
        return jobFor(id, user.id)!;
      });
      return json({ job: cleanJob(job) }, 202);
    }
  }
  if (
    parts[0] === "assets" &&
    parts[1] &&
    ["GET", "HEAD", "DELETE"].includes(method)
  ) {
    const asset = assetFor(parts[1], user.id);
    if (!asset) throw new ApiError(404, "素材不存在。");
    if (parts.length === 2 && method === "DELETE") {
      if (asset.kind !== "reference")
        throw new ApiError(409, "源视频与项目关联，请通过删除项目清理。");
      transaction(() => {
        if (
          db()
            .prepare(
              "SELECT 1 FROM jobs WHERE project_id=? AND kind='analyze' AND json_extract(payload,'$.assetId')=? AND status IN ('queued','running')",
            )
            .get(asset.project_id, asset.id)
        )
          throw new ApiError(409, "请等待照片解析完成，或先取消解析任务。");
        db().prepare("DELETE FROM assets WHERE id=?").run(asset.id);
      });
      await rm(storagePath(asset.path), { force: true });
      if (asset.thumbnail)
        await rm(storagePath(asset.thumbnail), { force: true });
      return json({ ok: true });
    }
    if (parts.length === 2 && ["GET", "HEAD"].includes(method))
      return serveFile(request, asset.path, asset.mime);
    if (
      parts.length === 3 &&
      parts[2] === "thumbnail" &&
      asset.thumbnail &&
      ["GET", "HEAD"].includes(method)
    )
      return serveFile(request, asset.thumbnail, "image/jpeg");
  }
  if (parts[0] === "jobs") {
    if (parts.length === 1 && method === "GET")
      return json({
        jobs: (
          db()
            .prepare(
              "SELECT * FROM jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 100",
            )
            .all(user.id) as Job[]
        ).map(cleanJob),
      });
    if (!parts[1]) throw new ApiError(404, "接口不存在。");
    const job = jobFor(parts[1], user.id);
    if (!job) throw new ApiError(404, "任务不存在。");
    if (parts.length === 2 && method === "GET")
      return json({ job: cleanJob(job) });
    if (
      parts[2] === "download" &&
      parts.length === 3 &&
      ["GET", "HEAD"].includes(method)
    ) {
      if (job.status !== "succeeded" || job.kind !== "export" || !job.output)
        throw new ApiError(409, "导出文件尚未就绪。");
      return serveFile(
        request,
        job.output,
        "video/mp4",
        `${projectFor(job.project_id, user.id)?.title || "映刻导出"}.mp4`,
      );
    }
    if (parts[2] === "cancel" && parts.length === 3 && method === "POST") {
      transaction(() => {
        const current = jobFor(job.id, user.id)!;
        if (current.status === "queued") {
          db()
            .prepare(
              "UPDATE jobs SET status='cancelled',cancel_requested=1,finished_at=?,updated_at=? WHERE id=?",
            )
            .run(Date.now(), Date.now(), job.id);
          if (current.kind === "analyze")
            db()
              .prepare(
                "UPDATE assets SET status='failed',error='解析已取消，可重新上传。' WHERE id=?",
              )
              .run(JSON.parse(current.payload).assetId);
        } else if (current.status === "running")
          db()
            .prepare("UPDATE jobs SET cancel_requested=1 WHERE id=?")
            .run(job.id);
      });
      return json({ job: cleanJob(jobFor(job.id, user.id)!) });
    }
  }
  throw new ApiError(404, "接口不存在。");
});
export {
  handle as GET,
  handle as POST,
  handle as PATCH,
  handle as DELETE,
  handle as HEAD,
};
