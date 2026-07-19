import { useState } from "react";
import type { Rule } from "@lumen/core";
import { t } from "./i18n";

/**
 * Fetch a subscription URL and parse it as a Rule[] array. Throws on network
 * or parse errors. Tolerates a top-level object with a `rules` key too.
 */
export async function fetchSubscription(url: string): Promise<Rule[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { rules?: unknown[] })?.rules)
      ? (data as { rules: unknown[] }).rules
      : [];
  return arr.filter((r): r is Rule => isRule(r));
}

function isRule(v: unknown): v is Rule {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.match === "string" && r.match.length > 0;
}

export function SubscriptionManager({
  urls,
  onUrlsChange,
  onMergeRules,
}: {
  urls: string[];
  onUrlsChange: (urls: string[]) => void;
  onMergeRules: (fetched: Rule[]) => void;
}) {
  const [newUrl, setNewUrl] = useState("");
  const [status, setStatus] = useState<Record<string, string>>({});

  const add = () => {
    const u = newUrl.trim();
    if (!u || urls.includes(u)) return;
    onUrlsChange([...urls, u]);
    setNewUrl("");
  };

  const remove = (u: string) => onUrlsChange(urls.filter((x) => x !== u));

  const fetchOne = async (u: string) => {
    setStatus((s) => ({ ...s, [u]: t("subscriptions.fetching") }));
    try {
      const rules = await fetchSubscription(u);
      onMergeRules(rules);
      setStatus((s) => ({
        ...s,
        [u]: t("subscriptions.fetched").replace("$count", String(rules.length)).replace("$url", shortUrl(u)),
      }));
    } catch (err) {
      setStatus((s) => ({
        ...s,
        [u]: t("subscriptions.error")
          .replace("$url", shortUrl(u))
          .replace("$msg", (err as Error).message),
      }));
    }
  };

  const fetchAll = () => Promise.all(urls.map(fetchOne));

  return (
    <div className="space-y-2">
      {urls.map((u) => (
        <div key={u} className="flex items-center gap-2">
          <code className="text-xs flex-1 truncate text-gray-700">{u}</code>
          <button className="text-xs text-blue-600 hover:underline" onClick={() => fetchOne(u)}>
            {t("subscriptions.fetch")}
          </button>
          <button className="text-xs text-red-500 hover:underline" onClick={() => remove(u)}>
            {t("subscriptions.remove")}
          </button>
          {status[u] && <span className="text-xs text-gray-500">{status[u]}</span>}
        </div>
      ))}
      <div className="flex gap-2">
        <input
          className="input flex-1"
          placeholder={t("subscriptions.url")}
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
        />
        <button className="text-sm text-blue-600" onClick={add}>
          {t("subscriptions.add")}
        </button>
        {urls.length > 0 && (
          <button className="text-sm text-blue-600" onClick={() => void fetchAll()}>
            {t("subscriptions.fetch")} all
          </button>
        )}
      </div>
    </div>
  );
}

function shortUrl(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u.length > 40 ? u.slice(0, 40) + "…" : u;
  }
}
