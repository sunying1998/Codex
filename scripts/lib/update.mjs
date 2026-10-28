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
import {
  inspectGeneratedNextEnv,
  prepareGeneratedNextEnv,
  preserveGeneratedNextEnv,
} from "./generated-next-env.mjs";

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
    prefetched = null,
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
  assertClean(ctx.root, { allowGeneratedNextEnv: true });
  let expectedTip = null;
  if (prefetched) {
    const source = fs.realpathSync(prefetched.source);
    if (
      source === ctx.root ||
      !/^[a-f0-9]{40}$/.test(prefetched.expectedCommit || "")
    )
      throw new Error("安装器临时仓库或固定提交参数不正确。");
    if (
      remoteIdentity(git(source, ["remote", "get-url", "origin"])) !==
        remoteIdentity(repository) ||
      git(source, ["branch", "--show-current"]) !== branch ||
      git(source, ["rev-parse", "HEAD"]) !== prefetched.expectedCommit
    )
      throw new Error("安装器临时仓库来源、分支或固定提交校验失败。");
    assertClean(source);
    const ref = "refs/remotes/origin/" + branch;
    expectedTip = git(source, ["rev-parse", "--verify", ref + "^{commit}"]);
    if (!isAncestor(source, prefetched.expectedCommit, expectedTip))
      throw new Error("安装器固定提交不在已下载分支的历史中。");
    safeTree(source, expectedTip);
    console.log("使用安装器已下载的 Git 版本，不重复连接 GitHub…");
    git(ctx.root, ["fetch", "--no-tags", "--", source, ref]);
  } else {
    console.log("检查 GitHub 更新…");
    git(ctx.root, ["fetch", "origin", branch]);
  }
  const before = git(ctx.root, ["rev-parse", "HEAD"]),
    after = git(ctx.root, ["rev-parse", "FETCH_HEAD"]);
  if (expectedTip && after !== expectedTip)
    throw new Error("安装器临时分支在校验期间发生变化，未合并代码。");
  const files = safeTree(ctx.root, after);
  const untracksNextEnv = !files.includes("next-env.d.ts");
  if (!isAncestor(ctx.root, before, after))
    throw new Error(
      "本地提交与远端分叉，更新已停止；不会重置、强推或丢弃提交。",
    );
  assertClean(ctx.root, { allowGeneratedNextEnv: untracksNextEnv });
  await stop(ctx);
  await waitStopped(ctx);
  assertClean(ctx.root, { allowGeneratedNextEnv: untracksNextEnv });
  let backup = null;
  if (before !== after) {
    backup = await backupState(ctx, "git-update", { before, after });
    git(ctx.root, ["update-ref", "refs/yingke/backups/" + Date.now(), before]);
    console.log("更新前备份：" + backup);
    let generated = null;
    if (untracksNextEnv && inspectGeneratedNextEnv(ctx.root)) {
      generated = prepareGeneratedNextEnv(ctx.root, backup);
      console.log(
        "已备份 Next.js 自动生成的 next-env.d.ts，更新后由本机生成，不再参与 Git 同步。",
      );
    }
    try {
      git(ctx.root, ["merge", "--ff-only", after]);
    } catch (error) {
      if (generated && git(ctx.root, ["rev-parse", "HEAD"]) === before)
        preserveGeneratedNextEnv(generated, true);
      throw error;
    }
    if (generated) preserveGeneratedNextEnv(generated);
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
