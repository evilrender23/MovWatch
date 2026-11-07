//! Reproductores externos (mpv y VLC).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{Result, msg};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum External {
    Mpv,
    Vlc,
}

impl External {
    fn label(self) -> &'static str {
        match self {
            External::Mpv => "mpv",
            External::Vlc => "VLC",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Detected {
    pub mpv: Option<String>,
    pub vlc: Option<String>,
}

pub fn detect(mpv_path: Option<&str>, vlc_path: Option<&str>) -> Detected {
    let show = |p: PathBuf| p.to_string_lossy().into_owned();
    Detected {
        mpv: find(External::Mpv, mpv_path).map(show),
        vlc: find(External::Vlc, vlc_path).map(show),
    }
}

/// Ruta manual si existe; si no, el PATH y las carpetas de instalación habituales.
pub fn find(player: External, manual: Option<&str>) -> Option<PathBuf> {
    if let Some(manual) = manual.map(str::trim).filter(|m| !m.is_empty()) {
        let path = PathBuf::from(manual);
        return path.is_file().then_some(path);
    }
    let (commands, candidates): (&[&str], Vec<PathBuf>) = match player {
        External::Mpv => (
            &["mpv", "mpvnet"],
            [
                env_path("ProgramFiles", r"mpv\mpv.exe"),
                env_path("ProgramFiles", r"mpv.net\mpvnet.exe"),
                env_path("LOCALAPPDATA", r"Programs\mpv.net\mpvnet.exe"),
                env_path("USERPROFILE", r"scoop\apps\mpv\current\mpv.exe"),
                env_path("ProgramData", r"chocolatey\bin\mpv.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
        External::Vlc => (
            &["vlc"],
            [
                env_path("ProgramFiles", r"VideoLAN\VLC\vlc.exe"),
                env_path("ProgramFiles(x86)", r"VideoLAN\VLC\vlc.exe"),
                env_path("USERPROFILE", r"scoop\apps\vlc\current\vlc.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
    };
    // Las apps abiertas desde el Finder no heredan el PATH de Homebrew ni ven los .app como comandos.
    #[cfg(target_os = "macos")]
    let candidates: Vec<PathBuf> = candidates
        .into_iter()
        .chain(
            match player {
                External::Mpv => &["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv", "/Applications/mpv.app/Contents/MacOS/mpv"][..],
                External::Vlc => &["/Applications/VLC.app/Contents/MacOS/VLC"][..],
            }
            .iter()
            .map(PathBuf::from),
        )
        .collect();
    commands
        .iter()
        .find_map(|c| which::which(c).ok())
        .or_else(|| candidates.into_iter().find(|p| p.is_file()))
}

fn env_path(var: &str, rest: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(|base| Path::new(&base).join(rest))
}

/// Abre el video en el reproductor (con un subtítulo opcional) y devuelve la ruta del ejecutable.
pub fn launch(player: External, manual: Option<&str>, url: &str, title: &str, subtitle: Option<&Path>) -> Result<String> {
    let exe = find(player, manual).ok_or_else(|| {
        msg(format!(
            "No se encontró {}. Instálalo o indica la ruta del ejecutable en Ajustes.",
            player.label()
        ))
    })?;
    let mut args: Vec<String> = Vec::new();
    match player {
        External::Mpv => {
            args.push(format!("--force-media-title={title}"));
            // Un poco más de caché: el torrent entrega a ráfagas.
            args.push("--cache=yes".into());
            args.push("--demuxer-max-bytes=200MiB".into());
            if let Some(sub) = subtitle {
                args.push(format!("--sub-file={}", sub.display()));
            }
            args.push(url.to_owned());
        }
        External::Vlc => {
            args.push(format!("--meta-title={title}"));
            args.push("--network-caching=5000".into());
            if let Some(sub) = subtitle {
                args.push(format!("--sub-file={}", sub.display()));
            }
            args.push(url.to_owned());
        }
    }

    let mut command = Command::new(&exe);
    command.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Sin ventana de consola si el ejecutable es de consola (p. ej. mpv.com).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|err| msg(format!("No se pudo abrir {}: {err}", player.label())))?;
    Ok(exe.to_string_lossy().into_owned())
}
