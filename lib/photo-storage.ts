/**
 * Low-level IndexedDB persistence primitives for the photo batch, so it
 * survives reload/tab-close/lost-connectivity until an explicit "Clear
 * all". Hand-rolled minimal typed wrapper around raw IndexedDB (no `idb`
 * dependency) -- a single `photos` object store keyed by `id`.
 */

const DB_NAME = 'photo-tidy'
const DB_VERSION = 1
const STORE_NAME = 'photos'

/** A photo persisted to IndexedDB. `capturedAt` is epoch millis or `null`
 * (converted at the call site from/to `Date | null`). `thumbnail: null`
 * means thumbnail generation failed for this photo -- a later unit falls
 * back to the full `blob` for display in that case. */
export interface PhotoRecord {
  id: string
  blob: Blob
  filename: string
  type: string
  lastModified: number
  capturedAt: number | null
  source: 'local' | 'google-photos'
  uploadIndex: number
  mediaItemId?: string
  thumbnail: Blob | null
}

// Memoized connection, shared across every call — opening a fresh
// `indexedDB.open()` connection (and closing it) on every single
// get/put/delete would mean a write-through pass touching a chunk of
// records opens one connection per record. Reused until the connection
// itself reports it's gone away (see onversionchange/onclose below), at
// which point it's nulled out so the next call transparently reopens.
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // Only one DB version exists today, so there's no upgrade logic to
      // run here — just drop the cached connection so the next call
      // reopens fresh, whenever the connection closes for any reason
      // (another tab upgrading the schema, or the connection being closed
      // out from under us).
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })

  return dbPromise
}

/** Wraps an `IDBRequest` in a Promise, rejecting with the request's own
 * `.error` (a `DOMException`, e.g. named `QuotaExceededError`) unchanged
 * so callers can identify it by `.name` rather than string-matching. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, mode)
  const store = tx.objectStore(STORE_NAME)
  return await requestToPromise(fn(store))
}

/** Returns every stored photo record, in no particular order. */
export async function getAllPhotoRecords(): Promise<PhotoRecord[]> {
  return withStore('readonly', (store) => store.getAll())
}

/** Inserts or overwrites the record with this `id`. Rejects with the
 * original `DOMException` (e.g. `.name === 'QuotaExceededError'`) on
 * failure -- never wrapped in a generic `Error`. */
export async function putPhotoRecord(record: PhotoRecord): Promise<void> {
  await withStore('readwrite', (store) => store.put(record))
}

/** Removes the record with this `id`, if present. */
export async function deletePhotoRecord(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id))
}

/** Empties the `photos` store entirely. */
export async function clearAllPhotoRecords(): Promise<void> {
  await withStore('readwrite', (store) => store.clear())
}

/** Wraps `navigator.storage.persist()`. Never throws: resolves `false`
 * when persistence is denied, unsupported, or the call itself errors. */
export async function requestPersistence(): Promise<boolean> {
  try {
    const granted = await navigator.storage?.persist?.()
    return granted ?? false
  } catch {
    return false
  }
}
