import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  project,
  git,
  remoteIdentity,
  REPOSITORY,
  BRANCH,
  safeTree,
  waitWorkerStopped,
  backupState,
} from "./project.mjs";

function destination(root, relative) {
  const parts = relative.split("/");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error("目标路径存在链接，未覆盖：" + relative);
  }
  if (fs.existsSync(current) && !fs.statSync(current).isFile())
    throw new Error("目标文件与现有目录冲突：" + relative);
  return current;
}
export async function adoptProject({
  root,
  source,
  repository = REPOSITORY,
  branch = BRANCH,
  expectedCommit,
  waitStopped = waitWorkerStopped,
}) {
  const ctx = project(root);
  source = fs.realpathSync(source);
  if (
    source === ctx.root ||
    source.startsWith(ctx.root + path.sep) ||
    ctx.root.startsWith(source + path.sep)
  )
    throw new Error("迁移临时检出必须与现有项目分开。");
  if (fs.existsSync(path.join(ctx.root, ".git")))
    throw new Error(
      "该目录已经存在 Git 元数据，请使用项目里的 Update-Yingke.cmd；未覆盖已有仓库。",
    );
  if (
    remoteIdentity(git(source, ["remote", "get-url", "origin"])) !==
    remoteIdentity(repository)
  )
    throw new Error("临时检出来源不正确。");
  const commit = git(source, ["rev-parse", "HEAD"]);
  if (expectedCommit && commit !== expectedCommit)
    throw new Error("首次安装的提交校验失败。");
  if (git(source, ["branch", "--show-current"]) !== branch)
    throw new Error("临时检出分支不正确。");
  let externalWorktree = false;
  try {
    externalWorktree = !!execFileSync(
      "git",
      ["config", "--local", "--get", "core.worktree"],
      { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (error) {
    if (error.status !== 1) throw new Error("无法检查临时检出的 Git 元数据。");
  }
  if (externalWorktree)
    throw new Error("不支持带外部 worktree 路径的临时检出。");
  const files = safeTree(source);
  await waitStopped(ctx);
  const replacements = files.map((relative) => ({
    relative,
    target: destination(ctx.root, relative),
    source: path.join(source, relative),
  }));
  for (const item of replacements)
    if (!fs.statSync(item.source).isFile())
      throw new Error("检出文件缺失：" + item.relative);
  const backup = await backupState(ctx, "first-git-setup", { commit });
  for (const item of replacements)
    if (fs.existsSync(item.target)) {
      const saved = path.join(backup, "previous-code", item.relative);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.copyFileSync(item.target, saved);
      item.saved = saved;
    }
  const completed = [];
  let metadataStarted = false;
  try {
    for (const item of replacements) {
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      fs.copyFileSync(item.source, item.target);
      completed.push(item);
    }
    metadataStarted = true;
    fs.cpSync(path.join(source, ".git"), path.join(ctx.root, ".git"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    if (git(ctx.root, ["status", "--porcelain", "--untracked-files=no"]))
      throw new Error("首次 Git 接入后版本检查失败。");
  } catch (error) {
    for (const item of completed.reverse()) {
      if (item.saved) fs.copyFileSync(item.saved, item.target);
      else fs.rmSync(item.target, { force: true });
    }
    if (metadataStarted)
      fs.rmSync(path.join(ctx.root, ".git"), { recursive: true, force: true });
    throw error;
  }
  console.log("已接入 Git。旧代码与本机配置备份：" + backup);
  console.log("账号、素材和本机 .env 配置保留在原位置。");
  return { commit, backup };
}
