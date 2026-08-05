import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Three separate documents rather than one SPA with a router: each Tauri
// window loads its own entry, so the always-on-top action bar stays a ~40 KB
// document that can be shown within a frame of a selection gesture instead of
// booting the whole settings UI.
export default defineConfig({
  plugins: [react()],
  // Tauri serves the built assets from a custom protocol, so asset URLs must
  // be relative.
  base: "./",
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "chrome105",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        translate: resolve(__dirname, "index.html"),
        prefs: resolve(__dirname, "prefs.html"),
        bar: resolve(__dirname, "bar.html"),
      },
    },
  },
});
