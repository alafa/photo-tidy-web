import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import React from 'react'

afterEach(cleanup)

vi.mock('@/lib/photo-storage', () => ({
  getAllPhotoRecords: vi.fn(),
  putPhotoRecord: vi.fn(),
  deletePhotoRecord: vi.fn(),
  clearAllPhotoRecords: vi.fn(),
  requestPersistence: vi.fn(),
}))

vi.mock('@/lib/generate-thumbnail', () => ({
  generateThumbnail: vi.fn(),
}))

import { usePhotoPersistence } from './usePhotoPersistence'
import type { PhotoEntry } from './usePhotos'
import {
  getAllPhotoRecords,
  putPhotoRecord,
  deletePhotoRecord,
  clearAllPhotoRecords,
  requestPersistence,
  type PhotoRecord,
} from '@/lib/photo-storage'
import { generateThumbnail } from '@/lib/generate-thumbnail'

const mockGetAllPhotoRecords = vi.mocked(getAllPhotoRecords)
const mockPutPhotoRecord = vi.mocked(putPhotoRecord)
const mockDeletePhotoRecord = vi.mocked(deletePhotoRecord)
const mockClearAllPhotoRecords = vi.mocked(clearAllPhotoRecords)
const mockRequestPersistence = vi.mocked(requestPersistence)
const mockGenerateThumbnail = vi.mocked(generateThumbnail)

// --- helpers ---------------------------------------------------------------

function makeFile(name: string, contents = 'x'): File {
  return new File([contents], name, { type: 'image/jpeg', lastModified: 12345 })
}

function makePhoto(overrides: Partial<PhotoEntry> = {}): PhotoEntry {
  return {
    id: 'id-1',
    file: makeFile(overrides.filename ?? 'a.jpg'),
    filename: 'a.jpg',
    capturedAt: null,
    uploadIndex: 0,
    source: 'local',
    ...overrides,
  }
}

function makeRecord(overrides: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    id: 'id-1',
    blob: makeFile('a.jpg'),
    filename: 'a.jpg',
    type: 'image/jpeg',
    lastModified: 12345,
    capturedAt: null,
    source: 'local',
    uploadIndex: 0,
    thumbnail: null,
    ...overrides,
  }
}

function renderPersistence(
  photos: PhotoEntry[],
  hydratePhotos: (entries: PhotoEntry[]) => void = vi.fn(),
  seedPhotoStates: (map: Map<string, string>) => void = vi.fn(),
) {
  return renderHook(
    (props: { photos: PhotoEntry[] }) => usePhotoPersistence(props.photos, hydratePhotos, seedPhotoStates),
    { initialProps: { photos } },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAllPhotoRecords.mockResolvedValue([])
  mockPutPhotoRecord.mockResolvedValue(undefined)
  mockDeletePhotoRecord.mockResolvedValue(undefined)
  mockClearAllPhotoRecords.mockResolvedValue(undefined)
  mockRequestPersistence.mockResolvedValue(true)
  mockGenerateThumbnail.mockResolvedValue(null)
})

// --- restore -----------------------------------------------------------

