#!/usr/bin/env bash
# Compila MovWatch desde el código fuente en macOS y Linux.
#
# Uso:
#   bash scripts/build.sh                        # comprueba requisitos y compila
#   bash scripts/build.sh --install-deps         # instala lo que falte y compila
#   bash scripts/build.sh --bundles app,dmg      # solo ciertos formatos (macOS)
#   bash scripts/build.sh --bundles appimage,deb # solo ciertos formatos (Linux)
#
# Formatos disponibles: macOS app, dmg · Linux appimage, deb, rpm.
# Sin --bundles se generan los formatos definidos en src-tauri/tauri.conf.json.
#
# Firma de actualizaciones: se usa TAURI_SIGNING_PRIVATE_KEY (y
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD) o, si no existe, ~/.tauri/movwatch.key.
# Sin clave se compila igualmente, pero sin artefactos de actualización automática.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OS="$(uname -s)"
KEY_FILE="$HOME/.tauri/movwatch.key"

INSTALL_DEPS=0
BUNDLES=""
WORK_DIR=""
CONFIG_FILE=""

# Estado de la comprobación de requisitos (ver check_prereqs).
NEED_NODE=0
NEED_RUST=0
NEED_XCODE=0
NEED_CTOOLS=0
MISSING_PKGS=""
PM=""
PKGS=""

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Compila MovWatch desde el código fuente.

Uso: bash scripts/build.sh [--install-deps] [--bundles lista]

  --install-deps     Instala automáticamente los requisitos que falten.
  --bundles lista    Formatos separados por comas (macOS: app,dmg;
                     Linux: appimage,deb,rpm). Por defecto, los de tauri.conf.json.
  -h, --help         Muestra esta ayuda.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --install-deps) INSTALL_DEPS=1 ;;
      --bundles)
        [ $# -ge 2 ] || die "--bundles necesita una lista, por ejemplo: --bundles appimage,deb"
        BUNDLES="$2"
        shift
        ;;
      --bundles=*) BUNDLES="${1#--bundles=}" ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "Opción desconocida: $1" ;;
    esac
    shift
  done
}

cleanup() {
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# --- Detección de herramientas ----------------------------------------------

node_version() {
  node -p 'process.versions.node' 2>/dev/null
}

# Vite 8 necesita Node.js ^20.19.0 || >=22.12.0.
node_ok() {
  local version major minor
  have npm || return 1
  version="$(node_version)" || return 1
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  case "$major$minor" in '' | *[!0-9]*) return 1 ;; esac
  if [ "$major" -eq 20 ] && [ "$minor" -ge 19 ]; then return 0; fi
  if [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; then return 0; fi
  [ "$major" -gt 22 ]
}

rust_ok() {
  cargo --version >/dev/null 2>&1 && rustc --version >/dev/null 2>&1
}

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  # nvm.sh no es compatible con "set -eu".
  set +eu
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  set -eu
}

# Hace visibles Rust y Node aunque se hayan instalado en otra sesión.
load_toolchains() {
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.cargo/env"
  fi
  if ! node_ok; then load_nvm || true; fi
}

detect_linux_pm() {
  if have apt-get; then
    PM=apt
    PKGS="libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev"
  elif have dnf; then
    PM=dnf
    PKGS="webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel"
  elif have pacman; then
    PM=pacman
    PKGS="webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool"
  elif have zypper; then
    PM=zypper
    PKGS="webkit2gtk3-devel libopenssl-devel curl wget file libappindicator3-1 librsvg-devel"
  else
    PM=unknown
    PKGS=""
  fi
}

pkg_installed() {
  case "$PM" in
    apt) case "$(dpkg -s "$1" 2>/dev/null)" in *"Status: install ok installed"*) return 0 ;; *) return 1 ;; esac ;;
    dnf | zypper) rpm -q "$1" >/dev/null 2>&1 ;;
    pacman) pacman -Q "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

