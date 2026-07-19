import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { useSettings } from "../../src/store";
import { ENGINE_CATALOG, ENGINE_GROUPS } from "../../src/engines";
import { t } from "../../src/i18n";

export default function App() {
  const settings = useSettings();
  const set = useSettings((s) => s.set);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then((t) => setTab(t[0] ?? null))
      .catch(() => setTab(null));
  }, []);

  const send = (type: string) => {
    if (!tab?.id) return;
    browser.tabs.sendMessage(tab.id, { type }).catch(() => {});
  };

  const openOptions = () => browser.runtime.openOptionsPage?.();

  return (
    <div className="p-3 space-y-3 text-sm">
      <header className="flex items-center justify-between">
        <h1 className="font-bold text-base">{t("app.name")}</h1>
        <button onClick={openOptions} className="text-blue-600 hover:underline text-xs">
          {t("action.settings")}
        </button>
      </header>

      <div className="space-y-2">
        <label className="block">
          <span className="text-xs text-gray-500">{t("label.engine")}</span>
          <select
            className="w-full mt-0.5 border rounded px-2 py-1"
            value={settings.activeEngineId}
            onChange={(e) => {
              const activeEngineId = e.target.value;
              set({ activeEngineId });
              broadcast({ ...settings, activeEngineId });
            }}
          >
            {ENGINE_GROUPS.map((g) => (
              <optgroup key={g.id} label={g.label}>
                {ENGINE_CATALOG.filter((e) => e.group === g.id).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                    {e.needsKey ? ` ${t("label.requiresKey")}` : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="flex gap-2">
          <label className="flex-1">
            <span className="text-xs text-gray-500">{t("label.target")}</span>
            <input
              className="w-full mt-0.5 border rounded px-2 py-1"
              value={settings.targetLang}
              onChange={(e) => {
                const targetLang = e.target.value;
                set({ targetLang });
                broadcast({ ...settings, targetLang });
              }}
            />
          </label>
          <label className="flex-1">
            <span className="text-xs text-gray-500">{t("label.source")}</span>
            <input
              className="w-full mt-0.5 border rounded px-2 py-1"
              value={settings.sourceLang}
              onChange={(e) => {
                const sourceLang = e.target.value;
                set({ sourceLang });
                broadcast({ ...settings, sourceLang });
              }}
            />
          </label>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.bilingual}
            onChange={(e) => {
              const bilingual = e.target.checked;
              set({ bilingual });
              broadcast({ ...settings, bilingual });
            }}
          />
          <span>{t("label.bilingual")}</span>
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2 pt-1">
        <button
          className="bg-blue-600 text-white rounded py-1.5 hover:bg-blue-700"
          onClick={() => send("toggle-translate")}
        >
          {t("action.translate")}
        </button>
        <button
          className="border rounded py-1.5 hover:bg-gray-50"
          onClick={() => send("translate-selection")}
        >
          {t("action.selection")}
        </button>
        <button
          className="border rounded py-1.5 hover:bg-gray-50"
          onClick={() => send("translate-input")}
        >
          {t("action.input")}
        </button>
      </div>

      <p className="text-[11px] text-gray-400 leading-snug">{t("popup.shortcuts")}</p>

      <div className="pt-2 border-t">
        <div className="text-xs text-gray-500 mt-2 mb-1">Tools</div>
        <div className="grid grid-cols-3 gap-2">
          <ToolLink label="File" path="/file-translator.html" />
          <ToolLink label="PDF" path="/pdf-reader.html" />
          <ToolLink label="Image" path="/image-translator.html" />
        </div>
      </div>
    </div>
  );
}

function ToolLink({ label, path }: { label: string; path: string }) {
  const url = browser.runtime.getURL(path as never);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="border rounded py-1.5 text-center text-xs hover:bg-gray-50"
    >
      {label}
    </a>
  );
}

function broadcast(settings: unknown) {
  browser.runtime.sendMessage({ type: "settings-broadcast", settings }).catch(() => {});
}
