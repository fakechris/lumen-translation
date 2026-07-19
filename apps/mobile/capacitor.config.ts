import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.lumen.translation",
  appName: "Lumen Translation",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