check_linux_deps() {
  local pkg
  MISSING_PKGS=""
  for pkg in $PKGS; do
    pkg_installed "$pkg" || MISSING_PKGS="$MISSING_PKGS $pkg"
  done
  MISSING_PKGS="${MISSING_PKGS# }"
  # En dnf y zypper el compilador de C viene en un grupo/patrón aparte.
  NEED_CTOOLS=0
  case "$PM" in
    dnf | zypper) if ! have cc || ! have make; then NEED_CTOOLS=1; fi ;;
  esac
}

check_prereqs() {
  NEED_NODE=0
  NEED_RUST=0
  NEED_XCODE=0
  node_ok || NEED_NODE=1
  rust_ok || NEED_RUST=1
  case "$OS" in
    Darwin) xcode-select -p >/dev/null 2>&1 || NEED_XCODE=1 ;;
    Linux) check_linux_deps ;;
  esac
}

all_present() {
  [ "$NEED_NODE$NEED_RUST$NEED_XCODE$NEED_CTOOLS" = "0000" ] && [ -z "$MISSING_PKGS" ]
}

# --- Informe de requisitos que faltan ---------------------------------------

ctools_group() {
  if [ "$PM" = dnf ]; then echo "sudo dnf group install c-development"; else echo "sudo zypper install -t pattern devel_basis"; fi
}

linux_install_hint() {
  case "$PM" in
    apt) echo "sudo apt-get install $MISSING_PKGS" ;;
    dnf) echo "sudo dnf install $MISSING_PKGS" ;;
    pacman) echo "sudo pacman -S --needed $MISSING_PKGS" ;;
    zypper) echo "sudo zypper install $MISSING_PKGS" ;;
  esac
}

report_missing() {
  local found
  found="$(node_version || true)"
  echo
  warn "Faltan requisitos para compilar MovWatch:"
  if [ "$NEED_XCODE" -eq 1 ]; then
    echo "  - Herramientas de línea de comandos de Xcode"
    echo "      xcode-select --install"
  fi
  if [ -n "$MISSING_PKGS" ]; then
    echo "  - Paquetes del sistema: $MISSING_PKGS"
    echo "      $(linux_install_hint)"
  fi
  if [ "$NEED_CTOOLS" -eq 1 ]; then
    echo "  - Compilador de C y herramientas básicas"
    echo "      $(ctools_group)"
  fi
  if [ "$NEED_RUST" -eq 1 ]; then
    echo "  - Rust (cargo y rustc)"
    echo "      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  fi
  if [ "$NEED_NODE" -eq 1 ]; then
    echo "  - Node.js 20.19 o superior (o 22.12+); encontrado: ${found:-ninguno}"
    echo "      https://nodejs.org o con nvm: https://github.com/nvm-sh/nvm"
  fi
  echo
  echo "Para instalarlo todo automáticamente, ejecuta:"
  echo "  bash \"$SCRIPT_DIR/build.sh\" --install-deps"
}

# --- Instalación de requisitos ----------------------------------------------

install_xcode_tools() {
  info "Abriendo el instalador de las herramientas de línea de comandos de Xcode..."
  xcode-select --install || true
  die "Cuando termine la instalación de las herramientas de Xcode, vuelve a ejecutar este mismo comando."
}

# Los nombres de paquete no llevan espacios: se separan a propósito por palabras.
# shellcheck disable=SC2086
install_linux_packages() {
  info "Instalando paquetes del sistema ($PM): $MISSING_PKGS"
  case "$PM" in
    apt) as_root apt-get update && as_root apt-get install -y $MISSING_PKGS ;;
    dnf) as_root dnf install -y $MISSING_PKGS ;;
    pacman) as_root pacman -S --needed --noconfirm $MISSING_PKGS ;;
    zypper) as_root zypper --non-interactive install $MISSING_PKGS ;;
  esac
}

install_ctools() {
  info "Instalando el compilador de C y herramientas básicas..."
  if [ "$PM" = dnf ]; then
    as_root dnf group install -y c-development
  else
    as_root zypper --non-interactive install -t pattern devel_basis
  fi
}

install_rust() {
  info "Instalando Rust con rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
}

