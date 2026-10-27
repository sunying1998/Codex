import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ApiError } from "./http";
import { storagePath } from "./db";
import { rangeFor } from "./validation";
export async function serveFile(
  request: Request,
  relative: string,
  mime: string,
  download?: string,
) {
  const full = storagePath(relative);
  let size: number;
  try {
    size = (await stat(full)).size;
  } catch {
    throw new ApiError(404, "文件不存在或已被删除。");
  }
  const headers = new Headers({
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (download)
    headers.set(
      "Content-Disposition",
      `attachment; filename="export.mp4"; filename*=UTF-8''${encodeURIComponent(download)}`,
    );
  const range = request.headers.get("range");
  const parsed = range ? rangeFor(range, size) : undefined;
  if (range && !parsed)
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  const start = parsed?.start ?? 0,
    end = parsed?.end ?? size - 1;
  headers.set("Content-Length", String(end - start + 1));
  if (parsed) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  return new Response(
    request.method === "HEAD"
      ? null
      : (Readable.toWeb(
          createReadStream(full, { start, end }),
        ) as ReadableStream),
    { status: parsed ? 206 : 200, headers },
  );
}
