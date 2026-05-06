// VocabRadar - content script
// 职责：监听划词 → 验证 selection → 渲染骨架弹窗 → 通过 background 拿 SSE 流 → 渐进式渲染

(function () {
  'use strict';

  // ========== 配置 ==========
  const MAX_WORD_LEN = 50;
  // 单词或短语：英文字母、连字符、撇号、空格；不接受标点/换行
  const VALID_RE = /^[A-Za-z][A-Za-z\s'\-]{0,49}$/;

  // ========== 状态 ==========
  let popupHost = null;       // Shadow DOM host element
  let popupRoot = null;       // shadowRoot
  let activePort = null;      // 当前 SSE 连接
  let currentWord = null;     // 弹窗当前展示的词，用于"我认识了"按钮回填

  // 缓存的用户设置（来自 chrome.storage.local，通过 background 拉一次 + onChanged 实时同步）
  let cachedSettings = { translatePhrases: true, targetLang: 'zh' };

  // ========== i18n（content script 是 classic script，自己 fetch translations.json）==========
  let TRANSLATIONS = null;
  function t(key, params) {
    if (!TRANSLATIONS) return key;
    const entry = TRANSLATIONS[key];
    if (!entry) return key;
    const lang = cachedSettings.targetLang || 'zh';
    let s = entry[lang] || entry['en'] || entry['zh'] || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return s;
  }
  async function loadTranslationsCS() {
    try {
      const url = chrome.runtime.getURL('lib/translations.json');
      const resp = await fetch(url);
      TRANSLATIONS = await resp.json();
    } catch (e) {
      console.warn('[VocabRadar] load translations failed:', e);
    }
  }

  // ========== 工具：从选中区附近抓"上下文句子" ==========
  function extractContextSentence(selection) {
    try {
      const range = selection.getRangeAt(0);
      // 沿着祖先找一个 block 元素，取它的 textContent，再围绕选中片段裁出本句
      let node = range.commonAncestorContainer;
      while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode;
      while (node && getComputedStyle(node).display === 'inline') node = node.parentElement;
      const containerText = (node?.textContent || selection.toString()).replace(/\s+/g, ' ').trim();
      const word = selection.toString().trim();
      const idx = containerText.indexOf(word);
      if (idx < 0) return word;

      // 从 idx 向左右找最近的句号/问号/感叹号边界
      const startMatch = containerText.slice(0, idx).match(/[.!?。！？]\s+(?=\S)(?!.*[.!?。！？]\s+)/);
      const start = startMatch ? startMatch.index + startMatch[0].length : 0;
      const tail = containerText.slice(idx);
      const endMatch = tail.match(/[.!?。！？]/);
      const end = endMatch ? idx + endMatch.index + 1 : containerText.length;
      return containerText.slice(start, end).trim().slice(0, 1500);
    } catch {
      return selection.toString();
    }
  }

  // ========== UI：Shadow DOM 容器 ==========
  function ensurePopup() {
    if (popupHost && document.body.contains(popupHost)) return;
    popupHost = document.createElement('div');
    popupHost.id = 'vocab-radar-host';
    popupHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    popupRoot = popupHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .panel {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #222;
        background: #fff;
        border: 1px solid #e3e3e3;
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.18);
        padding: 12px 14px;
        min-width: 280px;
        max-width: 380px;
        word-wrap: break-word;
      }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .word { flex: 1; min-width: 0; }
      .word { font-size: 16px; font-weight: 600; color: #1a1a1a; }
      .badge {
        font-size: 11px; padding: 2px 8px; border-radius: 999px;
        background: #fff3b0; color: #6b5300; white-space: nowrap;
      }
      .badge.fresh { background: #fff3b0; color: #6b5300; }
      .badge.stuck { background: #ffd580; color: #7a4a00; }
      .badge.fam   { background: #d6eaff; color: #1f4f88; }
      .badge.grad  { background: #d4f7d4; color: #1f6b1f; }
      .del-btn { color: #888; }
      .del-btn:hover { color: #b00020; background: #fee5e5; border-color: #fcc; }
      .section { margin-top: 8px; }
      .label { font-size: 11px; color: #888; margin-bottom: 2px; }
      .definition { font-size: 14px; color: #111; }
      .in-context, .example { font-size: 13px; color: #333; }
      .skeleton {
        display: block; height: 10px; border-radius: 4px;
        background: linear-gradient(90deg, #eee, #f6f6f6, #eee);
        background-size: 200% 100%; animation: vr-shimmer 1.2s infinite;
        margin-top: 6px;
      }
      .skeleton.short { width: 60%; }
      .skeleton.full  { width: 100%; }
      @keyframes vr-shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .actions { margin-top: 10px; display: flex; gap: 8px; }
      button {
        font: inherit; cursor: pointer; border: 1px solid #ddd; background: #fafafa;
        padding: 4px 10px; border-radius: 6px; color: #333;
      }
      button:hover { background: #f0f0f0; }
      .grad-btn { border-color: #b3dcb3; color: #1f6b1f; }
      .grad-btn:hover { background: #e8f5e8; }
      .err { color: #b00020; font-size: 12px; margin-top: 6px; }
    `;
    popupRoot.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="head">
        <span class="word"></span>
        <span class="badge fresh" data-role="badge">…</span>
      </div>
      <div class="section">
        <div class="label">${t('lookup.label.definition')}</div>
        <div class="definition" data-role="definition"><span class="skeleton full"></span></div>
      </div>
      <div class="section">
        <div class="label">${t('lookup.label.in_context')}</div>
        <div class="in-context" data-role="in-context"><span class="skeleton short"></span></div>
      </div>
      <div class="section">
        <div class="label">${t('lookup.label.example')}</div>
        <div class="example" data-role="example"><span class="skeleton full"></span></div>
      </div>
      <div class="err" data-role="err" hidden></div>
      <div class="actions">
        <button data-role="known">${t('lookup.action.known')}</button>
        <button data-role="graduated" class="grad-btn">${t('lookup.action.graduated')}</button>
        <button data-role="delete" class="del-btn" title="${t('lookup.action.delete.title')}">${t('lookup.action.delete')}</button>
        <button data-role="close">${t('lookup.action.close')}</button>
      </div>
    `;
    popupRoot.appendChild(panel);

    panel.querySelector('[data-role="close"]').addEventListener('click', closePopup);
    panel.querySelector('[data-role="known"]').addEventListener('click', onKnownClicked);
    panel.querySelector('[data-role="graduated"]').addEventListener('click', onGraduatedClicked);
    panel.querySelector('[data-role="delete"]').addEventListener('click', onDeleteClicked);

    document.documentElement.appendChild(popupHost);
  }

  function placePopup(rect) {
    const pad = 8;
    // 默认放选区右下；越界时翻转
    let x = rect.right + pad;
    let y = rect.bottom + pad;
    if (x + 380 > window.innerWidth) x = Math.max(8, rect.left - 380 - pad);
    if (y + 280 > window.innerHeight) y = Math.max(8, rect.top - 280 - pad);
    popupHost.style.left = `${x}px`;
    popupHost.style.top = `${y}px`;
  }

  function setText(role, text) {
    const el = popupRoot?.querySelector(`[data-role="${role}"]`);
    if (el) el.textContent = text;
  }

  function setBadge(meta) {
    const badge = popupRoot?.querySelector('[data-role="badge"]');
    if (!badge) return;
    const { status, lookup_count } = meta;
    badge.classList.remove('fresh', 'stuck', 'fam', 'grad');
    if (status === 'familiar') badge.classList.add('fam');
    else if (status === 'graduated') badge.classList.add('grad');
    else if (lookup_count >= 3) badge.classList.add('stuck');
    else badge.classList.add('fresh');
    badge.textContent = `${status} · ${t('lookup.badge.lookupCount', { n: lookup_count })}`;
  }

  function showError(msg) {
    const err = popupRoot?.querySelector('[data-role="err"]');
    if (err) {
      err.textContent = msg;
      err.hidden = false;
    }
  }

  function closePopup() {
    try { activePort?.disconnect(); } catch (_) {}
    activePort = null;
    if (popupHost && popupHost.parentNode) {
      popupHost.parentNode.removeChild(popupHost);
    }
    popupHost = null;
    popupRoot = null;
    currentWord = null;
  }

  // ========== 渐进式 JSON 字段抽取 ==========
  // DeepSeek 流式吐字符级 token；我们用宽松正则从累积串里抓 definition/in_context/example
  function extractField(buf, key) {
    // 匹配 "<key>"\s*:\s*"  之后的字符串内容（处理 \" 转义），到下一个未转义的 " 或字符串结束
    const m = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)("|$)').exec(buf);
    if (!m) return null;
    // 把 \" 还原为 "，\n 还原换行
    return m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  function renderProgressive(contentBuf, word) {
    const def = extractField(contentBuf, 'definition');
    if (def && def.length) {
      setText('definition', def);
      // 同步写进当前页 translationMap，hover 当场就能用，不必刷新
      setLiveTranslation(word, def);
    }
    const inCtx = extractField(contentBuf, 'in_context');
    if (inCtx && inCtx.length) setText('in-context', inCtx);
    const ex = extractField(contentBuf, 'example');
    if (ex && ex.length) setText('example', ex);
  }

  // ========== SSE 主流程 ==========
  function startTranslate(word, context, rect) {
    closePopup();
    hideTooltip();
    ensurePopup();
    placePopup(rect);
    popupRoot.querySelector('.word').textContent = word;
    currentWord = word;

    let sseBuffer = '';        // 跨 chunk 拼接 SSE 字节
    let contentBuffer = '';    // 累计的 LLM content（来自 choices[0].delta.content）
    let receivedAnyContent = false;
    let translationDone = false;

    const port = chrome.runtime.connect({ name: 'translate' });
    activePort = port;

    // 兜底超时：meta 之后 25s 还没拿到任何 content 字符 → 提示用户
    const stallTimer = setTimeout(() => {
      if (!receivedAnyContent && !translationDone) {
        showError(t('lookup.error.timeout'));
      }
    }, 25000);

    port.onDisconnect.addListener(() => {
      clearTimeout(stallTimer);
      if (!translationDone && !receivedAnyContent) {
        showError(t('lookup.error.disconnect'));
      }
    });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'error') {
        showError(`${t('lookup.error.prefix')}${msg.error}`);
        translationDone = true;
        clearTimeout(stallTimer);
        return;
      }
      if (msg.type === 'done') {
        translationDone = true;
        clearTimeout(stallTimer);
        return;
      }
      if (msg.type !== 'chunk') return;

      sseBuffer += msg.data;
      // 按 \n\n 切 SSE 帧
      const frames = sseBuffer.split('\n\n');
      sseBuffer = frames.pop(); // 留下未完成的尾部

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }

        // 1) 我们自定义的 meta：拿到 status/lookup_count，并把当前词立刻高亮到全页
        if (obj.meta) {
          setBadge(obj.meta);
          if (obj.meta.status === 'learning') {
            addWordAndRescan(word, obj.meta.lookup_count);
          }
          continue;
        }
        // 2) 我们自定义的 error
        if (obj.error) {
          showError(`${t('lookup.error.prefix')}${obj.error}`);
          continue;
        }
        // 3) DeepSeek 的标准 chat completion chunk
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          contentBuffer += delta;
          receivedAnyContent = true;
          renderProgressive(contentBuffer, word);
        }
      }
    });

    port.postMessage({
      type: 'start',
      payload: {
        word,
        context,
        sourceUrl: location.href,
        pageTitle: document.title,
      },
    });
  }

  // ========== 双击/划词时自动跨连字符扩展 ==========
  // 浏览器双击以连字符为词边界（"no-brainer" 只选到 "no"）。
  // 这里在 selection 两端检查相邻字符是不是 [A-Za-z-]，是就吃进来；
  // 即使该词已被我们包成 vr-highlight span 也能跨 span 扩展。
  function expandHyphenated(selection) {
    const original = selection.toString().trim();
    if (!original) return original;
    if (selection.rangeCount === 0) return original;

    const range = selection.getRangeAt(0);

    // 上溯到最近的 block 父元素（跳过 inline span 包括我们的 vr-highlight）
    let block = range.commonAncestorContainer;
    if (block.nodeType !== Node.ELEMENT_NODE) block = block.parentNode;
    while (block && block.parentElement) {
      const display = getComputedStyle(block).display;
      if (display && !display.startsWith('inline')) break;
      block = block.parentElement;
    }
    if (!block) return original;

    // 算 selection 在 block.textContent 里的绝对偏移
    const preStart = document.createRange();
    preStart.selectNodeContents(block);
    try {
      preStart.setEnd(range.startContainer, range.startOffset);
    } catch { return original; }
    const startIdx = preStart.toString().length;

    const preEnd = document.createRange();
    preEnd.selectNodeContents(block);
    try {
      preEnd.setEnd(range.endContainer, range.endOffset);
    } catch { return original; }
    const endIdx = preEnd.toString().length;

    const fullText = block.textContent;
    let s = startIdx;
    let e = endIdx;
    if (s < 0 || e > fullText.length || s >= e) return original;

    // 两端扩展
    while (s > 0 && /[A-Za-z\-]/.test(fullText[s - 1])) s--;
    while (e < fullText.length && /[A-Za-z\-]/.test(fullText[e])) e++;
    // 修掉两端连字符
    while (s < e && fullText[s] === '-') s++;
    while (e > s && fullText[e - 1] === '-') e--;

    const expanded = fullText.slice(s, e).trim();
    // 防御：扩展结果绝对不能含空白；若 offset 错位导致跨空格，回退原始选区
    if (/\s/.test(expanded)) return original;
    return expanded || original;
  }

  // ========== 划词监听 ==========
  function onMouseUp(e) {
    // 点击在弹窗内不触发
    if (popupHost && popupHost.contains(e.target)) return;

    // 双击 = e.detail === 2；拖选 = e.detail === 1
    const isDoubleClick = e.detail === 2;

    // 节流到下一帧，等浏览器把 selection 状态稳定下来
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;

      // 先扩展再校验，"no-brainer" 这种通过双击也能查
      let text = expandHyphenated(sel);

      // 双击只允许单词。某些页面/字体/NBSP 会让浏览器把两个词当一个选中；
      // 这里只取第一个空白前的部分，避免把 "nails the" 这种存进库。
      if (isDoubleClick && /\s/.test(text)) {
        text = text.split(/\s+/)[0];
      }

      if (!text || text.length > MAX_WORD_LEN) return;
      if (!VALID_RE.test(text)) return;

      // 多词短语开关（连字符复合词不含空白，不受此约束）
      if (cachedSettings.translatePhrases === false && /\s/.test(text)) return;

      // 排除在 input/textarea/可编辑区/code/pre 里的选择
      const anchor = sel.anchorNode?.parentElement;
      if (!anchor) return;
      const blocked = anchor.closest('input, textarea, [contenteditable=""], [contenteditable="true"], code, pre');
      if (blocked) return;

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      const context = extractContextSentence(sel);
      startTranslate(text, context, rect);
    }, 0);
  }

  // 点击弹窗外关闭
  function onDocClick(e) {
    if (!popupHost) return;
    if (popupHost.contains(e.target)) return;
    // 如果点击恰好是新的划词，让 mouseup 处理；这里只在没有新选区时关闭
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    closePopup();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closePopup();
  }

  // ========== background 消息工具 ==========
  function callBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: 'no response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e.message || e) });
      }
    });
  }

  // ========== 状态机按钮：我认识了 / 完全掌握 ==========
  async function markStatus(targetStatus) {
    const word = currentWord;
    if (!word) { closePopup(); return; }
    closePopup();
    const resp = await callBackground({ type: 'updateWordStatus', word, status: targetStatus });
    if (resp?.ok) {
      removeHighlightsByWord(word);
    } else {
      console.warn(`[VocabRadar] PATCH ${targetStatus} failed:`, resp?.error);
    }
  }
  const onKnownClicked = () => markStatus('familiar');
  const onGraduatedClicked = () => markStatus('graduated');

  // 彻底删除：从 DB 删 word + 所有相关 lookup_events，并清当前页面高亮
  async function onDeleteClicked() {
    const word = currentWord;
    if (!word) { closePopup(); return; }
    closePopup();
    const resp = await callBackground({ type: 'deleteWord', word });
    if (resp?.ok) {
      removeHighlightsByWord(word);
    } else {
      console.warn('[VocabRadar] deleteWord failed:', resp?.error);
    }
  }

  // ========== 高亮词列表 ==========
  // 不做客户端缓存：本地后端 /words < 50ms，缓存反而让"刚学的新词不立即高亮"成为常见 bug。
  async function loadHighlightWords() {
    const resp = await callBackground({ type: 'getHighlightWords' });
    if (!resp?.ok) {
      console.warn('[VocabRadar] getHighlightWords failed:', resp?.error);
      return [];
    }
    return resp?.data?.highlight_words || [];
  }

  // ========== 高亮样式注入（页面级，不放 Shadow DOM 里）==========
  const HIGHLIGHT_CLASS = 'vr-highlight';
  function injectHighlightCss() {
    if (document.getElementById('vr-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'vr-highlight-style';
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        background-color: #FFF3B0 !important;
        border-radius: 2px;
        padding: 0 1px;
        cursor: help;
        box-decoration-break: clone;
      }
      .${HIGHLIGHT_CLASS}[data-vr-tier="hot"] {
        background-color: #FFD580 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ========== TreeWalker 扫描 + wrap ==========
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON',
    'CODE', 'PRE', 'KBD', 'SAMP',
  ]);

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function shouldSkipParent(el) {
    if (!el) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.classList && el.classList.contains(HIGHLIGHT_CLASS)) return true;
    if (el.id === 'vocab-radar-host') return true;
    // 检查祖先链
    if (el.closest && el.closest('#vocab-radar-host, code, pre, textarea, input, [contenteditable=""], [contenteditable="true"]')) return true;
    return false;
  }

  function highlightInTextNode(node, regex, lookupMap) {
    const text = node.nodeValue;
    regex.lastIndex = 0;
    if (!regex.test(text)) return;
    regex.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      const matched = m[0];
      const key = matched.toLowerCase();
      const span = document.createElement('span');
      span.className = HIGHLIGHT_CLASS;
      span.dataset.vrWord = key;
      const count = lookupMap[key] || 1;
      if (count >= 3) span.dataset.vrTier = 'hot';
      span.textContent = matched;
      frag.appendChild(span);
      lastIdx = m.index + matched.length;
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    node.parentNode.replaceChild(frag, node);
  }

  // 当前 active 的扫描上下文（init 后保留，给 MutationObserver 用）
  let scanContext = null;
  let mutationObserver = null;

  function buildScanContext(words) {
    const lookupMap = Object.create(null);
    const translationMap = Object.create(null);
    for (const w of words) {
      const key = w.word.toLowerCase();
      lookupMap[key] = w.lookup_count;
      const def = parseDefinition(w.translation);
      if (def) translationMap[key] = def;
    }
    const sortedWords = words.map((w) => w.word).sort((a, b) => b.length - a.length);
    const pattern = '\\b(' + sortedWords.map(escapeRegex).join('|') + ')\\b';
    return { regex: new RegExp(pattern, 'gi'), lookupMap, translationMap };
  }

  // 从存的 JSON 字符串里只挑 definition，作为 hover 简短释义
  function parseDefinition(translationJson) {
    if (!translationJson) return null;
    try {
      const obj = JSON.parse(translationJson);
      return typeof obj?.definition === 'string' ? obj.definition : null;
    } catch { return null; }
  }

  function scanRoot(root, ctx) {
    if (!root || !ctx) return 0;
    const { regex, lookupMap } = ctx;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 2) return NodeFilter.FILTER_REJECT;
        if (shouldSkipParent(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      regex.lastIndex = 0;
      if (regex.test(n.nodeValue)) targets.push(n);
    }
    if (targets.length === 0) return 0;
    // 写 DOM 期间临时停用观察器，避免我们自己的 replaceChild 触发再调度
    if (mutationObserver) mutationObserver.disconnect();
    for (const node of targets) highlightInTextNode(node, regex, lookupMap);
    if (mutationObserver) mutationObserver.observe(document.body, { childList: true, subtree: true });
    return targets.length;
  }

  function scanAndHighlight(words) {
    if (!words || words.length === 0) return 0;
    scanContext = buildScanContext(words);
    return scanRoot(document.body, scanContext);
  }

  // 把刚翻译完的词加入当前 scanContext 并立刻扫一次页面 —— 不用等刷新就能高亮
  function addWordAndRescan(word, lookupCount) {
    if (!word) return;
    const key = word.toLowerCase();
    if (!scanContext) {
      scanContext = buildScanContext([{ word, lookup_count: lookupCount }]);
    } else {
      scanContext.lookupMap[key] = lookupCount;
      const allWords = Object.keys(scanContext.lookupMap).sort((a, b) => b.length - a.length);
      const pattern = '\\b(' + allWords.map(escapeRegex).join('|') + ')\\b';
      scanContext.regex = new RegExp(pattern, 'gi');
    }
    scanRoot(document.body, scanContext);
  }

  // 流式解析中拿到 definition 后立即写进 translationMap，hover 同会话即可生效
  function setLiveTranslation(word, definition) {
    if (!word || !definition) return;
    if (!scanContext) return;
    scanContext.translationMap = scanContext.translationMap || Object.create(null);
    scanContext.translationMap[word.toLowerCase()] = definition;
  }

  // ========== MutationObserver：SPA 后续渲染的内容也要扫到 ==========
  let pendingNodes = new Set();
  let scanScheduled = false;

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    // 用 rAF + 50ms 简单 throttle，避免 React 大量挂载时把主线程压垮
    setTimeout(() => {
      requestAnimationFrame(() => {
        scanScheduled = false;
        if (!scanContext) return;
        const nodes = Array.from(pendingNodes);
        pendingNodes.clear();
        for (const node of nodes) {
          if (node && node.isConnected) scanRoot(node, scanContext);
        }
      });
    }, 50);
  }

  function startMutationObserver() {
    mutationObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) {
            if (added.id === 'vocab-radar-host') continue;
            if (added.classList && added.classList.contains(HIGHLIGHT_CLASS)) continue;
            pendingNodes.add(added);
          } else if (added.nodeType === Node.TEXT_NODE && added.parentElement) {
            pendingNodes.add(added.parentElement);
          }
        }
      }
      if (pendingNodes.size > 0) scheduleScan();
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function removeHighlightsByWord(word) {
    const key = word.toLowerCase();
    const spans = document.querySelectorAll(`span.${HIGHLIGHT_CLASS}[data-vr-word="${CSS.escape(key)}"]`);
    spans.forEach((s) => {
      const t = document.createTextNode(s.textContent);
      s.parentNode.replaceChild(t, s);
    });
    hideTooltip();
    // 同步从 scanContext 中也移除，避免 MutationObserver 后续重扫又把它包回去
    if (scanContext) {
      delete scanContext.lookupMap[key];
      delete (scanContext.translationMap || {})[key];
      const remaining = Object.keys(scanContext.lookupMap);
      if (remaining.length === 0) {
        scanContext = null;
      } else {
        const sorted = remaining.sort((a, b) => b.length - a.length);
        scanContext.regex = new RegExp('\\b(' + sorted.map(escapeRegex).join('|') + ')\\b', 'gi');
      }
    }
  }

  // ========== Hover tooltip ==========
  let tooltipHost = null;
  let tooltipRoot = null;
  let tooltipTimer = null;
  let tooltipActiveEl = null;

  function ensureTooltip() {
    if (tooltipHost && document.body.contains(tooltipHost)) return;
    tooltipHost = document.createElement('div');
    tooltipHost.id = 'vocab-radar-tooltip-host';
    tooltipHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; pointer-events: none; opacity: 0; transition: opacity .12s ease;';
    tooltipRoot = tooltipHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .tt {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 12px;
        line-height: 1.45;
        background: rgba(28,28,30,0.95);
        color: #fff;
        padding: 6px 10px;
        border-radius: 6px;
        max-width: 320px;
        white-space: normal;
        word-wrap: break-word;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      }
    `;
    tooltipRoot.appendChild(style);
    const tt = document.createElement('div');
    tt.className = 'tt';
    tt.textContent = '';
    tooltipRoot.appendChild(tt);
    document.documentElement.appendChild(tooltipHost);
  }

  function hideTooltip() {
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    if (tooltipHost) tooltipHost.style.opacity = '0';
    tooltipActiveEl = null;
  }

  function showTooltipAt(highlightEl) {
    if (!scanContext?.translationMap) return;
    const word = highlightEl.dataset.vrWord;
    if (!word) return;
    const def = scanContext.translationMap[word];
    if (!def) return;  // 老词还没补 translation —— 不弹

    ensureTooltip();
    tooltipRoot.querySelector('.tt').textContent = def;

    // 先显示一下让浏览器算尺寸，再修位置
    tooltipHost.style.left = '0px';
    tooltipHost.style.top = '-9999px';
    tooltipHost.style.opacity = '1';

    const rect = highlightEl.getBoundingClientRect();
    const ttRect = tooltipHost.getBoundingClientRect();
    const margin = 6;
    let left = rect.left + (rect.width - ttRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - ttRect.width - 8));
    let top = rect.top - ttRect.height - margin;
    if (top < 8) top = rect.bottom + margin;  // 顶部不够就放下面
    tooltipHost.style.left = `${left}px`;
    tooltipHost.style.top = `${top}px`;
  }

  function onHoverEnter(e) {
    const el = e.target.closest && e.target.closest('.' + HIGHLIGHT_CLASS);
    if (!el) return;
    if (el === tooltipActiveEl) return;
    if (tooltipTimer) clearTimeout(tooltipTimer);
    tooltipActiveEl = el;
    tooltipTimer = setTimeout(() => {
      if (tooltipActiveEl === el && document.body.contains(el)) showTooltipAt(el);
    }, 300);
  }

  function onHoverLeave(e) {
    const el = e.target.closest && e.target.closest('.' + HIGHLIGHT_CLASS);
    if (!el) return;
    // 鼠标仍在同一个高亮内就不隐
    const rel = e.relatedTarget;
    if (rel && rel.closest && rel.closest('.' + HIGHLIGHT_CLASS) === el) return;
    if (tooltipActiveEl === el) hideTooltip();
  }

  // ========== 设置同步 ==========
  async function loadCachedSettings() {
    const resp = await callBackground({ type: 'getSettings' });
    if (resp?.ok && resp.data) cachedSettings = { ...cachedSettings, ...resp.data };
  }
  // popup 改设置时实时同步进 content.js（settings.js 用 vr_settings_v1 这个 key）
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const c = changes['vr_settings_v1'];
      if (c && c.newValue) cachedSettings = { ...cachedSettings, ...c.newValue };
    });
  } catch (_) {}

  // ========== 初始化 ==========
  async function init() {
    injectHighlightCss();
    // 翻译表 + 设置同步并行启动；高亮扫描不等它们
    loadTranslationsCS();
    loadCachedSettings();
    try {
      const words = await loadHighlightWords();
      const count = scanAndHighlight(words);
      console.log(`[VocabRadar] 初次扫描：${words.length} 个高亮词，命中 ${count} 个文本节点`);

      // SPA 内容延迟挂载兜底：500ms / 1500ms / 3500ms 各兜一次（针对 React/Vue 慢速渲染）
      if (scanContext) {
        for (const delay of [500, 1500, 3500]) {
          setTimeout(() => scanRoot(document.body, scanContext), delay);
        }
        startMutationObserver();
      }
    } catch (e) {
      console.warn('[VocabRadar] init failed:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    // content_scripts run_at=document_idle，多数情况进这分支
    init();
  }

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onDocClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  // hover tooltip：mouseover/mouseout 用冒泡，靠 closest 委托到 .vr-highlight
  document.addEventListener('mouseover', onHoverEnter, true);
  document.addEventListener('mouseout', onHoverLeave, true);
})();
