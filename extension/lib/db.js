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

// ---- upsert_word: 单事务 read-modify-write，原子拿回 (status, lookup_count)
export async function upsertWord({ word, context, sourceUrl }) {
  const db = await getDb();
  const tx = db.transaction(['words'], 'readwrite');
  const store = tx.objectStore('words');
  const existing = await reqAsPromise(store.get(word));
  let row;
  if (existing) {
    row = {
      ...existing,
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
  return { status: row.status, lookup_count: row.lookup_count };
}

// ---- save_translation: 翻译流结束后存进 words.translation
export async function saveTranslation(word, translationJson) {
  const db = await getDb();
  const tx = db.transaction(['words'], 'readwrite');
  const store = tx.objectStore('words');
  const existing = await reqAsPromise(store.get(word));
  if (!existing) return; // upsert 没走完就不存（理论上不该发生）
  store.put({ ...existing, translation: translationJson });
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
