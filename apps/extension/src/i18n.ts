// Lightweight i18n for the Lumen extension UI. No external dependency.
//
// The active language is picked from the browser UI language, with a fallback
// to English. Strings live in `dictionaries` below; add a key to both `en`
// and `zh` to keep them in sync.

import { useEffect, useState } from "react";

export type Lang = "en" | "zh";

function detectLang(): Lang {
  const g = globalThis as { browser?: { i18n?: { getUILanguage?: () => string } } };
  const ui = g.browser?.i18n?.getUILanguage?.() ?? globalThis.navigator?.language ?? "en";
  return ui.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const dictionaries: Record<Lang, Record<string, string>> = {
  en: {
    "app.name": "Lumen",
    "app.tagline": "Open-source bilingual translation · Apache-2.0",
    "action.settings": "Settings",
    "action.translate": "Translate",
    "action.selection": "Selection",
    "action.input": "Input",
    "label.engine": "Engine",
    "label.target": "Target",
    "label.source": "Source",
    "label.bilingual": "Bilingual layout",
    "label.bilingual.hint": "show original + translation side by side",
    "label.concurrency": "Concurrency",
    "label.concurrency.hint": "Parallel translation requests (1-20).",
    "label.batch": "Max batch size",
    "label.batch.hint": "Segments sent per request when the engine supports batching.",
    "label.activeEngine": "Active engine",
    "label.apiKey": "API key",
    "label.endpoint": "Endpoint",
    "label.endpoint.hint": "Any OpenAI-compatible URL.",
    "label.model": "Model",
    "label.baseUrl": "Base URL",
    "label.pro": "DeepL Pro",
    "label.pro.hint": "use api.deepl.com instead of api-free",
    "label.requiresKey": "(requires key)",
    "label.region": "Region",
    "label.region.cn": "Mainland China",
    "label.region.overseas": "Overseas",
    "label.docs": "Get an API key",
    "section.general": "General",
    "section.engine": "Translation engine",
    "section.glossary": "Glossary",
    "section.rules": "Site rules",
    "section.shortcuts": "Shortcuts",
    "section.sync": "Cross-device sync",
    "sync.hint": "Sync settings and rules across devices via WebDAV or a self-hosted worker. Your keys never leave your devices unencrypted; choose a backend you trust.",
    "section.subscriptions": "Rule subscriptions",
    "subscriptions.hint": "Subscribe to a JSON URL that returns an array of site rules. Rules are merged on top of your local rules.",
    "subscriptions.url": "Subscription URL",
    "subscriptions.add": "+ Add subscription",
    "subscriptions.fetch": "Fetch now",
    "subscriptions.fetching": "Fetching…",
    "subscriptions.fetched": "Merged $count rules from $url",
    "subscriptions.error": "Failed to fetch $url: $msg",
    "subscriptions.remove": "remove",
    "shortcuts.hint":
      "Customize in the browser's extension shortcuts page (chrome://extensions/shortcuts).",
    "glossary.source": "source",
    "glossary.target": "target",
    "glossary.add": "+ Add term",
    "rules.match": "URL glob, e.g. https://news.ycombinator.com/*",
    "rules.root": "root selector (optional)",
    "rules.exclude": "exclude selectors (comma)",
    "rules.remove": "Remove rule",
    "rules.add": "+ Add rule",
    "reset.confirm": "Reset all settings to defaults?",
    "reset.action": "Reset",
    "footer":
      "Lumen Translation · Apache-2.0 · no telemetry, no ads, your keys stay on your device.",
    "popup.shortcuts":
      "Shortcuts: Alt+Q translate page, Alt+S selection, Alt+I input, Alt+hover paragraph.",
    "style.label": "Translation style",
    "style.blue": "Blue accent",
    "style.green": "Green accent",
    "style.plain": "Plain",
    "style.minimal": "Minimal",
  },
  zh: {
    "app.name": "Lumen 翻译",
    "app.tagline": "开源双语翻译 · Apache-2.0",
    "action.settings": "设置",
    "action.translate": "翻译",
    "action.selection": "划词",
    "action.input": "输入框",
    "label.engine": "引擎",
    "label.target": "目标语言",
    "label.source": "源语言",
    "label.bilingual": "双语对照",
    "label.bilingual.hint": "原文与译文并列显示",
    "label.concurrency": "并发数",
    "label.concurrency.hint": "并行翻译请求数（1-20）。",
    "label.batch": "最大批量",
    "label.batch.hint": "支持批量的引擎每次请求的段数。",
    "label.activeEngine": "当前引擎",
    "label.apiKey": "API Key",
    "label.endpoint": "接口地址",
    "label.endpoint.hint": "任意 OpenAI 兼容地址。",
    "label.model": "模型",
    "label.baseUrl": "Base URL",
    "label.pro": "DeepL Pro",
    "label.pro.hint": "使用 api.deepl.com 而非 api-free",
    "label.requiresKey": "（需要 Key）",
    "label.region": "区域",
    "label.region.cn": "国内",
    "label.region.overseas": "海外",
    "label.docs": "获取 API Key",
    "section.general": "通用",
    "section.engine": "翻译引擎",
    "section.glossary": "术语词典",
    "section.rules": "站点规则",
    "section.shortcuts": "快捷键",
    "section.sync": "跨端同步",
    "sync.hint": "通过 WebDAV 或自托管 Worker 在多设备间同步设置与规则。密钥不会明文离开你的设备，请选择你信任的后端。",
    "section.subscriptions": "规则订阅",
    "subscriptions.hint": "订阅一个返回规则 JSON 数组的 URL，规则会合并到你本地规则之上。",
    "subscriptions.url": "订阅 URL",
    "subscriptions.add": "+ 添加订阅",
    "subscriptions.fetch": "立即拉取",
    "subscriptions.fetching": "拉取中…",
    "subscriptions.fetched": "已从 $url 合并 $count 条规则",
    "subscriptions.error": "拉取 $url 失败：$msg",
    "subscriptions.remove": "移除",
    "shortcuts.hint": "在浏览器扩展快捷键页面自定义（chrome://extensions/shortcuts）。",
    "glossary.source": "原文",
    "glossary.target": "译文",
    "glossary.add": "+ 添加术语",
    "rules.match": "URL 通配，如 https://news.ycombinator.com/*",
    "rules.root": "根选择器（可选）",
    "rules.exclude": "排除选择器（逗号分隔）",
    "rules.remove": "删除规则",
    "rules.add": "+ 添加规则",
    "reset.confirm": "确定将所有设置恢复默认？",
    "reset.action": "重置",
    "footer": "Lumen Translation · Apache-2.0 · 无遥测、无广告，密钥只存本地。",
    "popup.shortcuts":
      "快捷键：Alt+Q 翻译页面，Alt+S 划词，Alt+I 输入框，Alt+悬停 段落。",
    "style.label": "译文样式",
    "style.blue": "蓝色强调",
    "style.green": "绿色强调",
    "style.plain": "朴素",
    "style.minimal": "极简",
  },
};

let currentLang: Lang = detectLang();

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: string): string {
  return dictionaries[currentLang]?.[key] ?? dictionaries.en[key] ?? key;
}

/** React hook that re-renders on language change. */
export function useT(): (key: string) => string {
  const [, force] = useState(0);
  useEffect(() => () => {}, []);
  return (key: string) => {
    // touch state so React keeps the hook subscribed
    void force;
    return t(key);
  };
}
