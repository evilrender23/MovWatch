<#
  Compila MovWatch desde el código fuente en Windows.

  Uso (desde cualquier carpeta):
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1
        Comprueba los requisitos y compila todos los instaladores definidos en tauri.conf.json.
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -InstallDeps
        Instala con winget lo que falte (Node.js LTS, Rust, Build Tools de C++) y compila.
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Bundles nsis
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Bundles nsis,msi
        Compila solo los formatos indicados.

  Firma de actualizaciones: si TAURI_SIGNING_PRIVATE_KEY no está definida y existe
  %USERPROFILE%\.tauri\movwatch.key, se usa esa clave. Sin clave se compila
  sin artefactos de actualización automática.

  Compatible con Windows PowerShell 5.1 y PowerShell 7.
#>
[CmdletBinding()]
param(
    [switch]$InstallDeps,
    [string[]]$Bundles
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$RepoRoot = Split-Path -Parent $PSScriptRoot
$VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$VsBuildToolsOverride = '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

# Ejecuta un programa sin mostrar su salida; devuelve la salida o $null si falla.
function Invoke-Quiet([string]$FilePath, [string[]]$Arguments) {
    if (-not (Get-Command $FilePath -ErrorAction SilentlyContinue)) { return $null }
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($output | Out-String).Trim()
}

# Lanza un programa mostrando su salida y falla si termina con error.
function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "'$FilePath $($Arguments -join ' ')' terminó con el código $LASTEXITCODE."
    }
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if ((Test-Path -LiteralPath $cargoBin) -and ($env:Path -notlike "*$cargoBin*")) {
        $env:Path = "$env:Path;$cargoBin"
    }
}

function Get-NodeVersion {
    $raw = Invoke-Quiet 'node' @('--version')
    if (-not $raw) { return $null }
    return [version](($raw.TrimStart('v') -split '-')[0])
}

# Vite 8 necesita Node ^20.19.0 || >=22.12.0
function Test-NodeVersion([version]$Version) {
    if ($Version.Major -eq 20) { return $Version.Minor -ge 19 }
    if ($Version.Major -eq 22) { return $Version.Minor -ge 12 }
    return $Version.Major -gt 22
}

function Test-Rust {
    return [bool](Invoke-Quiet 'cargo' @('--version')) -and [bool](Invoke-Quiet 'rustc' @('--version'))
}

