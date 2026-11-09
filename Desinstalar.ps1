# Quita la extensión XIX · El Sol de VS Code y Kiro.
# Tus planes de prueba (carpetas pruebas\ de cada proyecto) no se tocan.
# La clave queda en %APPDATA%\ElSol\config.json: bórrala a mano si quieres.
foreach ($editor in @("code", "kiro")) {
    if (Get-Command $editor -ErrorAction SilentlyContinue) {
        & $editor --uninstall-extension davidsant7e.el-sol | Out-Null
        Write-Host "Extensión quitada de $editor."
    }
}
Write-Host "Listo."
