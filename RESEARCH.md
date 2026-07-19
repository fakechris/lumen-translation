# Lumen Translation — 对标研究与技术方案

> 目标：打造一套功能完全覆盖 FluentRead / Kiss Translator / Immersive Translate，采用 **MIT 或 Apache-2.0** 协议的开源翻译产品矩阵。

---

## 1. 竞品全景

| 产品 | 协议 | Stars | 活跃度 | 技术栈 | 定位 |
|---|---|---|---|---|---|
| **Immersive Translate** | 闭源（GitHub 仅用于发版/Issue，旧 AGPL 版已归档） | 18.2k | 极高（2,276 commits，535 releases，2 天前更新） | 闭源 + 商业化 | 全平台商业产品，20M+ 用户 |
| **Kiss Translator** | GPL-3.0 | 11.4k | 极高（1,416 commits，87 releases，5 小时前更新） | React + CRA + JS（99.8% JS） | 开源功能最全的扩展 + 油猴脚本 |
| **FluentRead** | GPL-3.0 | 7.3k | 中（500 commits，4 个月前更新） | WXT + Vue + TypeScript | 定位"开源沉浸式翻译"，UI 友好 |

**结论**：三个产品里，开源的均为 GPL，闭源的 Immersive Translate 才是功能天花板。MIT/Apache 协议的空白确实存在，且 GPL 对企业二次商用限制较大，是机会窗口。

---

## 2. 功能覆盖矩阵

### 2.1 翻译场景

| 场景 | Immersive | Kiss | FluentRead | Lumen 目标 |
|---|:-:|:-:|:-:|:-:|
| 网页双语对照（段落级智能识别） | ✅ | ✅ | ✅ | ✅ P0 |
| 仅译文模式（隐藏原文） | ✅ | ✅ | ✅ | ✅ P0 |
| 划词翻译 | ✅ | ✅（多引擎对比 + 词典 + 收藏词） | ✅ | ✅ P0 |
| 鼠标悬停段落翻译 | ✅ | ✅ | ✅ | ✅ P0 |
| 输入框翻译（三空格 / 快捷键） | ✅ | ✅（Alt+I） | ❌ | ✅ P0 |
| 全文翻译悬浮球 | ❌ | ❌ | ✅ | ✅ P0 |
| YouTube 字幕翻译 | ✅（100+ 平台） | ✅（合并/断句 + AI 断句） | ❌ | ✅ P1（先 YT，后扩 100+） |
| 在线会议字幕翻译（Zoom/Meet/Teams） | ✅ | ❌ | ❌ | ⚠️ P2 |
| PDF 翻译（保留版式） | ✅ | ❌ | ❌ | ✅ P1 |
| PDF OCR 扫描件翻译 | ✅ | ❌ | ❌ | ⚠️ P2 |
| ePub / TXT / DOCX / Markdown 文件翻译 | ✅ | ✅（字幕/TXT） | ❌ | ✅ P1 |
| 图片翻译（OCR + Inpainting） | ✅ | ❌ | ❌ | ⚠️ P2 |
| 漫画 / Webtoon 翻译 | ✅ | ❌ | ❌ | ⚠️ P2 |

### 2.2 翻译引擎

| 引擎分类 | Immersive | Kiss | FluentRead | Lumen 目标 |
|---|:-:|:-:|:-:|:-:|
| Google / Microsoft / DeepL / DeepLX | ✅ | ✅ | ✅ | ✅ P0 |
| Tencent / Volcengine / Youdao / Baidu / Caiyun / Niu | ✅ | ✅（部分） | ❌ | ✅ P0（按需） |
| OpenAI / Claude / Gemini / DeepSeek / OpenRouter | ✅ | ✅ | ✅ | ✅ P0 |
| Ollama / 本地模型 | ✅ | ✅ | ✅ | ✅ P0 |
| SiliconFlow / BigModel / OpenCode 等国内聚合 | ✅ | ✅ | ✅ | ✅ P0 |
| Chrome 内置 AI（BuiltinAI / Translator API） | ✅ | ✅ | ✅ | ✅ P0 |
| 自定义接口（Hook + 模板） | ✅ | ✅（强） | ✅ | ✅ P0 |
| 流式输出 | ✅ | ✅ | ❌ | ✅ P0 |
| 聚合批量发送 | ✅ | ✅ | ✅（并发控制） | ✅ P0 |
| AI 上下文记忆 | ✅ | ✅ | ❌ | ✅ P0 |
| 自定义 AI 术语词典 | ✅ | ✅ | ❌ | ✅ P0 |

