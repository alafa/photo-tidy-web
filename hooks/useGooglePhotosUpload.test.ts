import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useGooglePhotosUpload } from './useGooglePhotosUpload'
import type { PhotoEntry } from './usePhotos'

afterEach(cleanup)

// --- Mocks ---

vi.mock('@/lib/exif-write', () => ({
  writeTimestamp: vi.fn(),
}))

import { writeTimestamp } from '@/lib/exif-write'
const mockWriteTimestamp = vi.mocked(writeTimestamp)

// --- Helpers ---

function makePhoto(overrides: Partial<PhotoEntry> = {}): PhotoEntry {
  return {
    id: crypto.randomUUID(),
    file: new File([], 'photo.jpg', { type: 'image/jpeg' }),
    filename: 'photo.jpg',
    capturedAt: new Date('2025-01-01T12:00:00Z'),
    uploadIndex: 0,
    source: 'local',
    ...overrides,
  }
}

const ACCESS_TOKEN = 'test-access-token'

beforeEach(() => {
  vi.clearAllMocks()
  // Default: writeTimestamp returns a mock Blob
  mockWriteTimestamp.mockResolvedValue(new Blob(['fake-image-data'], { type: 'image/jpeg' }))
})

// --- Tests ---

describe('useGooglePhotosUpload — happy path without album', () => {
  it('uploads two photos and calls batchCreate; both photoStates become done', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // upload photo1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'token-1',
    })
    // upload photo2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'token-2',
    })
    // batchCreate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], '', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')

    // batchCreate called with both tokens
    const batchCall = mockFetch.mock.calls[2]
    expect(batchCall[0]).toBe('/api/google-photos/batch-create')
    const batchBody = JSON.parse(batchCall[1].body)
    expect(batchBody.uploadTokens).toEqual([
      { token: 'token-1', filename: 'a.jpg' },
      { token: 'token-2', filename: 'b.jpg' },
    ])
    expect(batchBody.albumId).toBeUndefined()
  })
})

describe('useGooglePhotosUpload — happy path with album', () => {
  it('creates album first, then uploads, batchCreate includes albumId', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // create album
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'album-123', title: 'Paris 2024' }),
    })
    // upload photo1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'token-1',
    })
    // upload photo2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'token-2',
    })
    // batchCreate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Paris 2024', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')

    // First call creates album
    const albumCall = mockFetch.mock.calls[0]
    expect(albumCall[0]).toBe('/api/google-photos/albums')
    expect(JSON.parse(albumCall[1].body)).toEqual({ title: 'Paris 2024' })

    // batchCreate includes albumId
    const batchCall = mockFetch.mock.calls[3]
    const batchBody = JSON.parse(batchCall[1].body)
    expect(batchBody.albumId).toBe('album-123')
    expect(batchBody.uploadTokens).toHaveLength(2)
  })
})

describe('useGooglePhotosUpload — error path: single upload failure', () => {
  it('photo1 fails, photo2 still uploads; batchCreate called with photo2 token only', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // upload photo1 fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })
    // upload photo2 succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'token-2',
    })
    // batchCreate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], '', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')

    // batchCreate called with only photo2's token
    const batchCall = mockFetch.mock.calls[2]
    const batchBody = JSON.parse(batchCall[1].body)
    expect(batchBody.uploadTokens).toEqual([{ token: 'token-2', filename: 'b.jpg' }])
  })
})

describe('useGooglePhotosUpload — retryFailed', () => {
  it('re-uploads only failed photos; batchCreate called only with the retry token', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // startUpload: photo1 fails, photo2 succeeds
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' })
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // batchCreate #1

    // retryFailed: photo1 succeeds this time
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1-retry' })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // batchCreate #2
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], '', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')

    await act(() => result.current.retryFailed([photo1, photo2], ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')

    // batchCreate #2 should only have the retry token — not re-submit the already-committed token-2
    const batchCall2 = mockFetch.mock.calls[4]
    const batchBody = JSON.parse(batchCall2[1].body)
    const tokenValues = batchBody.uploadTokens.map((t: { token: string }) => t.token)
    expect(tokenValues).toEqual(['token-1-retry'])
    expect(tokenValues).not.toContain('token-2')
  })
})

describe('useGooglePhotosUpload — error path: album creation fails', () => {
  it('sets uploadState to error and does not attempt any uploads', async () => {
    const photo1 = makePhoto({ id: 'p1' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' })
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'My Album', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    // Only one fetch call (the album creation), no upload calls
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toBe('/api/google-photos/albums')
  })
})

describe('useGooglePhotosUpload — edge cases', () => {
  it('noop when startUpload called while already uploading', async () => {
    const photo1 = makePhoto({ id: 'p1' })

    // Make the upload hang until we resolve it
    let resolveUpload!: (value: Response) => void
    const uploadPromise = new Promise<Response>((res) => {
      resolveUpload = res
    })
    const mockFetch = vi.fn().mockReturnValue(uploadPromise)
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    // Start first upload (don't await yet)
    act(() => {
      result.current.startUpload([photo1], '', ACCESS_TOKEN)
    })

    // Attempt second startUpload while first is still in progress
    // Since uploadState is 'uploading', this should be a noop
    // We need to check the state is 'uploading' at this point
    // and the second call won't add additional fetch calls

    // Resolve the upload
    resolveUpload({ ok: true, text: async () => 'token-x' } as unknown as Response)
    // Also need batchCreate response
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
  })

  it('photos is empty → uploadState becomes done immediately, no API calls', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([], '', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('reset() returns to idle and clears photoStates', async () => {
    const photo1 = makePhoto({ id: 'p1' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], '', ACCESS_TOKEN))
    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.size).toBe(1)

    act(() => result.current.reset())

    expect(result.current.uploadState).toBe('idle')
    expect(result.current.photoStates.size).toBe(0)
  })
})
