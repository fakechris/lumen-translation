import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { create } from "zustand";
import { DEFAULT_SETTINGS, type Settings } from "@lumen/core";

interface SettingsStore extends Settings {
  set: (partial: Partial<Settings>) => void;
  reset: () => void;
}

/** Global settings store, persisted to browser.storage.local. */
export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (partial) => set(partial),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: "lumen-settings",
      storage: createJSONStorage((): StateStorage => {
        const g = globalThis as { browser?: typeof browser; chrome?: { storage?: { local: StorageAreaLike } } };
        const api = g.browser?.storage?.local ?? g.chrome?.storage?.local;
        if (api) {
          return {
            getItem: async (name: string): Promise<string | null> => {
              const v = (await api.get(name))[name] as string | undefined;
              return v ?? null;
            },
            setItem: async (name: string, value: string): Promise<void> => {
              await api.set({ [name]: value });
            },
            removeItem: async (name: string): Promise<void> => {
              await api.set({ [name]: undefined });
            },
          };
        }
        return localStorage as unknown as StateStorage;
      }),
    },
  ),
);

/** Synchronously read the current settings (used by content scripts). */
export async function readSettings(): Promise<Settings> {
  const g = globalThis as { browser?: typeof browser; chrome?: { storage?: { local: StorageAreaLike } } };
  const browserApi = g.browser ?? g.chrome;
  if (browserApi?.storage?.local) {
    const got = await (browserApi.storage.local as StorageAreaLike).get("lumen-settings");
    const stored = (got["lumen-settings"] as { state?: Partial<Settings> } | undefined)?.state;
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }
  // Fallback (userscript / test env).
  const raw = localStorage.getItem("lumen-settings");
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as { state?: Partial<Settings> } | Partial<Settings>;
    const state = (parsed as { state?: Partial<Settings> }).state ?? parsed;
    return { ...DEFAULT_SETTINGS, ...state };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  const g = globalThis as { browser?: typeof browser; chrome?: { storage?: { local: StorageAreaLike } } };
  const browserApi = g.browser ?? g.chrome;
  if (browserApi?.storage?.local) {
    await (browserApi.storage.local as StorageAreaLike).set({
      "lumen-settings": { state: settings, version: 1 },
    });
    return;
  }
  localStorage.setItem("lumen-settings", JSON.stringify({ state: settings, version: 1 }));
}

interface StorageAreaLike {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}
