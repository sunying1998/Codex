import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./lib/project.mjs";
import { DIRECT_GIT_OPTIONS } from "./lib/git-connection.mjs";
import { writePowerShellLauncher } from "./lib/windows-launcher.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [target, output, proxy = "", backend = ""] = process.argv.slice(2);
if (!target || !output)
  throw new Error(
    "用法：node scripts/create-windows-installer.mjs <Windows项目绝对路径> <输出cmd文件> [http://127.0.0.1:端口] [openssl|schannel]",
  );
if (!/^[A-Za-z]:[\\/]/.test(target)) throw new Error("需要 Windows 绝对路径。");
if (proxy) {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(proxy);
  if (!match || Number(match[1]) > 65535)
    throw new Error(
      "代理必须是有效的本机 HTTP/混合代理地址，例如 http://127.0.0.1:12450。",
    );
}
if (!["", "openssl", "schannel"].includes(backend))
  throw new Error("TLS 后端仅支持 openssl 或 schannel。");
const commit = git(root, ["rev-parse", "HEAD"]);
let source = fs.readFileSync(
  path.join(root, "scripts/windows-installer.ps1"),
  "utf8",
);
for (const [key, value] of Object.entries({
  TARGET: Buffer.from(target, "utf8").toString("base64"),
  COMMIT: commit,
  PROXY: proxy,
  BACKEND: backend,
  DIRECT_OPTIONS: DIRECT_GIT_OPTIONS.map(
    (value) => "'" + value.replaceAll("'", "''") + "'",
  ).join(","),
}))
  source = source.replaceAll("@@" + key + "@@", value);
if (/@@[A-Z_]+@@/.test(source)) throw new Error("安装器模板未完成替换。");
writePowerShellLauncher(output, source);
console.log(
  "已生成固定提交 " + commit.slice(0, 12) + " 的一次性 Git 接入入口：" + output,
);
