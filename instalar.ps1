# Instala o actualiza MovWatch en Windows compilándolo desde una rama del repositorio (main por defecto).
# Es el equivalente de instalar.sh.
#
#   git clone https://github.com/evilrender23/MovWatch
#   powershell -ExecutionPolicy Bypass -File MovWatch\instalar.ps1 [-Repo URL|RUTA] [-Rama main] [-Destino CARPETA]
#
# O en una línea:
#   irm https://raw.githubusercontent.com/evilrender23/MovWatch/main/instalar.ps1 | iex
#
# Desde un clon, sin -Repo, instala desde el origin de ese clon.
#
# En <Destino> (por defecto %LOCALAPPDATA%\MovWatch) deja:
#   codigo\    el clon, con node_modules y la caché de cargo (src-tauri\target\) para que la siguiente
#              compilación sea rápida;
#   app\       movwatch.exe y version.json (commit, fecha, rama, repo, destino);
#   registro\  actualizacion.log, con las líneas que lee la app (PASO n/total, LISTO, APLICADO,
#              ERROR), y compilacion.log, con la salida de git, npm y cargo.
# Crea «MovWatch» en el menú Inicio.
#
# Instala solo, avisando, todo lo que falte para compilar: Git y las Build Tools de Visual Studio con
# C++ (con winget), Rust (rustup-init, en %USERPROFILE%\.cargo) y Node.js (el oficial, en
# <Destino>\node, si no hay uno de 20.19 o más nuevo). WebView2 ya viene con Windows 10 y 11.
# Actualizaciones: la app lo relanza con -Actualizar -EsperarPid <su pid> -Relanzar. Así no pregunta
# ni instala requisitos, compila en app.nuevo, escribe LISTO y, cuando la app se cierra, cambia app\
# por la versión nueva y la vuelve a abrir.
# Se guarda sin BOM a propósito: `irm | iex` no lo admite.
param(
    [string]$Repo = 'https://github.com/evilrender23/MovWatch',
    [string]$Rama = 'main',
    [string]$Destino = (Join-Path $env:LOCALAPPDATA 'MovWatch'),
    [switch]$Actualizar,
    [int]$EsperarPid = 0,
    [switch]$Relanzar
)

# PowerShell 5.1 lee como ANSI un .ps1 sin BOM y estropearía los acentos: se vuelve a leer en UTF-8.
if ('ñ'.Length -ne 1) {
    $relectura = $PSCommandPath
    & ([scriptblock]::Create([IO.File]::ReadAllText($PSCommandPath, [Text.Encoding]::UTF8))) @PSBoundParameters
    exit $LASTEXITCODE
}

