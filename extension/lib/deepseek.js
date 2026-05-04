// VocabRadar - DeepSeek API client (直调 https://api.deepseek.com)
//
// 安全约束（重要）：
// 1. apiKey 只能通过 settings.js 读取，不缓存到任何地方
// 2. 永不打印 apiKey 到 console
// 3. 请求 URL 强制校验在 apiBaseUrl 下，不允许任意目标
// 4. 流式响应直接透传给调用方，由其包成 SSE 转发给 content.js

import { langDisplayName } from './settings.js';

function buildPrompt(word, context, sourceLang, targetLang) {
  const src = langDisplayName(sourceLang);
  const tgt = langDisplayName(targetLang);
  // !!! 注意：保持 system message 与 user prompt 前缀稳定，命中 DeepSeek 的 prompt cache
  return (
    `用户正在阅读${src}网页，遇到不认识的词。请用${tgt}返回：\n` +
    `1. 词性 + ${tgt}释义（简洁，1-2个含义即可）\n` +
    `2. 这个词在当前句子里的具体含义（结合上下文）\n` +
    `3. 一个帮助记忆的例句（贴近科技/互联网场景）\n\n` +
    `词: ${word}\n` +
    `原句: ${context}\n\n` +
    `以 JSON 格式返回，字段顺序固定如下（definition 必须是第一个字段）：\n` +
    `{"definition": "...", "in_context": "...", "example": "..."}`
  );
}

const SYSTEM_PROMPT = '你是一个专业的语言词汇助教，输出严格 JSON。';

function assertValidUrl(url, base) {
  // 防御性：发出去的 URL 必须以可信 base 开头
  try {
    const u = new URL(url);
    const b = new URL(base);
    if (u.origin !== b.origin) {
      throw new Error(`refused to call non-deepseek origin: ${u.origin}`);
    }
  } catch (e) {
    throw new Error(`invalid URL: ${e.message}`);
  }
}

// 测一次最便宜的请求：只要 200 + JSON 即认为 key 有效
export async function testApiKey({ apiKey, apiBaseUrl, model }) {
  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  assertValidUrl(url, apiBaseUrl);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
      thinking: { type: 'disabled' },
    }),
  });
  if (resp.status === 401) return { ok: false, error: 'API key 无效或已撤销' };
  if (resp.status === 402) return { ok: false, error: '账户余额不足' };
  if (resp.status === 429) return { ok: false, error: '触发限流，稍后再试' };
  if (!resp.ok) {
    const t = await resp.text();
    return { ok: false, error: `HTTP ${resp.status}: ${t.slice(0, 120)}` };
  }
  return { ok: true };
}

// 流式翻译：返回一个 ReadableStream-like 异步迭代器，逐行 yield 原始 SSE 文本（"data: ..." 单行）
export async function* streamTranslate({ word, context, settings }) {
  const { apiKey, apiBaseUrl, model, sourceLang, targetLang } = settings;
  if (!apiKey) throw new Error('未设置 DeepSeek API key');

  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  assertValidUrl(url, apiBaseUrl);

  const payload = {
    model,
    stream: true,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(word, context || '', sourceLang, targetLang) },
    ],
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`DeepSeek HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }

  // 按行解析 SSE
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 留下不完整的最后一行
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.startsWith('data:')) continue;
      yield line; // "data: {...}"  或  "data: [DONE]"
    }
  }
  if (buffer.trim().startsWith('data:')) yield buffer.trim();
}
