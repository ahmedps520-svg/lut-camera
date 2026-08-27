/**
 * IndexedDB — imported LUTs and captured shots live entirely on the device.
 * Nothing is uploaded anywhere; there is no server in this app.
 */
const DB_NAME = 'luma';
const DB_VERSION = 1;
const STORE_LUTS = 'luts';
const STORE_SHOTS = 'shots';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LUTS)) {
        db.createObjectStore(STORE_LUTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SHOTS)) {
        const s = db.createObjectStore(STORE_SHOTS, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let out;
    try { out = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/* ── LUTs ─────────────────────────────────────────────────── */

export async function saveLut(entry) {
  await tx(STORE_LUTS, 'readwrite', (os) => os.put(entry));
  return entry;
}

export async function allLuts() {
  const db = await open();
  return req(db.transaction(STORE_LUTS).objectStore(STORE_LUTS).getAll());
}

export async function deleteLut(id) {
  await tx(STORE_LUTS, 'readwrite', (os) => os.delete(id));
}

/* ── Shots ────────────────────────────────────────────────── */

export async function saveShot(shot) {
  await tx(STORE_SHOTS, 'readwrite', (os) => os.put(shot));
  return shot;
}

export async function allShots() {
  const db = await open();
  const list = await req(db.transaction(STORE_SHOTS).objectStore(STORE_SHOTS).getAll());
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getShot(id) {
  const db = await open();
  return req(db.transaction(STORE_SHOTS).objectStore(STORE_SHOTS).get(id));
}

export async function deleteShot(id) {
  await tx(STORE_SHOTS, 'readwrite', (os) => os.delete(id));
}

export async function estimateUsage() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { used: e.usage || 0, quota: e.quota || 0 } : null;
  } catch { return null; }
}

/* ── Small typed prefs helper (localStorage) ──────────────── */

export const prefs = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('luma:' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('luma:' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
  remove(key) {
    try { localStorage.removeItem('luma:' + key); } catch { /* ignore */ }
  },
};

export const uid = () =>
  (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
