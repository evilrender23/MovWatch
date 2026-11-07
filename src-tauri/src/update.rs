//! Actualizaciones automáticas sin releases, como en Mod Engine: cada equipo compila
//! MovWatch desde la rama `main` con el instalador de la raíz del repositorio
//! (`instalar.sh` / `instalar.ps1`).
//!
//! - El instalador deja la app (en Mac, `/Applications/MovWatch.app` con `version.json` en
//!   `Contents/Resources`; en Windows y Linux, `<destino>/app` con `version.json` al lado) y el
//!   clon en `<destino>/codigo`. `version.json` dice de qué commit y rama salió esta copia y
//!   dónde está `<destino>`. Sin él es una compilación de desarrollo (`tauri dev`,
//!   `target/release`): nunca se actualiza sola.
//! - Para saber si hay algo nuevo se hace `git fetch` en el clon, así que funciona también con
//!   repositorios privados usando las credenciales que ya tenga git.
//! - Para actualizar se lanza el instalador de la rama con `--actualizar --esperar-pid <nosotros>
//!   --relanzar` en su propio grupo de procesos. Compila en `app.nuevo`, escribe `LISTO <commit>`
//!   en `registro/actualizacion.log` y espera a que la app se cierre para cambiar las carpetas y
//!   volver a abrirla. Aquí se sigue ese registro para mostrar el progreso.
//! - Las copias de GitHub Releases (compiladas por `.github/workflows/release.yml` con
//!   `MOVWATCH_RELEASE=1`) no tienen clon ni instalador: consultan el último release y, si
//!   es más nuevo, avisan y abren su página para descargarlo.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const RAMA: &str = "main";
/// Repositorio del que salen los releases.
const REPO_RELEASES: &str = "evilrender23/MovWatch";
const INSTALADOR: &str = if cfg!(windows) { "instalar.ps1" } else { "instalar.sh" };
const LIMITE_GIT: Duration = Duration::from_secs(45);
const PRIMERA_COMPROBACION: Duration = Duration::from_secs(60);
const CADA: Duration = Duration::from_secs(6 * 60 * 60);
/// Evento con el [`Estado`] nuevo cada vez que cambia.
pub const EVENTO: &str = "actualizacion";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VersionInstalada {
    pub commit: String,
    #[serde(default = "rama_por_defecto")]
    pub rama: String,
    #[serde(default)]
    pub fecha: Option<String>,
    /// Carpeta con `codigo/` y `registro/`. Sin ella (instalaciones antiguas), la de encima de `app/`.
    #[serde(default)]
    pub destino: Option<PathBuf>,
}

fn rama_por_defecto() -> String {
    RAMA.into()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Commit {
    pub sha: String,
    pub mensaje: Option<String>,
    pub fecha: Option<String>,
}

/// En qué punto está la actualización; la interfaz lo recibe con el evento [`EVENTO`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "estado", rename_all = "snake_case")]
pub enum Estado {
    Inactiva,
    Buscando,
    AlDia,
    /// Hay un commit nuevo (sólo se queda aquí si no se pidió instalarlo).
    Nueva { ultimo: Commit },
    Compilando { paso: u32, total: u32, texto: String },
    Lista { commit: String },
    /// Copia de GitHub Releases: hay un release más nuevo para descargar.
    Release { version: String, url: String, titulo: Option<String> },
    Error { mensaje: String },
}

/// De dónde salió esta copia y, por tanto, cómo se actualiza.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Canal {
    /// `instalar.sh` / `instalar.ps1`: compila `main` y se actualiza sola.
    Instalador,
    /// GitHub Releases: avisa de releases nuevos.
    Release,
    /// `tauri dev` o una compilación local: no se actualiza.
    Desarrollo,
}

pub fn canal() -> Canal {
    if version_instalada().is_some() {
        Canal::Instalador
    } else if option_env!("MOVWATCH_RELEASE").is_some() {
        Canal::Release
    } else {
        Canal::Desarrollo
    }
}

