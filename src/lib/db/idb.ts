/**
 * Document storage.
 *
 * A small promise wrapper over IndexedDB rather than a library: we need five
 * operations on one object store, and `idb` would be a dependency for about
 * forty lines of glue.
 *
 * IndexedDB (not localStorage) because documents carry a page thumbnail and
 * the full text of a chapter — comfortably past localStorage's ~5 MB, and
 * localStorage writes block the main thread while speech is playing.
 */

import type { Doc, PlaybackPosition } from '../../types';

const DB_NAME = 'page-to-voice';
const DB_VERSION = 1;
const STORE = 'documents';

let dbPromise: Promise<IDBDatabase> | null = null;

/** True in private windows / disabled-storage setups, where we degrade to no library. */
export function isStorageAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (!isStorageAvailable()) {
      reject(new Error('This browser has no IndexedDB, so documents cannot be saved.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        // Sorting the library by "most recently touched" is the only query.
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'));
    // Another tab holds an old version open; nothing useful to do but report.
    request.onblocked = () => reject(new Error('Close other tabs of this app and retry.'));
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** Run one request inside a transaction and resolve with its result. */
async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = fn(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Newest first — the order the library shows them in. */
export async function listDocs(): Promise<Doc[]> {
  const all = await run<Doc[]>('readonly', (store) => store.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getDoc(id: string): Promise<Doc | undefined> {
  return run<Doc | undefined>('readonly', (store) => store.get(id));
}

export function putDoc(doc: Doc): Promise<IDBValidKey> {
  return run<IDBValidKey>('readwrite', (store) => store.put(doc));
}

export function deleteDoc(id: string): Promise<undefined> {
  return run<undefined>('readwrite', (store) => store.delete(id));
}

/**
 * Save just the playback position. Read-modify-write in one transaction so a
 * position update can't clobber a title edit made in another tab.
 */
export async function savePosition(
  id: string,
  position: PlaybackPosition,
): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const read = store.get(id);
    read.onsuccess = () => {
      const doc = read.result as Doc | undefined;
      if (!doc) {
        resolve();
        return;
      }
      store.put({ ...doc, position, updatedAt: Date.now() });
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Rough bytes used, for the library footer. Undefined where unsupported. */
export async function storageUsed(): Promise<number | undefined> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.usage;
  } catch {
    return undefined;
  }
}
