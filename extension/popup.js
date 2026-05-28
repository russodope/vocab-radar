// VocabRadar - popup
// 1) 词汇统计  2) BYOK key 输入 + 测试  3) 7×7 语言对  4) i18n 跟 targetLang 走

import { loadTranslations, makeT } from './lib/i18n.js';

const $ = (id) => document.getElementById(id);
let _t = (k) => k; // 占位，loadSettings 后替换为真正的 t()

const $banner = $('noKeyBanner');
const $totalNum = $('totalNum');
const $learning = $('learning');
const $familiar = $('familiar');
const $graduated = $('graduated');
const $highlightNum = $('highlightNum');
const $todayNum = $('todayNum');
const $btnRefresh = $('btnRefresh');
const $apiKey = $('apiKey');
const $btnTest = $('btnTest');
const $keyStatus = $('keyStatus');
const $sourceLang = $('sourceLang');
const $targetLang = $('targetLang');
const $translatePhrases = $('translatePhrases');
const $btnExport = $('btnExport');
const $btnImport = $('btnImport');
const $importFile = $('importFile');
const $backupStatus = $('backupStatus');

let supportedLangs = [];
let currentSettings = null;
let savedKey = ''; // 真实 key，不在 UI 显示，只在 testKey 用

function send(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp) => resolve(resp));
  });
}

function maskedDisplay(key) {
  if (!key) return '';
  if (key.length <= 12) return '************';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function setKeyStatus(text, kind) {
  if (!text) { $keyStatus.hidden = true; return; }
  $keyStatus.hidden = false;
  $keyStatus.textContent = text;
  $keyStatus.className = 'status-msg ' + (kind || '');
}

function fillLangSelect(sel, current) {
  sel.innerHTML = '';
  for (const l of supportedLangs) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.label;
    if (l.code === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadStats() {
  for (const el of [$totalNum, $learning, $familiar, $graduated, $todayNum, $highlightNum]) {
    el.innerHTML = '<span class="skeleton"></span>';
  }
  const stats = await send('getStats');
  if (stats?.ok) {
    const d = stats.data;
    $totalNum.textContent = d.total;
    $learning.textContent = d.learning;
    $familiar.textContent = d.familiar;
    $graduated.textContent = d.graduated;
    $todayNum.textContent = d.looked_up_today;
  }
  const words = await send('getHighlightWords');
  $highlightNum.textContent = words?.ok ? (words.data?.highlight_words || []).length : '—';
}

async function loadSettings() {
  const resp = await send('getSettings');
  if (!resp?.ok) {
    setKeyStatus(_t('popup.key.empty') || 'failed to load settings', 'err');
    return;
  }
  currentSettings = resp.data;
  supportedLangs = resp.supportedLangs || [];
  savedKey = currentSettings.apiKey || '';

  // i18n：先加载翻译表 → 重建 _t() → 给所有 data-i18n 元素填上对应语言文本
  try {
    const translations = await loadTranslations();
    _t = makeT(translations, currentSettings.targetLang || 'zh');
    applyI18n();
  } catch (e) {
    console.warn('[VocabRadar] i18n load failed, falling back to default text', e);
  }

  // key 输入框：有 key 时展示掩码占位（实际 value 留空，避免泄露原文回到 DOM）
  if (savedKey) {
    $apiKey.placeholder = maskedDisplay(savedKey) + ' ' + _t('popup.key.savedReplaceHint');
    $banner.hidden = true;
  } else {
    $apiKey.placeholder = 'sk-...';
    $banner.hidden = false;
  }
  $apiKey.value = '';

  fillLangSelect($sourceLang, currentSettings.sourceLang);
  fillLangSelect($targetLang, currentSettings.targetLang);
  $translatePhrases.checked = currentSettings.translatePhrases !== false;
}

// 把所有带 data-i18n 的元素 textContent 替换成对应翻译；data-i18n-html 用 innerHTML
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = _t(key);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    el.innerHTML = _t(key);
  });
}

// 输入框失焦自动保存
async function maybeSaveKey() {
  const newKey = $apiKey.value.trim();
  if (!newKey) return; // 空输入不动现有 key
  if (newKey === savedKey) return;
  await send('saveSettings', { patch: { apiKey: newKey } });
  savedKey = newKey;
  $apiKey.value = '';
  $apiKey.placeholder = maskedDisplay(savedKey) + ' ' + _t('popup.key.savedShort');
  $banner.hidden = true;
  setKeyStatus(_t('popup.key.savedShort'), 'ok');
  setTimeout(() => setKeyStatus(''), 1500);
}

