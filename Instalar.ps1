# XIX · El Sol — instalación en Windows.
#   1. Instala la extensión en VS Code y en Kiro (los que encuentre).
#   2. Clave de Gemini: usa la de La Justicia si ya la guardaste; si no, la pide (opcional).
# No necesita Node.js: la extensión corre con el motor del propio editor.
# Para quitarla: Desinstalar.bat.

$ErrorActionPreference = "Stop"
$vsix = Get-ChildItem (Join-Path $PSScriptRoot "dist") -Filter "el-sol-*.vsix" | Sort-Object Name | Select-Object -Last 1
Write-Host "XIX · El Sol" -ForegroundColor Yellow
if (-not $vsix) { Write-Host "No encontré dist\el-sol-*.vsix." -ForegroundColor Red; exit 1 }

# 1) extensión
$instalada = $false
foreach ($editor in @("code", "kiro")) {
    if (Get-Command $editor -ErrorAction SilentlyContinue) {
        & $editor --install-extension $vsix.FullName --force | Out-Null
        Write-Host "Extensión instalada en $editor."
        $instalada = $true
    } else {
        Write-Host "No encontré '$editor' en la terminal (si lo tienes: Extensiones → ··· → Instalar desde VSIX → $($vsix.FullName))."
    }
}

# 2) clave de Gemini (compartida con La Justicia)
$propia = Join-Path $env:APPDATA "ElSol\config.json"
$justicia = Join-Path $env:APPDATA "Justicia\config.json"
if ($env:GEMINI_API_KEY) {
    Write-Host "Se usará la clave de la variable GEMINI_API_KEY."
} elseif (Test-Path $propia) {
    Write-Host "Ya hay una clave guardada en $propia."
} elseif (Test-Path $justicia) {
    Write-Host "Se usará la misma clave de Gemini que guardaste para La Justicia."
} else {
    Write-Host ""
    Write-Host "Pega tu clave de Gemini (aistudio.google.com → Get API key) para que la IA arme los escenarios."
    Write-Host "Deja vacío para usar solo la plantilla. También puedes ponerla luego con «El Sol: Configurar clave de Gemini»."
    $segura = Read-Host "Clave de Gemini" -AsSecureString
    $clave = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura))
    if ($clave) {
        New-Item -ItemType Directory -Force -Path (Split-Path $propia) | Out-Null
        [IO.File]::WriteAllText($propia, (@{ clave = $clave.Trim() } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
        Write-Host "Clave guardada en $propia."
    }
}

Write-Host ""
if ($instalada) {
    Write-Host "Listo. Abre tu proyecto y usa Ctrl+Alt+Shift+T (o Ctrl+Shift+P → «El Sol: Nuevo plan de pruebas»)." -ForegroundColor Green
} else {
    Write-Host "No se instaló en ningún editor: hazlo a mano con «Instalar desde VSIX»." -ForegroundColor Yellow
}
