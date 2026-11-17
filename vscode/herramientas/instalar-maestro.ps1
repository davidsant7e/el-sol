# XIX · El Sol — instala Maestro (pruebas end-to-end de Android) en Windows, sin permisos de administrador.
#   1. Java 17 o más nuevo: usa el que ya tengas o el que trae Android Studio (jbr).
#   2. Descarga Maestro de GitHub (mobile-dev-inc/maestro) en %LOCALAPPDATA%\maestro.
#   3. Agrega maestro y adb al PATH de tu usuario.
# Se puede correr otra vez para actualizar Maestro.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host "XIX · El Sol — instalar Maestro" -ForegroundColor Yellow

function Version-Java($exe) {
    # java -version escribe en stderr; con cmd /c se lee sin que PowerShell lo tome como error.
    try {
        $t = (cmd /c "`"$exe`" -version 2>&1" | Out-String)
        if ($t -match 'version "(\d+)') { return [int]$Matches[1] }
    } catch { }
    return 0
}

function Agregar-AlPath($carpeta) {
    $actual = [Environment]::GetEnvironmentVariable("Path", "User")
    $partes = @(); if ($actual) { $partes = $actual.Split(";") | Where-Object { $_ } }
    if ($partes -notcontains $carpeta) {
        [Environment]::SetEnvironmentVariable("Path", (($partes + $carpeta) -join ";"), "User")
        Write-Host "  Agregado al PATH: $carpeta"
    }
    if (($env:Path.Split(";")) -notcontains $carpeta) { $env:Path = "$env:Path;$carpeta" }
}

# 1) Java
Write-Host "`n1) Java 17 o más nuevo"
$java = 0
if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\java.exe")) { $java = Version-Java "$env:JAVA_HOME\bin\java.exe" }
if ($java -lt 17) {
    $jbr = @("$env:ProgramFiles\Android\Android Studio\jbr", "$env:LOCALAPPDATA\Programs\Android Studio\jbr") |
        Where-Object { Test-Path "$_\bin\java.exe" } | Select-Object -First 1
    if ($jbr) {
        [Environment]::SetEnvironmentVariable("JAVA_HOME", $jbr, "User")
        $env:JAVA_HOME = $jbr
        $java = Version-Java "$jbr\bin\java.exe"
        Write-Host "  JAVA_HOME = $jbr (el Java de Android Studio, versión $java)"
    } elseif ((Get-Command java -ErrorAction SilentlyContinue) -and (Version-Java "java") -ge 17) {
        $java = Version-Java "java"
        Write-Host "  Se usa el java del PATH (versión $java)."
    } else {
        Write-Host "  No encontré Java 17+. Instala Android Studio o un JDK 17 (adoptium.net) y vuelve a correr esto." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  JAVA_HOME ya apunta a Java $java."
}

# 2) Maestro
Write-Host "`n2) Maestro"
$destino = Join-Path $env:LOCALAPPDATA "maestro"
$zip = Join-Path $env:TEMP "maestro.zip"
$url = "https://github.com/mobile-dev-inc/maestro/releases/latest/download/maestro.zip"
Write-Host "  Descargando $url ..."
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
$tmp = Join-Path $env:TEMP "maestro-descomprimido"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
# el zip trae una carpeta "maestro" con bin\ y lib\
$origen = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName "bin") } | Select-Object -First 1
if (-not $origen) { $origen = Get-Item $tmp }
if (Test-Path $destino) { Remove-Item $destino -Recurse -Force }
Move-Item $origen.FullName $destino
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Agregar-AlPath (Join-Path $destino "bin")

# 3) adb (Maestro lo usa para hablar con el celular)
Write-Host "`n3) adb"
$adb = @("$env:USERPROFILE\platform-tools", "$env:LOCALAPPDATA\Android\Sdk\platform-tools") |
    Where-Object { Test-Path "$_\adb.exe" } | Select-Object -First 1
if ($adb) { Agregar-AlPath $adb; Write-Host "  adb: $adb" } else { Write-Host "  No encontré adb.exe (platform-tools). Maestro lo necesita para el celular." -ForegroundColor Yellow }

# Comprobar
Write-Host "`nComprobando..."
foreach ($v in @("MAESTRO_CLI_NO_ANALYTICS", "MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED")) {
    Set-Item "env:$v" "true"
    [Environment]::SetEnvironmentVariable($v, "true", "User")
}
& (Join-Path $destino "bin\maestro.bat") --version
if ($adb) {
    Write-Host "`nCelulares conectados (adb devices):"
    & "$adb\adb.exe" devices -l
}
Write-Host ""
Write-Host "Listo. Cierra y vuelve a abrir VS Code / Kiro para que vean el PATH nuevo." -ForegroundColor Green
Write-Host "Si hay más de un celular conectado (por ejemplo el Redmi que da internet), pon el del Motorola en"
Write-Host "Ajustes → El Sol → Dispositivo Android (ZY22KKQ9LD)."
