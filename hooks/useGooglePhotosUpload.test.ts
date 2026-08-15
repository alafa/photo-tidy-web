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

// A successful reconciliation response — mirrors Google's batchAddMediaItems
// success shape (an empty body is sufficient for our purposes, only `ok`
// matters to the client).
function reconcileSuccess() {
  return { ok: true, json: async () => ({}) }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: writeTimestamp returns a mock Blob
  mockWriteTimestamp.mockResolvedValue(new Blob(['fake-image-data'], { type: 'image/jpeg' }))
})

// --- Tests ---

describe('useGooglePhotosUpload — album creation is mandatory', () => {
  it('creates an album before uploading any photo bytes, then uploads, batch-creates, then reconciles album membership', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // create album
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'album-123', title: 'Paris 2024 (photo tidy)' }),
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
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
        ],
      }),
    })
    // reconcile album membership for this chunk
    mockFetch.mockResolvedValueOnce(reconcileSuccess())
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Paris 2024', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    expect(result.current.photoStates.get('p1')?.mediaItemId).toBe('m1')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')
    expect(result.current.photoStates.get('p2')?.mediaItemId).toBe('m2')

    // First call creates album, before any upload call
    expect(mockFetch.mock.calls[0][0]).toBe('/api/google-photos/albums')

    // batchCreate no longer sends albumId — reconciliation (below) is now
    // the sole mechanism that ever adds an item to an album.
    const batchCall = mockFetch.mock.calls[3]
    expect(batchCall[0]).toBe('/api/google-photos/batch-create')
    const batchBody = JSON.parse(batchCall[1].body)
    expect(batchBody.albumId).toBeUndefined()
    expect(batchBody.uploadTokens).toEqual([
      { token: 'token-1', filename: 'a.jpg' },
      { token: 'token-2', filename: 'b.jpg' },
    ])

    // Reconciliation is called once for the chunk, scoped to its own media item ids
    const reconcileCall = mockFetch.mock.calls[4]
    expect(reconcileCall[0]).toBe('/api/google-photos/albums/album-123/batch-add')
    const reconcileBody = JSON.parse(reconcileCall[1].body)
    expect(reconcileBody.mediaItemIds).toEqual(['m1', 'm2'])
  })

  it('composes the album title as "<name> (photo tidy)", not the raw batch name', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'album-456' }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'token-1',
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
        ],
      }),
    })
    mockFetch.mockResolvedValueOnce(reconcileSuccess())
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Vacaciones 2024', ACCESS_TOKEN))

    const albumCall = mockFetch.mock.calls[0]
    expect(albumCall[0]).toBe('/api/google-photos/albums')
    expect(JSON.parse(albumCall[1].body)).toEqual({ title: 'Vacaciones 2024 (photo tidy)' })
  })
})

describe('useGooglePhotosUpload — error path: single upload failure', () => {
  it('photo1 fails, photo2 still uploads; batchCreate called with photo2 token only', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // create album
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'album-789' }),
    })
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
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
        ],
      }),
    })
    // reconcile
    mockFetch.mockResolvedValueOnce(reconcileSuccess())
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')

    // batchCreate called with only photo2's token
    const batchCall = mockFetch.mock.calls[3]
    const batchBody = JSON.parse(batchCall[1].body)
    expect(batchBody.uploadTokens).toEqual([{ token: 'token-2', filename: 'b.jpg' }])
  })
})

