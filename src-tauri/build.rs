fn main() {
    // Las copias de GitHub Releases se compilan con ANIME_WATCHER_RELEASE=1 (ver update.rs).
    println!("cargo:rerun-if-env-changed=ANIME_WATCHER_RELEASE");
    tauri_build::build()
}
