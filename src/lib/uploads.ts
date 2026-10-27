import Busboy from "busboy";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { storagePath } from "./db";
import { ApiError } from "./http";

const videos: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};
const images: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};
export async function receiveUpload(
  request: Request,
  projectId: string,
  kind: "source" | "reference",
) {
  const max = (kind === "source" ? 512 : 15) * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > max + 1_048_576)
    throw new ApiError(413, "文件超过上传大小限制。");
  if (!request.body) throw new ApiError(400, "请选择文件。");
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: { "content-type": request.headers.get("content-type") || "" },
      limits: { files: 1, fields: 0, parts: 2, fileSize: max },
    });
  } catch {
    throw new ApiError(400, "上传格式错误，请选择一个文件。");
  }
  let uploaded:
    | { id: string; name: string; path: string; mime: string; bytes: number }
    | undefined;
  let failure: Error | undefined;
  const writes: Promise<void>[] = [];
  await mkdir(storagePath(`media/${projectId}`), {
    recursive: true,
    mode: 0o700,
  });
  parser.on("file", (field, stream, info) => {
    const filename = info.filename || "";
    const ext = path.extname(filename).toLowerCase();
    const mime = (kind === "source" ? videos : images)[ext];
    if (field !== "file" || !mime) {
      failure = new ApiError(
        415,
        kind === "source"
          ? "支持 MP4、MOV、WebM 和 MKV 视频。"
          : "参考照片支持 JPG 和 PNG。",
      );
      stream.resume();
      return;
    }
    const id = randomUUID();
    uploaded = {
      id,
      name:
        path
          .basename(filename)
          .replace(/[\x00-\x1f\x7f]/g, "")
          .slice(0, 180) || "未命名素材",
      path: `media/${projectId}/${id}${ext}`,
      mime,
      bytes: 0,
    };
    const asset = uploaded;
    stream.on("data", (chunk: Buffer) => {
      asset.bytes += chunk.length;
    });
    stream.on("limit", () => {
      failure = new ApiError(
        413,
        `文件超过 ${kind === "source" ? 512 : 15} MB 限制。`,
      );
    });
    writes.push(
      pipeline(
        stream,
        createWriteStream(storagePath(asset.path), {
          flags: "wx",
          mode: 0o600,
        }),
      ).catch(() => {
        failure ||= new ApiError(400, "上传中断，请重试。");
      }),
    );
  });
  parser.on("filesLimit", () => {
    failure = new ApiError(400, "每次请选择一个文件。");
  });
  parser.on("fieldsLimit", () => {
    failure = new ApiError(400, "上传格式错误。");
  });
  parser.on("partsLimit", () => {
    failure = new ApiError(400, "每次请选择一个文件。");
  });
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(
        total > max + 1_048_576 ? new ApiError(413, "上传内容过大。") : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(Readable.fromWeb(request.body as never), limiter, parser);
  } catch (error) {
    failure ||=
      error instanceof ApiError
        ? error
        : new ApiError(400, "上传中断或格式错误，请重试。");
  }
  await Promise.all(writes);
  if (failure || !uploaded || uploaded.bytes === 0) {
    if (uploaded) await rm(storagePath(uploaded.path), { force: true });
    throw failure || new ApiError(400, "文件为空，请重新选择。");
  }
  return uploaded;
}