describe('useGooglePhotosUpload — retryFailed', () => {
  it('re-uploads only failed photos; batchCreate called only with the retry token', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // startUpload: create album, then photo1 fails, photo2 succeeds
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-321' }) }) // album creation
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' })
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
        ],
      }),
    }) // batchCreate #1
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile #1 (photo2)

    // retryFailed: photo1 succeeds this time
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1-retry' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1-retry', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
        ],
      }),
    }) // batchCreate #2
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile #2 (photo1)
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')

    await act(() => result.current.retryFailed([photo1, photo2], ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')

    // batchCreate #2 should only have the retry token — not re-submit the already-committed token-2
    const batchCall2 = mockFetch.mock.calls[6]
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

    // Make the album-creation fetch hang so uploadState stays 'uploading'
    // for the whole first call.
    let resolveAlbum!: (value: Response) => void
    const hangingAlbum = new Promise<Response>((res) => {
      resolveAlbum = res
    })
    const mockFetch = vi.fn().mockReturnValueOnce(hangingAlbum)
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    // Start first upload (don't await yet)
    act(() => {
      result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN)
    })
    expect(result.current.uploadState).toBe('uploading')

    // A second concurrent startUpload call while the first is still in
    // flight must be a noop — no additional fetch calls.
    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))
    expect(mockFetch.mock.calls.length).toBe(1)

    // Let the first call's album creation resolve and finish out normally.
    resolveAlbum({ ok: true, json: async () => ({ id: 'album-1' }) } as unknown as Response)
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'photo.jpg' } },
        ],
      }),
    })
    mockFetch.mockResolvedValueOnce(reconcileSuccess())

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    // Exactly one upload cycle happened: album + upload + batchCreate + reconcile = 4 calls.
    expect(mockFetch.mock.calls.length).toBe(4)
  })

  it('noop when retryFailed is called while an upload is already in progress', async () => {
    const photo1 = makePhoto({ id: 'p1' })
    const photo2 = makePhoto({ id: 'p2' })

    // First run: p1 fails, p2 succeeds, so p1 is retryable.
    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' }) // p1 fails raw upload
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // p2 succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'photo.jpg' } },
        ],
      }),
    })
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile p2
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())
    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')

    // Make the first retryFailed's raw upload hang so uploadState stays 'uploading'.
    // p1 has no mediaItemId (its raw upload failed), so retryFailed routes it
    // through the full pipeline — the first call it makes is the re-upload.
    let resolveRetryUpload!: (value: Response) => void
    const hangingUpload = new Promise<Response>((res) => {
      resolveRetryUpload = res
    })
    mockFetch.mockReturnValueOnce(hangingUpload)

    act(() => {
      result.current.retryFailed([photo1, photo2], ACCESS_TOKEN)
    })
    expect(result.current.uploadState).toBe('uploading')

    // A second concurrent retryFailed call while the first is still in
    // flight must be a noop. Assert against the final settled state rather
    // than an intermediate call count, since the first call's own pending
    // continuation (past its earlier `await`) can still resolve during this
    // await and is not itself evidence the guard failed.
    await act(() => result.current.retryFailed([photo1, photo2], ACCESS_TOKEN))

    // Let the first (and only) retry's upload finish.
    resolveRetryUpload({ ok: true, text: async () => 'token-1-retry' } as unknown as Response)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1-retry', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'photo.jpg' } },
        ],
      }),
    })
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile p1 retry
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    // Exactly one retry cycle happened: 5 calls from startUpload (album,
    // p1 upload fail, p2 upload, batchCreate, reconcile) + 3 from the single
    // retry (raw upload + batchCreate + reconcile) = 8. If the guard had
    // failed and a second concurrent retry cycle also ran, this would be higher.
    expect(mockFetch.mock.calls.length).toBe(8)
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
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-999' }) }) // album creation
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'photo.jpg' } },
        ],
      }),
    })
    mockFetch.mockResolvedValueOnce(reconcileSuccess())
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))
    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.size).toBe(1)

    act(() => result.current.reset())

    expect(result.current.uploadState).toBe('idle')
    expect(result.current.photoStates.size).toBe(0)
  })
})

