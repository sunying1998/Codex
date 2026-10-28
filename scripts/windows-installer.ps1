$ErrorActionPreference = 'Stop'
$stage = $null
$result = 0
$script:DirectGit = $false
$script:Http1 = $false
$project = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@TARGET@@'))
$commit = '@@COMMIT@@'
$repository = 'https://github.com/sunying1998/Codex.git'
$proxy = '@@PROXY@@'
$backend = '@@BACKEND@@'

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
}
function Install-Tool($id, $upgrade) {
    if (!(Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Install Microsoft App Installer / WinGet, then retry.' }
    if ($upgrade) {
        & winget.exe upgrade --id $id --source winget --exact --silent --accept-source-agreements --accept-package-agreements
    } else {
        & winget.exe install --id $id --source winget --exact --silent --accept-source-agreements --accept-package-agreements
    }
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw ('Installation failed: ' + $id) }
    Refresh-Path
}
function Session-GitConfig {
    $env:YINGKE_SETUP_GIT_PROXY = $proxy
    $env:YINGKE_SETUP_GIT_SSL_BACKEND = $backend
    $settings = [ordered]@{}
    if ($proxy) {
        foreach ($key in @('http.proxy', 'remote.origin.proxy', 'http.https://github.com/.proxy', 'http.https://github.com/sunying1998/Codex.git.proxy', 'http.https://github.com/sunying1998/Codex.git/.proxy')) { $settings[$key] = $proxy }
        $settings['http.version'] = 'HTTP/1.1'
        $script:Http1 = $true
        $env:YINGKE_GIT_HTTP_VERSION = 'HTTP/1.1'
        $env:YINGKE_GIT_CONNECTION_MODE = ''
    }
    if ($backend) { $settings['http.sslBackend'] = $backend }
    if ($proxy -or $backend) {
        foreach ($key in @('http.sslVerify', 'http.https://github.com/.sslVerify', 'http.https://github.com/sunying1998/Codex.git.sslVerify', 'http.https://github.com/sunying1998/Codex.git/.sslVerify')) { $settings[$key] = 'true' }
    }
    $count = 0
    if ($env:GIT_CONFIG_COUNT) { $count = [int]$env:GIT_CONFIG_COUNT }
    foreach ($key in $settings.Keys) {
        [Environment]::SetEnvironmentVariable(('GIT_CONFIG_KEY_' + $count), $key, 'Process')
        [Environment]::SetEnvironmentVariable(('GIT_CONFIG_VALUE_' + $count), $settings[$key], 'Process')
        $count++
    }
    if ($settings.Count) { $env:GIT_CONFIG_COUNT = [string]$count }
}
function Run-Git($gitArgs, $direct) {
    $items = @($gitArgs)
    if ($script:Http1) { $items = @('-c', 'http.version=HTTP/1.1') + $items }
    if ($direct) { $items = @(@@DIRECT_OPTIONS@@) + $items }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command git.exe -ErrorAction Stop).Source
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Arguments = ($items | ForEach-Object { ('{0}{1}{0}' -f [char]34, [string]$_) }) -join ' '
    if ($direct) {
        foreach ($key in @($info.EnvironmentVariables.Keys)) {
            if ($key -match '^(HTTP|HTTPS|ALL)_PROXY$') { $info.EnvironmentVariables.Remove($key) }
        }
    }
    $p = New-Object Diagnostics.Process
    $p.StartInfo = $info
    $p.Start() | Out-Null
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (!$p.WaitForExit(60000)) {
        $p.Kill(); $p.WaitForExit(); $p.Dispose()
        return [pscustomobject]@{ Code = 124; Out = ''; Err = 'Git connection or authentication timed out.' }
    }
    $value = [pscustomobject]@{ Code = $p.ExitCode; Out = $out.Result; Err = $err.Result }
    $p.Dispose()
    return $value
}
function Safe-Error($text) { return ($text -replace '(https?://)[^\s/@]+(:[^\s/@]+)?@', '$1[credentials]@') }
function Transient-Transfer($text) {
    return ($text -match '(Recv failure: Connection was reset|schannel: failed to receive handshake|SSL_ERROR_SYSCALL|SSL routines::unexpected eof while reading|HTTP/2 stream .* (closed|reset)|HTTP/2 framing layer)' -and $text -notmatch '(authentication|certificate|CERT_|SEC_E_UNTRUSTED_ROOT|CONNECT tunnel|returned error:|HTTP/[^ ]+ [45][0-9][0-9])')
}
function Connect-Git($gitArgs, $direct) {
    $readTransfer = $gitArgs -contains 'ls-remote' -or $gitArgs -contains 'fetch'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $r = Run-Git $gitArgs $direct
        if ($r.Code -eq 0 -or $attempt -eq 3 -or !$readTransfer -or !(Transient-Transfer $r.Err)) { return $r }
        Write-Host ('Transfer interrupted. Retrying on the same proxy/TLS settings (' + ($attempt + 1) + '/3)...')
        $script:Http1 = $true
        $env:YINGKE_GIT_HTTP_VERSION = 'HTTP/1.1'
        Start-Sleep -Seconds 1
    }
}
function Use-Git($gitArgs) {
    $r = Connect-Git $gitArgs $script:DirectGit
    if ($r.Code -ne 0 -and !$proxy -and !$script:DirectGit -and $r.Err -match '(over proxy|proxy)[^\r\n]*(127\.0\.0\.1|localhost|::1)' -and $r.Err -match '(Could not connect|Failed to connect|Connection refused)' -and $r.Err -notmatch '(authentication|certificate|SSL|TLS|CONNECT tunnel|returned error:|HTTP/)') {
        Write-Host 'Local proxy is unavailable. Trying a command-only direct connection; global settings and TLS verification are preserved.'
        $r = Connect-Git $gitArgs $true
        if ($r.Code -ne 0) { throw ('Local proxy and direct access both failed. Restore your proxy endpoint. ' + (Safe-Error $r.Err)) }
        $script:DirectGit = $true
        $env:YINGKE_GIT_CONNECTION_MODE = 'direct'
    }
    if ($r.Code -ne 0) { throw ('Git operation failed. Selected proxy: ' + $(if ($proxy) { $proxy } else { 'existing settings' }) + '. ' + (Safe-Error $r.Err)) }
    if ($r.Err) { Write-Host (Safe-Error $r.Err) }
    return $r.Out
}