### 2.3 平台与分发

| 平台 | Immersive | Kiss | FluentRead | Lumen 目标 |
|---|:-:|:-:|:-:|:-:|
| Chrome / Edge | ✅ | ✅ | ✅ | ✅ P0 |
| Firefox | ✅ | ✅ | ✅ | ✅ P0 |
| Safari (Mac) | ✅ | ⚠️（部分） | ❌ | ✅ P1（WXT Safari 模块） |
| Safari (iOS) / Orion | ✅ | ✅（iOS Userscripts） | ❌ | ✅ P1 |
| Android（Kiwi） | ✅ | ✅ | ❌ | ✅ P0（扩展天然支持） |
| 原生 iOS App | ✅ | ❌ | ❌ | ⚠️ P3 |
| 原生 Android App | ✅ | ❌ | ❌ | ⚠️ P3 |
| Thunderbird | ❌ | ✅ | ❌ | ⚠️ P2 |
| Userscript 油猴脚本 | ✅ | ✅ | ✅ | ✅ P1（作为受限 fallback） |
| **PopClip 扩展（macOS 选词翻译）** | ❌ | ❌ | ❌ | ✅ P1（差异化，Bob 风格） |

### 2.4 数据、规则与同步

| 能力 | Immersive | Kiss | FluentRead | Lumen 目标 |
|---|:-:|:-:|:-:|:-:|
| 全本地存储、隐私优先 | ✅ | ✅ | ✅ | ✅ P0 |
| 站点自定义规则 | ✅ | ✅（个人>订阅>全局） | ✅ | ✅ P0 |
| 规则订阅 / 分享 | ✅ | ✅（kiss-rules 社区） | ❌ | ✅ P0 |
| 跨端同步（WebDAV） | ✅ | ✅ | ❌ | ✅ P1 |
| 跨端同步（自托管 Worker / Cloudflare） | ✅ | ✅（kiss-worker） | ❌ | ✅ P1 |
| 富文本保留（链接、样式） | ✅ | ✅ | ✅ | ✅ P0 |
| 自定义快捷键 | ✅ | ✅（Alt+Q/C/K/S/O/I） | ✅ | ✅ P0 |
| 自定义译文样式 | ✅ | ✅ | ✅ | ✅ P0 |
| 多语言 UI（en/zh/ja/ko） | ✅ | ✅（4 种 README） | ✅（en/zh） | ✅ P0 |
| 外部事件触发 API（CustomEvent） | ❌ | ✅ | ❌ | ✅ P0（差异化） |

---

## 3. 差异化机会（超越 GPL 竞品的卖点）

1. **真正宽松协议**：MIT/Apache-2.0，企业可闭源二次商用，云厂商可集成，避开 GPL 传染性。
2. **架构开放**：翻译引擎、规则引擎、同步后端全部以独立 npm 包发布（`@lumen/core`、`@lumen/engines`、`@lumen/rules`、`@lumen/sync`），允许第三方嵌入到任意 Electron / Webview / 移动端产品。
3. **可编程 Hook 系统**：在 Kiss Translator 自定义接口之上，提供生命周期 Hook（beforeTranslate / segment / merge / render / afterTranslate），支持插件化扩展。
4. **现代化的工程基线**：WXT + TypeScript + React + Vite + Tailwind + Zustand + Vitest，相比 Kiss 的 CRA+JS 和 FluentRead 的 Vue 单仓，更利于社区贡献。
5. **内置隐私模式**：默认全本地，AI 调用走用户自有 Key，绝不内置任何"代理转发"服务；同步默认端到端加密。
6. **无追踪、无遥测、无商业化路径**：明确写入 README，对标 Immersive 的"被收购后商业化"焦虑。

