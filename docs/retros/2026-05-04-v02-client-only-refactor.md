# Retro · 2026-05-04 · v0.1 → v0.2 客户端化重构

把 FastAPI + SQLite 后端整套删掉，所有逻辑搬进 Chrome 扩展。这是项目最大的一次架构变化。

---

## 做了什么

**删**：整个 `backend/` 目录（FastAPI + SQLAlchemy + aiosqlite 共 ~600 行 Python）

**新增** `extension/lib/`：
- `db.js` — IndexedDB CRUD，镜像原 SQLite schema（`words` + `lookup_events` 两个 store）
- `deepseek.js` — 扩展 background 直接 fetch `https://api.deepseek.com`，绕开后端代理
- `settings.js` — `chrome.storage.local` 上的 BYOK key + 7×7 语言对配置 + key 安全工具

**重写** `background.js`：
- 原来：fetch 到 `localhost:8000` 的 SSE 代理
- 现在：直调 DeepSeek + IDB 写入 + SSE 格式包装回传给 content.js
- **content.js 完全没动** —— 因为 content/bg 之间的消息协议（port + chunk/done/error）我设计时就和后端 SSE 解耦，所以重构没穿透到 UI 层

**新增** `popup.html / popup.js / onboarding.html / onboarding.js`：
- popup 里 BYOK key 输入框（password 类型 + 掩码显示前 6 末 4） + "测试" 按钮
- 7×7 语言对选择
- 首次安装跳出 onboarding 引导填 key

**manifest 升到 v0.2.0**：`host_permissions` 从 `localhost:8000` 换到 `api.deepseek.com`。

---

## 为什么这样做

### 1. 商业模型决定架构

讨论 BYOK 时发现一个矛盾：
- 用户说"实在懒就找我充个值，我账户单独配 key 限额给他"
- 但保留后端的话，朋友拿到的 key 跟他自己电脑上的后端实例没绑定关系，"充值限额"模型跑不通

唯一能让"我给你 key、你贴进去就用"成立的是**客户端架构**：用户的 key 直接从浏览器调 DeepSeek，不经过任何中间层。这一刻架构决定就被业务模型逼出来了。

### 2. "0 配置"承诺的兑现

用户希望"基本上就配置个 deepseek key 就行"。在后端方案下，0 配置必须依赖 docker-compose（用户要装 Docker）。在客户端方案下，0 配置真的就是"装扩展 + 贴 key"，5 步内完成。

### 3. 维护成本归零

后端意味着永久挂着的服务器、永远要监控的 uptime、定期升级安全补丁。客户端意味着发完 = 不用管。对一个**自用 + 作品展示**定位的项目，后者完爆前者。

### 4. 隐私故事更干净

"你的词全在你浏览器里，永远不上服务器" —— 这一句话作为产品 README 的卖点比"我用 nginx 反代 + Let's Encrypt + ..."强 100 倍。

---

## 遇到了什么问题

### 1. ES Module 在 SW 里的细节

`manifest.json` 里 `background.service_worker` 必须配 `"type": "module"` 才能在 background.js 用 `import { ... } from './lib/db.js'`。这块查了一下确认 MV3 支持。

### 2. content.js 不动是设计的功劳

原来设计 content/bg 协议时刻意把 SSE 协议变成了 bg 的内部细节 —— content 只看到 `{type:'chunk', data:'...'}`，data 是 bg 喂进来的字符串。这次重构 bg 内部的源头从 fetch(localhost) 换成 fetch(deepseek.com) + IDB 写入，但 chunk 文本还是同样的 SSE 格式，所以 content.js 一行不改就能跑。

**教训**：进程间通信用"内部协议 wrap 外部协议"模式，外部协议（SSE）变了内部协议不变，重构边界清晰。

### 3. IndexedDB transaction 坑

`upsertWord` 需要 read-modify-write 原子性。IDB 的 transaction 一旦在事务期间 await 一个**非 IDB 的** Promise（比如 fetch、setTimeout），事务就自动 commit 关闭了。所以我把 `reqAsPromise()` 写成只 wrap IDB Request 的 onsuccess/onerror，不引入 microtask 间隙，这样在事务内的连续 await 是安全的。

**下次注意**：IDB 事务里**只能 await IDB 操作**，不能 await fetch/setTimeout/任何异步任务。

### 4. chrome.storage.local 不加密

Key 存在 chrome.storage.local 是 plaintext。Chrome 没提供"密码保护"的 storage。这是一个**接受的风险**：物理接触用户电脑 + 拿到 Chrome profile 的攻击者能读到 key。这跟所有客户端 API 工具同等级别（VS Code 的扩展 token、Cursor 的 API key 都一样）。

**下次注意**：做 BYOK 类项目时把这个限制写进 README 让用户知情。

### 5. v4-flash 的 prompt 缓存利好

讨论定价时确认：DeepSeek 对 system prompt + user prompt 的稳定 prefix 做 cache，命中后 input 价格降 10×。所以 prompt 模板要把变量（word/context）放在最后，prefix（system message + 模板前文）保持稳定。这次重构改语言对时刻意只改 user message 的中间部分，system message 完全不动。

---

## 下次注意什么

- ☑ **架构跟随业务模型** —— 别先选技术再硬塞业务。BYOK 决定了客户端，docker-compose 决定了 BYOK 不可能（钥匙跟后端解耦）
- ☑ **进程间协议 wrap 外部协议** —— content/bg port 用内部 chunk 包 SSE，重构换源头不穿透 UI
- ☑ **IDB 事务里只 await IDB 操作** —— 任何其他 await 都会自动 commit 事务
- ☑ **prompt 模板设计：把变量放最后** —— 让 prefix 稳定，吃 LLM 服务端 prompt cache
- ☑ **BYOK 的安全限制要写进 README** —— chrome.storage 不加密，DevTools Network 能看 key，让用户知情后自己决策
- ☑ **MV3 service worker 用 ES module** 必须在 manifest 里 `"type": "module"`，不然 import 报错

---

## 数据快照（写 retro 时刻）

```
extension/ 文件大小：
  background.js     5.7 KB
  content.js       28.4 KB  (Shadow DOM 弹窗 + 高亮 + Hover + MutationObserver)
  popup.html        6.5 KB
  popup.js          4.7 KB
  onboarding.html   4.3 KB
  onboarding.js     1.3 KB
  manifest.json     0.8 KB
  lib/db.js         7.2 KB
  lib/deepseek.js   4.4 KB
  lib/settings.js   1.8 KB

总：约 65 KB 源码（无混淆）。后端代码：删除 0 KB。
```

旧的 8 个测试词 + SQLite DB 文件随 backend/ 一起删除，从 0 重新开始用。
