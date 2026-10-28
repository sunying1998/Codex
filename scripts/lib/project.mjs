import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { executeGit } from "./git-connection.mjs";

export const REPOSITORY = "https://github.com/sunying1998/Codex.git";
export const BRANCH = "main";
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const hash = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");
export function project(root) {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("需要 Node.js 24 或以上版本。");
  root = fs.realpathSync(root);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (pkg.name !== "yingke-studio") throw new Error("所选目录不是映刻项目。");
  for (const file of [".env.local", ".env"])
    if (fs.existsSync(path.join(root, file)))
      process.loadEnvFile(path.join(root, file));
  const data = path.resolve(root, process.env.YINGKE_DATA_DIR || ".data");
  return {
    root,
    data,
    runtime: path.join(data, "runtime"),
    updates: path.join(data, "updates"),
  };
}
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
}
export function git(root, args) {
  return executeGit(root, args);
}
export function isAncestor(root, a, b) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw new Error("无法检查 Git 提交关系。");
  }
}
export function remoteIdentity(value) {
  if (
    value.startsWith("https://") ||
    value.startsWith("http://") ||
    value.startsWith("ssh://")
  ) {
    const url = new URL(value);
    return (
      url.hostname +
      "/" +
      url.pathname.replace(/^\//, "").replace(/\.git$/, "")
    ).toLowerCase();
  }
  const match = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(value);
  return match
    ? (match[1] + "/" + match[2].replace(/\.git$/, "")).toLowerCase()
    : value;
}
export function assertClean(root) {
  const changes = git(root, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (changes)
    throw new Error(
      "本地受 Git 管理的文件有修改。更新已停止，请先保存或处理这些修改；不会覆盖。\n改动文件（仅状态与文件名）：\n" +
        changes,
    );
}
export function protectedPath(file) {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  return (
    normalized
      .split("/")
      .some((part) =>
        [".data", "node_modules", ".next", ".git"].includes(part),
      ) ||
    normalized
      .split("/")
      .some((part) => part.startsWith(".env") && part !== ".env.example") ||
    /\.(sqlite(?:-wal|-shm)?|db|log)$/.test(normalized)
  );
}
export function safeTree(root, ref = "HEAD") {
  const raw = execFileSync("git", ["ls-tree", "-r", "-z", ref], { cwd: root });
  return raw
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t"),
        info = entry.slice(0, tab).split(" "),
        file = entry.slice(tab + 1);
      if (info[0] !== "100644" && info[0] !== "100755")
        throw new Error("仓库包含当前更新器不支持的链接或子模块：" + file);
      if (
        protectedPath(file) ||
        file.split("/").includes("..") ||
        path.isAbsolute(file)
      )
        throw new Error("拒绝同步本机数据或敏感配置路径：" + file);
      return file;
    });
}
export function workerOnline(ctx) {
  const file = path.join(ctx.data, "studio.sqlite");
  if (!fs.existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const exists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_lock'",
      )
      .get();
    if (!exists) return false;
    const row = db
      .prepare("SELECT expires_at FROM worker_lock WHERE id=1")
      .get();
    return !!row && row.expires_at > Date.now();
  } finally {
    db.close();
  }
}
export async function waitWorkerStopped(ctx, milliseconds = 35000) {
  const end = Date.now() + milliseconds;
  while (workerOnline(ctx) && Date.now() < end) await delay(300);
  if (workerOnline(ctx))
    throw new Error(
      "旧版或其他 Worker 仍在运行。请先关闭原启动窗口，再执行更新；未停止其他程序。",
    );
}
export async function npm(root, action) {
  const args =
    action === "install"
      ? ["ci", "--include=dev", "--no-audit", "--no-fund"]
      : ["run", "build"];
  await new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(
            "cmd.exe",
            [
              "/d",
              "/s",
              "/c",
              action === "install"
                ? "npm ci --include=dev --no-audit --no-fund"
                : "npm run build",
            ],
            {
              cwd: root,
              stdio: "inherit",
              env: {
                ...process.env,
                NODE_ENV: "production",
                NEXT_TELEMETRY_DISABLED: "1",
              },
            },
          )
        : spawn("npm", args, {
            cwd: root,
            stdio: "inherit",
            env: {
              ...process.env,
              NODE_ENV: "production",
              NEXT_TELEMETRY_DISABLED: "1",
            },
          });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              action === "install"
                ? "依赖安装失败，保留现有数据。"
                : "构建失败，服务保持停止，保留代码和数据备份。",
            ),
          ),
    );
  });
}
export function prerequisites() {
  for (const tool of ["ffmpeg", "ffprobe"])
    try {
      execFileSync(tool, ["-version"], { stdio: "ignore", windowsHide: true });
    } catch {
      throw new Error("缺少 " + tool + "，请先安装 FFmpeg。");
    }
}
export async function backupState(ctx, label, commits = {}) {
  const folder = path.join(ctx.updates, label + "-" + Date.now());
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const databaseFile = path.join(ctx.data, "studio.sqlite");
  if (fs.existsSync(databaseFile)) {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      await backup(db, path.join(folder, "studio.sqlite"));
    } finally {
      db.close();
    }
  }
  for (const name of [".env.local", ".env"]) {
    const source = path.join(ctx.root, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(folder, name));
  }
  const connectionFile = path.join(ctx.data, "git-connection.json");
  if (fs.existsSync(connectionFile))
    fs.copyFileSync(connectionFile, path.join(folder, "git-connection.json"));
  writeJson(path.join(folder, "version.json"), {
    ...commits,
    createdAt: new Date().toISOString(),
    media: "原素材保留在持久化目录，未重复复制。",
  });
  return folder;
}