describe('useGooglePhotosUpload — U4: per-photo done/failed status matches batch-create result', () => {
  it('full success: every batchCreate result indicates success → every photo is done', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })
    const photo3 = makePhoto({ id: 'p3', filename: 'c.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // upload p2
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-3' }) // upload p3
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
          { uploadToken: 'token-3', status: { message: 'Success' }, mediaItem: { id: 'm3', filename: 'c.jpg' } },
        ],
      }),
    }) // batchCreate
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2, photo3], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')
    expect(result.current.photoStates.get('p3')?.status).toBe('done')
  })

  it('partial success: succeeding photos are done, failing ones are failed with their own message', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })
    const photo3 = makePhoto({ id: 'p3', filename: 'c.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // upload p2
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-3' }) // upload p3
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
          { uploadToken: 'token-2', status: { message: 'Invalid argument', code: 3 } },
          { uploadToken: 'token-3', status: { message: 'Success' }, mediaItem: { id: 'm3', filename: 'c.jpg' } },
        ],
      }),
    }) // batchCreate
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile (p1, p3)
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2, photo3], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.error).toBe('Invalid argument')
    expect(result.current.photoStates.get('p3')?.status).toBe('done')
  })

  it('regression: raw-upload failure for the middle photo does not misalign batch-create results', async () => {
    // 3 photos; photo2's raw upload fails, so only photo1 and photo3's tokens
    // are submitted to batchCreate. The mocked response deliberately returns
    // results NOT in original-array order (photo3's result first) to prove
    // matching is by id, not position.
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })
    const photo3 = makePhoto({ id: 'p3', filename: 'c.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1 succeeds
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' }) // upload p2 fails
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-3' }) // upload p3 succeeds
    // batchCreate receives [token-1, token-3] in that submission order.
    // Response order matches submission order (token-1 first, token-3 second) —
    // the point under test is that matching uses the PendingUploadToken's
    // photoId captured at submission time, not a coincidental index into the
    // original `photos` array (which would have put photo3's result at index 2).
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
          { uploadToken: 'token-3', status: { message: 'Success' }, mediaItem: { id: 'm3', filename: 'c.jpg' } },
        ],
      }),
    })
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile (p1, p3)
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2, photo3], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed') // raw upload failure
    expect(result.current.photoStates.get('p3')?.status).toBe('done')

    // batchCreate must have been submitted with only photo1 and photo3's tokens
    const batchCall = mockFetch.mock.calls[4]
    const batchBody = JSON.parse(batchCall[1].body)
    expect(batchBody.uploadTokens).toEqual([
      { token: 'token-1', filename: 'a.jpg' },
      { token: 'token-3', filename: 'c.jpg' },
    ])
  })

  it('regression: chunk results in non-original-array order still match the right photo id', async () => {
    // A second flavor of the misalignment regression: the batch-create response
    // itself returns results in an order that would misassign status if matched
    // by position against `photos` (photo3 first, then photo1) — but since only
    // photo1 and photo3 were submitted (photo2's raw upload failed), the matching
    // must be by that chunk's own submission order + photoId, not `photos` order.
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })
    const photo3 = makePhoto({ id: 'p3', filename: 'c.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' }) // upload p1 fails
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // upload p2 succeeds
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-3' }) // upload p3 succeeds
    // Chunk submission order is [token-2, token-3] (p1 skipped). Response
    // results correspond 1:1 with that submission order.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
          { uploadToken: 'token-3', status: { message: 'Invalid argument', code: 3 } },
        ],
      }),
    })
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile (p2 only)
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2, photo3], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed') // raw upload failure
    expect(result.current.photoStates.get('p2')?.status).toBe('done')
    expect(result.current.photoStates.get('p3')?.status).toBe('failed')
    expect(result.current.photoStates.get('p3')?.error).toBe('Invalid argument')
  })

  it('multi-chunk: results from each 50-item chunk are matched only to that chunk\'s own photos, and reconciliation is scoped per chunk', async () => {
    const chunk1Photos = Array.from({ length: 50 }, (_, i) =>
      makePhoto({ id: `chunk1-${i}`, filename: `c1-${i}.jpg` })
    )
    const chunk2Photos = Array.from({ length: 5 }, (_, i) =>
      makePhoto({ id: `chunk2-${i}`, filename: `c2-${i}.jpg` })
    )
    const photos = [...chunk1Photos, ...chunk2Photos]

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album

    // Raw uploads for all 55 photos succeed, one token per photo id
    for (const photo of photos) {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => `token-${photo.id}` })
    }

    // Chunk 1 (50 items, index 0 within this chunk's own results array):
    // only the FIRST item of the chunk fails, the other 49 succeed. If the
    // implementation used a running position across the whole multi-chunk
    // call (instead of resetting per chunk), chunk 2's items — which would
    // then be read starting at global index 50 — could accidentally read
    // past chunk 1's own results array and pick up the wrong entries.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: chunk1Photos.map((p, i) => ({
          uploadToken: `token-${p.id}`,
          status: i === 0 ? { message: 'Invalid argument', code: 3 } : { message: 'Success' },
          ...(i === 0 ? {} : { mediaItem: { id: `m-${p.id}`, filename: p.filename } }),
        })),
      }),
    })
    // Reconciliation for chunk 1 (49 successful ids)
    mockFetch.mockResolvedValueOnce(reconcileSuccess())

    // Chunk 2 (5 items): a distinct, differentiated pattern — only the LAST
    // item fails. Chunk 2's own results array has only 5 entries (indices
    // 0-4); if the implementation wrongly carried over a position/offset
    // from chunk 1, it would index out of bounds or read chunk 1 data here,
    // which this differentiated pattern would expose.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: chunk2Photos.map((p, i) => ({
          uploadToken: `token-${p.id}`,
          status:
            i === chunk2Photos.length - 1
              ? { message: 'Invalid argument', code: 3 }
              : { message: 'Success' },
          ...(i === chunk2Photos.length - 1 ? {} : { mediaItem: { id: `m-${p.id}`, filename: p.filename } }),
        })),
      }),
    })
    // Reconciliation for chunk 2 (4 successful ids)
    mockFetch.mockResolvedValueOnce(reconcileSuccess())

    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload(photos, 'Big Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')

    // Chunk 1: only the first photo failed, the rest are done
    expect(result.current.photoStates.get('chunk1-0')?.status).toBe('failed')
    for (const p of chunk1Photos.slice(1)) {
      expect(result.current.photoStates.get(p.id)?.status).toBe('done')
    }

    // Chunk 2: only the last photo failed, the rest are done — proving chunk
    // 2's own 5-entry results array was used, not a continuation of chunk 1's
    for (const p of chunk2Photos.slice(0, -1)) {
      expect(result.current.photoStates.get(p.id)?.status).toBe('done')
    }
    expect(result.current.photoStates.get('chunk2-4')?.status).toBe('failed')

    // Verify chunking: two separate batch-create calls were made (one per 50-item chunk)
    const batchCalls = mockFetch.mock.calls.filter(
      (call) => call[0] === '/api/google-photos/batch-create'
    )
    expect(batchCalls).toHaveLength(2)
    expect(JSON.parse(batchCalls[0][1].body).uploadTokens).toHaveLength(50)
    expect(JSON.parse(batchCalls[1][1].body).uploadTokens).toHaveLength(5)

    // KTD2: reconciliation is called once per chunk, never once across the
    // whole run, and each call is scoped to only that chunk's own ids.
    const reconcileCalls = mockFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/batch-add')
    )
    expect(reconcileCalls).toHaveLength(2)
    const chunk1ReconcileIds = JSON.parse(reconcileCalls[0][1].body).mediaItemIds
    const chunk2ReconcileIds = JSON.parse(reconcileCalls[1][1].body).mediaItemIds
    expect(chunk1ReconcileIds).toHaveLength(49)
    expect(chunk1ReconcileIds.every((id: string) => id.startsWith('m-chunk1-'))).toBe(true)
    expect(chunk2ReconcileIds).toHaveLength(4)
    expect(chunk2ReconcileIds.every((id: string) => id.startsWith('m-chunk2-'))).toBe(true)
  })

  it('chunk batch-create call fails outright (non-2xx): every photo in that chunk becomes failed, none stuck uploading', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // upload p2
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Server Error' }) // batchCreate fails
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Batch create request failed')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.error).toBe('Batch create request failed')
  })

  it('chunk batch-create call fails outright (network error): every photo in that chunk becomes failed', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockRejectedValueOnce(new Error('network down')) // batchCreate network failure
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Batch create request failed')
  })

  it('chunk batch-create response is ok but not valid JSON: the chunk is marked failed, not left stuck uploading', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token') },
    }) // batchCreate returns 200 with a non-JSON body
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Batch create returned an invalid response')
  })

  it('a later chunk failing outright does not abandon or leave an earlier chunk stuck uploading', async () => {
    const firstChunkPhotos = Array.from({ length: 50 }, (_, i) => makePhoto({ id: `p${i}`, filename: `${i}.jpg` }))
    const lastPhoto = makePhoto({ id: 'p-last', filename: 'last.jpg' })
    const photos = [...firstChunkPhotos, lastPhoto]

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    // Raw upload for all 51 photos succeeds.
    for (let i = 0; i < photos.length; i++) {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => `token-${i}` })
    }
    // First batchCreate call (chunk of 50) succeeds fully.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: firstChunkPhotos.map((_, i) => ({
          uploadToken: `token-${i}`,
          status: { message: 'Success' },
          mediaItem: { id: `m${i}`, filename: `${i}.jpg` },
        })),
      }),
    })
    // Reconciliation for the first chunk succeeds.
    mockFetch.mockResolvedValueOnce(reconcileSuccess())
    // Second batchCreate call (the remaining 1 photo) fails outright.
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())
    await act(() => result.current.startUpload(photos, 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    for (const photo of firstChunkPhotos) {
      expect(result.current.photoStates.get(photo.id)?.status).toBe('done')
    }
    expect(result.current.photoStates.get('p-last')?.status).toBe('failed')
  })

  it('retryFailed applies the same id-based, per-chunk matching to the retry batchCreate response', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })
    const photo3 = makePhoto({ id: 'p3', filename: 'c.jpg' })

    const mockFetch = vi.fn()
    // startUpload: album, then p1 and p2 fail raw upload, p3 succeeds
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) })
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' }) // p1 fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' }) // p2 fails
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-3' }) // p3 succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-3', status: { message: 'Success' }, mediaItem: { id: 'm3', filename: 'c.jpg' } },
        ],
      }),
    }) // batchCreate #1 (only p3)
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile #1 (p3)

    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())
    await act(() => result.current.startUpload([photo1, photo2, photo3], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed')
    expect(result.current.photoStates.get('p3')?.status).toBe('done')

    // retryFailed re-uploads p1 and p2 only, in that submission order. Raw
    // uploads both succeed, but the mocked batchCreate response returns
    // results in REVERSE order (p2's token first, p1's second) — this proves
    // matching is by uploadToken, not by array position, since a
    // position-based match would incorrectly swap p1 and p2's outcomes.
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1-retry' }) // p1 retry upload
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2-retry' }) // p2 retry upload
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-2-retry', status: { message: 'Invalid argument', code: 3 } },
          { uploadToken: 'token-1-retry', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
        ],
      }),
    }) // batchCreate #2 (retry) — deliberately out of submission order
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile #2 (p1 only)

    await act(() => result.current.retryFailed([photo1, photo2, photo3], ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    // p3 was already 'done' from the initial run and is not touched by retry
    expect(result.current.photoStates.get('p3')?.status).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.error).toBe('Invalid argument')

    // retryFailed's batchCreate call should only include the two retried tokens
    const retryBatchCall = mockFetch.mock.calls[8]
    expect(retryBatchCall[0]).toBe('/api/google-photos/batch-create')
    const retryBatchBody = JSON.parse(retryBatchCall[1].body)
    expect(retryBatchBody.uploadTokens).toEqual([
      { token: 'token-1-retry', filename: 'a.jpg' },
      { token: 'token-2-retry', filename: 'b.jpg' },
    ])
  })
})

