import { describe, it, expect, vi, beforeEach } from 'vitest'
import { triggerDownload, downloadPhoto, downloadAll } from './download'
import type { PhotoEntry } from '@/hooks/usePhotos'

vi.mock('./exif-write', () => ({
  writeTimestamp: vi.fn(),
}))

import { writeTimestamp } from './exif-write'
const mockWriteTimestamp = vi.mocked(writeTimestamp)

// Stub URL and DOM globals
const mockCreateObjectURL = vi.fn(() => 'blob:test-url')
const mockRevokeObjectURL = vi.fn()
vi.stubGlobal('URL', {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
})

function makeEntry(name: string, type = 'image/jpeg'): PhotoEntry {
  return {
    file: new File([], name, { type }),
    filename: name,
    capturedAt: new Date('2025-01-01T10:00:00Z'),
    uploadIndex: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteTimestamp.mockImplementation(async (file) => file)
})

describe('triggerDownload', () => {
  it('creates an anchor with the correct download attribute and clicks it', () => {
    const clicks: string[] = []
    const mockClick = vi.fn(() => clicks.push('clicked'))
    vi.spyOn(document, 'createElement').mockReturnValueOnce(
      Object.assign(document.createElement('a'), { click: mockClick })
    )

    const blob = new Blob(['data'], { type: 'image/jpeg' })
    triggerDownload(blob, 'photo.jpg')

    expect(mockCreateObjectURL).toHaveBeenCalledWith(blob)
    expect(mockClick).toHaveBeenCalledTimes(1)
  })

  it('sets the download filename on the anchor', () => {
    let capturedDownload = ''
    const anchor = document.createElement('a')
    Object.defineProperty(anchor, 'download', {
      set: (v: string) => { capturedDownload = v },
      get: () => capturedDownload,
    })
    vi.spyOn(document, 'createElement').mockReturnValueOnce(anchor)

    triggerDownload(new Blob(['x']), 'my-file.jpg')

    expect(capturedDownload).toBe('my-file.jpg')
  })

  it('revokes the object URL after a timeout', async () => {
    vi.useFakeTimers()

    triggerDownload(new Blob(['data']), 'photo.jpg')

    expect(mockRevokeObjectURL).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:test-url')

    vi.useRealTimers()
  })
})

describe('downloadPhoto', () => {
  it('calls writeTimestamp with entry file and capturedAt, then triggers download', async () => {
    const entry = makeEntry('photo.jpg')
    const modifiedBlob = new Blob(['modified'], { type: 'image/jpeg' })
    mockWriteTimestamp.mockResolvedValue(modifiedBlob)

    const anchor = document.createElement('a')
    const clickSpy = vi.spyOn(anchor, 'click')
    vi.spyOn(document, 'createElement').mockReturnValueOnce(anchor)

    await downloadPhoto(entry)

    expect(mockWriteTimestamp).toHaveBeenCalledWith(entry.file, entry.capturedAt)
    expect(mockCreateObjectURL).toHaveBeenCalledWith(modifiedBlob)
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('uses new Date() as fallback when capturedAt is null', async () => {
    const entry = { ...makeEntry('photo.jpg'), capturedAt: null }
    await downloadPhoto(entry)

    const [, passedDate] = mockWriteTimestamp.mock.calls[0]
    expect(passedDate).toBeInstanceOf(Date)
  })

  it('passes PNG file to writeTimestamp (which passes it through unchanged)', async () => {
    const entry = makeEntry('photo.png', 'image/png')
    await downloadPhoto(entry)

    expect(mockWriteTimestamp).toHaveBeenCalledWith(entry.file, entry.capturedAt)
  })
})

describe('downloadAll', () => {
  it('calls downloadPhoto for each entry in order', async () => {
    vi.useFakeTimers()

    const entries = [makeEntry('a.jpg'), makeEntry('b.jpg'), makeEntry('c.jpg')]
    const anchors = entries.map(() => {
      const a = document.createElement('a')
      vi.spyOn(a, 'click')
      return a
    })

    let callCount = 0
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag === 'a') return anchors[callCount++]
      return document.createElement(tag)
    })

    const downloadPromise = downloadAll(entries, 60)
    await vi.runAllTimersAsync()
    await downloadPromise

    expect(mockWriteTimestamp).toHaveBeenCalledTimes(3)
    expect(mockWriteTimestamp.mock.calls[0][0]).toBe(entries[0].file)
    expect(mockWriteTimestamp.mock.calls[1][0]).toBe(entries[1].file)
    expect(mockWriteTimestamp.mock.calls[2][0]).toBe(entries[2].file)

    vi.useRealTimers()
  })
})