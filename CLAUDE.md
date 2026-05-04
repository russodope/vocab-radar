# VocabRadar — CLAUDE.md

## 项目概述

Chrome 扩展，划词查英文 + 个人词汇成长追踪系统。
- 用户在浏览英文网页时双击或划选某个词 → 弹窗显示中文释义（DeepSeek 流式生成）
- 不认识的词自动建状态机（learning → familiar → graduated）
- 再次访问含有 learning 状态词的页面时自动高亮
- 累计查询 ≥ 3 次的"卡词"用更深的橙色高亮
- 鼠标 hover 已学过的词显示简短释义（从本地缓存读取）

**不是翻译工具，是阅读伴生的词汇成长系统。**

---

## 项目定位

**个人作品 + 自用，非商业**。代码公开 GitHub repo（不主动广泛传播），可能上 Chrome Web Store 但不强求。BYOK（Bring Your Own Key）模式，用户自带 DeepSeek API key。

---

## 技术栈（v0.2 客户端架构）

| 层 | 技术 |
|---|---|
| 全部 | Chrome 扩展 MV3，**纯客户端**，无后端 |
| Service Worker | `background.js` ES module + `lib/{db,deepseek,settings}.js` |
| 数据库 | **IndexedDB**（store: `words` + `lookup_events`） |
| 设置存储 | `chrome.storage.local`（API key、语言对、模型名） |
| AI | **BYOK**：用户自带 DeepSeek key，扩展直调 `https://api.deepseek.com`（默认 `deepseek-v4-flash` + thinking disabled） |
| UI | Vanilla JS + Shadow DOM 弹窗（与页面 CSS 完全隔离） |

> **架构演进**：v0.1 是 FastAPI + SQLite 后端 + 扩展前端。v0.2 删后端，所有逻辑搬进扩展。理由：BYOK 模式下用户分别配自己的 key，集中后端没意义；客户端架构换机器零摩擦、永久免维护、无隐私顾虑。v0.1 后端代码已从主分支移除（git history 可查）。

---

## 项目结构

```
vocab-radar/
├── extension/                  # 全部代码都在这里
│   ├── manifest.json           # MV3, host_permissions: api.deepseek.com + <all_urls>
│   ├── background.js           # SW: 接收 content/popup 的消息，调用 lib/* 处理
│   ├── content.js              # 划词 + 弹窗 + 高亮扫描 + MutationObserver + hover tooltip
│   ├── popup.html / popup.js   # BYOK key 输入 + 7×7 语言对 + 词汇统计
│   ├── onboarding.html / .js   # 首次安装欢迎页（引导填 key）
│   └── lib/
│       ├── db.js               # IndexedDB CRUD（words + lookup_events）
│       ├── deepseek.js         # 直调 DeepSeek API（流式 + 测试 key）
│       └── settings.js         # chrome.storage.local 上的 BYOK key + 语言对
└── docs/retros/                # 开发回顾
```

---

## 数据 Schema (IndexedDB)

### `words` store
```js
keyPath: 'word'        // 主键，唯一
indexes: [status, lookup_count, last_seen_at]

{
  word: string,                                    // PK
  translation: string | null,                      // DeepSeek 返回的完整 JSON 字符串
  status: 'learning' | 'familiar' | 'graduated',
  lookup_count: number,
  first_seen_at: ISO string,
  last_seen_at: ISO string,
  last_context: string | null,                     // 最近一次查询时的原句
  last_source_url: string | null,
}
```

### `lookup_events` store
```js
keyPath: 'id'          // autoIncrement
indexes: [word, created_at]

{
  id: number,
  word: string,
  context_sentence: string | null,
  source_url: string | null,
  page_title: string | null,
  created_at: ISO string,
}
```

### Upsert 语义（在 `lib/db.js` 的 `upsertWord` 里）
单事务 read → modify → write。首次：插入 `status='learning', lookup_count=1`。已存在：`lookup_count++`，更新 `last_seen_at / last_context / last_source_url`。

---

## 状态机

| 状态 | 进入条件 | 页面行为 |
|---|---|---|
| `learning` | 首次查词自动 | 黄色（1-2 次）/ 橙色（3+ 次）高亮 |
| `familiar` | 弹窗点"我认识了" | 不高亮但留库 |
| `graduated` | 弹窗点"完全掌握" | 不高亮，不在 `listLearningWords()` 返回 |

未来 v0.3 计划：`familiar` 词 30 天未触碰自动退回 `learning`（自动降级）。

---

## 消息协议（content/popup ↔ background）

### 流式翻译（双向 long-lived port）
- content.js → bg：`chrome.runtime.connect({name:'translate'})` + `port.postMessage({type:'start', payload:{word, context, sourceUrl, pageTitle}})`
- bg → content：
  - `{type:'chunk', data:'data: {meta:{...}}\n\n'}` 第一帧元数据
  - `{type:'chunk', data:'data: {choices:[...]}\n\n'}` 透传 DeepSeek 流
  - `{type:'chunk', data:'data: [DONE]\n\n'}` 终止
  - `{type:'done'}` / `{type:'error', error:'...'}` 控制信号

