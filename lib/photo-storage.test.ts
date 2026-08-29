import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Minimal in-memory fake IndexedDB -----------------------------------
//
// jsdom does not implement IndexedDB, so we hand-roll just enough of the
// API surface for lib/photo-storage.ts's wrapper: open/onupgradeneeded,
// transaction/objectStore, and get/getAll/put/delete/clear with the
// request.onsuccess/onerror callback semantics real IndexedDB uses.
// This is not a full reimplementation -- just enough to prove the
// wrapper's contract.

type ReqCallback = ((this: FakeRequest, ev: unknown) => void) | null

class FakeRequest {
  result: unknown = undefined
  error: DOMException | Error | null = null
  onsuccess: ReqCallback = null
  onerror: ReqCallback = null

  _succeed(result: unknown) {
    this.result = result
    // Emulate the async nature of real IDB requests.
    queueMicrotask(() => {
      this.onsuccess?.call(this, { target: this })
    })
  }

  _fail(error: DOMException | Error) {
    this.error = error
    queueMicrotask(() => {
      this.onerror?.call(this, { target: this })
    })
  }
}

class FakeObjectStore {
  constructor(private db: FakeDatabase) {}

  private failNextPut: (DOMException | Error) | null = null

  _setFailNextPut(error: DOMException | Error) {
    this.failNextPut = error
  }

  get(id: string): FakeRequest {
    const req = new FakeRequest()
    req._succeed(this.db.records.get(id))
    return req
  }

  getAll(): FakeRequest {
    const req = new FakeRequest()
    req._succeed(Array.from(this.db.records.values()))
    return req
  }

  put(value: { id: string }): FakeRequest {
    const req = new FakeRequest()
    if (this.db.failNextPut) {
      const err = this.db.failNextPut
      this.db.failNextPut = null
      req._fail(err)
      return req
    }
    this.db.records.set(value.id, value)
    req._succeed(value.id)
    return req
  }

  delete(id: string): FakeRequest {
    const req = new FakeRequest()
    this.db.records.delete(id)
    req._succeed(undefined)
    return req
  }

  clear(): FakeRequest {
    const req = new FakeRequest()
    this.db.records.clear()
    req._succeed(undefined)
    return req
  }
}

class FakeTransaction {
  constructor(private db: FakeDatabase) {}
  objectStore(name: string): FakeObjectStore {
    if (name !== 'photos') throw new Error(`unknown store ${name}`)
    return new FakeObjectStore(this.db)
  }
}

class FakeDatabase {
  records = new Map<string, unknown>()
  objectStoreNames = {
    contains: (name: string) => name === 'photos',
  }
  failNextPut: (DOMException | Error) | null = null

  createObjectStore(name: string) {
    if (name !== 'photos') throw new Error('unexpected store name')
    return {}
  }

  transaction(): FakeTransaction {
    return new FakeTransaction(this)
  }

  close() {}
}

class FakeIDBOpenRequest extends FakeRequest {
  onupgradeneeded: ReqCallback = null
}

function makeFakeIndexedDB(sharedDb: { current: FakeDatabase | null }) {
  return {
    open() {
      const req = new FakeIDBOpenRequest()
      queueMicrotask(() => {
        const isNew = !sharedDb.current
        if (isNew) {
          sharedDb.current = new FakeDatabase()
        }
        const db = sharedDb.current!
        if (isNew) {
          // Real IndexedDB fires onupgradeneeded before onsuccess when the
          // store doesn't exist yet.
          req.result = db
          req.onupgradeneeded?.call(req, { target: req })
        }
        req.result = db
        req.onsuccess?.call(req, { target: req })
      })
      return req
    },
  }
}

let sharedDb: { current: FakeDatabase | null }

beforeEach(() => {
  sharedDb = { current: null }
  vi.stubGlobal('indexedDB', makeFakeIndexedDB(sharedDb))
  vi.resetModules()
})

function makeBlob(content: string, type = 'image/jpeg'): Blob {
  return new Blob([content], { type })
}

async function importFresh() {
  return await import('./photo-storage')
}

