// VocabRadar - settings (BYOK key + 语言对) on chrome.storage.local

// chrome.storage.local 是扩展私有；其他扩展/网页脚本读不到。
// !!! API key 不打印到 console；UI 显示走 maskKey() 掩码。

const STORAGE_KEY = 'vr_settings_v1';

const SUPPORTED_LANGS = [
  { code: 'en',     label: 'English' },
  { code: 'zh',     label: '中文' },
  { code: 'ja',     label: '日本語' },
  { code: 'ko',     label: '한국어' },
  { code: 'fr',     label: 'Français' },
  { code: 'de',     label: 'Deutsch' },
  { code: 'es',     label: 'Español' },
];

const DEFAULTS = {
  apiKey: '',
  apiBaseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  sourceLang: 'en',
  targetLang: 'zh',
};

export { SUPPORTED_LANGS };

export async function getSettings() {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  const stored = obj[STORAGE_KEY] || {};
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

// 安全展示给 UI 用：sk-abcd...wxyz 只露头尾
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '***';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// 永远不要写 console.log(key)。这个函数刻意只回长度 + 掩码。
export function describeKeyForLog(key) {
  if (!key) return '<empty>';
  return `<key len=${key.length} masked=${maskKey(key)}>`;
}

// 语言 code → 在 prompt 里使用的可读名称（中文）
export function langDisplayName(code) {
  const m = {
    en: '英文', zh: '中文', ja: '日文', ko: '韩文',
    fr: '法文', de: '德文', es: '西班牙文',
  };
  return m[code] || code;
}
