import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import { db, storagePath, transaction } from "./db";
import type { Asset, Job } from "./types";

const owner = randomUUID();
let shutdown = false;
let active: AbortController | undefined;
class Cancelled extends Error {}
class Interrupted extends Error {}
function run(
  binary: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
  progress?: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      stopped = false,
      timedOut = false;
    const stop = () => {
      stopped = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      const value = chunk.toString();
      progress?.(value);
      stdout += value;
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (timedOut) reject(new Error("处理超时，请尝试更短的片段。"));
      else if (stopped) reject(new Cancelled());
      else if (code !== 0) {
        // Do not store raw media metadata, absolute paths or arbitrary tool output in user-facing errors.
        console.error(
          `${binary} exited ${code}; diagnostic:`,
          stderr.replaceAll(storagePath("media"), "[media]"),
        );
        reject(
          new Error(
            binary === "ffprobe"
              ? "无法解析文件，请使用有效的 MP4、MOV、WebM、MKV 视频或 JPG、PNG 图片。"
              : "视频处理失败，请检查素材编码，或换一个片段重试。",
          ),
        );
      } else resolve(stdout);
    });
  });
}
function inputFlags(kind: Asset["kind"]) {
  return [
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    kind === "source" ? "mov,matroska,webm" : "image2,jpeg_pipe,png_pipe",
  ];
}
async function analyze(job: Job, signal: AbortSignal) {
  const { assetId } = JSON.parse(job.payload) as { assetId: string };
  const asset = db().prepare("SELECT * FROM assets WHERE id=?").get(assetId) as
    Asset | undefined;
  if (!asset) throw new Error("素材已被删除。");
  const probe = JSON.parse(
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        ...inputFlags(asset.kind),
        "-show_entries",
        "stream=codec_type,width,height,codec_name:format=duration,format_name",
        "-of",
        "json",
        storagePath(asset.path),
      ],
      signal,
      45_000,
    ),
  ) as {
    streams: {
      codec_type: string;
      codec_name: string;
      width: number;
      height: number;
    }[];
    format: { duration?: string; format_name: string };
  };
  const stream = probe.streams.find((s) => s.codec_type === "video");
  if (!stream?.width || !stream.height)
    throw new Error("文件不包含可处理的画面。");
  const duration = asset.kind === "source" ? Number(probe.format.duration) : 0;
  if (
    asset.kind === "source" &&
    (!Number.isFinite(duration) || duration <= 0 || duration > 600)
  )
    throw new Error("内测版支持最长 10 分钟的有限时长视频。");
  const allowedFormat =
    asset.kind === "source"
      ? /mov|mp4|matroska|webm/.test(probe.format.format_name)
      : /^(image2|png_pipe|jpeg_pipe)$/.test(probe.format.format_name) &&
        ["png", "mjpeg", "ljpeg"].includes(stream.codec_name);
  if (!allowedFormat)
    throw new Error(
      asset.kind === "reference"
        ? "图片实际格式不受支持，请导出为 JPG 或 PNG 后重新上传；只改文件后缀不会转换格式。"
        : "实际文件格式与支持的素材类型不符。",
    );
  if (
    stream.width > (asset.kind === "source" ? 4096 : 8192) ||
    stream.height > (asset.kind === "source" ? 4096 : 8192) ||
    stream.width * stream.height >
      (asset.kind === "source" ? 16_777_216 : 33_554_432)
  )
    throw new Error(
      asset.kind === "reference"
        ? `照片为 ${stream.width} × ${stream.height} 像素，超过限制：最长边 8192，且总像素不超过 32 MP。请缩小后重新上传。`
        : `视频为 ${stream.width} × ${stream.height} 像素，超过限制：最长边 4096，且总像素不超过 16 MP。`,
    );
  const thumb = `media/${job.project_id}/${asset.id}.jpg`;
  const temporary = `media/${job.project_id}/${asset.id}.${owner}.partial.jpg`;
  try {
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        ...inputFlags(asset.kind),
        ...(asset.kind === "source"
          ? ["-ss", String(Math.min(0.5, duration / 2))]
          : []),
        "-i",
        storagePath(asset.path),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=640:360:force_original_aspect_ratio=decrease",
        "-threads",
        "1",
        storagePath(temporary),
      ],
      signal,
      60_000,
    );
    if (signal.aborted) throw new Cancelled();
    await rename(storagePath(temporary), storagePath(thumb));
    transaction(() => {
      assertActive(job.id);
      db()
        .prepare(
          "UPDATE assets SET status='ready',duration=?,width=?,height=?,thumbnail=?,mime=?,error=NULL WHERE id=?",
        )
        .run(
          duration,
          stream.width,
          stream.height,
          thumb,
          asset.kind === "reference"
            ? stream.codec_name === "png"
              ? "image/png"
              : "image/jpeg"
            : asset.mime,
          asset.id,
        );
      if (asset.kind === "source")
        db()
          .prepare(
            "UPDATE projects SET trim_start=0,trim_end=?,version=version+1,updated_at=? WHERE id=?",
          )
          .run(Math.min(duration, 10), Date.now(), job.project_id);
      finish(job.id, null);
    });
  } finally {
    await rm(storagePath(temporary), { force: true });
  }
}
function assertActive(id: string) {
  const job = db()
    .prepare("SELECT status,cancel_requested FROM jobs WHERE id=?")
    .get(id) as Job | undefined;
  const lock = db()
    .prepare("SELECT owner FROM worker_lock WHERE id=1")
    .get() as { owner: string } | undefined;
  if (lock?.owner !== owner) throw new Interrupted();
  if (!job || job.cancel_requested || job.status !== "running")
    throw new Cancelled();
  if (shutdown) throw new Interrupted();
}
function finish(id: string, output: string | null) {
  db()
    .prepare(
      "UPDATE jobs SET status='succeeded',progress=100,output=?,error=NULL,updated_at=?,finished_at=? WHERE id=?",
    )
    .run(output, Date.now(), Date.now(), id);
}
async function exportClip(job: Job, signal: AbortSignal) {
  const input = JSON.parse(job.payload) as {
    assetId: string;
    start: number;
    end: number;
  };
  const asset = db()
    .prepare(
      "SELECT * FROM assets WHERE id=? AND project_id=? AND status='ready'",
    )
    .get(input.assetId, job.project_id) as Asset | undefined;
  if (!asset) throw new Error("源视频不可用，请重新上传。");
  const output = `media/${job.project_id}/${job.id}.mp4`;
  const temporary = `media/${job.project_id}/${job.id}.${owner}.partial.mp4`;
  let progressBuffer = "";
  try {
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        ...inputFlags("source"),
        "-ss",
        String(input.start),
        "-i",
        storagePath(asset.path),
        "-t",
        String(input.end - input.start),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "2",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        storagePath(temporary),
      ],
      signal,
      20 * 60_000,
      (text) => {
        progressBuffer += text;
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop() || "";
        for (const line of lines)
          if (line.startsWith("out_time_us=")) {
            const value = Math.min(
              99,
              Math.max(
                1,
                Math.round(
                  (Number(line.slice(12)) /
                    ((input.end - input.start) * 1_000_000)) *
                    100,
                ),
              ),
            );
            if (Number.isFinite(value))
              db()
                .prepare(
                  "UPDATE jobs SET progress=? WHERE id=? AND status='running'",
                )
                .run(value, job.id);
          }
      },
    );
    if (signal.aborted) throw new Cancelled();
    const outputSize = (await stat(storagePath(temporary))).size;
    if (!outputSize) throw new Error("导出文件为空，请重试。");
    await rename(storagePath(temporary), storagePath(output));
    transaction(() => {
      assertActive(job.id);
      finish(job.id, output);
    });
  } catch (error) {
    await rm(storagePath(output), { force: true });
    throw error;
  } finally {
    await rm(storagePath(temporary), { force: true });
  }
}
function claimJob(): Job | undefined {
  return transaction(() => {
    const job = db()
      .prepare(
        "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1",
      )
      .get() as Job | undefined;
    if (!job) return;
    db()
      .prepare(
        "UPDATE jobs SET status='running',started_at=?,updated_at=?,attempts=attempts+1,progress=1,error=NULL WHERE id=?",
      )
      .run(Date.now(), Date.now(), job.id);
    return job;
  });
}
export async function startWorker() {
  const acquired = transaction(() => {
    const lock = db().prepare("SELECT * FROM worker_lock WHERE id=1").get() as
      { owner: string; expires_at: number } | undefined;
    if (lock && lock.expires_at > Date.now()) return false;
    db()
      .prepare(
        "INSERT INTO worker_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at",
      )
      .run(owner, Date.now() + 30_000);
    const interrupted = db()
      .prepare("SELECT * FROM jobs WHERE status='running'")
      .all() as Job[];
    for (const job of interrupted) {
      const terminal = job.cancel_requested || job.attempts >= 3;
      db()
        .prepare(
          "UPDATE jobs SET status=?,progress=0,error=?,updated_at=?,finished_at=? WHERE id=?",
        )
        .run(
          job.cancel_requested ? "cancelled" : terminal ? "failed" : "queued",
          terminal ? "任务多次中断，请重新提交。" : null,
          Date.now(),
          terminal ? Date.now() : null,
          job.id,
        );
      if (terminal && job.kind === "analyze")
        db()
          .prepare(
            "UPDATE assets SET status='failed',error='解析中断，请重新上传。' WHERE id=?",
          )
          .run(JSON.parse(job.payload).assetId);
    }
    return true;
  });
  if (!acquired)
    throw new Error("已有 Worker 正在运行；异常退出后请等待最多 30 秒再启动。");
  console.log("映刻 Worker 已启动，等待任务。");
  const stop = () => {
    shutdown = true;
    active?.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const onMessage = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "yingke:shutdown"
    )
      stop();
  };
  process.on("message", onMessage);
  const heartbeat = setInterval(() => {
    try {
      if (
        !db()
          .prepare("UPDATE worker_lock SET expires_at=? WHERE id=1 AND owner=?")
          .run(Date.now() + 30_000, owner).changes
      )
        stop();
    } catch {
      stop();
    }
  }, 5000);
  try {
    while (!shutdown) {
      const job = claimJob();
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      active = new AbortController();
      const poll = setInterval(() => {
        const current = db()
          .prepare("SELECT status,cancel_requested FROM jobs WHERE id=?")
          .get(job.id) as Job | undefined;
        if (
          !current ||
          current.cancel_requested ||
          current.status !== "running"
        )
          active?.abort();
      }, 250);
      try {
        if (job.kind === "analyze") await analyze(job, active.signal);
        else if (job.kind === "export") await exportClip(job, active.signal);
        else throw new Error("不支持的任务类型。");
      } catch (error) {
        transaction(() => {
          const lock = db()
            .prepare("SELECT owner FROM worker_lock WHERE id=1")
            .get() as { owner: string } | undefined;
          if (lock?.owner !== owner) return;
          const current = db()
            .prepare("SELECT * FROM jobs WHERE id=?")
            .get(job.id) as Job | undefined;
          if (!current || current.status !== "running") return;
          const retry = shutdown && !current.cancel_requested;
          const cancelled =
            !!current.cancel_requested ||
            (error instanceof Cancelled && !shutdown);
          const status = retry ? "queued" : cancelled ? "cancelled" : "failed";
          const message = retry
            ? null
            : cancelled
              ? "任务已取消。"
              : error instanceof Error
                ? error.message
                : "处理失败，请重试。";
          db()
            .prepare(
              "UPDATE jobs SET status=?,progress=0,error=?,updated_at=?,finished_at=? WHERE id=?",
            )
            .run(
              status,
              message,
              Date.now(),
              retry ? null : Date.now(),
              job.id,
            );
          if (!retry && job.kind === "analyze")
            db()
              .prepare("UPDATE assets SET status='failed',error=? WHERE id=?")
              .run(message, JSON.parse(job.payload).assetId);
        });
      } finally {
        clearInterval(poll);
        active = undefined;
      }
    }
  } finally {
    clearInterval(heartbeat);
    db().prepare("DELETE FROM worker_lock WHERE id=1 AND owner=?").run(owner);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("message", onMessage);
  }
}
