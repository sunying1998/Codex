import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.argv[2] ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
process.chdir(root);
for (const file of [".env.local", ".env"])
  if (fs.existsSync(file)) process.loadEnvFile(file);
const data = path.resolve(process.env.YINGKE_DATA_DIR || ".data");
const sanitize = (value) =>
  String(value)
    .split(data)
    .join("[data]")
    .split(root)
    .join("[project]")
    .slice(-3500);
function run(binary, args) {
  try {
    return {
      ok: true,
      output: execFileSync(binary, args, {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: sanitize(error.stderr || error.message),
      exit: error.status,
      code: error.code,
    };
  }
}
function version(binary) {
  const result = run(binary, ["-version"]);
  return result.ok ? result.output.split(/\r?\n/)[0] : result;
}
function probe(file, formats) {
  const result = run("ffprobe", [
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    formats,
    "-show_entries",
    "format=format_name:stream=codec_name,codec_type,width,height",
    "-of",
    "json",
    file,
  ]);
  if (result.ok) return { ok: true, metadata: JSON.parse(result.output) };
  return result;
}
function actualType(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(32);
  let count;
  try {
    count = fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (
    count >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "PNG";
  if (count >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255)
    return "JPEG";
  if (
    head.toString("ascii", 0, 4) === "RIFF" &&
    head.toString("ascii", 8, 12) === "WEBP"
  )
    return "WebP";
  if (head.toString("ascii", 0, 3) === "GIF") return "GIF";
  if (head.toString("ascii", 0, 2) === "BM") return "BMP";
  if (head.toString("ascii", 4, 8) === "ftyp") return "HEIF/AVIF/ISO-container";
  return "Unknown";
}
const database = new DatabaseSync(path.join(data, "studio.sqlite"), {
  readOnly: true,
});
let rows;
try {
  rows = database
    .prepare(
      `SELECT a.id,a.name,a.path,a.mime,a.bytes,a.status,a.error,a.width,a.height,
    (SELECT j.error FROM jobs j WHERE json_extract(j.payload,'$.assetId')=a.id ORDER BY j.created_at DESC LIMIT 1) AS task_error
    FROM assets a WHERE a.kind='reference' ORDER BY a.created_at DESC LIMIT 4`,
    )
    .all();
} finally {
  database.close();
}
const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  ffmpeg: version("ffmpeg"),
  ffprobe: version("ffprobe"),
  images: [],
};
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "yingke-image-diagnostic-"),
);
try {
  for (const row of rows) {
    const { path: relative, ...details } = row;
    const entry = { ...details };
    report.images.push(entry);
    const file = path.resolve(data, relative);
    const inside = path.relative(path.join(data, "media"), file);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      entry.fileError = "File is outside the media directory";
      continue;
    }
    if (!fs.existsSync(file)) {
      entry.fileError = "Uploaded file is missing";
      continue;
    }
    entry.actualType = actualType(file);
    entry.oldProbe = probe(file, "mov,matroska,webm,jpeg_pipe,png_pipe");
    entry.fixedProbe = probe(file, "image2,jpeg_pipe,png_pipe");
    if (entry.fixedProbe.ok) {
      const stream = entry.fixedProbe.metadata.streams?.find(
        (stream) => stream.codec_type === "video",
      );
      if (
        stream &&
        ["png", "mjpeg", "ljpeg"].includes(stream.codec_name) &&
        stream.width <= 8192 &&
        stream.height <= 8192 &&
        stream.width * stream.height <= 33554432
      ) {
        const output = path.join(temporary, row.id + ".jpg");
        const result = run("ffmpeg", [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "image2,jpeg_pipe,png_pipe",
          "-i",
          file,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "scale=640:360:force_original_aspect_ratio=decrease",
          "-threads",
          "1",
          output,
        ]);
        entry.thumbnail = result.ok
          ? { ok: true, bytes: fs.statSync(output).size }
          : result;
      } else
        entry.thumbnail = {
          ok: false,
          error: "Image codec or dimensions are outside supported limits",
        };
    }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
const directory = path.join(root, ".data", "diagnostics");
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, "image-report-" + Date.now() + ".json");
fs.writeFileSync(output, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
console.log("\nReport saved: " + output);
console.log(
  "This report contains image errors and codec metadata; no images, passwords, session tokens or environment values are included.",
);
