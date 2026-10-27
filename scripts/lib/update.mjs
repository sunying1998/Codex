import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  BRANCH,
  REPOSITORY,
  git,
  isAncestor,
  remoteIdentity,
  assertClean,
  safeTree,
  hash,
  readJson,
  writeJson,
  npm,
  backupState,
  waitWorkerStopped,
} from "./project.mjs";
import { stopRuntime } from "./control.mjs";

export async function withUpdateLock(ctx, operation) {
  const file = path.join(ctx.updates, "operation.lock");
  fs.mkdirSync(ctx.updates, { recursive: true, mode: 0o700 });
  const identity = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const old = readJson(file);
      let running = false;
      if (old?.pid)
        try {
          process.kill(old.pid, 0);
          running = true;
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      if (running || attempt)
        throw new Error("另一个启动或更新操作正在进行，请等待完成。");
      fs.renameSync(file, file + ".stale-" + Date.now());
    }
  }
  try {
    return await operation();
  } finally {
    if (readJson(file)?.identity === identity) fs.rmSync(file, { force: true });
  }
}
export async function ensureBuild(
  ctx,
  { runNpm = npm, commit = git(ctx.root, ["rev-parse", "HEAD"]) } = {},
) {
  const lockHash = hash(
    fs.readFileSync(path.join(ctx.root, "package-lock.json")),
  );
  const installed = readJson(path.join(ctx.runtime, "dependencies.json"));
  if (
    installed?.lockHash !== lockHash ||
    installed?.nodeMajor !== process.versions.node.split(".")[0] ||
    !fs.existsSync(path.join(ctx.root, "node_modules/next/package.json")) ||
    !fs.existsSync(path.join(ctx.root, "node_modules/tsx/package.json"))
  ) {
    await runNpm(ctx.root, "install");
    writeJson(path.join(ctx.runtime, "dependencies.json"), {
      lockHash,
      nodeMajor: process.versions.node.split(".")[0],
    });
  }
  const build = readJson(path.join(ctx.runtime, "build.json"));
  if (
    build?.commit !== commit ||
    build?.lockHash !== lockHash ||
    build?.nodeMajor !== process.versions.node.split(".")[0] ||
    !fs.existsSync(path.join(ctx.root, ".next/BUILD_ID"))
  ) {
    await runNpm(ctx.root, "build");
    writeJson(path.join(ctx.runtime, "build.json"), {
      commit,
      lockHash,
      nodeMajor: process.versions.node.split(".")[0],
    });
  }
}
export async function updateProject(
  ctx,
  {
    repository = REPOSITORY,
    branch = BRANCH,
    runNpm = npm,
    stop = stopRuntime,
    waitStopped = waitWorkerStopped,
    build = ensureBuild,
  } = {},
) {
  const top = fs.realpathSync(git(ctx.root, ["rev-parse", "--show-toplevel"]));
  if (top !== ctx.root) throw new Error("当前文件夹不是 Git 仓库根目录。");
  if (
    remoteIdentity(git(ctx.root, ["remote", "get-url", "origin"])) !==
    remoteIdentity(repository)
  )
    throw new Error("origin 不是预期仓库，未更改远端配置。");
  if (git(ctx.root, ["branch", "--show-current"]) !== branch)
    throw new Error("当前不在 " + branch + " 分支，更新已停止。");
  assertClean(ctx.root);
  console.log("检查 GitHub 更新…");
  git(ctx.root, ["fetch", "origin", branch]);
  const before = git(ctx.root, ["rev-parse", "HEAD"]),
    after = git(ctx.root, ["rev-parse", "FETCH_HEAD"]);
  safeTree(ctx.root, after);
  if (!isAncestor(ctx.root, before, after))
    throw new Error(
      "本地提交与远端分叉，更新已停止；不会重置、强推或丢弃提交。",
    );
  assertClean(ctx.root);
  await stop(ctx);
  await waitStopped(ctx);
  let backup = null;
  if (before !== after) {
    backup = await backupState(ctx, "git-update", { before, after });
    git(ctx.root, ["update-ref", "refs/yingke/backups/" + Date.now(), before]);
    console.log("更新前备份：" + backup);
    git(ctx.root, ["merge", "--ff-only", after]);
  }
  try {
    await build(ctx, { runNpm, commit: after });
  } catch (error) {
    throw new Error(
      error.message +
        (backup ? "\n更新前数据库、配置和版本记录：" + backup : "") +
        "\n服务保持停止，可修复后再次运行更新；不会自动回退数据库。",
    );
  }
  console.log(
    before === after
      ? "代码已是最新，运行依赖与构建已验证。"
      : "代码已同步到 " + after.slice(0, 12),
  );
  return { before, after, backup };
}
