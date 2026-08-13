$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
$pyinstaller = Join-Path $projectRoot ".venv\Scripts\pyinstaller.exe"

if (-not (Test-Path -LiteralPath $pyinstaller)) {
    & $python -m pip install pyinstaller
}

& $pyinstaller `
    --noconfirm --clean --onedir `
    --name mavat-backend `
    --distpath (Join-Path $projectRoot ".artifact\python-backend") `
    --workpath (Join-Path $projectRoot ".artifact\pyinstaller-work") `
    --specpath (Join-Path $projectRoot ".artifact") `
    --collect-all playwright `
    --collect-all keyring `
    --hidden-import keyring.backends.Windows `
    --add-data "$(Join-Path $projectRoot 'workflow.json');." `
    --add-data "$(Join-Path $projectRoot 'web');web" `
    (Join-Path $projectRoot "web_app.py")

if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed with exit code $LASTEXITCODE" }