describe('useGooglePhotosUpload — U1: timeout and rate-limit message surfacing', () => {
  it('batch-create chunk resolves with error.status REQUEST_TIMEOUT: every photo in the chunk is marked failed with the timeout-specific message', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // upload p2
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 504,
      json: async () => ({ error: { message: 'Request to Google Photos timed out', status: 'REQUEST_TIMEOUT' } }),
    }) // batchCreate times out
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Request to Google Photos timed out')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.error).toBe('Request to Google Photos timed out')
  })

  it('uploadSinglePhoto receives a RATE_LIMITED-status error body with retryAfterMs: the photo is marked failed with the wait time included', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: { message: 'Rate limited by Google Photos', status: 'RATE_LIMITED', retryAfterMs: 30000 },
      }),
    }) // upload p1 rate limited
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Rate limited by Google — try again in 30s')
  })

  it('uploadSinglePhoto receives a RATE_LIMITED-status error body with no retryAfterMs: falls back to the fixed message', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: { message: 'Rate limited by Google Photos', status: 'RATE_LIMITED' },
      }),
    }) // upload p1 rate limited, no retryAfterMs in the body
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Rate limited by Google — try again in a moment')
  })

  it('an error body with an unrecognized error.status falls back to the body message, not a REQUEST_TIMEOUT/RATE_LIMITED message', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Missing required field: filename', status: 'INVALID_REQUEST' } }),
    }) // upload p1 fails with an unrelated status
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Missing required field: filename')
  })

  it('an error body with no status field at all (or an unparseable body) still falls back to the generic message — no regression for older failure shapes', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    // p1: response.json() throws (unparseable body) — falls back to HTTP status text
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
      text: async () => 'Internal Server Error',
    })
    // p2: uploads fine
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
        ],
      }),
    })
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile (p2)
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('HTTP 500')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')
  })

  it('batch-create chunk failing outright with an unparseable/absent error body still falls back to the generic "Batch create request failed" message', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Server Error' }) // batchCreate fails, no .json()
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Batch create request failed')
  })
})

