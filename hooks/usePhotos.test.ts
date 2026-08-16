import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

afterEach(cleanup)
import { usePhotos } from './usePhotos'
import { useObjectUrls } from './useObjectUrls'

// --- Mocks ---

vi.mock('@/lib/exif', () => ({
  getPhotoDate: vi.fn(),
}))

import { getPhotoDate } from '@/lib/exif'
const mockGetPhotoDate = vi.mocked(getPhotoDate)

const mockCreateObjectURL = vi.fn((file: File) => `blob:${file.name}`)
const mockRevokeObjectURL = vi.fn()
vi.stubGlobal('URL', {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
})

function makeFile(name: string): File {
  return new File([], name, { type: 'image/jpeg' })
}

function makeFileList(files: File[]): FileList {
  // jsdom doesn't implement DataTransfer; build a FileList-compatible object
  // using the same properties the hook accesses: length + numeric index.
  return Object.assign([...files], {
    item: (i: number) => files[i] ?? null,
  }) as unknown as FileList
}

beforeEach(() => {
  vi.clearAllMocks()
})

// --- usePhotos ---

describe('usePhotos', () => {
  it('sorts three files with distinct timestamps oldest-first', async () => {
    const [a, b, c] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')]
    mockGetPhotoDate.mockImplementation(async (file: File) => {
      if (file === a) return new Date('2025-03-01')
      if (file === b) return new Date('2024-01-15')
      if (file === c) return new Date('2025-12-31')
      return null
    })

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b, c])))

    expect(result.current.photos.map((p) => p.filename)).toEqual([
      'b.jpg',
      'a.jpg',
      'c.jpg',
    ])
  })

  it('uses upload order as tiebreaker for identical timestamps', async () => {
    const [a, b] = [makeFile('first.jpg'), makeFile('second.jpg')]
    const sameDate = new Date('2025-06-01T10:00:00')
    mockGetPhotoDate.mockResolvedValue(sameDate)

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b])))

    expect(result.current.photos.map((p) => p.filename)).toEqual([
      'first.jpg',
      'second.jpg',
    ])
  })

  it('puts timestamped files before no-date files', async () => {
    const [withDate, noDate] = [makeFile('dated.jpg'), makeFile('nodated.jpg')]
    mockGetPhotoDate.mockImplementation(async (file: File) => {
      if (file === withDate) return new Date('2025-01-01')
      return null
    })

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([noDate, withDate])))

    expect(result.current.photos.map((p) => p.filename)).toEqual([
      'dated.jpg',
      'nodated.jpg',
    ])
  })

  it('preserves upload order for multiple no-date files', async () => {
    const files = [makeFile('z.jpg'), makeFile('a.jpg'), makeFile('m.jpg')]
    mockGetPhotoDate.mockResolvedValue(null)

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList(files)))

    expect(result.current.photos.map((p) => p.filename)).toEqual([
      'z.jpg',
      'a.jpg',
      'm.jpg',
    ])
  })

  it('returns empty array for empty FileList', async () => {
    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([])))

    expect(result.current.photos).toEqual([])
  })

  it('processFiles produces entries with source="local"', async () => {
    const [a] = [makeFile('a.jpg')]
    mockGetPhotoDate.mockResolvedValue(new Date('2025-01-01'))

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a])))

    expect(result.current.photos[0].source).toBe('local')
  })

  it('processFiles accepts a plain File[] (not FileList)', async () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')]
    mockGetPhotoDate.mockImplementation(async (file: File) => {
      if (file === a) return new Date('2025-03-01')
      if (file === b) return new Date('2024-01-15')
      return null
    })

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles([a, b]))

    expect(result.current.photos.map((p) => p.filename)).toEqual(['b.jpg', 'a.jpg'])
    expect(result.current.photos[0].source).toBe('local')
  })
})

describe('usePhotos — addPhotos', () => {
  it('appends google-photos entries in sorted order to an existing grid', async () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')]
    const [c, d] = [makeFile('c.jpg'), makeFile('d.jpg')]

    mockGetPhotoDate.mockImplementation(async (file: File) => {
      if (file === a) return new Date('2025-01-01')
      if (file === b) return new Date('2025-06-01')
      if (file === c) return new Date('2025-03-15') // between a and b
      if (file === d) return new Date('2025-09-01') // after b
      return null
    })

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b])))
    await act(() => result.current.addPhotos([c, d], 'google-photos'))

    const filenames = result.current.photos.map((p) => p.filename)
    expect(filenames).toEqual(['a.jpg', 'c.jpg', 'b.jpg', 'd.jpg'])
    expect(result.current.photos.find((p) => p.filename === 'c.jpg')?.source).toBe('google-photos')
    expect(result.current.photos.find((p) => p.filename === 'd.jpg')?.source).toBe('google-photos')
  })

  it('adds and sorts entries on an empty grid', async () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')]
    mockGetPhotoDate.mockImplementation(async (file: File) => {
      if (file === a) return new Date('2025-06-01')
      if (file === b) return new Date('2025-01-01')
      return null
    })

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.addPhotos([a, b], 'google-photos'))

    expect(result.current.photos.map((p) => p.filename)).toEqual(['b.jpg', 'a.jpg'])
    expect(result.current.photos[0].source).toBe('google-photos')
  })

})

