import { defineConfig } from "vite";

// Three separate documents rather than one SPA with a router: each Tauri
// window loads its own entry, so the always-on-top action bar stays a ~40 KB
// document that can be shown within a frame of a selection gesture instead of
// booting the whole settings UI.
//
// Deliberately no @vitejs/plugin-react. Vite's own esbuild transform already
// handles the automatic JSX runtime (tsconfig `jsx: react-jsx`); the plugin
// would only add React Fast Refresh. Adding it puts a second requester of
// `@vitejs/plugin-react@^4` in the workspace, which is enough for pnpm to
// dedupe wxt's `@vitejs/plugin-react@^6` down to 4 — and v4 typed against
// apps/extension's vite 8 fails that package's typecheck. Fast Refresh in a
// three-window tray app is not worth that.
export default defineConfig({
  plugins: [],
  // Tauri serves the built assets from a custom protocol, so asset URLs must
  // be relative.
  base: "./",
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
  },
  esbuild: {
    jsx: "automatic",
  },
  build: {
    outDir: "dist",
    target: "chrome105",
    emptyOutDir: true,
    // Relative to the Vite root, so this config needs no node built-ins and
    // therefore no @types/node — which would create a second peer-resolved
    // variant of vite 6 and shift resolution elsewhere in the workspace.
    rollupOptions: {
      input: {
        translate: "index.html",
        prefs: "prefs.html",
        bar: "bar.html",
      },
    },
  },
});