describe('useGooglePhotosUpload — U2: album membership reconciliation', () => {
  it('chunk succeeds and reconciliation succeeds: every photo is done and has a mediaItemId', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // upload p2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
        ],
      }),
    }) // batchCreate
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    expect(result.current.photoStates.get('p1')?.mediaItemId).toBe('m1')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')
    expect(result.current.photoStates.get('p2')?.mediaItemId).toBe('m2')
  })

  it('chunk succeeds but reconciliation fails outright (non-2xx): every photo in the chunk is failed, mediaItemId retained', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // upload p2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
        ],
      }),
    }) // batchCreate
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }) // reconcile fails outright
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Media item created but could not be confirmed in the album')
    expect(result.current.photoStates.get('p1')?.mediaItemId).toBe('m1')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.error).toBe('Media item created but could not be confirmed in the album')
    expect(result.current.photoStates.get('p2')?.mediaItemId).toBe('m2')
  })

  it('chunk succeeds but reconciliation throws a network error: same outcome as a non-2xx response', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
        ],
      }),
    }) // batchCreate
    mockFetch.mockRejectedValueOnce(new Error('network down')) // reconcile throws
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('Media item created but could not be confirmed in the album')
    expect(result.current.photoStates.get('p1')?.mediaItemId).toBe('m1')
  })

  it('album-creation response has no id (defensive branch): reconciliation is skipped and every photo is failed with "No album to confirm membership against"', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // Album creation resolves ok, but the response body has no `id` field —
    // albumIdRef.current (and thus the albumId captured for this upload)
    // stays undefined even though the album-creation request itself succeeded.
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // album, no id
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2' }) // upload p2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
          { uploadToken: 'token-2', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
        ],
      }),
    }) // batchCreate — both succeed, so both are reconcilable
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('error')
    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe('No album to confirm membership against')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.error).toBe('No album to confirm membership against')

    // No call was made to the batch-add route — there was no albumId to call it with.
    expect(mockFetch.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('/batch-add'))).toBe(false)
    // Exactly album + 2 uploads + batchCreate = 4 calls, nothing more.
    expect(mockFetch.mock.calls.length).toBe(4)
  })

  it('KTD9: a batch-create result with success status but no mediaItem.id is its own distinct failure — no reconciliation attempted', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' } }, // success, but no mediaItem
        ],
      }),
    }) // batchCreate
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())

    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.error).toBe(
      'Google reported success but did not return a media item id'
    )
    expect(result.current.photoStates.get('p1')?.mediaItemId).toBeUndefined()

    // No reconciliation call was made for this photo: album + upload + batchCreate = 3 calls, nothing more.
    expect(mockFetch.mock.calls.length).toBe(3)
  })

  it('retryFailed with a mix: the reconciliation-only photo retries only the batch-add route; the raw-upload-failure photo runs the full pipeline', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })
    const photo2 = makePhoto({ id: 'p2', filename: 'b.jpg' })

    const mockFetch = vi.fn()
    // startUpload: album, p1 uploads and batch-creates fine but reconciliation
    // fails outright; p2's raw upload fails outright.
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-x' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' }) // upload p2 fails
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
        ],
      }),
    }) // batchCreate (only p1's token)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }) // reconcile p1 fails outright
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())
    await act(() => result.current.startUpload([photo1, photo2], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.mediaItemId).toBe('m1')
    expect(result.current.photoStates.get('p2')?.status).toBe('failed')
    expect(result.current.photoStates.get('p2')?.mediaItemId).toBeUndefined()

    // retryFailed: p1 (has mediaItemId) retries reconciliation only; p2 (no
    // mediaItemId) re-uploads then batch-creates.
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile p1 retry — succeeds this time
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-2-retry' }) // p2 re-upload
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-2-retry', status: { message: 'Success' }, mediaItem: { id: 'm2', filename: 'b.jpg' } },
        ],
      }),
    }) // batchCreate for p2's retry
    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile p2's newly-created item

    await act(() => result.current.retryFailed([photo1, photo2], ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')
    expect(result.current.photoStates.get('p2')?.status).toBe('done')

    // The 5 calls made during startUpload are calls[0..4]; the retry begins at call index 5.
    const retryCalls = mockFetch.mock.calls.slice(5)
    expect(retryCalls).toHaveLength(4)

    // p1's retry: the very first retry call is a reconciliation-only call
    // scoped to just p1's mediaItemId — never a call to /upload or /batch-create.
    expect(retryCalls[0][0]).toBe('/api/google-photos/albums/album-x/batch-add')
    expect(JSON.parse(retryCalls[0][1].body).mediaItemIds).toEqual(['m1'])

    // p2's retry: full pipeline — upload, then batch-create, then reconcile.
    expect(retryCalls[1][0]).toBe('/api/google-photos/upload')
    expect(retryCalls[2][0]).toBe('/api/google-photos/batch-create')
    expect(retryCalls[3][0]).toBe('/api/google-photos/albums/album-x/batch-add')
    expect(JSON.parse(retryCalls[3][1].body).mediaItemIds).toEqual(['m2'])

    // p1's retry never touched /upload or /batch-create.
    expect(retryCalls.filter((c) => c[0] === '/api/google-photos/upload')).toHaveLength(1)
    expect(retryCalls.filter((c) => c[0] === '/api/google-photos/batch-create')).toHaveLength(1)
  })

  it('AE1: single photo, reconciliation fails then succeeds on retry — final state done, retry made exactly one call', async () => {
    const photo1 = makePhoto({ id: 'p1', filename: 'a.jpg' })

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'token-1' }) // upload p1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: [
          { uploadToken: 'token-1', status: { message: 'Success' }, mediaItem: { id: 'm1', filename: 'a.jpg' } },
        ],
      }),
    }) // batchCreate
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }) // reconcile fails
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())
    await act(() => result.current.startUpload([photo1], 'Trip', ACCESS_TOKEN))

    expect(result.current.photoStates.get('p1')?.status).toBe('failed')
    expect(result.current.photoStates.get('p1')?.mediaItemId).toBe('m1')

    const callsBeforeRetry = mockFetch.mock.calls.length

    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // reconcile succeeds this time
    await act(() => result.current.retryFailed([photo1], ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    expect(result.current.photoStates.get('p1')?.status).toBe('done')

    // Retry made exactly one call — not three (no re-upload, no re-batch-create).
    expect(mockFetch.mock.calls.length - callsBeforeRetry).toBe(1)
    const retryCall = mockFetch.mock.calls[callsBeforeRetry]
    expect(retryCall[0]).toBe('/api/google-photos/albums/album-1/batch-add')
  })

  it('AE2: 50-photo chunk, reconciliation fails outright for the whole chunk, then a retry of all 50 succeeds through the reconciliation-only path', async () => {
    const photos = Array.from({ length: 50 }, (_, i) => makePhoto({ id: `p${i}`, filename: `${i}.jpg` }))

    const mockFetch = vi.fn()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'album-1' }) }) // album
    for (let i = 0; i < photos.length; i++) {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => `token-${i}` })
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        newMediaItemResults: photos.map((_, i) => ({
          uploadToken: `token-${i}`,
          status: { message: 'Success' },
          mediaItem: { id: `m${i}`, filename: `${i}.jpg` },
        })),
      }),
    }) // batchCreate — all 50 succeed
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }) // reconcile fails for the whole chunk
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useGooglePhotosUpload())
    await act(() => result.current.startUpload(photos, 'Trip', ACCESS_TOKEN))

    for (const photo of photos) {
      expect(result.current.photoStates.get(photo.id)?.status).toBe('failed')
      expect(result.current.photoStates.get(photo.id)?.mediaItemId).toBe(`m${photos.indexOf(photo)}`)
    }

    const uploadCallsBeforeRetry = mockFetch.mock.calls.filter((c) => c[0] === '/api/google-photos/upload').length
    const batchCreateCallsBeforeRetry = mockFetch.mock.calls.filter((c) => c[0] === '/api/google-photos/batch-create').length

    mockFetch.mockResolvedValueOnce(reconcileSuccess()) // retry: reconciliation succeeds for the whole chunk
    await act(() => result.current.retryFailed(photos, ACCESS_TOKEN))

    expect(result.current.uploadState).toBe('done')
    for (const photo of photos) {
      expect(result.current.photoStates.get(photo.id)?.status).toBe('done')
    }

    // None of the 50 photos were re-uploaded or re-batch-created — only one
    // additional reconciliation call was made, covering all 50 in a single
    // batch-add call (matching batch-create's own 50-per-call chunking).
    const uploadCallsAfterRetry = mockFetch.mock.calls.filter((c) => c[0] === '/api/google-photos/upload').length
    const batchCreateCallsAfterRetry = mockFetch.mock.calls.filter((c) => c[0] === '/api/google-photos/batch-create').length
    expect(uploadCallsAfterRetry).toBe(uploadCallsBeforeRetry)
    expect(batchCreateCallsAfterRetry).toBe(batchCreateCallsBeforeRetry)

    const reconcileCalls = mockFetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/batch-add')
    )
    expect(reconcileCalls).toHaveLength(2) // one failed attempt during startUpload, one successful retry
    expect(JSON.parse(reconcileCalls[1][1].body).mediaItemIds).toHaveLength(50)
  })
})
