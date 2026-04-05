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

  it('processFiles after reorderPhotos replaces state with EXIF-sorted order', async () => {
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

    // re-upload restores EXIF order: b (early) before a (late)
    await act(() => result.current.processFiles(makeFileList([a, b])))
    expect(result.current.photos[0].filename).toBe('b.jpg')
  })
})

// --- useObjectUrls ---

describe('useObjectUrls', () => {
  it('returns a URL for a file', () => {
    const file = makeFile('photo.jpg')
    const { result } = renderHook(() => useObjectUrls())

    const url = result.current(file)

    expect(url).toBe('blob:photo.jpg')
    expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
  })

  it('returns the same URL when called twice with the same file', () => {
    const file = makeFile('photo.jpg')
    const { result } = renderHook(() => useObjectUrls())

    const url1 = result.current(file)
    const url2 = result.current(file)

    expect(url1).toBe(url2)
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1)
  })

  it('revokes all URLs on unmount', () => {
    const [f1, f2] = [makeFile('a.jpg'), makeFile('b.jpg')]
    const { result, unmount } = renderHook(() => useObjectUrls())

    result.current(f1)
    result.current(f2)
    unmount()

    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(2)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:a.jpg')
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:b.jpg')
  })
})