describe('usePhotos — processFiles append behavior', () => {
  it('merges newly-added local files into an existing batch instead of replacing it', async () => {
    const [gp1, gp2] = [makeFile('gp1.jpg'), makeFile('gp2.jpg')]
    const [local1] = [makeFile('local1.jpg')]
    mockGetPhotoDate.mockImplementation(async (file: File) => {
      if (file === gp1) return new Date('2025-01-01')
      if (file === gp2) return new Date('2025-02-01')
      if (file === local1) return new Date('2025-03-01')
      return null
    })

    const { result } = renderHook(() => usePhotos())
    // Simulate importing 2 photos from Google Photos first
    await act(() => result.current.addPhotos([gp1, gp2], 'google-photos'))
    expect(result.current.photos).toHaveLength(2)

    // Then add 1 local file (as if dropped via drag-drop)
    await act(() => result.current.processFiles(makeFileList([local1])))

    expect(result.current.photos).toHaveLength(3)
    const filenames = result.current.photos.map((p) => p.filename)
    expect(filenames).toEqual(['gp1.jpg', 'gp2.jpg', 'local1.jpg'])
  })

  it('behaves the same as a fresh upload when there are no prior photos', async () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')]
    mockGetPhotoDate.mockImplementation(async (file: File) =>
      file === a ? new Date('2025-01-01') : new Date('2025-02-01')
    )

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b])))

    expect(result.current.photos.map((p) => p.filename)).toEqual(['a.jpg', 'b.jpg'])
  })

  it('preserves both batches when adding local files twice in a row', async () => {
    const [a] = [makeFile('a.jpg')]
    const [b] = [makeFile('b.jpg')]
    mockGetPhotoDate.mockImplementation(async (file: File) =>
      file === a ? new Date('2025-01-01') : new Date('2025-02-01')
    )

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a])))
    await act(() => result.current.processFiles(makeFileList([b])))

    expect(result.current.photos).toHaveLength(2)
    expect(result.current.photos.map((p) => p.filename)).toEqual(['a.jpg', 'b.jpg'])
  })

  it('assigns continuing uploadIndex values to newly-appended entries', async () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')]
    mockGetPhotoDate.mockResolvedValue(null) // no dates -> uploadIndex is the sort tiebreaker

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a])))
    expect(result.current.photos[0].uploadIndex).toBe(0)

    await act(() => result.current.processFiles(makeFileList([b])))
    expect(result.current.photos.map((p) => p.uploadIndex)).toEqual([0, 1])
  })
})