### 一次性请求（`chrome.runtime.sendMessage`）
| type | 用途 | 返回 |
|---|---|---|
| `getHighlightWords` | 高亮扫描需要的 learning 词列表（含 translation） | `{highlight_words: [{word, lookup_count, translation}]}` |
| `updateWordStatus` | 改 status | `{word, status, lookup_count}` |
| `getStats` | popup 词汇统计 | `{total, learning, familiar, graduated, looked_up_today}` |
| `getSettings` / `saveSettings` | 读写设置 | `{apiKey, apiBaseUrl, model, sourceLang, targetLang}` + `supportedLangs` |
| `testApiKey` | 验证 key 有效性（最便宜请求） | `{ok, error?}` |
| `exportAll` / `importAll` | 备份用 | JSON dump |

---

## DeepSeek prompt 模板

`definition` **必须排第一**，让流式输出时用户最先看到中文释义。

```
用户正在阅读{src_lang}网页，遇到不认识的词。请用{tgt_lang}返回：
1. 词性 + {tgt_lang}释义（简洁，1-2个含义即可）
2. 这个词在当前句子里的具体含义（结合上下文）
3. 一个帮助记忆的例句（贴近科技/互联网场景）

词: {word}
原句: {context}

以 JSON 格式返回，字段顺序固定如下（definition 必须是第一个字段）：
{"definition": "...", "in_context": "...", "example": "..."}
```

**System prompt 必须保持稳定**：DeepSeek 对相同 prefix 做 prompt cache（命中时 input 价格降 10×）。改 system prompt 会击穿缓存。

**必传**：`thinking: {type: 'disabled'}` —— v4-flash 默认开思考模式，所有 token 进 `delta.reasoning_content`，不关闭则 content.js 永远拿不到字符。

---

## 安全约束（API key 处理）

- ✅ key 存 `chrome.storage.local`（扩展私有，普通页面 JS 读不到）
- ✅ UI 显示用 `maskKey()` 掩码（前 6 + 末 4，中间 …）
- ✅ console / 日志永不打印 key 原文（只打 `describeKeyForLog()` 的长度 + 掩码）
- ✅ `lib/deepseek.js` 的 `assertValidUrl()` 强制 URL origin 在 `apiBaseUrl` 范围内，防意外外发
- ⚠️ DevTools Network 面板能看到 Authorization header —— 这是所有客户端调用 API 的固有限制，非本项目特有

---

## 高亮扫描细节（content.js）

### 时机
- `document_idle`（content_scripts 默认）首次扫一次
- 之后 setTimeout 三次延迟兜底（500/1500/3500ms）应对 React/Vue SPA 慢渲染
- 长期保活 MutationObserver 监听 `addedNodes`，rAF + 50ms throttle

### 跳过区域
- `SCRIPT / STYLE / NOSCRIPT / IFRAME / OBJECT / EMBED`
- `INPUT / TEXTAREA / SELECT / BUTTON`
- `CODE / PRE / KBD / SAMP`
- `[contenteditable]`、`.vr-highlight`（自家高亮 span）、`#vocab-radar-host`（自家弹窗）

### 匹配
- 正则 `\b(word1|word2|...)\b` + `gi` 标志，长词优先
- 命中后 wrap 进 `<span class="vr-highlight" data-vr-word="...">`
- `data-vr-tier="hot"` 表示 lookup_count ≥ 3，CSS 走橙色

### Hover tooltip
- 鼠标进 `.vr-highlight` → 300ms 延迟 → 从 `scanContext.translationMap[word]` 读 definition → 显示在词上方
- pointer-events: none，不挡点击
- Shadow DOM 隔离样式

### 划词扩展
- 双击只能选到 `no-brainer` 的 `no` —— 我们在 `expandHyphenated()` 跨 vr-highlight span 扩展到完整连字符复合词
- 用 `range.commonAncestorContainer` 上溯到 block 父元素，算 selection 的绝对偏移，向两端吃 `[A-Za-z\-]`，修剪两端连字符

---

## 安装与开发

```bash
# 1) 直接加载未打包扩展（无构建步骤）
git clone <repo>
cd vocab-radar
# 浏览器：chrome://extensions/ → 开发者模式 → 加载已解压的扩展 → 选 extension/

# 2) 首次启动会跳出 onboarding 页，粘贴 DeepSeek key 即可开始用
# key 来源：https://platform.deepseek.com/api_keys
```

无需 npm / 构建。所有 JS 都是浏览器原生能跑的 ES module。

---

## Hard Rules（沿用全局 ~/.claude/CLAUDE.md）

- 涉及 API key / 鉴权的逻辑修改必须经我授权
- nginx 配置、`.env` 文件、数据库 migration 修改必须经我授权
- 任务完成前必须运行验证命令并展示输出（不允许"完成了"无凭据）

---

## Auto-Retros

触发条件、保留规则、格式要求 → 见全局 `~/.claude/CLAUDE.md`。
本项目 retro 路径：`docs/retros/YYYY-MM-DD-topic.md`。
