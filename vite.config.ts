import { defineConfig } from "vite";

// Configuración pensada para Tauri: puerto fijo y sin observar src-tauri.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome120",
    outDir: "dist",
    emptyOutDir: true,
    // Se carga desde disco dentro de la app; hls.js por sí solo ya supera los 500 kB.
    chunkSizeWarningLimit: 1024,
  },
});