describe('usePhotos — reorderPhotos', () => {
  async function setupPhotos(files: File[], dates: (Date | null)[]) {
    mockGetPhotoDate.mockImplementation(async (file: File) => {
      const i = files.indexOf(file)
      return dates[i] ?? null
    })
    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList(files)))
    return result
  }

  it('moves photo from index 2 to index 0 and slots its timestamp before its new neighbor', async () => {
    const [a, b, c] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')]
    const d = new Date('2025-01-01T10:00:00Z')
    const result = await setupPhotos([a, b, c], [d, d, d])

    act(() => result.current.reorderPhotos(2, 0))

    // Order after move: [c, a, b]
    const filenames = result.current.photos.map((p) => p.filename)
    expect(filenames[0]).toBe('c.jpg')
    expect(filenames[1]).toBe('a.jpg')
    expect(filenames[2]).toBe('b.jpg')

    // slotTimestamp: c moved to index 0, no prev neighbor, next neighbor = a (d)
    // → c gets d - 1000ms; a and b keep d unchanged
    const times = result.current.photos.map((p) => p.capturedAt!.getTime())
    expect(times[0]).toBe(d.getTime() - 1000)
    expect(times[1]).toBe(d.getTime())
    expect(times[2]).toBe(d.getTime())
  })

  it('slots moved photo between its new neighbors via midpoint timestamp', async () => {
    const [a, b, c] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')]
    const t1 = new Date('2025-01-01T10:00:00Z')
    const t2 = new Date('2025-01-01T10:00:10Z')
    const t3 = new Date('2025-01-01T10:00:20Z')
    const result = await setupPhotos([a, b, c], [t1, t2, t3])

    // Move c (index 2) to index 1 — between a (t1) and b (t2)
    act(() => result.current.reorderPhotos(2, 1))

    // Order after move: [a, c, b]
    const filenames = result.current.photos.map((p) => p.filename)
    expect(filenames[0]).toBe('a.jpg')
    expect(filenames[1]).toBe('c.jpg')
    expect(filenames[2]).toBe('b.jpg')

    // c gets midpoint of t1 and t2; a and b unchanged
    const expectedMidpoint = Math.round((t1.getTime() + t2.getTime()) / 2)
    expect(result.current.photos[1].capturedAt!.getTime()).toBe(expectedMidpoint)
    expect(result.current.photos[0].capturedAt!.getTime()).toBe(t1.getTime())
    expect(result.current.photos[2].capturedAt!.getTime()).toBe(t2.getTime())
  })

  it('keeps capturedAt null when all neighbors have null timestamps', async () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg')]
    mockGetPhotoDate.mockResolvedValue(null)
    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList(files)))

    act(() => result.current.reorderPhotos(1, 0))

    // Both photos have null timestamps — moved photo stays null
    expect(result.current.photos[0].capturedAt).toBeNull()
    expect(result.current.photos[1].capturedAt).toBeNull()
  })

  it('does not mutate original PhotoEntry objects', async () => {
    const [a] = [makeFile('a.jpg')]
    const d = new Date('2025-01-01T10:00:00Z')
    const result = await setupPhotos([a], [d])
    const original = result.current.photos[0]

    act(() => result.current.reorderPhotos(0, 0))

    expect(result.current.photos[0]).not.toBe(original)
  })

  it('processFiles after reorderPhotos appends new entries without discarding the reordered edit', async () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')]
    const early = new Date('2020-01-01T00:00:00Z')
    const late = new Date('2025-06-15T10:00:00Z')
    mockGetPhotoDate.mockImplementation(async (file: File) =>
      file === a ? late : early
    )
    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b])))

    // reorder to put 'a' first
    act(() => result.current.reorderPhotos(1, 0))
    expect(result.current.photos[0].filename).toBe('a.jpg')

    // adding more local files appends — the reordered 'a' stays first, and
    // both the original two photos plus the two newly-added ones are present
    await act(() => result.current.processFiles(makeFileList([a, b])))
    expect(result.current.photos).toHaveLength(4)
    expect(result.current.photos[0].filename).toBe('a.jpg')
  })

  it('processFiles after reordering undated photos keeps the dragged order (uploadIndex tiebreak follows array position)', async () => {
    // All three photos have no EXIF date, so sortPhotos falls back to
    // uploadIndex to order them. Dragging among undated neighbours leaves
    // capturedAt untouched (slotTimestamp's all-null branch), so the drag
    // is only reflected in array position — appendWithIndex must renumber
    // that position into uploadIndex or the append's sortPhotos call would
    // silently snap back to original upload order.
    const [a, b, c] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')]
    mockGetPhotoDate.mockResolvedValue(null)
    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b, c])))
    expect(result.current.photos.map((p) => p.filename)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])

    // drag 'c' to the front
    act(() => result.current.reorderPhotos(2, 0))
    expect(result.current.photos.map((p) => p.filename)).toEqual(['c.jpg', 'a.jpg', 'b.jpg'])

    const [d] = [makeFile('d.jpg')]
    await act(() => result.current.processFiles(makeFileList([d])))
    expect(result.current.photos.map((p) => p.filename)).toEqual([
      'c.jpg',
      'a.jpg',
      'b.jpg',
      'd.jpg',
    ])
  })

  it('updatePhotoTimestamp after reordering undated photos keeps the other undated photos in their dragged order', async () => {
    // Same uploadIndex/sortPhotos hazard as the append case above, but for
    // an inline timestamp edit: giving one undated photo a real date must
    // not resort the rest back to stale upload-time uploadIndex order.
    const [a, b, c, d] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg'), makeFile('d.jpg')]
    mockGetPhotoDate.mockResolvedValue(null)
    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b, c, d])))

    // drag 'c' to the front
    act(() => result.current.reorderPhotos(2, 0))
    expect(result.current.photos.map((p) => p.filename)).toEqual(['c.jpg', 'a.jpg', 'b.jpg', 'd.jpg'])

    // Give 'd' a real timestamp — dated photos always sort before undated
    // ones, so 'd' moves to the front; the still-undated photos must keep
    // the dragged order (c, a, b), not revert to upload order (a, b, c).
    const dId = result.current.photos.find((p) => p.filename === 'd.jpg')!.id
    act(() => result.current.updatePhotoTimestamp(dId, new Date('2025-06-01T00:00:00Z')))

    expect(result.current.photos.map((p) => p.filename)).toEqual(['d.jpg', 'c.jpg', 'a.jpg', 'b.jpg'])
  })

  it('batchSetTimestamps after reordering undated photos keeps the other undated photos in their dragged order', async () => {
    const [a, b, c, d] = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg'), makeFile('d.jpg')]
    mockGetPhotoDate.mockResolvedValue(null)
    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b, c, d])))

    // drag 'c' to the front
    act(() => result.current.reorderPhotos(2, 0))
    expect(result.current.photos.map((p) => p.filename)).toEqual(['c.jpg', 'a.jpg', 'b.jpg', 'd.jpg'])

    const dId = result.current.photos.find((p) => p.filename === 'd.jpg')!.id
    act(() => result.current.batchSetTimestamps([dId], new Date('2025-06-01T00:00:00Z')))

    expect(result.current.photos.map((p) => p.filename)).toEqual(['d.jpg', 'c.jpg', 'a.jpg', 'b.jpg'])
  })
})

