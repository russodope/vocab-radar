# VocabRadar

> 读着读着，单词就背完了。

一个 Chrome 扩展，让"被动阅读"变成"主动积累"。在任何英文网页上划词查询，DeepSeek 给上下文感知翻译；不认识的词自动建状态机，下次访问同一篇文章时**自动高亮**已查过的生词，复习自然发生。

**完全本地存储，无后端，无服务器，无隐私顾虑。**

<!-- ![demo](docs/demo.gif) -->

---

## 它和别的"划词翻译"有什么不同

划词翻译是工具，VocabRadar 是**词汇成长系统**。

| 别的工具 | VocabRadar |
|---|---|
| 查完忘了 | 自动入库，再读到自动高亮 |
| 字典查 word，不看上下文 | DeepSeek 看整句给"在这句里的意思" |
| 反复查同一个词没人提醒 | 查 ≥ 3 次的"卡词"用更深橙色，提醒重点关注 |
| 数据上传第三方 | **数据全在你浏览器**，扩展卸了就没了 |
| 订阅制 / 限免 | BYOK：你给一个 DeepSeek key，月度成本 ¥1-3 |

---

## 截图

> _截图占位，[demo gif 制作中]_

---

## 安装

> ⚠️ 暂未上架 Chrome Web Store。当前需手动加载未打包扩展。

**步骤一：拿到代码**

```bash
git clone https://github.com/russodope/vocab-radar.git
```

或者直接 Download ZIP。

**步骤二：加载到 Chrome**

1. 打开 `chrome://extensions/`
2. 右上角开"开发者模式"
3. 点"加载已解压的扩展程序"
4. 选 `vocab-radar/extension/` 文件夹

**步骤三：拿 DeepSeek API key**

1. 访问 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
2. 创建一个新 key（命名为 `VocabRadar` 方便管理）
3. **建议**给这个 key 设置月度限额（比如 ¥10/月，重度使用一个月也就 ¥1-3）

**步骤四：粘贴 key**

首次安装会自动跳出欢迎页，把 key 粘上去点"保存并测试" → ✓ 即可开始使用。

之后随时可以从 Chrome 工具栏 VocabRadar 图标 → popup 修改设置（key、语言对）。

---

## 怎么用

| 操作 | 行为 |
|---|---|
| **双击** 一个英文词 | 划词弹窗 → DeepSeek 流式给中文释义 + 例句 |
| **拖选** 多词短语（如 `no-brainer`）| 同上 |
| 弹窗"我认识了" | 词标记为 familiar，不再高亮 |
| 弹窗"完全掌握" | 词标记为 graduated，永久不再高亮 |
| 鼠标悬停高亮词 | 300ms 后弹出简短释义 tooltip |
| 点击 popup 图标 | 看词汇统计 + 调设置 |

### 高亮配色

- **淡黄** `#FFF3B0` —— 查过 1-2 次的 learning 词
- **深橙** `#FFD580` —— 查过 ≥ 3 次的"卡词"，重点关注

---

## 隐私 / 安全

**所有数据在你本地浏览器**：
- 词汇库存在 IndexedDB（按浏览器 profile 隔离）
- API key 存在 `chrome.storage.local`（其他扩展/网站无法读取）
- 唯一对外通信：你查询时扩展直接发请求到 `https://api.deepseek.com`，**不经过任何中间服务器**（包括我）

**已知限制（任何客户端 API 工具的固有问题）**：
- API key 在请求里以 `Authorization: Bearer ...` 头发出，打开 DevTools Network 面板能看到自己的 key
- Chrome profile 没有密码保护时，物理接触电脑的人理论上能读到 key
- 建议：给 VocabRadar 单独建一个 DeepSeek key 并设月度限额，万一泄露损失可控

---

## 技术栈

- **Chrome Extension MV3**，Vanilla JS，无构建步骤
- **IndexedDB** — 本地 NoSQL 存储（words / lookup_events 两个 store）
- **chrome.storage.local** — 设置和 BYOK key
- **DeepSeek v4-flash** — 上下文翻译（thinking mode disabled，只要最终答案）
- **Shadow DOM** — 弹窗样式与页面 CSS 完全隔离

依赖：**0 个 npm 包**。所有 JS 都是浏览器原生 ES Module。

---

## 项目结构

```
extension/
├── manifest.json
├── background.js          # Service Worker：消息路由 + DeepSeek 调用 + IDB 写入
├── content.js             # 划词 + 弹窗 + 高亮 + MutationObserver + hover tooltip
├── popup.html / popup.js  # 设置 + 统计
├── onboarding.html / .js  # 首次安装欢迎页
└── lib/
    ├── db.js              # IndexedDB CRUD
    ├── deepseek.js        # 直调 DeepSeek API（流式 + 测试 key）
    └── settings.js        # BYOK key + 语言对管理

docs/
└── retros/                # 开发回顾，每次大变化记一篇
```

---

## 语言支持

7×7 矩阵（任选阅读语言 → 任选释义语言）：
- **阅读**：English / 日本語 / 한국어 / Français / Deutsch / Español / 中文
- **释义**：同上 7 种

> 当前划词识别仅支持空格分词的语言（拉丁字母系 + 韩文）。日文、中文这种无空格语言的划词识别需要更复杂的分词逻辑，未来版本再加。

---

## 路线图

- [x] **v0.1** — FastAPI 后端 + 扩展前端打通端到端（已废弃）
- [x] **v0.2** — 客户端化重构，删后端，BYOK，7×7 语言对
- [ ] **v0.3** — 自动降级（familiar 30 天没碰自动退回 learning）
- [ ] **v0.3** — 数据导出 / 导入 JSON
- [ ] **v0.4 ?** — 上 Chrome Web Store
- [ ] **v0.4 ?** — Dashboard 网页（词汇增长曲线、搜索、批量编辑）

---

## 开发

无构建步骤。直接编辑 `extension/` 下的文件，到 `chrome://extensions/` 点扩展旁边的 🔄 刷新按钮即可看到改动。

调试：
- **Service Worker 日志**：`chrome://extensions/` → VocabRadar → "service worker" 链接
- **content.js 日志**：在测试页面 F12 → Console 搜 `[VocabRadar]`
- **popup 日志**：popup 上右键"检查" → Console
- **IndexedDB 数据**：F12 → Application → IndexedDB → `vocab_radar`

---

## 致谢

- 灵感来源：每次读 Reddit/HN 时反复查同一个词，怀疑自己短期记忆有问题
- DeepSeek API 的极致便宜让 BYOK 模式真正可行
- Claude Code 协作完成大部分代码（参见 `docs/retros/`，每次架构决策都记下来了）

---

## License

MIT
