import { browser } from "wxt/browser";
import { useSettings } from "../../src/store";
import { ENGINE_CATALOG, ENGINE_GROUPS, getCatalogEntry } from "../../src/engines";
import { t, type Lang, setLang } from "../../src/i18n";
import type { Settings, Rule, GlossaryEntry, TranslationStyle } from "@lumen/core";
import { getEngineConfig } from "@lumen/core";
import { SubscriptionManager } from "../../src/subscriptions";
import { SyncPanel } from "../../src/sync-panel";

const STYLES: TranslationStyle[] = ["blue", "green", "plain", "minimal"];

export default function App() {
  const settings = useSettings();
  const set = useSettings((s) => s.set);
  const reset = useSettings((s) => s.reset);

  const update = (partial: Partial<Settings>) => {
    set(partial);
    broadcast({ ...settings, ...partial });
  };

  const engineCfg = getEngineConfig(settings, settings.activeEngineId);
  const setEngineCfg = (cfg: Record<string, unknown>) => {
    const engines = { ...settings.engines, [settings.activeEngineId]: cfg };
    update({ engines });
  };

  const switchLang = (lang: Lang) => {
    setLang(lang);
    // force a re-render by toggling an inert setting
    update({ targetLang: settings.targetLang });
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("app.name")}</h1>
          <p className="text-sm text-gray-500">{t("app.tagline")}</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            className="text-xs border rounded px-2 py-1"
            value={t("app.name") === "Lumen 翻译" ? "zh" : "en"}
            onChange={(e) => switchLang(e.target.value as Lang)}
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
          <button
            className="text-xs text-gray-500 hover:underline"
            onClick={() => {
              if (confirm(t("reset.confirm"))) {
                reset();
                broadcast({ ...useSettings.getState() });
              }
            }}
          >
            {t("reset.action")}
          </button>
        </div>
      </header>

      {/* General */}
      <Section title={t("section.general")}>
        <Field label={t("label.target")} hint="ISO 639-1: zh, en, ja, ko, fr…">
          <input
            className="input"
            value={settings.targetLang}
            onChange={(e) => update({ targetLang: e.target.value })}
          />
        </Field>
        <Field label={t("label.source")} hint='"auto" or ISO 639-1.'>
          <input
            className="input"
            value={settings.sourceLang}
            onChange={(e) => update({ sourceLang: e.target.value })}
          />
        </Field>
        <Field label={t("label.bilingual")}>
          <input
            type="checkbox"
            checked={settings.bilingual}
            onChange={(e) => update({ bilingual: e.target.checked })}
          />
          <span className="ml-2 text-sm">{t("label.bilingual.hint")}</span>
        </Field>
        <Field label={t("style.label")}>
          <select
            className="input"
            value={settings.style}
            onChange={(e) => update({ style: e.target.value as TranslationStyle })}
          >
            {STYLES.map((s) => (
              <option key={s} value={s}>
                {t(`style.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("label.concurrency")} hint={t("label.concurrency.hint")}>
          <input
            type="number"
            min={1}
            max={20}
            className="input w-24"
            value={settings.concurrency}
            onChange={(e) => update({ concurrency: Number(e.target.value) || 6 })}
          />
        </Field>
        <Field label={t("label.batch")} hint={t("label.batch.hint")}>
          <input
            type="number"
            min={1}
            className="input w-24"
            value={settings.maxBatchSize}
            onChange={(e) => update({ maxBatchSize: Number(e.target.value) || 32 })}
          />
        </Field>
      </Section>

      {/* Engine */}
      <Section title={t("section.engine")}>
        <Field label={t("label.activeEngine")}>
          <select
            className="input"
            value={settings.activeEngineId}
            onChange={(e) => update({ activeEngineId: e.target.value })}
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
        </Field>

        <ProviderFields
          engineId={settings.activeEngineId}
          cfg={engineCfg}
          onChange={setEngineCfg}
        />
      </Section>

      {/* Glossary */}
      <Section title={t("section.glossary")}>
        <GlossaryEditor
          entries={settings.glossary}
          onChange={(glossary) => update({ glossary })}
        />
      </Section>

      {/* Rules */}
      <Section title={t("section.rules")}>
        <RulesEditor entries={settings.rules} onChange={(rules) => update({ rules })} />
      </Section>

      {/* Rule subscriptions */}
      <Section title={t("section.subscriptions")}>
        <p className="text-xs text-gray-500 mb-2">{t("subscriptions.hint")}</p>
        <SubscriptionManager
          urls={settings.subscribedRuleUrls}
          onUrlsChange={(subscribedRuleUrls) => update({ subscribedRuleUrls })}
          onMergeRules={(fetched) => {
            const existing = new Set(settings.rules.map((r) => r.match));
            const merged = [...settings.rules];
            for (const r of fetched) if (!existing.has(r.match)) merged.push(r);
            update({ rules: merged });
          }}
        />
      </Section>

      {/* Shortcuts */}
      <Section title={t("section.shortcuts")}>
        <p className="text-xs text-gray-500 mb-2">{t("shortcuts.hint")}</p>
        <ul className="text-sm space-y-1">
          {Object.entries(settings.shortcuts).map(([k, v]) => (
            <li key={k} className="flex justify-between">
              <span>{k}</span>
              <code className="text-gray-600">{v}</code>
            </li>
          ))}
        </ul>
      </Section>

      {/* Sync */}
      <Section title={t("section.sync")}>
        <p className="text-xs text-gray-500 mb-2">{t("sync.hint")}</p>
        <SyncPanel
          settings={settings}
          onSyncConfigChange={(cfg) => {
            const engines = { ...settings.engines, __sync__: cfg };
            update({ engines });
          }}
          onSettingsChange={(merged) => update(merged)}
        />
      </Section>

      <footer className="text-xs text-gray-400 pt-4 border-t">{t("footer")}</footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-lg shadow-sm p-5 space-y-3">
      <h2 className="font-semibold text-lg">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
    </label>
  );
}

function GlossaryEditor({
  entries,
  onChange,
}: {
  entries: GlossaryEntry[];
  onChange: (e: GlossaryEntry[]) => void;
}) {
  const update = (i: number, patch: Partial<GlossaryEntry>) => {
    const next = entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e));
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {entries.map((e, i) => (
        <div key={i} className="flex gap-2">
          <input
            className="input flex-1"
            placeholder={t("glossary.source")}
            value={e.source}
            onChange={(ev) => update(i, { source: ev.target.value })}
          />
          <input
            className="input flex-1"
            placeholder={t("glossary.target")}
            value={e.target}
            onChange={(ev) => update(i, { target: ev.target.value })}
          />
          <button
            className="text-red-500 px-2"
            onClick={() => onChange(entries.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button className="text-sm text-blue-600" onClick={() => onChange([...entries, { source: "", target: "" }])}>
        {t("glossary.add")}
      </button>
    </div>
  );
}

function RulesEditor({
  entries,
  onChange,
}: {
  entries: Rule[];
  onChange: (r: Rule[]) => void;
}) {
  const update = (i: number, patch: Partial<Rule>) => {
    const next = entries.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {entries.map((r, i) => (
        <div key={i} className="border rounded p-3 space-y-2">
          <input
            className="input"
            placeholder={t("rules.match")}
            value={r.match}
            onChange={(ev) => update(i, { match: ev.target.value })}
          />
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder={t("rules.root")}
              value={r.rootSelector ?? ""}
              onChange={(ev) => update(i, { rootSelector: ev.target.value })}
            />
            <input
              className="input flex-1"
              placeholder={t("rules.exclude")}
              value={(r.excludeSelectors ?? []).join(", ")}
              onChange={(ev) =>
                update(i, {
                  excludeSelectors: ev.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <button
            className="text-red-500 text-sm"
            onClick={() => onChange(entries.filter((_, idx) => idx !== i))}
          >
            {t("rules.remove")}
          </button>
        </div>
      ))}
      <button
        className="text-sm text-blue-600"
        onClick={() => onChange([...entries, { match: "", bilingual: true }])}
      >
        {t("rules.add")}
      </button>
    </div>
  );
}

function ProviderFields({
  engineId,
  cfg,
  onChange,
}: {
  engineId: string;
  cfg: Record<string, unknown>;
  onChange: (cfg: Record<string, unknown>) => void;
}) {
  const entry = getCatalogEntry(engineId);
  if (!entry) return null;
  const set = (patch: Record<string, unknown>) => onChange({ ...cfg, ...patch });

  return (
    <>
      {entry.needsKey && (
        <Field label={t("label.apiKey")}>
          <input
            type="password"
            className="input"
            value={String(cfg.apiKey ?? "")}
            onChange={(e) => set({ apiKey: e.target.value })}
          />
        </Field>
      )}

      {engineId === "ollama" && (
        <Field label={t("label.baseUrl")}>
          <input
            className="input"
            value={String(cfg.baseUrl ?? "")}
            placeholder="http://localhost:11434"
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
        </Field>
      )}

      {engineId === "deepl" && (
        <Field label={t("label.pro")}>
          <input
            type="checkbox"
            checked={Boolean(cfg.pro)}
            onChange={(e) => set({ pro: e.target.checked })}
          />
          <span className="ml-2 text-sm">{t("label.pro.hint")}</span>
        </Field>
      )}

      {engineId === "openai" && (
        <Field label={t("label.endpoint")} hint={t("label.endpoint.hint")}>
          <input
            className="input"
            value={String(cfg.endpoint ?? "")}
            placeholder="https://api.openai.com/v1/chat/completions"
            onChange={(e) => set({ endpoint: e.target.value })}
          />
        </Field>
      )}

      {/* Model: dropdown if the catalog offers preset models, free text otherwise. */}
      {(engineId === "openai" || engineId === "ollama" || Boolean(entry.models?.length)) && (
        <Field label={t("label.model")}>
          {entry.models && entry.models.length > 0 ? (
            <select
              className="input"
              value={String(cfg.model ?? "")}
              onChange={(e) => set({ model: e.target.value })}
            >
              {entry.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {/* Allow custom model: show current value if not in list. */}
              {Boolean(cfg.model) && !entry.models.includes(String(cfg.model)) && (
                <option value={String(cfg.model)}>{String(cfg.model)} (custom)</option>
              )}
            </select>
          ) : (
            <input
              className="input"
              value={String(cfg.model ?? "")}
              placeholder={engineId === "ollama" ? "llama3.1" : "gpt-4o-mini"}
              onChange={(e) => set({ model: e.target.value })}
            />
          )}
        </Field>
      )}

      {/* Region selector for providers with domestic + overseas endpoints. */}
      {entry.hasRegion && (
        <Field label={t("label.region")}>
          <select
            className="input"
            value={String(cfg.region ?? "cn")}
            onChange={(e) => set({ region: e.target.value })}
          >
            <option value="cn">{t("label.region.cn")}</option>
            <option value="overseas">{t("label.region.overseas")}</option>
          </select>
        </Field>
      )}

      {entry.docs && (
        <div className="text-xs text-gray-500">
          <a href={entry.docs} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
            {t("label.docs")} ↗
          </a>
        </div>
      )}
    </>
  );
}

function broadcast(settings: Settings) {
  browser.runtime.sendMessage({ type: "settings-broadcast", settings }).catch(() => {});
}