describe('usePhotos — removePhotos', () => {
  it('removes the selected photos and keeps the rest, preserving order', async () => {
    const files = [
      makeFile('a.jpg'),
      makeFile('b.jpg'),
      makeFile('c.jpg'),
      makeFile('d.jpg'),
      makeFile('e.jpg'),
    ]
    mockGetPhotoDate.mockImplementation(async (file: File) => {
      const i = files.indexOf(file)
      return new Date(2025, 0, i + 1)
    })

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList(files)))
    expect(result.current.photos).toHaveLength(5)

    const idsToRemove = [
      result.current.photos[1].id, // b.jpg
      result.current.photos[3].id, // d.jpg
    ]

    act(() => result.current.removePhotos(idsToRemove))

    expect(result.current.photos).toHaveLength(3)
    expect(result.current.photos.map((p) => p.filename)).toEqual([
      'a.jpg',
      'c.jpg',
      'e.jpg',
    ])
  })

  it('empties the list entirely when every photo is removed, with no error', async () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg')]
    mockGetPhotoDate.mockResolvedValue(new Date('2025-01-01'))

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList(files)))

    const allIds = result.current.photos.map((p) => p.id)

    expect(() => {
      act(() => result.current.removePhotos(allIds))
    }).not.toThrow()

    expect(result.current.photos).toEqual([])
  })

  it('is a no-op for ids that are not present in the current list', async () => {
    const [a, b] = [makeFile('a.jpg'), makeFile('b.jpg')]
    mockGetPhotoDate.mockResolvedValue(new Date('2025-01-01'))

    const { result } = renderHook(() => usePhotos())
    await act(() => result.current.processFiles(makeFileList([a, b])))

    act(() => result.current.removePhotos(['nonexistent-id']))

    expect(result.current.photos).toHaveLength(2)
  })
})

// --- useObjectUrls ---

describe('useObjectUrls', () => {
  it('returns a URL for a file', () => {
    const file = makeFile('photo.jpg')
    const { result } = renderHook(() => useObjectUrls())

    const url = result.current.getObjectUrl(file)

    expect(url).toBe('blob:photo.jpg')
    expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
  })

  it('returns the same URL when called twice with the same file', () => {
    const file = makeFile('photo.jpg')
    const { result } = renderHook(() => useObjectUrls())

    const url1 = result.current.getObjectUrl(file)
    const url2 = result.current.getObjectUrl(file)

    expect(url1).toBe(url2)
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1)
  })

  it('revokes all URLs on unmount', () => {
    const [f1, f2] = [makeFile('a.jpg'), makeFile('b.jpg')]
    const { result, unmount } = renderHook(() => useObjectUrls())

    result.current.getObjectUrl(f1)
    result.current.getObjectUrl(f2)
    unmount()

    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(2)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:a.jpg')
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:b.jpg')
  })

  it('releaseObjectUrl revokes and evicts a single file without waiting for unmount', () => {
    const [f1, f2] = [makeFile('a.jpg'), makeFile('b.jpg')]
    const { result, unmount } = renderHook(() => useObjectUrls())

    result.current.getObjectUrl(f1)
    result.current.getObjectUrl(f2)
    result.current.releaseObjectUrl(f1)

    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:a.jpg')

    // Releasing again (or unmounting) must not double-revoke the same URL.
    mockRevokeObjectURL.mockClear()
    unmount()
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:b.jpg')
  })

  it('releaseObjectUrl is a noop for a file that was never fetched', () => {
    const file = makeFile('never-fetched.jpg')
    const { result } = renderHook(() => useObjectUrls())

    result.current.releaseObjectUrl(file)

    expect(mockRevokeObjectURL).not.toHaveBeenCalled()
  })
})
