import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "__MSG_extName__",
    version: "0.1.0",
    description: "__MSG_extDescription__",
    default_locale: "en",
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    permissions: ["storage", "activeTab", "contextMenus"],
    host_permissions: ["<all_urls>"],
    commands: {
      "toggle-translate": {
        suggested_key: { default: "Alt+Q" },
        description: "__MSG_commandToggleTranslate__",
      },
      "translate-selection": {
        suggested_key: { default: "Alt+S" },
        description: "__MSG_commandTranslateSelection__",
      },
      "open-popup": {
        suggested_key: { default: "Alt+K" },
        description: "__MSG_commandOpenPopup__",
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
    browser_specific_settings: {
      gecko: {
        id: "lumen@lumen-translation.app",
        strict_min_version: "115.0",
      },
    },
  },
  // WXT provides default aliases: `@` -> rootDir, `~` -> srcDir.
  // We use relative imports for in-package files (rolldown-safe).
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
