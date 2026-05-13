// VocabRadar - IndexedDB layer
// 替代原 SQLite 后端。两个 store 镜像 SQLAlchemy 模型：
//   words:           keyPath='word', 唯一；带 status / lookup_count 索引
//   lookup_events:   autoIncrement id；带 word / created_at 索引

const DB_NAME = 'vocab_radar';
const DB_VERSION = 1;

let _dbPromise = null;

export function getDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('words')) {
        const w = db.createObjectStore('words', { keyPath: 'word' });
        w.createIndex('status', 'status', { unique: false });
        w.createIndex('lookup_count', 'lookup_count', { unique: false });
        w.createIndex('last_seen_at', 'last_seen_at', { unique: false });
      }
      if (!db.objectStoreNames.contains('lookup_events')) {
        const e2 = db.createObjectStore('lookup_events', { keyPath: 'id', autoIncrement: true });
        e2.createIndex('word', 'word', { unique: false });
        e2.createIndex('created_at', 'created_at', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
  return _dbPromise;
}

// 把 IDB 请求 promisify
function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

const nowIso = () => new Date().toISOString();
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ---- log_lookup_event: 写一条事件，不等 LLM
export async function logLookupEvent({ word, context, sourceUrl, pageTitle }) {
  const db = await getDb();
  const tx = db.transaction(['lookup_events'], 'readwrite');
  tx.objectStore('lookup_events').add({
    word,
    context_sentence: context || null,
    source_url: sourceUrl || null,
    page_title: pageTitle || null,
    created_at: nowIso(),
  });
  await txDone(tx);
}

// ---- upsert_word: 单事务 read-modify-write
// 返回：(status, lookup_count, cachedTranslation, cachedTranslationLang, demoted)
//   demoted: true 表示这次 upsert 把 familiar/graduated 自动降级回了 learning
//
// 状态机自动降级：familiar / graduated 状态的词如果被用户再次查询，强信号说明没真掌握，
// 自动 demote 回 learning。delete（"不用记"）的词由于走 deleteWord 已经完全删除，
// 这里看到的就是 existing=null 的全新词，不会触发降级。
export async function upsertWord({ word, context, sourceUrl }) {
  const db = await getDb();
  const tx = db.transaction(['words'], 'readwrite');
  const store = tx.objectStore('words');
  const existing = await reqAsPromise(store.get(word));
  let row;
  let demoted = false;
  if (existing) {
    let newStatus = existing.status;
    if (existing.status === 'familiar' || existing.status === 'graduated') {
      newStatus = 'learning';
      demoted = true;
    }
    row = {
      ...existing,
      status: newStatus,
      lookup_count: (existing.lookup_count || 0) + 1,
      last_seen_at: nowIso(),
      last_context: context || existing.last_context || null,
      last_source_url: sourceUrl || existing.last_source_url || null,
    };
  } else {
    row = {
      word,
      translation: null,
      status: 'learning',
      lookup_count: 1,
      first_seen_at: nowIso(),
      last_seen_at: nowIso(),
      last_context: context || null,
      last_source_url: sourceUrl || null,
    };
  }
  store.put(row);
  await txDone(tx);
  return {
    status: row.status,
    lookup_count: row.lookup_count,
    cachedTranslation: existing?.translation || null,
    cachedTranslationLang: existing?.translation_lang || null,
    demoted,
  };
}

// ---- save_translation: 翻译流结束后存进 words.translation + 语言标记
export async function saveTranslation(word, translationJson, targetLang) {
  const db = await getDb();
  const tx = db.transaction(['words'], 'readwrite');
  const store = tx.objectStore('words');
  const existing = await reqAsPromise(store.get(word));
  if (!existing) return;
  store.put({
    ...existing,
    translation: translationJson,
    translation_lang: targetLang || null,
  });
  await txDone(tx);
}

// ---- list_learning_words: 用于高亮扫描
export async function listLearningWords() {
  const db = await getDb();
  const tx = db.transaction(['words'], 'readonly');
  const store = tx.objectStore('words');
  const idx = store.index('status');
  const rows = await reqAsPromise(idx.getAll('learning'));
  rows.sort((a, b) => (b.lookup_count || 0) - (a.lookup_count || 0));
  return rows.map((r) => ({
    word: r.word,
    lookup_count: r.lookup_count || 0,
    translation: r.translation || null,
  }));
}

// ---- update_word_status
export async function updateWordStatus(word, status) {
  if (!['learning', 'familiar', 'graduated'].includes(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const db = await getDb();
  const tx = db.transaction(['words'], 'readwrite');
  const store = tx.objectStore('words');
  const existing = await reqAsPromise(store.get(word));
  if (!existing) {
    await txDone(tx);
    return null;
  }
  const updated = { ...existing, status };
  store.put(updated);
  await txDone(tx);
  return { word, status, lookup_count: updated.lookup_count };
}

// ---- delete_word: 把这个词从 words + 所有相关 lookup_events 里清干净
export async function deleteWord(word) {
  const db = await getDb();
  const tx = db.transaction(['words', 'lookup_events'], 'readwrite');
  tx.objectStore('words').delete(word);
  // lookup_events 用 word index 拿到所有事件，逐个 cursor.delete()
  const idx = tx.objectStore('lookup_events').index('word');
  const cursorReq = idx.openCursor(IDBKeyRange.only(word));
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  await txDone(tx);
}

// ---- get_stats
export async function getStats() {
  const db = await getDb();
  const tx = db.transaction(['words', 'lookup_events'], 'readonly');
  const wordsStore = tx.objectStore('words');
  const allWords = await reqAsPromise(wordsStore.getAll());
  const counts = { learning: 0, familiar: 0, graduated: 0 };
  for (const w of allWords) {
    if (counts[w.status] !== undefined) counts[w.status]++;
  }

  // 今日查询次数：lookup_events 中 created_at 落在本地"今天"的事件数
  const events = await reqAsPromise(tx.objectStore('lookup_events').getAll());
  const today = localDateKey(new Date());
  let todayCount = 0;
  for (const e of events) {
    if (localDateKey(new Date(e.created_at)) === today) todayCount++;
  }

  return {
    total: counts.learning + counts.familiar + counts.graduated,
    learning: counts.learning,
    familiar: counts.familiar,
    graduated: counts.graduated,
    looked_up_today: todayCount,
  };
}

// ---- 数据导入/导出（备份用，CLI 测试也方便）
export async function exportAll() {
  const db = await getDb();
  const tx = db.transaction(['words', 'lookup_events'], 'readonly');
  const words = await reqAsPromise(tx.objectStore('words').getAll());
  const events = await reqAsPromise(tx.objectStore('lookup_events').getAll());
  return { version: 1, exported_at: nowIso(), words, lookup_events: events };
}

export async function importAll(payload) {
  if (!payload || !Array.isArray(payload.words)) throw new Error('invalid payload');
  const db = await getDb();
  const tx = db.transaction(['words', 'lookup_events'], 'readwrite');
  // 不清空现有数据；按 word 去重 merge（已存在的累加 lookup_count 会复杂，先策略：以导入的为准覆盖）
  for (const w of payload.words) tx.objectStore('words').put(w);
  for (const e of payload.lookup_events || []) {
    const { id, ...rest } = e; // 让 autoIncrement 重新分配 id
    tx.objectStore('lookup_events').add(rest);
  }
  await txDone(tx);
  return { imported_words: payload.words.length, imported_events: (payload.lookup_events || []).length };
}
