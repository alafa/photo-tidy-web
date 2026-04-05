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