# MAIN
try {
    if (!(Test-Path (Join-Path $project 'package.json'))) { throw ('Project folder not found: ' + $project) }
    Session-GitConfig
    Write-Host '[1/3] Checking Node.js, Git and FFmpeg...'
    Refresh-Path
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $major = 0
    if ($nodeCommand) { $v = & $nodeCommand.Source --version; if ($v -match '^v([0-9]+)') { $major = [int]$Matches[1] } }
    if ($major -lt 24) { Install-Tool 'OpenJS.NodeJS.LTS' ([bool]$nodeCommand) }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $v = & $node --version
    if ($v -notmatch '^v([0-9]+)' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24+ is required. Restart this launcher after installation.' }
    if (!(Get-Command git.exe -ErrorAction SilentlyContinue)) { Install-Tool 'Git.Git' $false }
    if (!(Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -or !(Get-Command ffprobe.exe -ErrorAction SilentlyContinue)) { Install-Tool 'Gyan.FFmpeg' $false }
    if ($proxy) {
        Write-Host ('Using HTTP proxy ' + $proxy + ' for this process only; global settings unchanged.')
        $endpoint = [uri]$proxy
        $client = New-Object Net.Sockets.TcpClient
        try {
            $pending = $client.ConnectAsync($endpoint.DnsSafeHost, $endpoint.Port)
            if (!$pending.Wait(2000)) { throw 'Proxy port timed out' }
            $pending.GetAwaiter().GetResult() | Out-Null
        } catch { throw ('Proxy port is unavailable: ' + $proxy + '. Start Sakuracat and confirm its HTTP/mixed port.') }
        finally { $client.Dispose() }
    }
    if ($backend) { Write-Host ('TLS backend: ' + $backend + '; certificate verification remains enabled.') }
    Write-Host '[2/3] Fetching the verified installer commit from GitHub...'
    Use-Git @('ls-remote', '--exit-code', $repository, 'refs/heads/main') | Out-Null
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('yingke-git-' + [guid]::NewGuid().ToString('N'))
    Use-Git @('init', '--quiet', $stage) | Out-Null
    Use-Git @('-C', $stage, 'remote', 'add', 'origin', $repository) | Out-Null
    Use-Git @('-C', $stage, 'fetch', '--no-tags', 'origin', 'main') | Out-Null
    Use-Git @('-C', $stage, 'switch', '-C', 'main', $commit) | Out-Null
    $actual = Use-Git @('-C', $stage, 'rev-parse', 'HEAD')
    if ($actual.Trim() -ne $commit) { throw 'Installer commit verification failed.' }
    Write-Host '[3/3] Backing up existing code, connecting Git, building and starting...'
    Write-Host 'Close the OLD launcher before migration. Existing accounts, media and local configuration are preserved.'
    & $node (Join-Path $stage 'scripts/first-git-setup.mjs') $project $commit
    if ($LASTEXITCODE -ne 0) { throw 'Setup did not finish. Read the error above; data and recovery backups are retained.' }
    Write-Host 'READY. Next time use Update-Yingke.cmd inside your project. Proxy/TLS preferences are saved locally when provided.' -ForegroundColor Green
} catch {
    $result = 1
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
} finally {
    if ($stage -and (Test-Path $stage)) {
        try { Remove-Item -LiteralPath $stage -Recurse -Force }
        catch { Write-Warning 'Temporary checkout could not be removed.' }
    }
}
Read-Host 'Press ENTER to close this installer' | Out-Null
exit $result
