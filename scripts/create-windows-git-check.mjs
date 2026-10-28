import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePowerShellLauncher } from "./lib/windows-launcher.mjs";

const [target, output] = process.argv.slice(2);
if (!target || !output || !/^[A-Za-z]:[\\/]/.test(target))
  throw new Error(
    "用法：node scripts/create-windows-git-check.mjs <Windows项目绝对路径> <输出cmd文件>",
  );
const source = fs
  .readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "windows-git-check.ps1",
    ),
    "utf8",
  )
  .replaceAll("@@TARGET@@", Buffer.from(target, "utf8").toString("base64"));
writePowerShellLauncher(output, source);
console.log("已生成只读 Git 文件变更检查入口：" + output);
