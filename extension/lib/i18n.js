// VocabRadar - i18n loader
// 通过 fetch 读取 lib/translations.json；module 和 content script 都能用同样路径。

let cache = null;

export async function loadTranslations() {
  if (cache) return cache;
  const url = chrome.runtime.getURL('lib/translations.json');
  const resp = await fetch(url);
  cache = await resp.json();
  return cache;
}

// t(translations, key, lang, params?)
// translations: 上面 loadTranslations() 返回的对象
// key: 'lookup.label.definition' 之类
// lang: 'zh' / 'en' / ...
// params: 可选；用于 '{n}' 这种插值
export function t(translations, key, lang, params) {
  if (!translations) return key;
  const entry = translations[key];
  if (!entry) return key; // missing key -> 返回 key 名作为 fallback
  let s = entry[lang] || entry['en'] || entry['zh'] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

// 快捷方法：返回一个 t(key, params?) 函数，闭包了 translations + lang
export function makeT(translations, lang) {
  return (key, params) => t(translations, key, lang, params);
}
