import { describe, it, expect, vi, beforeEach } from 'vitest'
import { triggerDownload, buildPhotoZipBlob } from './download'
import type { PhotoEntry } from '@/hooks/usePhotos'

vi.mock('./exif-write', () => ({
  writeTimestamp: vi.fn(),
}))

import { writeTimestamp } from './exif-write'
const mockWriteTimestamp = vi.mocked(writeTimestamp)

vi.mock('client-zip', () => ({
  downloadZip: vi.fn(),
}))

import { downloadZip } from 'client-zip'
const mockDownloadZip = vi.mocked(downloadZip)

// Stub URL and DOM globals
const mockCreateObjectURL = vi.fn(() => 'blob:test-url')
const mockRevokeObjectURL = vi.fn()
vi.stubGlobal('URL', {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
})

function makeEntry(name: string, type = 'image/jpeg'): PhotoEntry {
  return {
    id: name,
    file: new File([], name, { type }),
    filename: name,
    capturedAt: new Date('2025-01-01T10:00:00Z'),
    uploadIndex: 0,
    source: 'local',
  }
}

type CapturedZipEntry = { name: string; lastModified: Date; input: Blob }
let capturedZipEntries: CapturedZipEntry[] = []

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteTimestamp.mockImplementation(async (file) => file)
  capturedZipEntries = []
  mockDownloadZip.mockImplementation((files) => {
    return {
      blob: async () => {
        for await (const f of files as AsyncIterable<CapturedZipEntry>) {
          capturedZipEntries.push(f)
        }
        return new Blob(['zip'], { type: 'application/zip' })
      },
    } as unknown as Response
  })
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

describe('buildPhotoZipBlob', () => {
  it('builds a Blob from N entries, calling writeTimestamp in the exact given order', async () => {
    const entries = [makeEntry('a.jpg'), makeEntry('b.jpg'), makeEntry('c.jpg')]

    const blob = await buildPhotoZipBlob(entries)

    expect(blob).toBeInstanceOf(Blob)
    expect(mockDownloadZip).toHaveBeenCalledTimes(1)
    expect(mockWriteTimestamp).toHaveBeenCalledTimes(3)
    expect(mockWriteTimestamp.mock.calls[0][0]).toBe(entries[0].file)
    expect(mockWriteTimestamp.mock.calls[1][0]).toBe(entries[1].file)
    expect(mockWriteTimestamp.mock.calls[2][0]).toBe(entries[2].file)
  })

  it('de-duplicates a repeated filename by appending a numeric suffix before the extension', async () => {
    const entries = [makeEntry('photo.jpg'), makeEntry('photo.jpg')]

    await buildPhotoZipBlob(entries)

    expect(capturedZipEntries[0].name).toBe('photo.jpg')
    expect(capturedZipEntries[1].name).toBe('photo (2).jpg')
  })

  it('falls back to new Date() for capturedAt null, used for both writeTimestamp and lastModified', async () => {
    const entry = { ...makeEntry('photo.jpg'), capturedAt: null }

    await buildPhotoZipBlob([entry])

    const [, passedDate] = mockWriteTimestamp.mock.calls[0]
    expect(passedDate).toBeInstanceOf(Date)
    expect(capturedZipEntries[0].lastModified).toBe(passedDate)
  })

  it('sets the ZIP entry lastModified from capturedAt for a non-JPEG entry even though writeTimestamp passes bytes through unchanged', async () => {
    const entry = makeEntry('photo.png', 'image/png')

    await buildPhotoZipBlob([entry])

    expect(mockWriteTimestamp).toHaveBeenCalledWith(entry.file, entry.capturedAt)
    expect(capturedZipEntries[0].lastModified).toBe(entry.capturedAt)
    expect(capturedZipEntries[0].input).toBe(entry.file)
  })

  it('calls onProgress once per resolved entry with an increasing done and a constant total', async () => {
    const entries = [makeEntry('a.jpg'), makeEntry('b.jpg'), makeEntry('c.jpg')]
    const onProgress = vi.fn()

    await buildPhotoZipBlob(entries, onProgress)

    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 3)
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 3)
    expect(onProgress).toHaveBeenNthCalledWith(3, 3, 3)
  })
})
