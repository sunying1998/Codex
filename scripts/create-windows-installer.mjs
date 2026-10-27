import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, REPOSITORY, BRANCH } from "./lib/project.mjs";
import { DIRECT_GIT_OPTIONS } from "./lib/git-connection.mjs";

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
const directOptions = DIRECT_GIT_OPTIONS.map(
  (value) => "'" + value.replaceAll("'", "''") + "'",
).join(",");
const source = `$ErrorActionPreference='Stop'; $stage=$null; $result=0; $script:DirectGit=$false;
function Refresh-Path { $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')+';'+$env:Path };
function Install-Tool($id,$upgrade) { if(!(Get-Command winget.exe -ErrorAction SilentlyContinue)){throw 'Install Microsoft App Installer / WinGet, then retry.'}; if($upgrade){ & winget.exe upgrade --id $id --source winget --exact --silent --accept-source-agreements --accept-package-agreements } else { & winget.exe install --id $id --source winget --exact --silent --accept-source-agreements --accept-package-agreements }; if($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010){throw ('Installation failed: '+$id)}; Refresh-Path };
function Run-Git($gitArgs,$direct) { $items=@($gitArgs); if($direct){$items=@(${directOptions})+$items}; $info=New-Object Diagnostics.ProcessStartInfo; $info.FileName=(Get-Command git.exe -ErrorAction Stop).Source; $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.Arguments=($items|ForEach-Object{('{0}{1}{0}' -f [char]34,[string]$_)}) -join ' '; if($direct){foreach($key in @($info.EnvironmentVariables.Keys)){if($key -match '^(HTTP|HTTPS|ALL)_PROXY$'){$info.EnvironmentVariables.Remove($key)}}}; $p=New-Object Diagnostics.Process; $p.StartInfo=$info; $p.Start()|Out-Null; $out=$p.StandardOutput.ReadToEndAsync(); $err=$p.StandardError.ReadToEndAsync(); if(!$p.WaitForExit(60000)){$p.Kill();$p.WaitForExit();$p.Dispose();return [pscustomobject]@{Code=124;Out='';Err='Git connection or authentication timed out.'}}; $value=[pscustomobject]@{Code=$p.ExitCode;Out=$out.Result;Err=$err.Result};$p.Dispose();return $value };
function Safe-Error($text) { return ($text -replace '(https?://)[^\\s/@]+(:[^\\s/@]+)?@','$1[credentials]@') };
function Use-Git($gitArgs) { $r=Run-Git $gitArgs $script:DirectGit; if($r.Code -ne 0 -and !$script:DirectGit -and $r.Err -match '(over proxy|proxy)[^\\r\\n]*(127\\.0\\.0\\.1|localhost|::1)' -and $r.Err -match '(Could not connect|Failed to connect|Connection refused)' -and $r.Err -notmatch '(authentication|certificate|SSL|TLS|CONNECT tunnel|returned error:|HTTP/)'){Write-Host 'Local proxy is unavailable. Trying a command-only direct connection; global proxy settings and TLS verification are preserved.'; $r=Run-Git $gitArgs $true; if($r.Code -ne 0){throw ('Local proxy is unavailable and direct GitHub access also failed. Start your existing proxy application or fix its endpoint, then retry. Direct result: '+(Safe-Error $r.Err))};$script:DirectGit=$true;$env:YINGKE_GIT_CONNECTION_MODE='direct'}; if($r.Code -ne 0){throw ('Git operation failed: '+(Safe-Error $r.Err))}; if($r.Err){Write-Host (Safe-Error $r.Err)};return $r.Out };
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
 Use-Git @('ls-remote','--exit-code','${REPOSITORY}','refs/heads/${BRANCH}')|Out-Null;
 $stage=Join-Path ([IO.Path]::GetTempPath()) ('yingke-git-'+[guid]::NewGuid().ToString('N'));
 Use-Git @('clone','--single-branch','--branch','${BRANCH}','${REPOSITORY}',$stage)|Out-Null;
 Use-Git @('-C',$stage,'fetch','origin','${commit}')|Out-Null;
 Use-Git @('-C',$stage,'switch','-C','${BRANCH}','${commit}')|Out-Null;
 $actual=Use-Git @('-C',$stage,'rev-parse','HEAD'); if($actual.Trim() -ne '${commit}'){throw 'Installer commit verification failed.'};
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
