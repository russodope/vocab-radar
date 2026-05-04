// VocabRadar - popup
// 1) 词汇统计  2) BYOK key 输入 + 测试  3) 7×7 语言对

const $ = (id) => document.getElementById(id);

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
    setKeyStatus('读取设置失败', 'err');
    return;
  }
  currentSettings = resp.data;
  supportedLangs = resp.supportedLangs || [];
  savedKey = currentSettings.apiKey || '';

  // key 输入框：有 key 时展示掩码占位（实际 value 留空，避免泄露原文回到 DOM）
  if (savedKey) {
    $apiKey.placeholder = maskedDisplay(savedKey) + '（已保存，重新粘贴可替换）';
    $banner.hidden = true;
  } else {
    $apiKey.placeholder = 'sk-...';
    $banner.hidden = false;
  }
  $apiKey.value = '';

  fillLangSelect($sourceLang, currentSettings.sourceLang);
  fillLangSelect($targetLang, currentSettings.targetLang);
}

// 输入框失焦自动保存
async function maybeSaveKey() {
  const newKey = $apiKey.value.trim();
  if (!newKey) return; // 空输入不动现有 key
  if (newKey === savedKey) return;
  await send('saveSettings', { patch: { apiKey: newKey } });
  savedKey = newKey;
  $apiKey.value = '';
  $apiKey.placeholder = maskedDisplay(savedKey) + '（已保存）';
  $banner.hidden = true;
  setKeyStatus('已保存', 'ok');
  setTimeout(() => setKeyStatus(''), 1500);
}

$apiKey.addEventListener('blur', maybeSaveKey);
$apiKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); maybeSaveKey(); }
});

$btnTest.addEventListener('click', async () => {
  const candidate = $apiKey.value.trim() || savedKey;
  if (!candidate) {
    setKeyStatus('请先粘贴 key', 'err');
    return;
  }
  $btnTest.disabled = true;
  setKeyStatus('正在校验...', '');
  // 测试用临时 patch；通过后才写盘
  const r = await send('testApiKey', { patch: { apiKey: candidate } });
  if (r?.ok) {
    // 校验成功，写盘
    if (candidate !== savedKey) {
      await send('saveSettings', { patch: { apiKey: candidate } });
      savedKey = candidate;
      $apiKey.value = '';
      $apiKey.placeholder = maskedDisplay(savedKey) + '（已保存）';
      $banner.hidden = true;
    }
    setKeyStatus('✓ key 有效', 'ok');
  } else {
    setKeyStatus('✗ ' + (r?.error || '未知错误'), 'err');
  }
  $btnTest.disabled = false;
});

$sourceLang.addEventListener('change', async () => {
  await send('saveSettings', { patch: { sourceLang: $sourceLang.value } });
});
$targetLang.addEventListener('change', async () => {
  await send('saveSettings', { patch: { targetLang: $targetLang.value } });
});

$btnRefresh.addEventListener('click', loadStats);

(async function main() {
  await loadSettings();
  await loadStats();
})();