---

## 4. 推荐技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 扩展框架 | **WXT** | 支持 Chrome/Edge/Firefox/Safari 统一构建，有 Safari 模块；FluentRead 已采用，验证可行 |
| 语言 | **TypeScript**（strict） | 三个竞品趋势一致 |
| UI 框架 | **React 19 + Tailwind CSS v4** | 生态最大、社区贡献门槛低 |
| 状态管理 | **Zustand** + **jotai**（细粒度） | 轻量，避免 Redux 样板 |
| 存储 | **Dexie.js**（IndexedDB） + `browser.storage` | 大数据用 Dexie，配置用 storage API |
| 内容脚本 DOM 处理 | 原生 + **MutationObserver** 队列 | 段落智能识别核心 |
| PDF | **PDF.js** + 自研双语排版层 | Immersive 的 PDF 是护城河之一，需重点投入 |
| 字幕 | 自研字幕合并/断句算法（参考 Kiss） + AI 断句 | YouTube 用 `ytInitialPlayerResponse`/`timedtext` |
| OCR | **Tesseract.js**（本地） + 可选云 OCR Hook | 默认本地，隐私优先 |
| 同步后端 | **Cloudflare Workers** 模板 + **WebDAV** 适配器 | 仿 kiss-worker，自托管优先 |
| 构建/打包 | WXT 内置 Vite + **pnpm** | 速度与 monorepo 友好 |
| 测试 | **Vitest** + **Playwright**（扩展 E2E） | 单元 + 端到端 |
| i18n | **i18next** | 支持复杂文案 |
| CI/CD | GitHub Actions（多浏览器打包 + 自动发布） | 仿 FluentRead 流程 |

### Monorepo 结构（pnpm workspaces）

```
lumen-translation/
├── packages/
│   ├── core/              # @lumen/core 翻译核心，引擎无关
│   ├── engines/           # @lumen/engines 各翻译引擎适配器
│   ├── rules/             # @lumen/rules 规则引擎 + 订阅格式
│   ├── dom/               # @lumen/dom 段落识别 + 双语渲染
│   ├── sync/              # @lumen/sync WebDAV / Worker 同步
│   ├── i18n/              # @lumen/i18n 文案
│   └── ui/                # @lumen/ui 设置页/弹窗/悬浮球组件
├── apps/
│   ├── extension/         # WXT 主扩展（Chrome/Edge/Firefox/Safari）
│   └── userscript/        # 受限版油猴脚本（复用 core/engines/dom）
├── sites/                 # 站点适配规则包（@lumen/site-rules）
├── docs/                  # 文档站（Astro）
└── tools/                 # 发版/打包脚本
```

---

## 5. 分阶段路线图

### Phase 0 — 地基（2 周）
- 仓库初始化、license（Apache-2.0）、CI、CONTRIBUTING
- WXT + React + TS 脚手架，跨浏览器能跑通 hello world
- `@lumen/core` 接口定义：Translator / Engine / Rule / Segment
- 一个最小可用引擎（Google 免费端点 + OpenAI）

### Phase 1 — MVP 对标 FluentRead + Kiss 核心（4 周）
- 网页双语对照翻译（段落智能识别 + 仅译文模式）
- 划词翻译 / 悬停翻译 / 输入框翻译 / 悬浮球全文翻译
- 5 个核心引擎：Google、Microsoft、DeepL、OpenAI、Ollama
- 流式 AI + 聚合批量 + 并发控制
- 自定义引擎（Hook 模板）+ AI 术语词典
- 站点规则系统（个人 > 订阅 > 全局）+ 社区规则仓库
- 自定义快捷键、样式、深色模式
- 多语言 UI（en/zh）✅
- Chrome / Edge / Firefox / Android(Kiwi) 发布
- macOS PopClip 扩展（选词即译，Bob 风格 show-result）