#[derive(Debug, Deserialize)]
struct UltimoRelease {
    tag_name: String,
    html_url: String,
    name: Option<String>,
}

/// "v1.2.3" → [1, 2, 3] (lo que no sea número cuenta como 0).
fn numeros_version(v: &str) -> Vec<u64> {
    v.trim().trim_start_matches(['v', 'V']).split(['.', '-', '+']).take(3).map(|p| p.parse().unwrap_or(0)).collect()
}

fn es_mas_nueva(otra: &str, actual: &str) -> bool {
    numeros_version(otra) > numeros_version(actual)
}

/// Último release publicado, si es más nuevo que esta copia. `Ok(None)`: al día.
fn buscar_release() -> Result<Option<UltimoRelease>, String> {
    tauri::async_runtime::block_on(async {
        let cliente = reqwest::Client::builder()
            .user_agent(concat!("MovWatch/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let respuesta = cliente
            .get(format!("https://api.github.com/repos/{REPO_RELEASES}/releases/latest"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|_| "Sin conexión con GitHub: revisa tu conexión.".to_string())?;
        if respuesta.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !respuesta.status().is_success() {
            return Err(format!("GitHub respondió {} al buscar actualizaciones.", respuesta.status()));
        }
        let ultimo: UltimoRelease = respuesta.json().await.map_err(|e| format!("Respuesta de GitHub inesperada: {e}"))?;
        Ok(es_mas_nueva(&ultimo.tag_name, env!("CARGO_PKG_VERSION")).then_some(ultimo))
    })
}

#[derive(Debug, PartialEq)]
enum Linea {
    Paso { paso: u32, total: u32, texto: String },
    Listo(String),
    Error(String),
}

/// Las líneas del registro del instalador que importan aquí; el resto se ignora.
fn interpretar_linea(linea: &str) -> Option<Linea> {
    let linea = linea.trim_start_matches('\u{feff}').trim();
    let (clave, resto) = linea.split_once(' ').unwrap_or((linea, ""));
    match clave {
        "PASO" => {
            let (cuenta, texto) = resto.split_once(' ').unwrap_or((resto, ""));
            let (paso, total) = cuenta.split_once('/')?;
            Some(Linea::Paso { paso: paso.parse().ok()?, total: total.parse().ok()?, texto: texto.into() })
        }
        "LISTO" if !resto.is_empty() => Some(Linea::Listo(resto.into())),
        "ERROR" => Some(Linea::Error(resto.into())),
        _ => None,
    }
}

pub fn corto(commit: &str) -> String {
    commit.chars().take(7).collect()
}

/// Un hash corto y uno largo son el mismo commit si uno empieza por el otro.
fn mismo_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    a.len() >= 7 && b.len() >= 7 && (a.starts_with(&b) || b.starts_with(&a))
}

fn interpretar_version(texto: &str) -> Option<VersionInstalada> {
    serde_json::from_str(texto.trim_start_matches('\u{feff}')).ok()
}

/// Salida de `git log -1 --format=%H%x00%s%x00%cI`.
fn interpretar_log(salida: &str) -> Option<Commit> {
    let mut campos = salida.trim().splitn(3, '\0');
    let sha = campos.next().filter(|s| !s.is_empty())?.to_string();
    let mensaje = campos.next().filter(|s| !s.is_empty()).map(String::from);
    let fecha = campos.next().filter(|s| !s.is_empty()).map(String::from);
    Some(Commit { sha, mensaje, fecha })
}

fn explicar_error_git(error: &str) -> String {
    let e = error.to_lowercase();
    if ["authentication failed", "repository not found", "could not read username", "terminal prompts disabled", "403", "401"]
        .iter()
        .any(|m| e.contains(m))
    {
        "Sin acceso al repositorio: hace falta permiso para verlo y haber iniciado sesión en GitHub con Git.".into()
    } else if ["could not resolve host", "unable to access", "timed out", "no respondió"].iter().any(|m| e.contains(m)) {
        "Sin conexión con el repositorio. Revisa tu conexión e inténtalo de nuevo.".into()
    } else {
        format!("git falló: {}", error.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("sin detalles"))
    }
}

fn orden_oculta(programa: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut orden = Command::new(programa);
    orden.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        orden.creation_flags(CREATE_NO_WINDOW);
    }
    orden
}

/// `git -C <dir> …` con límite de tiempo. Nunca pide credenciales: falla en vez de esperar.
fn git(carpeta: &Path, argumentos: &[&str]) -> Result<String, String> {
    let mut hijo = orden_oculta("git")
        .arg("-C")
        .arg(carpeta)
        .args(argumentos)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar git ({e}): ¿está instalado?"))?;
    let inicio = Instant::now();
    while hijo.try_wait().map_err(|e| e.to_string())?.is_none() {
        if inicio.elapsed() > LIMITE_GIT {
            let _ = hijo.kill();
            return Err(explicar_error_git(&format!("git {} no respondió en {} s", argumentos[0], LIMITE_GIT.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let salida = hijo.wait_with_output().map_err(|e| e.to_string())?;
    if !salida.status.success() {
        return Err(explicar_error_git(&String::from_utf8_lossy(&salida.stderr)));
    }
    Ok(String::from_utf8_lossy(&salida.stdout).into_owned())
}

/// `version.json` de esta copia: junto al ejecutable (Windows, Linux), en
/// `MovWatch.app/Contents/Resources` (Mac) o, en instalaciones antiguas de Mac, junto al `.app`.
fn archivo_version() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .skip(1)
        .take(4)
        .flat_map(|d| [d.join("version.json"), d.join("Resources").join("version.json")])
        .find(|f| f.is_file())
}

/// La versión instalada, o `None` en una compilación de desarrollo.
pub fn version_instalada() -> Option<VersionInstalada> {
    interpretar_version(&fs::read_to_string(archivo_version()?).ok()?)
}

/// `<destino>`: la carpeta con `codigo/` y `registro/`.
fn destino() -> Option<PathBuf> {
    if let Some(destino) = version_instalada()?.destino {
        return Some(destino);
    }
    // Instalaciones antiguas: `<destino>/app/version.json`.
    archivo_version()?.parent()?.parent().map(Path::to_path_buf)
}

fn registro(destino: &Path) -> PathBuf {
    destino.join("registro").join("actualizacion.log")
}

/// Trae la rama y compara su último commit con el instalado. `Ok(None)`: al día.
pub fn buscar() -> Result<Option<Commit>, String> {
    let version = version_instalada().ok_or("Esta copia no se instaló con el instalador: no se actualiza sola.")?;
    let clon = destino().ok_or("No se encuentra la carpeta de MovWatch.")?.join("codigo");
    if !clon.join(".git").exists() {
        return Err(format!("Falta el código en {}: vuelve a instalar MovWatch.", clon.display()));
    }
    git(&clon, &["fetch", "--quiet", "origin", &version.rama])?;
    let remota = format!("origin/{}", version.rama);
    let ultimo = interpretar_log(&git(&clon, &["log", "-1", "--format=%H%x00%s%x00%cI", &remota])?)
        .ok_or(format!("No se pudo leer el último commit de {remota}."))?;
    Ok((!mismo_commit(&version.commit, &ultimo.sha)).then_some(ultimo))
}

/// El instalador de la punta de la rama (traída por `buscar`), copiado a `registro/`. Así un
/// arreglo del instalador se aplica desde la actualización que lo trae, y bash nunca ejecuta un
/// archivo que `git reset` cambie debajo de él.
fn instalador_de_la_rama(destino: &Path, rama: &str) -> Result<PathBuf, String> {
    let codigo = destino.join("codigo");
    let texto = git(&codigo, &["show", &format!("origin/{rama}:{INSTALADOR}")])
        .or_else(|_| fs::read_to_string(codigo.join(INSTALADOR)).map_err(|e| e.to_string()))?;
    if !texto.starts_with('#') {
        return Err(format!("{INSTALADOR} no parece un instalador."));
    }
    let carpeta = destino.join("registro");
    fs::create_dir_all(&carpeta).map_err(|e| e.to_string())?;
    let (ruta, nuevo) = (carpeta.join(INSTALADOR), carpeta.join(format!("{INSTALADOR}.nuevo")));
    fs::write(&nuevo, texto).map_err(|e| e.to_string())?;
    fs::rename(&nuevo, &ruta).map_err(|e| e.to_string())?;
    Ok(ruta)
}

/// Lee lo añadido al registro desde `leidos` (vuelve a 0 si el archivo se recreó).
fn leer_desde(ruta: &Path, leidos: &mut u64) -> String {
    let Ok(mut f) = fs::File::open(ruta) else { return String::new() };
    let largo = f.metadata().map(|m| m.len()).unwrap_or(0);
    if largo < *leidos {
        *leidos = 0;
    }
    let mut nuevo = Vec::new();
    if f.seek(SeekFrom::Start(*leidos)).is_ok() && f.read_to_end(&mut nuevo).is_ok() {
        *leidos += nuevo.len() as u64;
    }
    String::from_utf8_lossy(&nuevo).into_owned()
}

// ------------------------------------------------------------------ el actualizador

/// Compartido entre los comandos y los hilos en segundo plano.
#[derive(Clone)]
pub struct Actualizador {
    estado: Arc<Mutex<Estado>>,
    app: Arc<Mutex<Option<AppHandle>>>,
    /// La app se cierra para aplicar la actualización: el instalador debe volver a abrirla.
    aplicando: Arc<AtomicBool>,
}

impl Default for Actualizador {
    fn default() -> Self {
        Actualizador { estado: Arc::new(Mutex::new(Estado::Inactiva)), app: Arc::default(), aplicando: Arc::default() }
    }
}

impl Actualizador {
    pub fn estado(&self) -> Estado {
        self.estado.lock().unwrap().clone()
    }

    fn poner(&self, e: Estado) {
        *self.estado.lock().unwrap() = e.clone();
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            let _ = app.emit(EVENTO, e);
        }
    }

    fn ocupado(&self) -> bool {
        matches!(self.estado(), Estado::Buscando | Estado::Compilando { .. } | Estado::Lista { .. })
    }

    /// Un minuto después de arrancar y cada 6 horas: si hay versión nueva y las
    /// actualizaciones automáticas están activas, la compila en segundo plano.
    pub fn vigilar(&self, app: AppHandle, automatico: impl Fn() -> bool + Send + 'static) {
        *self.app.lock().unwrap() = Some(app);
        if canal() == Canal::Desarrollo {
            return;
        }
        let a = self.clone();
        std::thread::spawn(move || {
            let mut espera = PRIMERA_COMPROBACION;
            loop {
                std::thread::sleep(espera);
                espera = CADA;
                if automatico() && !a.ocupado() {
                    a.buscar_e_instalar(true);
                }
            }
        });
    }

    /// "Buscar actualizaciones": busca en segundo plano y, si `instalar`, compila la nueva.
    pub fn buscar_ahora(&self, instalar: bool) {
        if self.ocupado() {
            return;
        }
        let a = self.clone();
        std::thread::spawn(move || a.buscar_e_instalar(instalar));
    }

    fn buscar_e_instalar(&self, instalar: bool) {
        self.poner(Estado::Buscando);
        if canal() == Canal::Release {
            return self.poner(match buscar_release() {
                Err(mensaje) => Estado::Error { mensaje },
                Ok(None) => Estado::AlDia,
                Ok(Some(r)) => Estado::Release { version: r.tag_name, url: r.html_url, titulo: r.name },
            });
        }
        match buscar() {
            Err(mensaje) => self.poner(Estado::Error { mensaje }),
            Ok(None) => self.poner(Estado::AlDia),
            Ok(Some(_)) if instalar => {
                if let Err(mensaje) = self.instalar() {
                    self.poner(Estado::Error { mensaje });
                }
            }
            Ok(Some(ultimo)) => self.poner(Estado::Nueva { ultimo }),
        }
    }

    /// Lanza el instalador en modo actualización y sigue su registro hasta `LISTO` o `ERROR`.
    pub fn instalar(&self) -> Result<(), String> {
        let version = version_instalada().ok_or("Esta copia no se instaló con el instalador.")?;
        let destino = destino().ok_or("No se encuentra la carpeta de MovWatch.")?;
        let script = instalador_de_la_rama(&destino, &version.rama)?;
        // Un registro antiguo no debe leerse como el de esta vez.
        let _ = fs::remove_file(registro(&destino));
        let _ = fs::remove_file(destino.join("registro").join("no-relanzar"));
        let pid = std::process::id().to_string();
        #[cfg(windows)]
        let mut orden = {
            use std::os::windows::process::CommandExt;
            let mut o = Command::new("powershell.exe");
            o.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&script)
                .args(["-Actualizar", "-Destino"])
                .arg(&destino)
                .args(["-Rama", &version.rama, "-EsperarPid", &pid, "-Relanzar"]);
            // Su propio grupo: sigue vivo cuando la app se cierra, que es cuando cambia las carpetas.
            o.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            o
        };
        #[cfg(not(windows))]
        let mut orden = {
            use std::os::unix::process::CommandExt;
            let mut o = Command::new("/bin/bash");
            o.arg(&script)
                .args(["--actualizar", "--destino"])
                .arg(&destino)
                .args(["--rama", &version.rama, "--esperar-pid", &pid, "--relanzar"]);
            o.process_group(0);
            o
        };
        // Fuera de app/: Windows no deja renombrar una carpeta en la que esté algún proceso.
        orden.current_dir(&destino).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let hijo = orden.spawn().map_err(|e| format!("No se pudo lanzar {INSTALADOR}: {e}"))?;
        self.poner(Estado::Compilando { paso: 0, total: 0, texto: "Empezando".into() });
        let a = self.clone();
        let log = registro(&destino);
        std::thread::spawn(move || a.seguir_registro(&log, hijo));
        Ok(())
    }

    fn seguir_registro(&self, ruta: &Path, mut instalador: Child) {
        let (mut leidos, mut pendiente) = (0, String::new());
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let terminado = instalador.try_wait().ok().flatten();
            pendiente.push_str(&leer_desde(ruta, &mut leidos));
            while let Some(fin) = pendiente.find('\n') {
                let linea: String = pendiente.drain(..=fin).collect();
                match interpretar_linea(&linea) {
                    Some(Linea::Paso { paso, total, texto }) => self.poner(Estado::Compilando { paso, total, texto }),
                    Some(Linea::Listo(commit)) => return self.poner(Estado::Lista { commit: corto(&commit) }),
                    Some(Linea::Error(mensaje)) => return self.poner(Estado::Error { mensaje }),
                    None => {}
                }
            }
            if let Some(codigo) = terminado {
                let mensaje = format!("El instalador terminó sin acabar ({codigo}); mira {}", ruta.display());
                return self.poner(Estado::Error { mensaje });
            }
        }
    }

    /// La app va a cerrarse para aplicar una actualización lista: el instalador la reabrirá.
    pub fn aplicar(&self) {
        self.aplicando.store(true, Ordering::SeqCst);
    }

    /// Al salir sin aplicar una actualización pendiente: el instalador cambia igualmente las
    /// carpetas cuando nos vamos (el próximo arranque ya es la versión nueva), pero no reabre.
    pub fn al_salir(&self) {
        let pendiente = matches!(self.estado(), Estado::Compilando { .. } | Estado::Lista { .. });
        if pendiente && !self.aplicando.load(Ordering::SeqCst) {
            if let Some(d) = destino() {
                let _ = fs::write(d.join("registro").join("no-relanzar"), "");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lineas_del_registro() {
        assert_eq!(interpretar_linea("PASO 3/7 Compilando"), Some(Linea::Paso { paso: 3, total: 7, texto: "Compilando".into() }));
        assert_eq!(interpretar_linea("\u{feff}LISTO abc1234def\r"), Some(Linea::Listo("abc1234def".into())));
        assert_eq!(interpretar_linea("ERROR sin conexión"), Some(Linea::Error("sin conexión".into())));
        assert_eq!(interpretar_linea("APLICADO abc"), None);
        assert_eq!(interpretar_linea("PASO x"), None);
    }

    #[test]
    fn versiones_y_commits() {
        let v = interpretar_version("\u{feff}{ \"commit\": \"1e648a248962\", \"fecha\": \"2026-11-05T17:15:12+01:00\", \"rama\": \"main\", \"repo\": \"x\" }").unwrap();
        assert_eq!(v.commit, "1e648a248962");
        assert_eq!(interpretar_version("{ \"commit\": \"abcdef12\" }").unwrap().rama, "main");
        assert!(interpretar_version("{}").is_none());
        assert!(es_mas_nueva("v1.0.10", "1.0.9"));
        assert!(es_mas_nueva("v2.0.0", "1.9.9"));
        assert!(!es_mas_nueva("v1.0.3", "1.0.3"));
        assert!(!es_mas_nueva("v1.0.2", "1.0.3"));
        let d = interpretar_version("{ \"commit\": \"abcdef12\", \"destino\": \"/x/MovWatch\" }").unwrap();
        assert_eq!(d.destino.as_deref(), Some(Path::new("/x/MovWatch")));
        assert!(mismo_commit("1e648a2", "1E648A248962af"));
        assert!(!mismo_commit("1e648a2", "1e648a3ffff"));
        assert!(!mismo_commit("1e6", "1e6"), "demasiado corto para comparar");
        let c = interpretar_log("abc123456\0Arregla el zoom\02026-11-05T10:00:00+01:00\n").unwrap();
        assert_eq!(c.mensaje.as_deref(), Some("Arregla el zoom"));
        assert_eq!(c.fecha.as_deref(), Some("2026-11-05T10:00:00+01:00"));
    }

    /// Consulta real a GitHub: `cargo test -- --ignored release_real`.
    #[test]
    #[ignore]
    fn release_real() {
        let r = buscar_release();
        println!("{:?}", r.as_ref().map(|o| o.as_ref().map(|u| (&u.tag_name, &u.html_url))));
        assert!(r.is_ok());
    }

    #[test]
    fn errores_de_git_explicados() {
        assert!(explicar_error_git("fatal: Authentication failed for 'https://…'").starts_with("Sin acceso"));
        assert!(explicar_error_git("fatal: unable to access: Could not resolve host").starts_with("Sin conexión"));
        assert!(explicar_error_git("\n  fatal: algo raro\n").contains("algo raro"));
    }

    #[test]
    fn lee_solo_lo_nuevo_del_registro() {
        let f = std::env::temp_dir().join(format!("movwatch-upd-{}.log", std::process::id()));
        fs::write(&f, "PASO 1/7 a\n").unwrap();
        let mut n = 0;
        assert_eq!(leer_desde(&f, &mut n), "PASO 1/7 a\n");
        assert_eq!(leer_desde(&f, &mut n), "");
        fs::write(&f, "X\n").unwrap(); // recreado, más corto
        assert_eq!(leer_desde(&f, &mut n), "X\n");
        let _ = fs::remove_file(f);
    }
}