$ErrorActionPreference = 'Stop'
if ($Destino.StartsWith('\\?\UNC\')) { $Destino = '\\' + $Destino.Substring(8) }
elseif ($Destino.StartsWith('\\?\')) { $Destino = $Destino.Substring(4) }
$interactivo = -not $Actualizar
if ($Actualizar) {
    # Sin nadie delante, git no debe quedarse esperando credenciales: mejor que falle y lo diga.
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
}
$repoIndicado = [bool]($PSBoundParameters -and $PSBoundParameters.ContainsKey('Repo'))
# Ejecutado desde un clon de MovWatch y sin -Repo: el mismo repositorio (un fork, una copia local).
$propio = if ($PSCommandPath) { Split-Path $PSCommandPath } elseif ($relectura) { Split-Path $relectura }
if (-not $repoIndicado -and $propio -and (Test-Path (Join-Path $propio 'src-tauri\tauri.conf.json')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    try {
        $origenPropio = & git -C $propio remote get-url origin 2>$null
        if ($LASTEXITCODE -eq 0 -and $origenPropio) { $Repo = "$origenPropio".Trim() }
    } catch { }
}

$codigo = Join-Path $Destino 'codigo'
$app = Join-Path $Destino 'app'
$nuevo = Join-Path $Destino 'app.nuevo'
$anterior = Join-Path $Destino 'app.anterior'
$registro = Join-Path $Destino 'registro'
$logCompilacion = Join-Path $registro 'compilacion.log'
$log = Join-Path $registro 'actualizacion.log'
# La app lo deja si se cierra sin aplicar la actualización: se cambia de versión, pero no se abre.
$noRelanzar = Join-Path $registro 'no-relanzar'
$cerrojoRuta = Join-Path $registro 'instalar.lock'
$script:cerrojo = $null
$toolchain = 'stable-x86_64-pc-windows-msvc'
$exe = 'movwatch.exe'
# Node.js propio (si el sistema no tiene uno válido): sólo hace falta para compilar.
$nodePropio = Join-Path $Destino 'node'
$nodeSerie = 'latest-v22.x'
$TOTAL = 7
$utf8 = New-Object System.Text.UTF8Encoding $false
$script:salidaUltima = @()

function Anotar([string]$linea) {
    [IO.File]::AppendAllText($log, "$linea`r`n", $utf8)
}

function Paso([int]$n, [string]$texto) {
    Anotar "PASO $n/$TOTAL $texto"
    if ($interactivo) { Write-Host "[$n/$TOTAL] $texto" -ForegroundColor Cyan }
}

# Ejecuta un programa con su salida en pantalla y en compilacion.log.
function Ejecutar([string]$programa, [string[]]$argumentos, [string]$carpeta = $codigo, [switch]$SinComprobar) {
    [IO.File]::AppendAllText($logCompilacion, "> $programa $($argumentos -join ' ')`r`n", $utf8)
    $lineas = New-Object System.Collections.Generic.List[string]
    Push-Location $carpeta
    try {
        # Con 'Stop', PowerShell 5.1 corta en la primera línea que el programa escriba en stderr (cargo escribe ahí).
        $ErrorActionPreference = 'Continue'
        & $programa @argumentos 2>&1 | ForEach-Object {
            $texto = "$_"
            $lineas.Add($texto)
            [IO.File]::AppendAllText($logCompilacion, "$texto`r`n", $utf8)
            if ($interactivo) { Write-Host $texto -ForegroundColor DarkGray }
        }
        $salida = $LASTEXITCODE
        $script:salidaUltima = $lineas
    } finally {
        Pop-Location
    }
    if ($salida -ne 0 -and -not $SinComprobar) {
        throw "$programa $($argumentos[0]) terminó con código $salida (detalles en $logCompilacion)"
    }
}

function Tiene([string]$comando) {
    [bool](Get-Command $comando -ErrorAction SilentlyContinue)
}

# Lo recién instalado no está en el PATH de esta consola.
function Refrescar-Path {
    foreach ($ambito in 'Machine', 'User') {
        foreach ($carpeta in ([Environment]::GetEnvironmentVariable('Path', $ambito) -split ';')) {
            if ($carpeta -and -not (($env:Path -split ';') -contains $carpeta)) { $env:Path = "$env:Path;$carpeta" }
        }
    }
    $cargo = Join-Path $env:USERPROFILE '.cargo\bin'
    if ((Test-Path $cargo) -and -not (($env:Path -split ';') -contains $cargo)) { $env:Path = "$cargo;$env:Path" }
    if ((Test-Path (Join-Path $nodePropio 'node.exe')) -and -not (($env:Path -split ';') -contains $nodePropio)) { $env:Path = "$nodePropio;$env:Path" }
}

function Hay-BuildTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { return $false }
    [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
}

function Hay-Rust {
    if (-not (Tiene rustup) -or -not (Tiene cargo)) { return $false }
    [bool]((& rustup toolchain list) -match "^$toolchain")
}

# Vite 8 necesita Node.js ^20.19.0 o >=22.12.0.
function Hay-Node {
    if (-not (Tiene node) -or -not (Tiene npm.cmd)) { return $false }
    $texto = "$(& node --version 2>$null)"
    if ($texto -notmatch '^v(\d+)\.(\d+)') { return $false }
    $mayor = [int]$Matches[1]; $menor = [int]$Matches[2]
    ($mayor -gt 22) -or ($mayor -eq 22 -and $menor -ge 12) -or ($mayor -eq 20 -and $menor -ge 19)
}

# Node.js LTS oficial de nodejs.org en <Destino>\node, con su SHA-256 comprobado. No usa winget
# ni pide administrador, así que también vale durante una actualización sin nadie delante.
function Instalar-Node {
    $arq = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $base = "https://nodejs.org/dist/$nodeSerie"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $sumas = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
    $linea = $sumas | Where-Object { $_ -match "\s(node-v[\d.]+-win-$arq\.zip)$" } | Select-Object -First 1
    if (-not $linea) { throw "nodejs.org no tiene Node.js para win-$arq." }
    $hash, $archivo = ($linea.Trim() -split '\s+', 2)
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("movwatch-node-" + [Guid]::NewGuid())
    New-Item -ItemType Directory $tmp | Out-Null
    try {
        $zip = Join-Path $tmp $archivo
        Invoke-WebRequest -UseBasicParsing "$base/$archivo" -OutFile $zip
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $hash.ToUpper()) { throw 'El Node.js descargado no coincide con su SHA-256; no se instala.' }
        Expand-Archive $zip -DestinationPath $tmp -Force
        if (Test-Path $nodePropio) { Remove-Item $nodePropio -Recurse -Force }
        Move-Item (Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($archivo))) $nodePropio
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    Refrescar-Path
}

# Node.js sólo se usa para compilar la interfaz: si falta, se instala sin preguntar, avisando.
function Asegurar-Node {
    Refrescar-Path
    if (Hay-Node) { return }
    Anotar "PASO 1/$TOTAL Instalando Node.js (dependencia necesaria para compilar)"
    Avisar "Dependencia necesaria para compilar MovWatch: falta Node.js (20.19 o más nuevo); se instala en $nodePropio."
    Instalar-Node
    if (-not (Hay-Node)) { throw "Se instaló Node.js en $nodePropio, pero no funciona." }
    if ($interactivo) { Write-Host "Node.js $(& node --version) instalado." -ForegroundColor Green }
}

function Con-Winget([string]$id, [string[]]$extra = @()) {
    # winget sale con códigos raros aunque instale; lo que vale es que luego se encuentre.
    Ejecutar winget (@('install', '--id', $id, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements') + $extra) $Destino -SinComprobar
}

# Rust con rustup-init.exe, el instalador oficial (en %USERPROFILE%\.cargo, sin administrador).
function Instalar-Rust {
    if (-not (Tiene rustup)) {
        $arq = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
        $init = Join-Path ([IO.Path]::GetTempPath()) 'rustup-init.exe'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing "https://static.rust-lang.org/rustup/dist/$arq-pc-windows-msvc/rustup-init.exe" -OutFile $init
        try { Ejecutar $init @('-y', '--profile', 'minimal', '--default-toolchain', 'none') $Destino }
        finally { Remove-Item $init -Force -ErrorAction SilentlyContinue }
        Refrescar-Path
    }
    Ejecutar rustup @('toolchain', 'install', $toolchain, '--profile', 'minimal') $Destino
    Ejecutar rustup @('default', $toolchain) $Destino -SinComprobar
}

# En orden: rustup avisa si no hay Build Tools, y el toolchain MSVC las necesita para enlazar.
$requisitos = @(
    @{ Nombre = 'Git'; Winget = $true; Hay = { Tiene git }; Instalar = { Con-Winget 'Git.Git' @('--silent') } },
    @{ Nombre = 'Build Tools de Visual Studio con C++'; Winget = $true; Hay = { Hay-BuildTools }
       Instalar = { Con-Winget 'Microsoft.VisualStudio.2022.BuildTools' @('--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended') } },
    @{ Nombre = "Rust ($toolchain)"; Hay = { Hay-Rust }; Instalar = { Instalar-Rust } }
)

function Avisar([string]$texto) {
    [IO.File]::AppendAllText($logCompilacion, "$texto`r`n", $utf8)
    if ($interactivo) { Write-Host $texto -ForegroundColor Yellow }
}

# Todo lo que falte se instala solo, avisando de qué es y para qué hace falta. Las Build Tools
# piden permiso de administrador con la ventana de Windows (UAC).
function Comprobar-Requisitos {
    Refrescar-Path
    foreach ($requisito in $requisitos) {
        if (& $requisito.Hay) { continue }
        if ($requisito.Winget -and -not (Tiene winget)) {
            throw "Falta $($requisito.Nombre) y no hay winget para instalarlo: instala «Instalador de aplicación» desde Microsoft Store o $($requisito.Nombre) a mano."
        }
        Anotar "PASO 1/$TOTAL Instalando $($requisito.Nombre) (dependencia necesaria para compilar)"
        Avisar "Dependencia necesaria para compilar MovWatch: falta $($requisito.Nombre); se instala ahora."
        & $requisito.Instalar
        Refrescar-Path
        if (-not (& $requisito.Hay)) {
            throw "Se instaló $($requisito.Nombre), pero no aparece: abre una consola nueva y vuelve a ejecutar el instalador."
        }
        if ($interactivo) { Write-Host "Listo: $($requisito.Nombre)." -ForegroundColor Green }
    }
}

function Explicar-ErrorGit([string]$origen) {
    $texto = $script:salidaUltima -join "`n"
    if ($texto -match 'Authentication failed|Repository not found|could not read Username|\b40[13]\b') {
        throw "Sin acceso a $origen`: hace falta permiso para ver el repositorio y haber iniciado sesión en GitHub con Git o con GitHub Desktop."
    }
    if ($texto -match 'Could not resolve host|unable to access') {
        throw "Sin conexión con $origen."
    }
}

function Descargar-Codigo {
    if (Test-Path (Join-Path $codigo '.git')) {
        if ($repoIndicado) { Ejecutar git @('remote', 'set-url', 'origin', $Repo) }
        $origen = (& git -C $codigo remote get-url origin).Trim()
        try { Ejecutar git @('fetch', '--prune', 'origin', $Rama) } catch { Explicar-ErrorGit $origen; throw }
        Ejecutar git @('checkout', '-B', $Rama, "origin/$Rama")
        Ejecutar git @('reset', '--hard', "origin/$Rama")
        # Sin -x: lo ignorado (node_modules\, src-tauri\target\) es la caché.
        Ejecutar git @('clean', '-fd')
    } else {
        New-Item -ItemType Directory -Force $Destino | Out-Null
        try { Ejecutar git @('clone', '--branch', $Rama, $Repo, $codigo) $Destino } catch { Explicar-ErrorGit $Repo; throw }
    }
}

# No se puede cambiar app\ con la app abierta (Windows bloquea los .exe en uso).
function Esperar-Pid {
    if ($EsperarPid) {
        $proceso = Get-Process -Id $EsperarPid -ErrorAction SilentlyContinue
        if ($proceso) { $proceso.WaitForExit() }
    }
}

function Esperar-Cierre {
    Esperar-Pid
    $avisado = $false
    while (Get-Process movwatch -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -and $_.Path.StartsWith("$app\", [StringComparison]::OrdinalIgnoreCase) }) {
        if ($interactivo -and -not $avisado) {
            Write-Host 'Cierra MovWatch para terminar la instalación…' -ForegroundColor Yellow
            $avisado = $true
        }
        Start-Sleep -Seconds 1
    }
}

# Recién cerrada la app, Windows o el antivirus pueden tener aún algún fichero abierto.
function Reintentar([scriptblock]$accion) {
    for ($intento = 1; ; $intento++) {
        try { & $accion; return } catch { if ($intento -ge 20) { throw } }
        Start-Sleep -Milliseconds 500
    }
}

function Crear-Acceso {
    $acceso = Join-Path ([Environment]::GetFolderPath('Programs')) 'MovWatch.lnk'
    $ruta = Join-Path $app $exe
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($acceso)
    $lnk.TargetPath = $ruta
    $lnk.WorkingDirectory = $Destino
    $lnk.IconLocation = "$ruta,0"
    $lnk.Description = 'Películas y series por torrent, al instante'
    $lnk.Save()
}

function Abrir-Cerrojo {
    try { [IO.File]::Open($cerrojoRuta, 'OpenOrCreate', 'ReadWrite', 'None') } catch { $null }
}

# Si otra instalación tiene el cerrojo (normalmente una que espera a que se cierre la app), se la
# sustituye: esta compila lo último de la rama y hace lo mismo que ella.
function Tomar-Cerrojo {
    $script:cerrojo = Abrir-Cerrojo
    if ($script:cerrojo) { return }
    $ErrorActionPreference = 'Continue'
    $otras = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessId -ne $PID -and "$($_.CommandLine)" -match 'instalar\.ps1' })
    if (-not $otras) { throw 'Ya hay otra instalación de MovWatch en marcha.' }
    foreach ($otra in $otras) { & taskkill.exe /PID $otra.ProcessId /T /F 2>&1 | Out-Null }
    for ($i = 0; $i -lt 40 -and -not $script:cerrojo; $i++) {
        Start-Sleep -Milliseconds 500
        $script:cerrojo = Abrir-Cerrojo
    }
    if (-not $script:cerrojo) { throw 'Ya hay otra instalación de MovWatch en marcha.' }
}

function Principal {
    New-Item -ItemType Directory -Force $registro | Out-Null
    # Windows no deja renombrar app\ mientras sea la carpeta actual de un proceso: este se va de ahí.
    Set-Location -LiteralPath $Destino
    [Environment]::CurrentDirectory = $Destino
    Tomar-Cerrojo
    [IO.File]::WriteAllText($logCompilacion, '', $utf8)
    [IO.File]::WriteAllText($log, '', $utf8)

    Paso 1 'Comprobando Git, las Build Tools de C++, Rust y Node.js'
    Comprobar-Requisitos
    Asegurar-Node

    Paso 2 "Descargando el código ($Rama)"
    Descargar-Codigo
    $commit = (& git -C $codigo rev-parse HEAD).Trim()
    $version = [ordered]@{
        commit = $commit
        fecha = (& git -C $codigo log -1 --format=%cI).Trim()
        rama = $Rama
        repo = (& git -C $codigo remote get-url origin).Trim()
        destino = $Destino
    }

    Paso 3 'Instalando las dependencias de JavaScript'
    Ejecutar npm.cmd @('ci', '--no-audit', '--no-fund')

    Paso 4 'Compilando la app (la primera vez tarda unos minutos)'
    $env:RUSTUP_TOOLCHAIN = $toolchain
    Ejecutar npm.cmd @('run', 'tauri', '--', 'build', '--no-bundle')
    $compilado = Join-Path $codigo "src-tauri\target\release\$exe"
    if (-not (Test-Path $compilado)) { throw "La compilación no dejó $compilado" }

    Paso 5 'Preparando la versión nueva'
    if (Test-Path $nuevo) { Reintentar { Remove-Item $nuevo -Recurse -Force } }
    New-Item -ItemType Directory $nuevo | Out-Null
    Copy-Item $compilado $nuevo
    [IO.File]::WriteAllText((Join-Path $nuevo 'version.json'), ($version | ConvertTo-Json), $utf8)
    Anotar "LISTO $commit"
    if (Test-Path $app) {
        Paso 6 'Esperando a que se cierre la app para cambiar de versión'
        Esperar-Cierre
        if (Test-Path $anterior) { Reintentar { Remove-Item $anterior -Recurse -Force } }
        Reintentar { Rename-Item $app 'app.anterior' }
        try { Rename-Item $nuevo 'app' } catch {
            Rename-Item $anterior 'app'
            throw "No se pudo cambiar a la versión nueva ($($_.Exception.Message)); sigue la anterior."
        }
        Remove-Item $anterior -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Paso 6 "Instalando en $app"
        Move-Item $nuevo $app
    }

    Paso 7 'Creando el acceso en el menú Inicio'
    Crear-Acceso
    Anotar "APLICADO $commit"
    if ($Relanzar -and -not (Test-Path $noRelanzar)) { Start-Process (Join-Path $app $exe) -WorkingDirectory $Destino }
    Remove-Item $noRelanzar -ErrorAction SilentlyContinue
    if (-not $interactivo) { return }

    Write-Host "MovWatch $($commit.Substring(0, 7)) instalado en $app." -ForegroundColor Green
    Write-Host 'Ábrelo desde el menú Inicio. Se actualiza sola: cuando haya cambios en GitHub, los compila y los instala al reiniciarla.'
}

$resultado = 0
$codificacion = [Console]::OutputEncoding
try {
    # Para leer bien la salida de git, npm y cargo, que escriben en UTF-8.
    try { [Console]::OutputEncoding = $utf8 } catch { }
    Principal
} catch {
    $resultado = 1
    $texto = ($_.Exception.Message -replace '\s*[\r\n]+\s*', ' ').Trim()
    try { Anotar "ERROR $texto" } catch { }
    if ($interactivo) { Write-Host "ERROR: $texto" -ForegroundColor Red }
} finally {
    if ($script:cerrojo) { $script:cerrojo.Dispose() }
    try { [Console]::OutputEncoding = $codificacion } catch { }
}
# Con -File, el código de salida; con `irm | iex`, no se cierra la consola de quien lo ejecuta.
if ($PSCommandPath -or $relectura) { exit $resultado }