describe('usePhotoPersistence — restore', () => {
  it('hydrates photos with reconstructed Files carrying the original filename and type', async () => {
    const record = makeRecord({
      id: 'r1',
      filename: 'orig.jpg',
      type: 'image/png',
      blob: new Blob(['data']),
    })
    mockGetAllPhotoRecords.mockResolvedValue([record])
    const hydratePhotos = vi.fn()

    const { result } = renderPersistence([], hydratePhotos)

    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    expect(hydratePhotos).toHaveBeenCalledTimes(1)
    const entries = hydratePhotos.mock.calls[0][0] as PhotoEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('r1')
    expect(entries[0].file).toBeInstanceOf(File)
    expect(entries[0].file.name).toBe('orig.jpg')
    expect(entries[0].file.type).toBe('image/png')
  })

  it('reconstructs capturedAt as a Date, or null when the record had null', async () => {
    const withDate = makeRecord({ id: 'r1', capturedAt: new Date('2025-01-01T00:00:00Z').getTime() })
    const noDate = makeRecord({ id: 'r2', capturedAt: null })
    mockGetAllPhotoRecords.mockResolvedValue([withDate, noDate])
    const hydratePhotos = vi.fn()

    const { result } = renderPersistence([], hydratePhotos)
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    const entries = hydratePhotos.mock.calls[0][0] as PhotoEntry[]
    const r1 = entries.find((e) => e.id === 'r1')!
    const r2 = entries.find((e) => e.id === 'r2')!
    expect(r1.capturedAt).toEqual(new Date('2025-01-01T00:00:00Z'))
    expect(r2.capturedAt).toBeNull()
  })

  it('calls seedPhotoStates with a map of ids to mediaItemId, for records that have one', async () => {
    const r1 = makeRecord({ id: 'r1', mediaItemId: 'media-1' })
    const r2 = makeRecord({ id: 'r2' })
    mockGetAllPhotoRecords.mockResolvedValue([r1, r2])
    const seedPhotoStates = vi.fn()

    const { result } = renderPersistence([], vi.fn(), seedPhotoStates)
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    expect(seedPhotoStates).toHaveBeenCalledTimes(1)
    const map = seedPhotoStates.mock.calls[0][0] as Map<string, string>
    expect(map.get('r1')).toBe('media-1')
    expect(map.has('r2')).toBe(false)
  })

  it('restore failure: isRestoring becomes false, hydratePhotos is never called, storageWarning is set', async () => {
    mockGetAllPhotoRecords.mockRejectedValue(new Error('IndexedDB blocked'))
    const hydratePhotos = vi.fn()

    const { result } = renderPersistence([], hydratePhotos)

    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    expect(hydratePhotos).not.toHaveBeenCalled()
    expect(result.current.storageWarning).toEqual(expect.any(String))
    expect(result.current.storageWarning).not.toBe('')
  })

  it('Strict Mode double-invoke: hydratePhotos is applied exactly once, with the correct data', async () => {
    const record = makeRecord({ id: 'r1' })
    mockGetAllPhotoRecords.mockResolvedValue([record])
    const hydratePhotos = vi.fn()

    const { result } = renderHook(
      (props: { photos: PhotoEntry[] }) => usePhotoPersistence(props.photos, hydratePhotos, vi.fn()),
      { initialProps: { photos: [] }, wrapper: React.StrictMode },
    )

    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    // In Strict Mode dev double-invoke, getAllPhotoRecords may be called
    // twice (once per effect invocation), but only the still-current
    // invocation's result may reach hydratePhotos.
    expect(hydratePhotos).toHaveBeenCalledTimes(1)
    expect(hydratePhotos.mock.calls[0][0]).toHaveLength(1)
    expect((hydratePhotos.mock.calls[0][0] as PhotoEntry[])[0].id).toBe('r1')
  })
})

// --- write-through -------------------------------------------------------

