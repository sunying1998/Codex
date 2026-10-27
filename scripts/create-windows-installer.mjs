import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, REPOSITORY, BRANCH } from "./lib/project.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2],
  output = process.argv[3];
if (!target || !output)
  throw new Error(
    "用法：node scripts/create-windows-installer.mjs <Windows项目绝对路径> <输出cmd文件>",
  );
if (!/^[A-Za-z]:[\\/]/.test(target)) throw new Error("需要 Windows 绝对路径。");
const commit = git(root, ["rev-parse", "HEAD"]);
const encoded = Buffer.from(target, "utf8").toString("base64");
const source = `$ErrorActionPreference='Stop'; $stage=$null; $result=0;
function Refresh-Path { $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')+';'+$env:Path };
function Install-Tool($id,$upgrade) { if(!(Get-Command winget.exe -ErrorAction SilentlyContinue)){throw 'Install Microsoft App Installer / WinGet, then retry.'}; if($upgrade){ & winget.exe upgrade --id $id --source winget --exact --silent --accept-source-agreements --accept-package-agreements } else { & winget.exe install --id $id --source winget --exact --silent --accept-source-agreements --accept-package-agreements }; if($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010){throw ('Installation failed: '+$id)}; Refresh-Path };
try {
 $project=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
 if(!(Test-Path (Join-Path $project 'package.json'))){throw ('Project folder not found: '+$project)};
 Write-Host '[1/3] Checking Node.js, Git and FFmpeg...'; Refresh-Path;
 $nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue; $major=0;
 if($nodeCommand){$v=& $nodeCommand.Source --version; if($v -match '^v([0-9]+)'){$major=[int]$Matches[1]}};
 if($major -lt 24){Install-Tool 'OpenJS.NodeJS.LTS' ([bool]$nodeCommand)};
 $node=(Get-Command node.exe -ErrorAction Stop).Source; $v=& $node --version;
 if($v -notmatch '^v([0-9]+)' -or [int]$Matches[1] -lt 24){throw 'Node.js 24+ is required. Restart this launcher after installation.'};
 if(!(Get-Command git.exe -ErrorAction SilentlyContinue)){Install-Tool 'Git.Git' $false};
 if(!(Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -or !(Get-Command ffprobe.exe -ErrorAction SilentlyContinue)){Install-Tool 'Gyan.FFmpeg' $false};
 Write-Host '[2/3] Fetching the verified installer commit from GitHub...';
 $stage=Join-Path ([IO.Path]::GetTempPath()) ('yingke-git-'+[guid]::NewGuid().ToString('N'));
 & git.exe clone --single-branch --branch '${BRANCH}' '${REPOSITORY}' $stage;
 if($LASTEXITCODE -ne 0){throw 'GitHub clone failed. Complete Git Credential Manager browser sign-in if requested, then retry.'};
 & git.exe -C $stage fetch origin '${commit}'; if($LASTEXITCODE -ne 0){throw 'Could not fetch the pinned installer commit.'};
 & git.exe -C $stage switch -C '${BRANCH}' '${commit}'; if($LASTEXITCODE -ne 0){throw 'Could not select the verified commit in the temporary clone.'};
 $actual=& git.exe -C $stage rev-parse HEAD; if($actual -ne '${commit}'){throw 'Installer commit verification failed.'};
 Write-Host '[3/3] Backing up existing code, connecting Git, building and starting...';
 Write-Host 'Close the OLD launcher before migration. Existing accounts, media and local configuration are preserved.';
 & $node (Join-Path $stage 'scripts/first-git-setup.mjs') $project '${commit}';
 if($LASTEXITCODE -ne 0){throw 'Setup did not finish. Read the error above; data and recovery backups are retained.'};
 Write-Host 'READY. Next time use Update-Yingke.cmd inside your project.' -ForegroundColor Green;
} catch { $result=1; Write-Host ('ERROR: '+$_.Exception.Message) -ForegroundColor Red }
finally { if($stage -and (Test-Path $stage)){try{Remove-Item -LiteralPath $stage -Recurse -Force}catch{Write-Warning 'Temporary clone could not be removed.'}} };
Read-Host 'Press ENTER to close this installer' | Out-Null; exit $result;
`;
const command = source
  .split(/\r?\n/)
  .map((line) => line.trim())
  .join(" ");
if (command.includes('"') || command.includes("%") || command.length > 7600)
  throw new Error("生成的启动器不符合 Windows 命令行边界。");
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(
  output,
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\npowershell.exe -NoLogo -NoProfile -Command "' +
    command +
    '"\r\nexit /b %errorlevel%\r\n',
  "ascii",
);
fs.writeFileSync(output + ".review.ps1", source, "utf8");
console.log(
  "已生成固定提交 " + commit.slice(0, 12) + " 的一次性 Git 接入入口：" + output,
);