$apiKey.addEventListener('blur', maybeSaveKey);
$apiKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); maybeSaveKey(); }
});

$btnTest.addEventListener('click', async () => {
  const candidate = $apiKey.value.trim() || savedKey;
  if (!candidate) {
    setKeyStatus(_t('popup.key.empty'), 'err');
    return;
  }
  $btnTest.disabled = true;
  setKeyStatus(_t('popup.key.testing'), '');
  // 测试用临时 patch；通过后才写盘
  const r = await send('testApiKey', { patch: { apiKey: candidate } });
  if (r?.ok) {
    // 校验成功，写盘
    if (candidate !== savedKey) {
      await send('saveSettings', { patch: { apiKey: candidate } });
      savedKey = candidate;
      $apiKey.value = '';
      $apiKey.placeholder = maskedDisplay(savedKey) + ' ' + _t('popup.key.savedShort');
      $banner.hidden = true;
    }
    setKeyStatus(_t('popup.key.valid'), 'ok');
  } else {
    setKeyStatus('✗ ' + (r?.error || ''), 'err');
  }
  $btnTest.disabled = false;
});

$sourceLang.addEventListener('change', async () => {
  await send('saveSettings', { patch: { sourceLang: $sourceLang.value } });
});
$targetLang.addEventListener('change', async () => {
  await send('saveSettings', { patch: { targetLang: $targetLang.value } });
  // 立即重新应用 i18n，让 popup UI 跟着切语言
  try {
    const translations = await loadTranslations();
    _t = makeT(translations, $targetLang.value);
    applyI18n();
    if (savedKey) {
      $apiKey.placeholder = maskedDisplay(savedKey) + ' ' + _t('popup.key.savedReplaceHint');
    }
  } catch (_) {}
});

$translatePhrases.addEventListener('change', async () => {
  await send('saveSettings', { patch: { translatePhrases: $translatePhrases.checked } });
});

$btnRefresh.addEventListener('click', loadStats);

// ====== 备份与迁移 ======

function setBackupStatus(text, kind) {
  if (!text) { $backupStatus.hidden = true; return; }
  $backupStatus.hidden = false;
  $backupStatus.textContent = text;
  $backupStatus.className = 'status-msg ' + (kind || '');
}

$btnExport.addEventListener('click', async () => {
  $btnExport.disabled = true;
  setBackupStatus('', '');
  try {
    const resp = await send('exportAll');
    if (!resp?.ok) {
      setBackupStatus(_t('popup.backup.exportFailed') + ': ' + (resp?.error || ''), 'err');
      return;
    }
    const blob = new Blob([JSON.stringify(resp.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vocab-radar-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    // 刷新统计（导出本身不改数据，但用户看见数字提醒自己刚操作）
    loadStats();
  } catch (e) {
    setBackupStatus(_t('popup.backup.exportFailed') + ': ' + (e.message || e), 'err');
  } finally {
    $btnExport.disabled = false;
  }
});

$btnImport.addEventListener('click', () => $importFile.click());

$importFile.addEventListener('change', async () => {
  const file = $importFile.files?.[0];
  if (!file) return;
  $btnImport.disabled = true;
  setBackupStatus('', '');
  try {
    const text = await file.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch { setBackupStatus(_t('popup.backup.invalidFile'), 'err'); return; }
    if (!payload || !Array.isArray(payload.words)) {
      setBackupStatus(_t('popup.backup.invalidFile'), 'err');
      return;
    }
    const resp = await send('importAll', { payload });
    if (!resp?.ok) {
      setBackupStatus(_t('popup.backup.importFailed') + ': ' + (resp?.error || ''), 'err');
      return;
    }
    const { imported_words, imported_events } = resp.data || {};
    setBackupStatus(
      _t('popup.backup.imported', { words: imported_words || 0, events: imported_events || 0 }),
      'ok',
    );
    // 重新拉统计反映导入后的状态
    loadStats();
  } catch (e) {
    setBackupStatus(_t('popup.backup.importFailed') + ': ' + (e.message || e), 'err');
  } finally {
    $btnImport.disabled = false;
    $importFile.value = '';  // 允许再次选同一个文件
  }
});

(async function main() {
  await loadSettings();
  await loadStats();
})();
