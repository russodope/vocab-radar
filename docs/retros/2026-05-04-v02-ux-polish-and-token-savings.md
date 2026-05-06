# Retro · 2026-05-04 · v0.2.x — UX 打磨 + Token 节流

v0.2 客户端化重构上线后，开始**真实使用**第一天就发现一堆体感问题。这次 retro 把当天 5 个修复 commit 串起来记一下。

---

## 做了什么

按提交时间排（5 个 commit，全部已推 main）：

| Commit | 主题 |
|---|---|
| `e3e6300` | 双击在 Reddit 选了"nails the"两词 → defensive 修 expandHyphenated + e.detail===2 强制单词 |
| `6c9d7c9` | 加"不用记"删除按钮 + 多词短语翻译开关（默认 ON）|
| `f6da76f` | 删除按钮太淡看不到 → 加大加深；翻译卡住骨架 → 加 25s 超时 + onDisconnect 提示 + bg 详细日志 |
| `c15a271` | 重复查同词跳过 LLM，直接 fake-stream 缓存内容；删除按钮搬进 actions 行改名"不用记" |
| `eb72745` | DeepSeek `max_tokens: 1024` 封顶 |

---

## 为什么这样做

### 1. 双击被浏览器选过头

CLAUDE.md 之前已经写了 `expandHyphenated` 跨连字符扩展。但实际 Reddit 上发现**浏览器原生双击**就能选到两个词（猜测：页面有 NBSP 或异常 word-segmentation hint）。我的 `[A-Za-z\-]` regex 不会跨空格扩展，但也没拦截"已经包含空格的输入"。

修法：双层防御：
- `expandHyphenated` 内部：扩展结果含 `\s` 就 fallback 原始选区
- `onMouseUp` 入口：`e.detail === 2`（双击）+ 含空格 → 取第一个空白前的部分

drag-select 多词照旧能用，只有双击被严格限制。

### 2. "不用记"是状态机之外的"删除"

误操作触发翻译后，原有的 "我认识了 / 完全掌握" 都是**正常状态机动作**，把词留在库里。用户原话"主要是不想那个词计入统计之中" —— 需要一个**真正从 DB 删除的动作**。

第一版放在 popup 头部右上 ✕，太淡看不见。第二版搬到底部 actions 行重命名"不用记"，跟其他动作并列，hover 微微红色。

值得记的设计判断：**没有加确认对话框**。一个词重新划即可，确认对话比误删本身更扰人。

### 3. 短语翻译开关默认 ON 是兼容旧体验

drag-select 一整段后想着重读 → 触发翻译 → 浪费 API + 污染统计。但同时 drag-select 多词词组（`machine learning`）是合理用法。

折中：开关默认 ON 保持 v0.2 体验不破坏；用户能关掉。

content.js 缓存 `translatePhrases` 通过 `chrome.storage.onChanged` 实时同步 —— popup 一改 content 立即生效，不用刷新页面。

### 4. 翻译卡住的可见性

之前如果 DeepSeek 返回 200 但 `delta.content` 是空字符串/全 null，弹窗会卡在骨架状态、用户**完全不知道发生了什么**。

补三层可见性：
- bg 检测 `totalChars === 0` 时主动发 error chunk
- content.js 25s 超时 timer 兜底显示"翻译超时"
- content.js `port.onDisconnect` 处理 SW 提前死亡情况

### 5. 缓存命中跳过 LLM —— 这次最有 ROI 的优化

实际使用发现：一篇文章里同一个生词反复 hover/查是常态。但每次都重新调 DeepSeek 是纯重复劳动 —— DB 里 translation 字段已经有完整 JSON。

修法：`upsertWord` 多返回一个 `cachedTranslation` 字段（upsert 之前的值），bg 看到非 null 就把它包成一个 fake stream chunk + [DONE] 直接发，**不调 DeepSeek**。

`lookup_count` 仍然增加，"统计我反复查这个词"这件事仍然真实。

效果显著：
- 第二次查同一词：**0 token + 瞬间响应**（之前 2-3s 流式 + 100-200 tokens）
- 整体词库里 80% 重复查询都被这一步消化掉

