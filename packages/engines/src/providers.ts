import type { Engine } from "@lumen/core";
import { createOpenAIEngine, type OpenAIEngineOptions } from "./openai.js";

/**
 * Built-in LLM provider presets. All of these expose an OpenAI-compatible
 * chat-completions endpoint, so they are thin wrappers over
 * {@link createOpenAIEngine} that pre-fill the endpoint and a sensible default
 * model. Users only need to supply an API key.
 *
 * For providers with separate domestic / overseas endpoints (MiniMax), pick
 * the endpoint via the `region` option.
 */

export interface ProviderPreset {
  id: string;
  label: string;
  /** Domestic (mainland China) endpoint. */
  endpoint: string;
  /** Optional overseas endpoint, used when `region: "overseas"`. */
  overseasEndpoint?: string;
  /** Default model. */
  model: string;
  /** Models offered by the provider, for UI dropdowns. */
  models: string[];
  /** Whether an API key is required. */
  needsKey: boolean;
  /** Auth header name (default "Authorization"). */
  authHeader?: string;
  /** Auth header value template, `{key}` is replaced. Default `Bearer {key}`. */
  authTemplate?: string;
  /** Optional extra headers (e.g. for OpenRouter-style routing). */
  headers?: Record<string, string>;
  /** Documentation / where to get a key. */
  docs?: string;
}

export const PROVIDER_CATALOG: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek 深度求索",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"],
    needsKey: true,
    docs: "https://platform.deepseek.com/api-keys",
  },
  {
    id: "glm",
    label: "GLM 智谱 BigModel",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4-long", "glm-4"],
    needsKey: true,
    docs: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "kimi",
    label: "Kimi 月之暗面 Moonshot",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-latest"],
    needsKey: true,
    docs: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "minimax",
    label: "MiniMax 海螺 AI",
    endpoint: "https://api.minimaxi.com/v1/text/chatcompletion_v2",
    overseasEndpoint: "https://api.minimax.chat/v1/text/chatcompletion_v2",
    model: "MiniMax-Text-01",
    models: ["MiniMax-Text-01", "abab6.5s-chat", "abab6.5-chat", "abab6-chat"],
    needsKey: true,
    docs: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
  },
  {
    id: "doubao",
    label: "豆包 字节火山方舟 Ark",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    model: "doubao-1-5-pro-32k-250115",
    models: [
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-lite-32k-250115",
      "doubao-pro-32k",
      "doubao-pro-128k",
      "doubao-lite-32k",
      "doubao-lite-128k",
    ],
    needsKey: true,
    docs: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
  },
  {
    id: "qwen",
    label: "通义千问 阿里 DashScope",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long", "qwen2.5-72b-instruct"],
    needsKey: true,
    docs: "https://dashscope.console.aliyun.com/apiKey",
  },
  {
    id: "hunyuan",
    label: "腾讯混元 Hunyuan",
    endpoint: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
    model: "hunyuan-turbo",
    models: ["hunyuan-turbo", "hunyuan-pro", "hunyuan-standard", "hunyuan-lite"],
    needsKey: true,
    docs: "https://console.cloud.tencent.com/hunyuan/api-key",
  },
  {
    id: "ernie",
    label: "百度文心 ERNIE 千帆",
    endpoint: "https://qianfan.baidubce.com/v2/chat/completions",
    model: "ernie-4.0-8k-latest",
    models: [
      "ernie-4.0-8k-latest",
      "ernie-3.5-8k-latest",
      "ernie-speed-8k",
      "ernie-speed-128k",
      "ernie-lite-8k",
    ],
    needsKey: true,
    docs: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
  },
  {
    id: "spark",
    label: "讯飞星火 Spark",
    endpoint: "https://spark-api-open.xf-yun.com/v1/chat/completions",
    // `generalv3.5` pointed at the Spark Max tier, which iFlytek retired on
    // 2026-03-10 (merged into Ultra). `4.0Ultra` is the current flagship and
    // is valid against the OpenAI-compatible endpoint above.
    model: "4.0Ultra",
    models: ["4.0Ultra", "max-32k", "generalv3.5", "generalv3", "pro-128k", "lite"],
    needsKey: true,
    docs: "https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html",
  },
  {
    id: "baichuan",
    label: "百川 Baichuan",
    endpoint: "https://api.baichuan-ai.com/v1/chat/completions",
    model: "Baichuan4-Turbo",
    models: ["Baichuan4-Turbo", "Baichuan4", "Baichuan3-Turbo", "Baichuan3-Turbo-128k"],
    needsKey: true,
    docs: "https://platform.baichuan-ai.com/console/apikey",
  },
  {
    id: "yi",
    label: "零一万物 Yi (01.AI)",
    endpoint: "https://api.lingyiwanwu.com/v1/chat/completions",
    model: "yi-large",
    models: ["yi-large", "yi-medium", "yi-spark", "yi-lightning"],
    needsKey: true,
    docs: "https://platform.lingyiwanwu.com/apikeys",
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow（聚合）",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    overseasEndpoint: "https://api.siliconflow.com/v1/chat/completions",
    model: "deepseek-ai/DeepSeek-V3",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-72B-Instruct",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "meta-llama/Meta-Llama-3.1-405B-Instruct",
      "glm-4-9b-chat",
    ],
    needsKey: true,
    docs: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openrouter",
    label: "OpenRouter（海外聚合）",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-4o-mini",
    models: [
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-flash-1.5",
      "deepseek/deepseek-chat",
    ],
    needsKey: true,
    headers: { "HTTP-Referer": "https://lumen-translation.app", "X-Title": "Lumen Translation" },
    docs: "https://openrouter.ai/keys",
  },
];

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

export interface ProviderEngineOptions {
  apiKey?: string;
  /** Override the preset model. */
  model?: string;
  /** For providers with both domestic and overseas endpoints. */
  region?: "cn" | "overseas";
  /** Override endpoint completely (advanced). */
  endpoint?: string;
  temperature?: number;
  systemPrompt?: string;
}

/**
 * Build an Engine for a built-in provider preset. Returns undefined if the
 * provider id is unknown.
 */
export function createProviderEngine(
  providerId: string,
  opts: ProviderEngineOptions = {},
): Engine | undefined {
  const preset = getProviderPreset(providerId);
  if (!preset) return undefined;

  const endpoint =
    opts.endpoint ??
    (preset.overseasEndpoint && opts.region === "overseas"
      ? preset.overseasEndpoint
      : preset.endpoint);

  const headers: Record<string, string> = { ...(preset.headers ?? {}) };

  // If the preset declares a custom auth header template, build it from the
  // user's API key and pass it through `headers`. In that case we deliberately
  // do NOT forward the apiKey to createOpenAIEngine, so it won't also emit a
  // default `Authorization: Bearer <key>` that would conflict with the custom
  // header (e.g. `X-API-Key` for some providers).
  let apiKeyForEngine = opts.apiKey;
  if (preset.authTemplate && opts.apiKey) {
    const headerName = preset.authHeader ?? "Authorization";
    headers[headerName] = preset.authTemplate.replace("{key}", opts.apiKey);
    apiKeyForEngine = undefined;
  }

  const openaiOpts: OpenAIEngineOptions = {
    apiKey: apiKeyForEngine,
    endpoint,
    model: opts.model ?? preset.model,
    temperature: opts.temperature,
    systemPrompt: opts.systemPrompt,
    headers,
  };
  const engine = createOpenAIEngine(openaiOpts);
  return { ...engine, id: preset.id, label: preset.label };
}
