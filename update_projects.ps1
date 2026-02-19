# PowerShell script to update all git projects in '2-参考项目'

$projectsDir = Join-Path $PSScriptRoot "2-参考项目"

if (-not (Test-Path $projectsDir)) {
    Write-Host "Directory '$projectsDir' not found." -ForegroundColor Red
    exit
}

$subdirs = Get-ChildItem -Path $projectsDir -Directory

foreach ($dir in $subdirs) {
    $gitDir = Join-Path $dir.FullName ".git"
    if (Test-Path $gitDir) {
        Write-Host "Updating $($dir.Name)..." -ForegroundColor Cyan
        Set-Location $dir.FullName
        git pull
        Set-Location $PSScriptRoot
    } else {
        Write-Host "Skipping $($dir.Name) (not a git repository)." -ForegroundColor Yellow
    }
}

Write-Host "`nAll projects updated!" -ForegroundColor Green
pause
