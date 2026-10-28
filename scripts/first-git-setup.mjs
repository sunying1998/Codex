import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { adoptProject } from "./lib/adopt.mjs";
import { project } from "./lib/project.mjs";
import { updateProject, withUpdateLock } from "./lib/update.mjs";
import { saveGitProfile } from "./lib/git-profile.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.argv[2],
  expectedCommit = process.argv[3];
try {
  if (!root || !expectedCommit || !/^[a-f0-9]{40}$/.test(expectedCommit))
    throw new Error("首次接入参数不完整。");
  if (fs.existsSync(path.join(root, ".git"))) {
    if (!fs.existsSync(path.join(root, "scripts/manage.mjs")))
      throw new Error("目录已有其他 Git 配置，请保留现场后交由本地任务处理。");
  } else await adoptProject({ root, source, expectedCommit });
  const ctx = project(root);
  await withUpdateLock(ctx, async () => {
    await updateProject(ctx, {
      prefetched: { source, expectedCommit },
    });
    if (
      process.platform === "win32" &&
      (process.env.YINGKE_SETUP_GIT_PROXY ||
        process.env.YINGKE_SETUP_GIT_SSL_BACKEND)
    ) {
      const file = saveGitProfile(root, {
        version: 1,
        proxy: process.env.YINGKE_SETUP_GIT_PROXY || "",
        tlsBackend: process.env.YINGKE_SETUP_GIT_SSL_BACKEND || "",
      });
      console.log(
        "已保存本项目 Git 连接设置：" +
          file +
          "。以后双击 Update-Yingke.cmd 即可更新。",
      );
    }
  });
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(root, "scripts/manage.mjs"),
        "start",
        ...(process.argv.includes("--no-open") ? [] : ["--open"]),
      ],
      { cwd: root, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Git 已接入，但启动未完成。可查看上方错误后再次点击 Start-Yingke.cmd；无需重复下载代码。",
            ),
          ),
    );
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
