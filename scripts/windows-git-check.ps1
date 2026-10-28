$ErrorActionPreference = 'Stop'
$project = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@TARGET@@'))
function Read-Git($items) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = & $script:gitExe --no-optional-locks -C $project -c core.quotePath=false @items 2>$null
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { throw 'Git metadata check failed. Confirm the project directory contains its .git folder.' }
    return ($result -join [Environment]::NewLine)
}
try {
    Write-Host 'Yingke local Git check - READ ONLY, no network access'
    Write-Host 'Only file names, status and change counts are printed. No file contents or credentials are read into this report.'
    if (!(Test-Path -LiteralPath (Join-Path $project '.git'))) { throw 'Project Git metadata was not found.' }
    $script:gitExe = (Get-Command git.exe -ErrorAction Stop).Source
    Write-Host ('Commit: ' + (Read-Git @('rev-parse', '--short', 'HEAD')))
    Write-Host ('Branch: ' + (Read-Git @('branch', '--show-current')))
    $changes = Read-Git @('status', '--short', '--untracked-files=no')
    if ([string]::IsNullOrWhiteSpace($changes)) {
        Write-Host 'CLEAN: No tracked local changes were found.'
    } else {
        Write-Host 'Tracked local changes:'
        Write-Host $changes
        Write-Host 'Unstaged change counts (added lines, removed lines, file):'
        Write-Host (Read-Git @('diff', '--no-ext-diff', '--no-textconv', '--numstat'))
        Write-Host 'Staged change counts (added lines, removed lines, file):'
        Write-Host (Read-Git @('diff', '--cached', '--no-ext-diff', '--no-textconv', '--numstat'))
    }
    Write-Host 'No files were restored, removed or stashed. Copy the output above back to the chat.'
} catch {
    Write-Host ('Check did not finish: ' + $_.Exception.Message)
}
Read-Host 'Press ENTER to close' | Out-Null
