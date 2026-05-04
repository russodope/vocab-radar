// VocabRadar - first-run onboarding
const $apiKey = document.getElementById('apiKey');
const $btnSave = document.getElementById('btnSave');
const $status = document.getElementById('status');
const $nextStep = document.getElementById('nextStep');

function send(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp) => resolve(resp));
  });
}
function setStatus(text, kind) {
  $status.textContent = text || '';
  $status.className = 'status ' + (kind || '');
}

$btnSave.addEventListener('click', async () => {
  const key = $apiKey.value.trim();
  if (!key) { setStatus('请先粘贴 key', 'err'); return; }
  $btnSave.disabled = true;
  setStatus('正在校验...', '');
  const r = await send('testApiKey', { patch: { apiKey: key } });
  if (r?.ok) {
    await send('saveSettings', { patch: { apiKey: key } });
    setStatus('✓ key 有效，已保存', 'ok');
    $apiKey.value = '';
    $apiKey.placeholder = 'sk-***（已保存）';
    $nextStep.hidden = false;
  } else {
    setStatus('✗ ' + (r?.error || '未知错误'), 'err');
  }
  $btnSave.disabled = false;
});

$apiKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $btnSave.click(); }
});