### 6. max_tokens 封顶

DeepSeek 默认无 `max_tokens` 上限（其实是模型 context max 4-8K）。一旦模型抽风输出无限内容，单次成本可能爆炸。

设 1024：
- 单词典型 100-200 ✓
- 整段翻译 600-1000 ✓
- 抽风 → 顶到 1024 → 单次最坏成本 ¥0.0015

不要设太死（500 可能就影响整段翻译），1024 是个保留空间且安全的数字。

---

## 遇到了什么问题

### 1. 浏览器原生双击行为不一致

Reddit / 某些 Twitter 嵌入页 / Wikipedia 的双击行为不完全一致。`document.body.style.userSelect`、字体 / NBSP 都可能影响。

**教训**：永远不要假设"selection.toString() 就是用户预期的词"。任何用户输入到 LLM 的字符串前都要做语义校验（这次的 `e.detail === 2 + /\s/` 检查就是）。

### 2. CSS 太淡用户看不见

`color:#aaa` + `font-size:14px` 在白底上是物理上能看见的，但**视觉权重不够**用户主动注意。

**教训**：可交互元素至少要 `color:#888` 或更深 + 加 hover 状态明显反馈。"看着像"和"用户能用"是两个标准。

### 3. SW 阻塞调试感

translate 卡住时，content.js 端只看到一个无尽的骨架。SW console 日志在 `chrome://extensions/ → service worker` 链接里，**不在页面 DevTools**。这个体验对自己 debug 都很恶心，对未来用户更是黑洞。

**教训**：所有"等待中"状态必须有**死线**和**回退态**。25s 超时是工程下限。

### 4. content.js 拿不到 chrome.storage 直接触发的设置变更

content.js 是 page-isolated world，但 `chrome.storage` API 是有访问权的（permissions 已声明）。我之前的设计是"通过 background 中转拿设置"。这次发现 `chrome.storage.onChanged` 也能在 content.js 直接监听，更轻量。

**教训**：有 chrome.* API 的地方就直接用，不要为了"统一通过 bg"白白加一跳。

### 5. cachedTranslation 可能是过期数据（小 trade-off）

如果用户 6 个月前查过 "leverage" 那时是 v4-flash 给的释义，今天再查走缓存 → 拿到当时的释义。如果当时 LLM 给得不准，错的就一直错。

**没解决**：现在缓存永久有效。可选择：
- 给 popup 加个"重新翻译"按钮强制 bypass 缓存
- 或缓存设 TTL（比如 30 天）
- 或对 `translation === null` 的词强制重译（已经有这个 fallback）

留 v0.3 看用户反馈再决定。

---

## 下次注意什么

- ☑ **用户输入到 LLM 前必须语义校验**：长度、字符集、单词数都要检查；不要直接把 `selection.toString()` 灌给 prompt
- ☑ **可交互 UI 元素 hover 状态必须明显**：颜色变化 + 背景变化 + 边框变化，至少 2 个维度变化才直观
- ☑ **所有等待状态必须有 timeout fallback**：骨架最多 25s，到点必须显示错误而不是无限转
- ☑ **LLM 调用永远要 max_tokens**：哪怕看似"输出可控"，也要封顶防极端值
- ☑ **本地缓存优先于远程调用**：BYOK 模式下省的是用户的钱；缓存命中是最大的 LLM 成本优化点
- ☑ **content.js 可以直接用 chrome.storage.onChanged**：不必所有事都中转 background
- ☑ **删除/破坏性动作不一定要确认对话框**：单条数据 + 易复原的场景，确认对话比误操作本身更打扰用户

---

## 数据快照

```
今日 5 个 commit，净增 ~150 行扩展代码，0 行删除（除了文案改动）。

DeepSeek 实测：
  word="escalation": 2474ms / 72 SSE 行 / 200 字符输出
  
缓存命中后再查同词：< 50ms（瞬间）/ 0 token

弹窗 actions 行布局（从左到右）：
  [我认识了] [完全掌握] [不用记] [关闭]
                                  ↑ 新增（grey/红 hover）
```
