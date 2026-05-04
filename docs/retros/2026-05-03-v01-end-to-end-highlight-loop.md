# Retro · 2026-05-03 · VocabRadar v0.1 端到端高亮闭环

一天内从空目录跑到 Step 1-4 全通：划词 → 弹窗流式翻译 → 入库 → 状态机 → 页面自动高亮。

---

## 做了什么

**后端（FastAPI + SQLite）**
- 项目脚手架：`config / database / models / crud / deepseek / routers/{translate,vocab}`
- `POST /translate` SSE 流式：先写 `lookup_events` + `words` upsert，再透传 DeepSeek
- `GET /words` 返回 `[{word, lookup_count}]`（偏离 CLAUDE.md 的纯字符串数组，让前端能直接分级配色）
- `PATCH /word/{word}/status` 状态机
- `GET /words/stats` 聚合（UI 留到 Step 5）

**插件（MV3）**
- `background.js` service worker：长连接 port 走 SSE，`sendMessage` 走一次性 API
- `content.js`：Shadow DOM 弹窗 + 渐进式 JSON 字段抽取（用宽松正则在 buffer 上抓 `definition`/`in_context`/`example`）
- 页面高亮：TreeWalker + `\b...\b` + 长词优先 + 跳过 input/code/contenteditable + 自家弹窗
- **MutationObserver + 500/1500/3500ms 三次延迟兜底**：应对 React/Vue SPA 后续渲染
- "我认识了" 按钮：PATCH familiar → 当前页面立即移除高亮 + 失效缓存
- localStorage 5 分钟缓存 `/words`

**配置/工程**
- `.env` + `.env.example` 双环境（dev/prod 通过 `chrome.storage.local.env` 切换）
- `init_db()` 启动建表 + SQLite PRAGMA（WAL/synchronous NORMAL/foreign_keys ON）
- CORS 用 `allow_origin_regex` 通配 `chrome-extension://*`

---

## 为什么这样做

- **SQLite 替代 MySQL**：单用户、写频率低、数据量天花板 < 10 万行；本地服务器都是一个 `.db` 文件，零运维。SQLAlchemy 抽象保留切回 MySQL 的成本约为零（改 DSN）。
- **GET /words 返回对象而非字符串**：高亮分级（1-2 黄、3+ 橙）必须有 `lookup_count`，省一次额外请求。
- **content script 走 background 代理 fetch**：避免页面 CSP 限制和 origin 污染；SSE 长连接用 `chrome.runtime.connect` 的 port 双向通信。
- **Shadow DOM 弹窗 + 页面级高亮 CSS**：弹窗要隔离，不被 Reddit 样式污染；高亮 span 必须暴露在 light DOM 才能 wrap 进文本节点。
- **MutationObserver + 延迟兜底**：单点 `document_idle` 在 SPA 完全不够（见下）。

---

## 遇到了什么问题

### 1. DeepSeek `deepseek-v4-flash` 默认开启思考模式（最坑）

**症状**：弹窗骨架永远不填充，看着像 content.js 写错了。

**根因**：v4-flash 默认 thinking 模式开启，所有 token 走 `delta.reasoning_content` 字段，`delta.content` 全是 `null`。我代码只读 `delta.content`，所以全程拿不到字符。

**深层根因**：我训练数据停在老的 `deepseek-chat` 时代，对 v4 系列默认行为有认知错位 —— 用户提醒"DeepSeek 有 v4 了"我才查文档。

**修法**：请求体加 `"thinking": {"type": "disabled"}`。

**下次怎么避免**：涉及"最近半年内发布的模型/工具/库"，**永远先 WebFetch 官方文档**，不要相信记忆。尤其是模型 API 这种迭代极快的对象。

### 2. Python 3.9 + SQLAlchemy 2.0 不兼容 PEP 604 联合类型

**症状**：`Mapped[str | None]` 报 `MappedAnnotationError: Could not de-stringify annotation`。

**根因**：SQLAlchemy 2.0 用 `eval()` 去字符串化注解，3.9 的 eval 不认 `str | None`。`from __future__ import annotations` 救不了 SA 的 eval 路径。

**修法**：切到 pyenv 的 Python 3.12.13。

**下次怎么避免**：FastAPI/SQLAlchemy 2.0 项目把 **Python ≥ 3.10 写进 README/requirements**，venv 创建脚本里指定路径。本项目下个 retro 时考虑加 `pyproject.toml` 锁版本。

### 3. SPA 一次性扫描失效（Reddit 高亮全无）

**症状**：DB 里有 `persistent` `gotchas` 等，刷新 Reddit 后视觉无任何高亮。

**根因**：`content_scripts.run_at = document_idle` 只比 `load` 晚一点点，但 Reddit 的评论是 React 在 `load` 之后才渲染。我们扫的时候 `document.body` 里根本没那些文本。

**修法**：
- 首次 init 后再 setTimeout 三次（500/1500/3500ms）兜底扫描
- 长期保活 MutationObserver 监听 `addedNodes`，throttle 到 50ms+rAF 后扫描
- 写 DOM 期间临时 disconnect observer，避免我们自己的 replaceChild 触发反馈循环

**下次怎么避免**：**任何 content script 项目，从一开始就带 MutationObserver**，不要等到"现象不对"才补。SPA 是 2026 年的默认。

### 4. SSE 在 nginx 后被缓冲

**修法**：响应头加 `X-Accel-Buffering: no` + `Cache-Control: no-cache`（已加，proactive）。

### 5. CORS 通配 chrome-extension://*

**修法**：用 `CORSMiddleware` 的 `allow_origin_regex` 不是 `allow_origins`，因为后者只支持精确匹配/`*`。

---

## 下次注意什么

- ☑ **新模型/SDK/库 → WebFetch 官方文档** 确认默认行为，不要靠训练数据脑补
- ☑ **content script 项目默认带 MutationObserver**，SPA 是常态不是例外
- ☑ **Python 3.10+ 是 SQLAlchemy 2.0 的事实下限**
- ☑ **CLAUDE.md 偏离要在 plan 里显式标注** —— 这次 SQLite 替代 MySQL 经过用户讨论同意才落地，后端注释和 retro 都留了证据
- ☑ **验证完成不能跳过 user-side 实操** —— 后端 curl 通 ≠ 端到端通；扩展必须真在 Chrome 里点过，否则会漏掉 SPA 渲染时机这种问题
- ☑ **Service Worker 是按需唤醒的**，调试时浏览器会显示"Service Worker（无效）"是正常的，不要被吓到（这次差点带歪诊断方向）
- ☑ **后端改完 reload 不一定生效**，`.env` 改动 `--reload` 检测不到，**改后端冷启动一次最稳**

---

## 数据快照（写 retro 时刻）

```
words: 8 条全部 learning
  hedge:3, persistent:3, coordinator:2, nascent:1, dumb:1,
  stack:1, gotchas:1, resilient:1
lookup_events: 11 条
今日查询: 11 次
```