describe('photo-storage', () => {
  it('creates the photos object store on first use', async () => {
    const { getAllPhotoRecords } = await importFresh()

    await getAllPhotoRecords()

    expect(sharedDb.current).not.toBeNull()
    expect(sharedDb.current!.objectStoreNames.contains('photos')).toBe(true)
  })

  it('round-trips a record via putPhotoRecord/getAllPhotoRecords, including a Blob field', async () => {
    const { putPhotoRecord, getAllPhotoRecords } = await importFresh()

    const thumbnail = makeBlob('thumb-bytes')
    const record = {
      id: 'photo-1',
      blob: makeBlob('full-bytes'),
      filename: 'a.jpg',
      type: 'image/jpeg',
      lastModified: 1700000000000,
      capturedAt: 1700000000000,
      source: 'local' as const,
      uploadIndex: 0,
      thumbnail,
    }

    await putPhotoRecord(record)
    const all = await getAllPhotoRecords()

    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(record)
    expect(all[0].thumbnail).toBeInstanceOf(Blob)
    expect(await (all[0].thumbnail as Blob).text()).toBe('thumb-bytes')
  })

  it('round-trips a record whose thumbnail is null', async () => {
    const { putPhotoRecord, getAllPhotoRecords } = await importFresh()

    const record = {
      id: 'photo-null-thumb',
      blob: makeBlob('full-bytes'),
      filename: 'b.jpg',
      type: 'image/jpeg',
      lastModified: 1700000001000,
      capturedAt: null,
      source: 'google-photos' as const,
      uploadIndex: 1,
      mediaItemId: 'media-1',
      thumbnail: null,
    }

    await putPhotoRecord(record)
    const all = await getAllPhotoRecords()

    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(record)
    expect(all[0].thumbnail).toBeNull()
  })

  it('deletePhotoRecord removes exactly the targeted record and leaves others untouched', async () => {
    const { putPhotoRecord, deletePhotoRecord, getAllPhotoRecords } = await importFresh()

    const makeRecord = (id: string) => ({
      id,
      blob: makeBlob(id),
      filename: `${id}.jpg`,
      type: 'image/jpeg',
      lastModified: 1,
      capturedAt: null,
      source: 'local' as const,
      uploadIndex: 0,
      thumbnail: null,
    })

    await putPhotoRecord(makeRecord('keep-1'))
    await putPhotoRecord(makeRecord('remove-me'))
    await putPhotoRecord(makeRecord('keep-2'))

    await deletePhotoRecord('remove-me')

    const all = await getAllPhotoRecords()
    const ids = all.map((r) => r.id).sort()
    expect(ids).toEqual(['keep-1', 'keep-2'])
  })

  it('clearAllPhotoRecords empties the store', async () => {
    const { putPhotoRecord, clearAllPhotoRecords, getAllPhotoRecords } = await importFresh()

    await putPhotoRecord({
      id: 'x',
      blob: makeBlob('x'),
      filename: 'x.jpg',
      type: 'image/jpeg',
      lastModified: 1,
      capturedAt: null,
      source: 'local' as const,
      uploadIndex: 0,
      thumbnail: null,
    })

    await clearAllPhotoRecords()

    const all = await getAllPhotoRecords()
    expect(all).toEqual([])
  })

  it('rejects with a QuotaExceededError DOMException (readable via .name) when the store write fails that way', async () => {
    const { putPhotoRecord } = await importFresh()

    // Prime the db so we can inject a failure on the next put.
    await putPhotoRecord({
      id: 'prime',
      blob: makeBlob('p'),
      filename: 'p.jpg',
      type: 'image/jpeg',
      lastModified: 1,
      capturedAt: null,
      source: 'local' as const,
      uploadIndex: 0,
      thumbnail: null,
    })

    sharedDb.current!.failNextPut = new DOMException('quota exceeded', 'QuotaExceededError')

    const record = {
      id: 'y',
      blob: makeBlob('y'),
      filename: 'y.jpg',
      type: 'image/jpeg',
      lastModified: 1,
      capturedAt: null,
      source: 'local' as const,
      uploadIndex: 0,
      thumbnail: null,
    }

    let caught: unknown = null
    try {
      await putPhotoRecord(record)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(DOMException)
    expect((caught as DOMException).name).toBe('QuotaExceededError')
  })

  it('requestPersistence resolves false without throwing when the browser denies persistence', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persist: vi.fn().mockResolvedValue(false),
      },
    })

    const { requestPersistence } = await importFresh()

    await expect(requestPersistence()).resolves.toBe(false)
  })

  it('requestPersistence resolves true when the browser grants persistence', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persist: vi.fn().mockResolvedValue(true),
      },
    })

    const { requestPersistence } = await importFresh()

    await expect(requestPersistence()).resolves.toBe(true)
  })

  it('requestPersistence resolves false without throwing when navigator.storage.persist is unavailable', async () => {
    vi.stubGlobal('navigator', {})

    const { requestPersistence } = await importFresh()

    await expect(requestPersistence()).resolves.toBe(false)
  })
})