describe('usePhotoPersistence — write-through', () => {
  it('persists a newly-added photo with uploadIndex from its array position, generating a thumbnail', async () => {
    mockGenerateThumbnail.mockResolvedValue('base64thumbnaildata')
    const { result, rerender } = renderPersistence([])
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    const photo = makePhoto({ id: 'p1', filename: 'new.jpg' })
    rerender({ photos: [photo] })

    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(1))

    expect(mockGenerateThumbnail).toHaveBeenCalledWith(photo.file)
    const record = mockPutPhotoRecord.mock.calls[0][0] as PhotoRecord
    expect(record.id).toBe('p1')
    expect(record.uploadIndex).toBe(0)
    expect(record.filename).toBe('new.jpg')
  })

  it('reuses the cached thumbnail on a metadata-only change (no thumbnail regeneration)', async () => {
    mockGenerateThumbnail.mockResolvedValue('base64thumbnaildata')
    const { result, rerender } = renderPersistence([])
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    const photo = makePhoto({ id: 'p1', filename: 'new.jpg' })
    rerender({ photos: [photo] })
    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(1))
    expect(mockGenerateThumbnail).toHaveBeenCalledTimes(1)

    const renamed: PhotoEntry = { ...photo, filename: 'renamed.jpg' }
    rerender({ photos: [renamed] })

    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(2))
    expect(mockGenerateThumbnail).toHaveBeenCalledTimes(1)
    const secondRecord = mockPutPhotoRecord.mock.calls[1][0] as PhotoRecord
    expect(secondRecord.filename).toBe('renamed.jpg')
  })

  it('a quota failure for one photo does not abort the rest of the batch, and sets storageWarning', async () => {
    const photoA = makePhoto({ id: 'a', filename: 'a.jpg', file: makeFile('a.jpg') })
    const photoB = makePhoto({ id: 'b', filename: 'b.jpg', file: makeFile('b.jpg') })

    mockPutPhotoRecord.mockImplementation(async (record: PhotoRecord) => {
      if (record.id === 'a') {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
    })

    const { result, rerender } = renderPersistence([])
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    rerender({ photos: [photoA, photoB] })

    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.storageWarning).toEqual(expect.any(String)))

    const idsAttempted = mockPutPhotoRecord.mock.calls.map((c) => (c[0] as PhotoRecord).id)
    expect(idsAttempted).toEqual(expect.arrayContaining(['a', 'b']))

    // The failing photo ('a') was not marked persisted, so a later
    // write-through pass retries it; 'b' already succeeded and is unchanged,
    // so it should not be re-persisted.
    mockPutPhotoRecord.mockClear()
    mockPutPhotoRecord.mockResolvedValue(undefined)
    rerender({ photos: [photoA, photoB] })

    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(1))
    expect((mockPutPhotoRecord.mock.calls[0][0] as PhotoRecord).id).toBe('a')
  })

  it('calls deletePhotoRecord for a photo removed from the photos array', async () => {
    const photo = makePhoto({ id: 'p1' })
    const { result, rerender } = renderPersistence([photo])
    await waitFor(() => expect(result.current.isRestoring).toBe(false))
    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(1))

    rerender({ photos: [] })

    await waitFor(() => expect(mockDeletePhotoRecord).toHaveBeenCalledWith('p1'))
  })

  it('persists uploadIndex from the photo\'s actual array position, not its own (possibly stale) uploadIndex field', async () => {
    const photo = makePhoto({ id: 'p1', uploadIndex: 5 })
    const { result, rerender } = renderPersistence([])
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    rerender({ photos: [photo] })

    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(1))
    const record = mockPutPhotoRecord.mock.calls[0][0] as PhotoRecord
    expect(record.uploadIndex).toBe(0)
  })

  it('CRITICAL: after restore, the write-through effect does not call putPhotoRecord for any restored photo', async () => {
    // Regression test for a bug where lastPersistedRef was seeded from the
    // raw PhotoRecord array (record.blob), while hydratePhotos received
    // PhotoEntry objects whose `.file` is a brand-new File wrapping that
    // same Blob. Since `new File([blob], ...) !== blob`, every restored
    // photo would look "changed" and get rewritten on every load. The fix
    // seeds lastPersistedRef with the same File objects handed to
    // hydratePhotos.
    //
    // Uses a real `useState` for `photos` (rather than the
    // externally-rerendered `photos` prop `renderPersistence` normally
    // uses) so `hydratePhotos` behaves like the real `usePhotos.hydratePhotos`
    // -- a genuine state setter. This matters: restore() calls
    // hydratePhotos(entries) and setIsRestoring(false) back-to-back with no
    // await between them, so React batches them into one render, meaning
    // the write-through effect only ever observes `photos` and
    // `isRestoring` in sync, exactly as it does in the real app.
    const record = makeRecord({ id: 'r1', filename: 'orig.jpg' })
    mockGetAllPhotoRecords.mockResolvedValue([record])

    function useHarness() {
      const [photos, setPhotos] = React.useState<PhotoEntry[]>([])
      const persistence = usePhotoPersistence(photos, setPhotos, vi.fn())
      return { photos, ...persistence }
    }

    const { result } = renderHook(() => useHarness())
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    expect(result.current.photos).toHaveLength(1)
    expect(result.current.photos[0].id).toBe('r1')

    // Give the write-through effect a chance to run and settle.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockPutPhotoRecord).not.toHaveBeenCalled()
    expect(mockDeletePhotoRecord).not.toHaveBeenCalled()
  })

  it('Fix #2: a photo deleted while its write is still in flight is not left orphaned in lastPersistedRef — it gets cleaned up via deletePhotoRecord', async () => {
    // Simulate: photo A is added (write starts, `putPhotoRecord` still
    // pending) -> user deletes A before it resolves (re-render with A
    // removed from `photos`) -> the pending `putPhotoRecord` resolves.
    // Before the fix, the resolving write would unconditionally commit A to
    // lastPersistedRef with no re-check that A is still present, orphaning
    // its record in IndexedDB forever (it reappears on next reload since
    // nothing will ever call deletePhotoRecord for it).
    let resolvePut!: (value: undefined) => void
    mockPutPhotoRecord.mockImplementation(
      () => new Promise((resolve) => { resolvePut = resolve }),
    )

    const photoA = makePhoto({ id: 'a', filename: 'a.jpg', file: makeFile('a.jpg') })
    const { result, rerender } = renderPersistence([])
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    rerender({ photos: [photoA] })
    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(1))

    // Delete photoA before its write resolves.
    rerender({ photos: [] })

    // Give the deletion's own write-through pass a chance to run (it will
    // find nothing to delete yet, since lastPersistedRef doesn't have 'a'
    // registered — the whole point of this race).
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockDeletePhotoRecord).not.toHaveBeenCalled()

    // Now let the original, now-stale write resolve.
    await act(async () => {
      resolvePut(undefined)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The in-flight write's own completion must detect photoA is no longer
    // present and clean up after itself.
    await waitFor(() => expect(mockDeletePhotoRecord).toHaveBeenCalledWith('a'))
  })

  it('calls requestPersistence exactly once, fired after the first successful put', async () => {
    const photoA = makePhoto({ id: 'a', file: makeFile('a.jpg') })
    const photoB = makePhoto({ id: 'b', file: makeFile('b.jpg') })
    const { result, rerender } = renderPersistence([])
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    rerender({ photos: [photoA] })
    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockRequestPersistence).toHaveBeenCalledTimes(1))

    rerender({ photos: [photoA, photoB] })
    await waitFor(() => expect(mockPutPhotoRecord).toHaveBeenCalledTimes(2))

    expect(mockRequestPersistence).toHaveBeenCalledTimes(1)
  })
})

