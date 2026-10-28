import fs from "node:fs";
import path from "node:path";

export function writePowerShellLauncher(output, source) {
  const marker = "# YINGKE-POWERSHELL-PAYLOAD";
  if (source.includes(marker)) throw new Error("启动脚本包含保留的载荷标记。");
  const command =
    "$s=[IO.File]::ReadAllText($env:YINGKE_INSTALLER);$m='" +
    marker +
    "';&([scriptblock]::Create($s.Substring($s.LastIndexOf($m)+$m.Length)))";
  const header =
    '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "YINGKE_INSTALLER=%~f0"\r\npowershell.exe -NoLogo -NoProfile -Command "' +
    command +
    '"\r\nexit /b %errorlevel%\r\n';
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(
    output,
    header + marker + "\r\n" + source.replace(/\r?\n/g, "\r\n"),
    "utf8",
  );
  fs.writeFileSync(output + ".review.ps1", source, "utf8");
}