### Phase 2 — 对齐 Kiss 全功能并超越（4 周）✅ 基本完成
- Safari（Mac + iOS via WXT Safari 模块 + Userscripts）✅ scaffold（`build:safari` / `safari:init`，需 macOS + Xcode）
- YouTube 字幕翻译 + 合并断句 + AI 断句 ✅（`@lumen/subtitles` + `video.content.ts` 覆盖 YouTube/Bilibili/Netflix/PrimeVideo/Vimeo）
- ePub / TXT / Markdown / HTML 文件翻译 ✅（`file-translator` 页，ePub 经 jszip 解包）
- PDF 翻译（PDF.js 双语版式层）✅（`@lumen/pdf` + `pdf-reader` 页，重排双语）
- 跨端同步：WebDAV + 自托管 Worker（Cloudflare/Docker）✅（`@lumen/sync` + `apps/worker` Hono 服务 + options 同步面板）
- 规则订阅市场 + 分享 ✅（options 订阅管理 + `fetchSubscription` 合并）
- 外部事件触发 API（CustomEvent）✅

### Phase 3 — 对标 Immersive 高阶（6 周+）✅ 框架完成
- PDF OCR 扫描件（Tesseract.js）✅（`@lumen/ocr`，按需动态加载 WASM）
- 100+ 视频平台字幕 ✅ 框架（`@lumen/subtitles` 的 `VideoPlatformAdapter` + 6 平台适配；社区可扩）
- 图片翻译（OCR + Inpainting）✅（`image-translator` 页 + `@lumen/ocr`，inpaint 为占位实现）
- 漫画 / Webtoon 翻译 ⚠️ 框架复用图片翻译，未做分镜
- 在线会议实时字幕（Zoom/Meet/Teams）✅（`@lumen/meetings` 适配器 + `meetings.content.ts` 浮层）
- 移动端原生壳（Capacitor）✅ scaffold（`apps/mobile`，复用 core/engines）

### 额外（用户追加需求）
- 国内 LLM provider 内置 ✅（deepseek/glm/kimi/minimax(国内+海外)/豆包/阿里/混元/ernie/spark/baichuan/yi/siliconflow/openrouter，options 分组下拉 + 模型预填 + 区域选择）
- PopClip 扩展（macOS 选词翻译，Bob 风格）✅（`apps/popclip`，三动作 show/copy/paste）

---

## 6. 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| PDF 版式还原工程量大 | Immersive 这块投入多年 | 分两步：先做"重排双语 PDF"，后做"原版式双语" |
| 100+ 视频平台适配 | 每家字幕机制不同 | 社区共建规则包，参考 kiss-rules 模式 |
| GPL 代码不可直接借鉴 | 三个开源竞品均 GPL，不能复制源码 | 仅做行为对标，干净室实现；架构与代码独立编写 |
| Chrome BuiltinAI 兼容性 | 各浏览器 API 不一致 | 抽象为 Engine 适配器，运行时探测能力 |
| 商业产品功能追赶节奏 | Immersive 已 535 releases | 聚焦"开源 + 宽松协议 + 隐私"叙事，不拼功能数量拼可组合性 |

---

## 7. 协议选择建议

**推荐 Apache-2.0**，理由：
- 比 MIT 多一份明确的专利授权条款，对企业更友好
- 与现代开源基础设施（Chromium、K8s 等）一致
- 允许二次商用、闭源衍生
- 可兼容纳入更大产品

如要极致简洁可选 MIT；两者都能达成"打破 GPL 锁定"的核心目标。

---

## 8. 待决问题

1. **首期范围**：是先做扩展 MVP（Phase 1）快速发布，还是先搭好 monorepo 全骨架再填功能？
2. **UI 框架**：React 还是 Vue？（推荐 React，社区基数大；FluentRead 用 Vue，Kiss 用 React）
3. **协议终选**：Apache-2.0 还是 MIT？
4. **是否纳入移动端原生 App**：影响 Phase 3 工作量
5. **是否提供云端 Key 代发服务**：与"隐私优先"叙事冲突，建议不做