install_node_nvm() {
  info "Instalando Node.js LTS con nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  load_nvm || die "No se pudo cargar nvm después de instalarlo."
  set +eu
  nvm install --lts && nvm alias default 'lts/*'
  local status=$?
  set -eu
  [ "$status" -eq 0 ] || die "nvm no pudo instalar Node.js."
}

install_node() {
  if [ "$OS" = Darwin ] && have brew; then
    info "Instalando Node.js con Homebrew..."
    brew install node
  else
    install_node_nvm
  fi
}

install_missing() {
  if [ "$NEED_XCODE" -eq 1 ]; then install_xcode_tools; fi
  if [ "$OS" = Linux ] && [ "$PM" = unknown ]; then
    warn "No reconozco tu gestor de paquetes. Instala a mano las dependencias de Tauri:"
    warn "https://v2.tauri.app/start/prerequisites/#linux"
  fi
  if [ -n "$MISSING_PKGS" ]; then install_linux_packages; fi
  if [ "$NEED_CTOOLS" -eq 1 ]; then install_ctools; fi
  if [ "$NEED_RUST" -eq 1 ]; then install_rust; fi
  if [ "$NEED_NODE" -eq 1 ]; then install_node; fi
}

ensure_prereqs() {
  info "Comprobando requisitos..."
  if [ "$OS" = Linux ]; then detect_linux_pm; fi
  check_prereqs
  all_present && return 0
  if [ "$INSTALL_DEPS" -ne 1 ]; then
    report_missing
    exit 1
  fi
  install_missing
  check_prereqs
  if ! all_present; then
    report_missing
    die "Algunos requisitos siguen sin estar disponibles. Abre una terminal nueva y vuelve a intentarlo."
  fi
}

# --- Compilación --------------------------------------------------------------

# Carga la clave de firma; sin clave, prepara CONFIG_FILE para no generar
# artefactos de actualización.
prepare_signing() {
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -f "$KEY_FILE" ]; then
    info "Usando la clave de firma de $KEY_FILE"
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
    export TAURI_SIGNING_PRIVATE_KEY
  fi
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
    return 0
  fi
  warn "No hay clave de firma: esta compilación no podrá publicar actualizaciones automáticas."
  CONFIG_FILE="$WORK_DIR/no-updater.json"
  printf '{"bundle":{"createUpdaterArtifacts":false}}\n' >"$CONFIG_FILE"
}

run_build() {
  prepare_signing
  cd "$REPO_ROOT"
  info "Instalando dependencias de JavaScript..."
  if [ -f package-lock.json ]; then npm ci; else npm install; fi

  local args=(run tauri -- build)
  if [ -n "$BUNDLES" ]; then args+=(--bundles "$BUNDLES"); fi
  if [ -n "$CONFIG_FILE" ]; then args+=(--config "$CONFIG_FILE"); fi
  info "Compilando MovWatch (puede tardar varios minutos)..."
  npm "${args[@]}"
}

# Lista los artefactos creados o actualizados por esta compilación.
print_artifacts() {
  local bundle_dir="${CARGO_TARGET_DIR:-$REPO_ROOT/src-tauri/target}/release/bundle"
  local found
  found="$(find "$bundle_dir" -mindepth 2 -maxdepth 2 -newer "$WORK_DIR/stamp" \
    \( -name '*.app' -o -name '*.dmg' -o -name '*.AppImage' -o -name '*.deb' \
    -o -name '*.rpm' -o -name '*.tar.gz' -o -name '*.sig' \) 2>/dev/null | sort)"
  [ -n "$found" ] || die "La compilación terminó, pero no encontré instaladores en $bundle_dir"
  echo
  info "¡Listo! Archivos generados:"
  printf '%s\n' "$found" | sed 's/^/  /'
}

main() {
  parse_args "$@"
  case "$OS" in
    Darwin | Linux) ;;
    *) die "Este script es para macOS y Linux. En Windows usa scripts/build.ps1." ;;
  esac
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/movwatch-build.XXXXXX")"
  trap cleanup EXIT
  touch "$WORK_DIR/stamp"

  load_toolchains
  ensure_prereqs
  run_build
  print_artifacts
}

main "$@"