// --- clearAllPersisted -----------------------------------------------------

describe('usePhotoPersistence — clearAllPersisted', () => {
  it('calls clearAllPhotoRecords and does not call hydratePhotos', async () => {
    const hydratePhotos = vi.fn()
    const { result } = renderPersistence([], hydratePhotos)
    await waitFor(() => expect(result.current.isRestoring).toBe(false))
    const callsBeforeClear = hydratePhotos.mock.calls.length

    await act(async () => {
      await result.current.clearAllPersisted()
    })

    expect(mockClearAllPhotoRecords).toHaveBeenCalledTimes(1)
    expect(hydratePhotos.mock.calls.length).toBe(callsBeforeClear)
  })

  it('a restore still in flight when clearAllPersisted runs must not hydrate stale data afterward', async () => {
    let resolveRestore!: (records: PhotoRecord[]) => void
    mockGetAllPhotoRecords.mockImplementation(
      () => new Promise((resolve) => { resolveRestore = resolve }),
    )
    const hydratePhotos = vi.fn()

    const { result } = renderPersistence([], hydratePhotos)
    expect(result.current.isRestoring).toBe(true)

    await act(async () => {
      await result.current.clearAllPersisted()
    })

    // The in-flight restore now resolves with data from before the clear —
    // it must be discarded, not hydrated in.
    await act(async () => {
      resolveRestore([makeRecord({ id: 'stale' })])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(hydratePhotos).not.toHaveBeenCalled()
  })

  it('Fix #3: clearAllPhotoRecords rejecting does not make clearAllPersisted reject, and sets storageWarning', async () => {
    mockClearAllPhotoRecords.mockRejectedValue(new Error('IndexedDB unavailable'))
    const { result } = renderPersistence([])
    await waitFor(() => expect(result.current.isRestoring).toBe(false))

    await expect(
      act(async () => {
        await result.current.clearAllPersisted()
      }),
    ).resolves.toBeUndefined()

    await waitFor(() => expect(result.current.storageWarning).toEqual(expect.any(String)))
    expect(result.current.storageWarning).not.toBe('')
  })
})