function Test-MsvcTools {
    if (-not (Test-Path -LiteralPath $VsWhere)) { return $false }
    $path = Invoke-Quiet $VsWhere @('-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
    return [bool]$path
}

function Get-MissingPrerequisites {
    $missing = @()
    $node = Get-NodeVersion
    if (-not $node) {
        $missing += [pscustomobject]@{ Key = 'node'; Name = 'Node.js 20.19+ o 22.12+ (no encontrado)'; Hint = 'winget install OpenJS.NodeJS.LTS   (o descárgalo de https://nodejs.org)' }
    } elseif (-not (Test-NodeVersion $node) -or -not (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue)) {
        $missing += [pscustomobject]@{ Key = 'node'; Name = "Node.js 20.19+ o 22.12+ (tienes la v$node o falta npm)"; Hint = 'winget install OpenJS.NodeJS.LTS   (o actualízalo desde https://nodejs.org)' }
    }
    if (-not (Test-Rust)) {
        $missing += [pscustomobject]@{ Key = 'rust'; Name = 'Rust (cargo y rustc mediante rustup)'; Hint = 'winget install Rustlang.Rustup   y luego   rustup default stable-msvc   (o https://rustup.rs)' }
    }
    if (-not (Test-MsvcTools)) {
        $missing += [pscustomobject]@{ Key = 'msvc'; Name = 'Herramientas de compilación de C++ de Visual Studio (MSVC)'; Hint = "winget install Microsoft.VisualStudio.2022.BuildTools --override `"$VsBuildToolsOverride`"   (o, en el Visual Studio Installer, marca 'Desarrollo para el escritorio con C++')" }
    }
    return $missing
}

function Show-Missing($Missing) {
    Write-Host ''
    Write-Host 'Faltan estos requisitos para compilar MovWatch:' -ForegroundColor Yellow
    foreach ($item in $Missing) {
        Write-Host "  - $($item.Name)" -ForegroundColor Yellow
        Write-Host "      Cómo instalarlo: $($item.Hint)"
    }
    Write-Host ''
}

function Install-WithWinget([string]$Id, [string[]]$Extra) {
    Write-Step "Instalando $Id con winget..."
    $wingetArgs = @('install', '--id', $Id, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements') + $Extra
    & winget @wingetArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Note "winget terminó con el código $LASTEXITCODE (puede que ya estuviera instalado). Se comprobará de nuevo al final."
    }
}

function Install-Prerequisites($Missing) {
    if (-not (Get-Command 'winget' -ErrorAction SilentlyContinue)) {
        Show-Missing $Missing
        throw "No se encontró winget. Instala 'Instalador de aplicación' desde Microsoft Store o instala los requisitos de arriba a mano y vuelve a ejecutar este script."
    }
    $keys = @($Missing | ForEach-Object { $_.Key })
    if ($keys -contains 'node') { Install-WithWinget 'OpenJS.NodeJS.LTS' @() }
    if (($keys -contains 'rust') -and -not (Get-Command 'rustup' -ErrorAction SilentlyContinue)) {
        Install-WithWinget 'Rustlang.Rustup' @()
    }
    if ($keys -contains 'msvc') {
        Write-Note 'Las Build Tools de Visual Studio tardan un rato y pueden pedir permisos de administrador.'
        Install-WithWinget 'Microsoft.VisualStudio.2022.BuildTools' @('--override', $VsBuildToolsOverride)
    }
    Update-SessionPath
    if ($keys -contains 'rust') {
        if (-not (Get-Command 'rustup' -ErrorAction SilentlyContinue)) { throw 'No se encontró rustup después de instalarlo. Cierra y abre PowerShell y vuelve a intentarlo.' }
        Write-Step 'Configurando la versión estable de Rust (MSVC)...'
        Invoke-Checked 'rustup' @('default', 'stable-msvc')
    }
}

function Assert-Prerequisites {
    Write-Step 'Comprobando requisitos...'
    $missing = @(Get-MissingPrerequisites)
    if ($missing.Count -eq 0) { Write-Ok 'Todo listo.'; return }
    if (-not $InstallDeps) {
        Show-Missing $missing
        Write-Host 'Instálalos o vuelve a ejecutar el script con -InstallDeps para hacerlo automáticamente.'
        exit 1
    }
    Install-Prerequisites $missing
    $missing = @(Get-MissingPrerequisites)
    if ($missing.Count -gt 0) {
        Show-Missing $missing
        throw 'Siguen faltando requisitos tras la instalación. Cierra y vuelve a abrir PowerShell y ejecuta de nuevo el script.'
    }
    Write-Ok 'Requisitos instalados.'
}

# Carga la clave de firma de actualizaciones si está disponible. Devuelve $true si hay clave.
# Sin TAURI_SIGNING_PRIVATE_KEY_PASSWORD, Tauri asume una clave sin contraseña.
function Initialize-SigningKey {
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        $keyFile = Join-Path $env:USERPROFILE '.tauri\movwatch.key'
        if (Test-Path -LiteralPath $keyFile) {
            $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -LiteralPath $keyFile -Raw).Trim()
            Write-Ok "Usando la clave de firma de $keyFile"
        }
    }
    return [bool]$env:TAURI_SIGNING_PRIVATE_KEY
}

function Get-TargetDir {
    $srcTauri = Join-Path $RepoRoot 'src-tauri'
    if (-not $env:CARGO_TARGET_DIR) { return Join-Path $srcTauri 'target' }
    if ([IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) { return $env:CARGO_TARGET_DIR }
    # cargo se ejecuta dentro de src-tauri, así que una ruta relativa parte de ahí.
    return Join-Path $srcTauri $env:CARGO_TARGET_DIR
}

function Invoke-Build {
    $tauriArgs = @('run', 'tauri', '--', 'build')
    if ($Bundles) { $tauriArgs += @('--bundles', ($Bundles -join ',')) }

    $tempConfig = $null
    if (-not (Initialize-SigningKey)) {
        Write-Note 'No hay clave de firma: esta compilación no incluirá actualizaciones automáticas.'
        $tempConfig = Join-Path ([IO.Path]::GetTempPath()) ("movwatch-config-" + [guid]::NewGuid().ToString('N') + '.json')
        [IO.File]::WriteAllText($tempConfig, '{"bundle":{"createUpdaterArtifacts":false}}')
        $tauriArgs += @('--config', $tempConfig)
    }

    Push-Location -LiteralPath $RepoRoot
    try {
        Write-Step 'Instalando dependencias de npm...'
        if (Test-Path -LiteralPath (Join-Path $RepoRoot 'package-lock.json')) {
            Invoke-Checked 'npm.cmd' @('ci')
        } else {
            Invoke-Checked 'npm.cmd' @('install')
        }
        Write-Step 'Compilando la aplicación (la primera vez puede tardar bastante)...'
        Invoke-Checked 'npm.cmd' $tauriArgs
    } finally {
        Pop-Location
        if ($tempConfig) { Remove-Item -LiteralPath $tempConfig -Force -ErrorAction SilentlyContinue }
    }
}

function Show-Artifacts([datetime]$Since) {
    $bundleDir = Join-Path (Get-TargetDir) 'release\bundle'
    $artifacts = @(Get-ChildItem -Path (Join-Path $bundleDir '*\*') -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $Since -and $_.Extension -ne '.sig' })
    if ($artifacts.Count -eq 0) {
        throw "La compilación terminó pero no se encontraron instaladores en $bundleDir"
    }
    Write-Host ''
    Write-Host 'Compilación terminada. Archivos generados:' -ForegroundColor Green
    foreach ($item in $artifacts) { Write-Host "  $($item.FullName)" }
}

try {
    $version = (Get-Content -LiteralPath (Join-Path $RepoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
    Write-Host "MovWatch v$version - compilación desde el código fuente" -ForegroundColor Magenta
    Assert-Prerequisites
    $started = (Get-Date).AddSeconds(-5)
    Invoke-Build
    Show-Artifacts $started
    exit 0
} catch {
    Write-Host ''
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
