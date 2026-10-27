# Lumen Translation

> 一套完整的开源双语翻译产品矩阵。Apache-2.0，隐私优先，跨平台，引擎无关。

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Build](https://github.com/fakechris/lumen-translation/actions/workflows/ci.yml/badge.svg)](https://github.com/fakechris/lumen-translation/actions/workflows/ci.yml)
[![Release](https://github.com/fakechris/lumen-translation/actions/workflows/release.yml/badge.svg)](https://github.com/fakechris/lumen-translation/releases)

[English](README.md) | 中文

Lumen Translation 让你用任何语言阅读、写作、看视频、开会。它以浏览器扩展、油猴脚本、macOS PopClip 扩展、移动端壳和可自托管的同步后端五种形态运行，全部构建在一组可独立引入的 npm 核心包之上。

- **许可证**：Apache-2.0（商业友好，无 copyleft）。
- **隐私**：所有设置保存在本地；AI 调用使用你自己的 key；无代理，无遥测，无广告。
- **当前版本**：[v0.1.2](https://github.com/fakechris/lumen-translation/releases/latest) —— Phase 1 MVP + Phase 2/3 框架。

---

## 快速开始（上手）

最快的尝试方式是**浏览器扩展** —— 三步，约两分钟，无需注册账号。

1. **安装** —— 从[最新 release](https://github.com/fakechris/lumen-translation/releases/latest) 下载 `lumen-chrome.zip`，解压，打开 `chrome://extensions`，打开右上角**开发者模式**，点 **加载已解压的扩展程序**，选择解压后的文件夹。
2. **选引擎** —— 点击 Lumen 工具栏图标 → **Options**。默认的 **Google Translate** 不需要任何 key。想要更高质量的 LLM 翻译，选择一个服务商（OpenAI、DeepSeek、GLM、Kimi 等）并填入**你自己的 API key** —— 它永不离开你的设备。
3. **翻译** —— 在任意页面按 **`Alt+Q`** 渲染双语。选中文字按 **`Alt+S`** 弹出选区翻译。按住 **`Alt`** 悬停段落，只翻译那一块。

就这样 —— 不登录、无代理、无遥测。设置、规则和 API key 全部留在本地。

> 想用其他形态？见[安装](#安装)：油猴脚本、macOS PopClip + 伴生应用、移动端壳、自托管同步。

---

## 目录

- [快速开始（上手）](#快速开始上手)
- [产品能力](#产品能力)
- [翻译引擎](#翻译引擎)
- [快捷键](#快捷键)
- [安装](#安装)
- [架构](#架构)
- [开发](#开发)
- [里程碑](#里程碑)
- [隐私](#隐私)
- [许可证](#许可证)

---

## 产品能力

### 网页翻译

- **双语对照**：段落级智能检测，译文渲染在原文旁边，并保留行内格式（链接、强调、代码）。
- **仅译文模式**：隐藏原文，只显示翻译后的文本。
- **富文本保留**：链接、样式、结构原样保留；不做扁平文本替换。
- **站点规则**：按 URL glob 覆盖检测选择器、翻译范围和引擎（个人 > 订阅 > 全局优先级）。
- **规则订阅**：订阅一个 JSON URL，把社区规则合并进本地规则集。

### 页内操作

- **选区翻译** —— 选中文字，弹出译文窗口；LLM 引擎流式输出，一键复制。
- **悬停翻译** —— 按住 `Alt` 悬停任意段落/块，只翻译该块。
- **输入框翻译** —— 原位翻译聚焦的 `<input>`/`<textarea>` 里的文字（用你的语言写，用对方的语言发）。
- **悬浮球** —— 页面上的常驻开关，翻译/还原整个页面。
- **右键菜单** —— 对页面、选区、可编辑字段右键翻译。

### 视频字幕

主流视频平台的双语字幕，通过 DOM 观察注入，带分平台选择器和翻译缓存：

- YouTube
- Bilibili
- Netflix
- Amazon Prime Video
- Vimeo
- 通用（其他 HTML5 播放器的兜底适配器）

字幕处理包含短句合并、长句拆分和 AI 重新分段钩子（`@lumen/subtitles`）。`VideoPlatformAdapter` 框架让社区无需改动核心即可接入新平台。

### 在线会议字幕

在线会议的实时双语字幕悬浮层，带按说话人分批与防抖冲刷：

- Google Meet
- Microsoft Teams
- Zoom

`CaptionAdapter` 框架（`@lumen/meetings`）轮询/观察各平台的字幕 DOM，把文本经 `createCaptionTranslator` 送入双语悬浮层。

### PDF 翻译

- 在扩展内置的 PDF 阅读器里打开 PDF（pdf.js worker 随包内置）。
- `translatePdf` 抽取文本、按段落分组，`renderBilingualPdf` 重排出双语文档（不是悬浮层），保持阅读顺序。
- 扫描版 PDF 走 `@lumen/ocr` OCR（Tesseract.js，懒加载）。

### 文档文件翻译

文件翻译页面处理纯文本与电子书格式。ePub 解析后双语渲染阅读；TXT、Markdown、HTML 可下载：

- **TXT**
- **Markdown**（双语渲染，结构保留）
- **HTML**（DOM 感知的双语序列化）
- **ePub**（jszip 解包，走 OPF spine，逐章双语渲染阅读）

### 图片翻译

- 图片翻译页动态加载 Tesseract.js，OCR 上传的图片，按目标语言自动确定 OCR 语言（`zh` → `chi_sim+eng`，`ja` → `jpn` 等），翻译并展示结果。
- 预留 `inpaintImage` 占位，用于未来的文字区域抹除。

### 跨设备同步

- **WebDAV** 后端（任何 WebDAV 服务：Nextcloud、坚果云、群晖等）。
- **自托管 Worker** 后端（`apps/worker`，Cloudflare Workers + KV，Bearer 认证，`/health` + `/snapshot` GET/PUT）。
- 三种合并策略（`local-wins`、`remote-wins`、`merge-rules`），经 `syncOnce` 使用。
- 在设置页的同步面板配置并测试连接。

### 国际化

- UI 支持**英文**和**中文**，按浏览器语言自动切换。
- 每个引擎带模型下拉、地区选择（国内/海外）和「获取 API key」文档链接。

### 外部事件 API

其他工具可以通过名为 `lumen` 的 `window` `CustomEvent` 驱动 Lumen：

```js
window.dispatchEvent(new CustomEvent('lumen', { detail: { action: 'toggle_translate' } }));
// actions: toggle_translate | translate_selection | translate_input
```

---

## 翻译引擎

引擎在设置页里分组展示。所有 LLM 引擎都走 OpenAI 兼容接口，使用你自己的 API key。

| 分组 | 引擎 |
| --- | --- |
| **免费（无需 key）** | Google Translate、Microsoft Translator |
| **传统机翻** | DeepL (Free/Pro) |
| **LLM · 国内** | DeepSeek 深度求索、GLM 智谱 BigModel、Kimi 月之暗面、MiniMax 海螺、豆包 字节火山 Ark、通义千问 阿里 DashScope、腾讯混元 Hunyuan、百度文心 ERNIE、讯飞星火 Spark、百川 Baichuan、零一万物 Yi、硅基流动 SiliconFlow |
| **LLM · 海外** | OpenRouter（聚合器，100+ 模型） |
| **本地 / 自定义** | Ollama（本地）、OpenAI 兼容自定义端点 |

LLM 特性：

- 所有 OpenAI 兼容引擎支持**流式输出**（SSE 解析）。
- **批量 + 并发控制**，带分段去重（`dedupeSegments`），相同句子只翻一次。
- **AI 术语表 / 术语字典**，按批过滤，只发送文本中实际出现的术语 —— 长术语表在无关内容上不产生额外 token。
- **母语者级 system prompt**，带优先级（确切名称与术语 → 语气 → 地道表达优先于逐词翻译）、行内标记示例，以及明确的「只输出译文」格式规则。
- **跨段落上下文**：PDF 翻译把上一段的结尾作为只读上下文喂给每一段，术语和语气跨页保持一致。
- **MiniMax 与 SiliconFlow 地区切换**（国内 / 海外端点）。
- 每个服务商带**模型预设**，并支持自定义模型兜底。

---

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Alt+Q` | 翻译 / 还原当前页面 |
| `Alt+S` | 翻译选区 |
| `Alt+Hover` | 翻译悬停的块 |

另有页面、选区、可编辑字段的右键菜单入口。

---

## 安装

### Chrome / Edge (MV3)

1. 从[最新 release](https://github.com/fakechris/lumen-translation/releases/latest) 下载 `lumen-chrome.zip`。
2. 解压。
3. `chrome://extensions` → 打开开发者模式 → 加载已解压的扩展程序 → 选择文件夹。

### Firefox (MV2)

1. 下载 `lumen-firefox.zip`。
2. `about:debugging` → This Firefox → Load Temporary Add-on → 选择解压出的 `manifest.json`。

### Safari (macOS)

需要 macOS + Xcode。构建脚本已就绪：

```bash
pnpm --filter @lumen/extension safari:init   # 生成 Xcode 工程
pnpm --filter @lumen/extension safari:build  # 构建并在 Safari 打开
```

### 油猴脚本（Tampermonkey / Violentmonkey）

从 release 资产安装 `lumen.user.js`。一个复用 `@lumen/core` / `@lumen/engines` / `@lumen/dom` 的轻量替代。

### macOS PopClip + Lumen Translation 应用

macOS 体验是**一套两件、配合工作**：

- **Lumen PopClip 扩展**（`apps/popclip`）—— 选中文字时在 PopClip 栏上加一个 **Lumen** 按钮。
- **Lumen Translation.app**（`apps/popclip-window`）—— 菜单栏伴生应用，在光标附近的悬浮窗口渲染译文，并保存你的服务商 / 模型 / API key 设置。

两者是一套：PopClip 按钮把选中文本和你的选项通过 AppleScript 交给应用，应用展示结果。请两个都装。

环境要求：[PopClip](https://pilotmoon.com/popclip/)、macOS 13+（Apple Silicon）。

**1. 安装伴生应用**

从源码构建（暂无公证版 release）：

```bash
cd apps/popclip-window
bash build.sh                              # → dist/LumenTranslation.app
cp -R dist/LumenTranslation.app /Applications/
open /Applications/LumenTranslation.app
```

首次启动可能被 Gatekeeper 拦截（应用尚未签名）。右键应用 → **打开** → **打开**，或清除隔离标记：

```bash
xattr -dr com.apple.quarantine /Applications/LumenTranslation.app
```

菜单栏出现图标 —— 点击 → **Settings** 选择服务商、模型和 API key。

**2. 安装 PopClip 扩展**

```bash
cd apps/popclip
pnpm build                                 # → dist/Lumen.popclipext
open dist/Lumen.popclipext                 # 双击安装进 PopClip
```

或从[最新 release](https://github.com/fakechris/lumen-translation/releases/latest) 下载 `Lumen.popclipextz` 双击安装。

**3. 使用**

在任意 macOS 应用中选中文字 → 点 PopClip 栏的 **Lumen** → 悬浮窗口出现译文。可在 PopClip 扩展选项里按次切换引擎 / 目标语言，或在应用的 **Settings** 统一管理。

悬浮窗口顶部有一条 Bob 风格的语言栏：选源语言（默认自动检测）或目标语言，或点 ⇄ 按钮互换 —— 文本立即按新语言对重新翻译（源语言为自动检测时，互换同样使用引擎自动识别的语言）。

### Windows 桌面应用

Windows 没有 PopClip，所以 **Lumen Translation for Windows**（`apps/desktop`）一肩挑两职：自己监听选中文本，并展示悬浮翻译窗口。一次安装，无需伴生扩展。

环境要求：Windows 10 20H1（build 19041）或更新，x64。缺 WebView2 时会自动安装。

**1. 安装**

Windows 安装包目前是**未签名的开发预览版**，不是可信的直发产物。从[最新 release](https://github.com/fakechris/lumen-translation/releases/latest) 下载 `Lumen-Translation-<version>-windows-x64-setup.exe` 与 `SHA256SUMS-windows.txt`，校验 SHA-256 值，可选地用 `gh attestation verify <installer> --repo fakechris/lumen-translation` 校验其 GitHub 签名来源。任一校验失败的产物不要运行。安装包按用户安装，无需管理员权限；正式分发需要代码签名。

或者自己构建：

```powershell
pnpm install
pnpm -r --filter "./packages/**" build      # 引擎通过 ./dist 暴露类型
pnpm --filter @lumen/desktop tauri build --bundles nsis
```

**2. 使用**

在任意应用中选中文字 → 光标旁出现一个小的 **Lumen** 条 → 点击。译文在悬浮窗口打开：**Copy**、**Speak**、**Esc** 或 **Ctrl+W** 关闭。

| 快捷键 | 操作 |
| --- | --- |
| `Alt+Ctrl+T` | 不经过小条，直接翻译当前选区 |
| `Alt+Ctrl+L` | 重新打开上一次翻译 |

两者都可在 **Preferences → Selection** 里重新绑定。

右键托盘图标有 **Engine**（与 macOS 菜单栏相同的快捷切换）和 **Preferences** —— API key、模型、端点地区、语言、自定义 OpenAI 兼容端点都在这里。

**它如何读取你的选区**

Lumen 向 Windows 无障碍层（UI Automation）请求选中的文本。这条路径不碰任何其他东西 —— 不碰剪贴板、不模拟按键 —— 且在大多数应用里可用，包括 Chromium 和 Electron 应用。

有些应用不暴露可访问文本。此时 Lumen 替你按一次 Ctrl+C，之后恢复剪贴板原有内容。该兜底只恢复_文本_，如果你之前复制的是图片或文件，会丢失。可在 **Preferences → Selection** 关掉它，代价是这类应用里小条不出现。

密码框永不读取、永不提供。API key 静态加密存储（DPAPI），绑定你的 Windows 账户。

实现清单、刻意不做的事、仍需真机验证的内容见 [`docs/WINDOWS_PORT_STATUS.md`](docs/WINDOWS_PORT_STATUS.md)。

### 移动端（iOS / Android）

Capacitor 壳（`apps/mobile`）复用 `@lumen/core` + `@lumen/engines`。

```bash
cd apps/mobile
pnpm build
npx cap add ios && npx cap sync ios   # 或 android
npx cap open ios
```

### 自托管同步后端

```bash
cd apps/worker
npx wrangler deploy
# 设置 LUMEN_TOKEN secret，绑定 LUMEN_KV（Workers KV）
```

把扩展同步面板指向你的 Worker URL + token。

---

## 架构

pnpm monorepo。核心包与引擎无关、与 DOM 无关，所有应用复用。

```
packages/
  core/        @lumen/core        Engine/Segment/Rule/Settings，批量+并发管线，去重
  engines/     @lumen/engines     Google/Microsoft/DeepL/OpenAI/Ollama + 目录驱动的 LLM 服务商，流式
  dom/         @lumen/dom         段落检测 + 富文本保留的双语渲染
  subtitles/   @lumen/subtitles   SRT/VTT 解析，句合并/拆分，AI 拆分，视频适配器框架
  pdf/         @lumen/pdf         pdf.js 抽取 + 双语重排
  ocr/         @lumen/ocr         Tesseract.js 封装（懒加载 WASM）+ OCR 并翻译
  sync/        @lumen/sync        WebDAV + Worker 后端，3 种合并策略
  meetings/    @lumen/meetings    Meet/Teams/Zoom 字幕捕获 + 翻译器 + 悬浮层

apps/
  extension/     @lumen/extension  WXT 跨浏览器应用（Chrome/Edge/Firefox/Safari）
  userscript/    @lumen/userscript Tampermonkey/Violentmonkey 构建
  popclip/       @lumen/popclip    macOS PopClip 扩展（esbuild IIFE）
  popclip-window/ LumenTranslation macOS 菜单栏伴生应用（Swift/AppKit 悬浮窗口）
  desktop/       @lumen/desktop    Windows 托盘应用（Tauri v2）—— 选区监听 + 翻译窗口
  worker/        @lumen/worker     Cloudflare Workers 同步后端（Hono + KV）
  mobile/        @lumen/mobile     Capacitor 壳（Vite + React）

sites/         社区站点适配规则
tools/         构建/图标脚本
```

重依赖（pdf.js、tesseract.js、jszip）动态导入，只在对应功能被使用时加载。

### 服务商目录（lumen-suite 契约）

`@lumen/engines` 里的 LLM 服务商预设不再手工维护。它们派生自 Lumen 产品套件的数据契约 `lumen.provider-catalog/v1`
（[fakechris/lumen-suite](https://github.com/fakechris/lumen-suite)，`contracts/provider-catalog.v1.json`），
以字节一致的方式 vendor 在 `packages/engines/src/provider-catalog.v1.json`，编译期经 JSON import 内嵌。`PROVIDER_CATALOG`（`packages/engines/src/providers.ts`）是这份 JSON 的过滤适配视图（OpenAI 兼容 chat 服务商），包含每个服务商的 `quirks.no_thinking` 数据，用于在推理模型上关闭思维链输出。

- 拉取最新目录：`pnpm sync:provider-catalog`（绝不手改 vendored JSON）。
- 契约一致性测试在 `packages/engines/src/__tests__/provider-catalog.test.ts`。

三个宿主读取同一份目录，各自叠加自己的 UI 策略：

| 宿主 | 如何读取目录 | 精选列表 |
| --- | --- | --- |
| 扩展 / 油猴脚本 | `@lumen/engines` 的 `PROVIDER_CATALOG` | OpenAI 兼容 chat，减去 `openai` |
| Windows 桌面 | `@lumen/engines` 的 `PROVIDER_CATALOG_SOURCE`，在 `apps/desktop/src/catalog.ts` 适配 | 精选八家，加两个免费机翻引擎 |
| macOS 伴生 | 同一份 JSON，`build.sh` 拷进 app bundle，由 `LumenTranslation/ProviderCatalog.swift` 解码 | 精选八家，加两个免费机翻引擎 |

Swift 解码器是仅剩的第二个实现。它读同一份 vendored 文件而不是硬编码服务商数据，但其精选列表与别名逻辑从 `apps/desktop/src/catalog.ts` 复制；两者靠 `apps/desktop/src/__tests__/catalog.test.ts` 和 `apps/popclip-window/tests/main.swift` 的测试保持同步。

---

## 开发

环境要求：Node 20+，pnpm 10+。

```bash
pnpm install
pnpm dev              # 开发模式跑扩展（Chrome）
pnpm dev:firefox      # Firefox 开发
pnpm typecheck        # 全 workspace 跑 tsc
pnpm test             # 全 workspace 跑 vitest
pnpm build            # 构建所有包 + 扩展 + 油猴 + popclip
pnpm --filter @lumen/extension zip        # chrome zip
pnpm --filter @lumen/extension zip:firefox
bash apps/popclip-window/build.sh         # macOS 伴生应用（需要 macOS + swiftc）
```

macOS 伴生应用（`apps/popclip-window`）是 `swiftc` 构建的 Swift/AppKit target，不在 pnpm 图里，需用上面的脚本单独构建（macOS 13+，Apple Silicon）。

### Windows 桌面应用

`apps/desktop` 是 Tauri v2 应用：pnpm 图里的 Vite/React 前端加 `src-tauri` 下的 Rust 后端。需要 Rust stable；完整构建需要带 Windows 10/11 SDK 的 Windows。

```bash
pnpm --filter @lumen/desktop typecheck
pnpm --filter @lumen/desktop test              # 目录、设置、兜底链
pnpm --filter @lumen/desktop tauri dev         # 仅 Windows
pnpm --filter @lumen/desktop tauri build --bundles nsis
node tools/gen-windows-icons.mjs               # 从 AppIcon.svg 重新生成图标
```

Rust 侧在 macOS 和 Linux 上也能构建 —— 仅 Windows 的模块（输入钩子、UI Automation、DPAPI、剪贴板）有 fail-closed 桩 —— 所以 `cargo test`、`cargo clippy`、`cargo fmt` 在任何工作站上都能跑：

```bash
cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets
```

仅 Windows 的代码路径由 `ci-windows.yml` 真实编译，它同时产出 NSIS 安装包和 Microsoft Store MSIX（`scripts/windows/build-msix.ps1`）。

发布：推一个 `v*` tag。`release.yml` workflow 构建全部产物并挂到 GitHub Release。

```bash
git tag v0.2.0 && git push origin v0.2.0
```

---

## 里程碑

状态截至 `v0.1.0`。

### v0.1.0 —— Phase 1 MVP + Phase 2/3 框架 ✅ 已发布

- [x] 网页双语 + 仅译文模式，富文本保留
- [x] 选区、悬停、输入框、悬浮球翻译
- [x] 右键菜单 + 快捷键
- [x] 5 个基础引擎（Google、Microsoft、DeepL、OpenAI、Ollama）+ 13 个 LLM 服务商
- [x] 流式 AI、批量+并发、去重、AI 术语表
- [x] 站点规则 + 规则订阅
- [x] en/zh UI，4 种翻译风格
- [x] Chrome MV3 + Firefox MV2 + 油猴 + PopClip 构建
- [x] 视频字幕：YouTube、Bilibili、Netflix、Prime Video、Vimeo（+ 通用适配器）
- [x] 会议字幕：Meet、Teams、Zoom
- [x] PDF 双语重排 + 扫描版 OCR
- [x] 文件翻译：TXT、Markdown、HTML、ePub
- [x] 图片 OCR 翻译
- [x] 跨设备同步：WebDAV + 自托管 Worker
- [x] 移动端壳（Capacitor）复用 core/engines
- [x] Safari 构建脚本（产出 Xcode 工程需 macOS + Xcode）
- [x] CI（typecheck/test/build）+ 发布管线（tag 触发）

### v0.2.0 —— 深度与覆盖（计划）

- [ ] PDF 原版式保留（当前是重排，不是叠加）
- [ ] 漫画 / 条漫分格 + 文字区域修复（框架复用图片翻译器；自动分格检测待做）
- [ ] 通过社区 `VideoPlatformAdapter` 包支持 100+ 视频平台
- [ ] Chrome BuiltinAI / Translator API 适配器（运行时能力检测）
- [ ] Thunderbird 支持
- [ ] 术语表导入/导出（CSV/JSON）

### v0.3.0 —— 原生移动端与 Safari（计划）

- [ ] Capacitor 原生 iOS 应用（App Store），带相机 OCR
- [ ] 原生 Android 应用，带应用内 webview 双语翻译
- [ ] 公证版 Safari 扩展构建与分发
- [ ] iOS Userscripts / Orion 支持

### v0.4.0 —— 可扩展性（计划）

- [ ] 插件/钩子系统：`beforeTranslate` / `segment` / `merge` / `render` / `afterTranslate` 生命周期钩子
- [ ] 云端 OCR 适配器钩子（本机 Tesseract.js 之外）
- [ ] 自定义引擎模板 UI（不写代码定制请求/响应形态）
- [ ] 社区规则市场（浏览 + 一键订阅）

### v1.0.0 —— 稳定性（计划）

- [ ] `@lumen/core`、`@lumen/engines`、`@lumen/dom`、`@lumen/sync` 公共 API 冻结
- [ ] 文档站（Astro）
- [ ] Chrome/Firefox/Safari 全覆盖 Playwright E2E
- [ ] 本地化：新增 ja/ko UI

---

## 隐私

- 扩展的设置、规则和历史经 `browser.storage.local` 存在本地（非扩展环境回退 `localStorage`）。Windows 桌面应用的设置存在 `%APPDATA%\app.lumen.translation`；API key 值按当前 Windows 用户 DPAPI 加密，其余偏好为本地 JSON。
- AI 调用用**你自己的 API key** 从你的设备直连引擎服务商。Lumen 永不代理你的流量。
- 同步后端是**你自己的**（你的 WebDAV 服务器或你的 Cloudflare Worker）。没有任何 Lumen 运营的云能看到你的数据。
- 无遥测、无分析、无广告、无收购变数。永远。

---

## 许可证

Apache-2.0。见 [LICENSE](./LICENSE)。可放心用于商业衍生、云集成和闭源 fork。
