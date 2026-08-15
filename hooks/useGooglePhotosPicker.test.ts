import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

afterEach(cleanup)

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock window.open
const mockWindowOpen = vi.fn()
vi.stubGlobal('open', mockWindowOpen)

import { useGooglePhotosPicker } from './useGooglePhotosPicker'
import type { PickerSession, MediaItemsResponse } from '@/lib/google-photos-types'

// ---- helpers ----

function makeSession(overrides?: Partial<PickerSession>): PickerSession {
  return {
    id: 'session-123',
    pickerUri: 'https://photos.google.com/picker?sessionId=session-123',
    pollingConfig: { pollInterval: '1s', timeoutIn: '300s' },
    expireTime: new Date(Date.now() + 3600_000).toISOString(),
    mediaItemsSet: false,
    ...overrides,
  }
}

function makeMediaItemsResponse(count = 2): MediaItemsResponse {
  const mediaItems = Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    type: 'PHOTO',
    mediaFile: {
      baseUrl: `https://lh3.googleusercontent.com/item${i}`,
      mimeType: 'image/jpeg',
      filename: `photo${i}.jpg`,
    },
    mediaMetadata: {
      creationTime: `2025-0${i + 1}-15T10:00:00Z`,
      width: '3024',
      height: '4032',
    },
  }))
  return { mediaItems }
}

function makeImageBlob(): Blob {
  return new Blob(['fake-image-bytes'], { type: 'image/jpeg' })
}

function makeVideoItem(id: string) {
  return {
    id,
    type: 'VIDEO',
    mediaFile: {
      baseUrl: `https://lh3.googleusercontent.com/${id}`,
      mimeType: 'video/mp4',
      filename: `${id}.mp4`,
    },
    mediaMetadata: {
      creationTime: '2025-01-15T10:00:00Z',
      width: '1920',
      height: '1080',
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWindowOpen.mockReturnValue(null)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---- tests ----

describe('useGooglePhotosPicker', () => {
  describe('happy path', () => {
    it('transitions idle → session-open → picking → downloading → idle and calls addPhotos', async () => {
      const session = makeSession()
      const itemsResp = makeMediaItemsResponse(2)
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      // 1: POST /sessions → session
      // 2: GET /sessions/session-123 → mediaItemsSet: true
      // 3: GET /sessions/session-123?items=true → items
      // 4,5: POST /download (x2)
      // 6: DELETE /sessions/session-123 (fire-and-forget)
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => itemsResp })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValue({ ok: true }) // DELETE

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'test-token', addPhotos })
      )

      expect(result.current.status).toBe('idle')

      // Start import and let the session creation + window.open + first poll interval pass
      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      // After all async work, status should be idle
      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBeNull()
      expect(addPhotos).toHaveBeenCalledOnce()

      const [files, source, capturedAts] = addPhotos.mock.calls[0]
      expect(source).toBe('google-photos')
      expect(files).toHaveLength(2)
      expect(files[0]).toBeInstanceOf(File)
      expect(capturedAts).toHaveLength(2)
      expect(capturedAts[0]).toBeInstanceOf(Date)
    })

    it('creates session with Authorization header', async () => {
      const session = makeSession()
      const itemsResp = makeMediaItemsResponse(1)
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => itemsResp })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValue({ ok: true })

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'my-token', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      const firstCall = mockFetch.mock.calls[0]
      expect(firstCall[0]).toBe('/api/google-photos/sessions')
      expect(firstCall[1].method).toBe('POST')
      expect(firstCall[1].headers.Authorization).toBe('Bearer my-token')
    })

    it('opens pickerUri in a new tab', async () => {
      const session = makeSession()
      const itemsResp = makeMediaItemsResponse(1)
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => itemsResp })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValue({ ok: true })

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'my-token', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(mockWindowOpen).toHaveBeenCalledWith(session.pickerUri, '_blank')
    })
  })

  describe('edge case: startImport with null accessToken is noop', () => {
    it('stays idle when accessToken is null', async () => {
      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: null, addPhotos })
      )

      await act(async () => {
        result.current.startImport()
      })

      expect(result.current.status).toBe('idle')
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('edge case: startImport when status !== idle is noop', () => {
    it('does not create a second session when already picking', async () => {
      const session = makeSession()
      // Never resolves mediaItemsSet, so status stays picking
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValue({ ok: true, json: async () => ({ ...session, mediaItemsSet: false }) })

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      // Start first import (will hang in polling)
      act(() => { result.current.startImport() })
      // Advance just enough for session creation
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })

      const callCountAfterFirst = mockFetch.mock.calls.length

      // Try starting again — should be noop
      await act(async () => { result.current.startImport() })

      expect(mockFetch.mock.calls.length).toBe(callCountAfterFirst)

      // Cleanup
      act(() => { result.current.cancelImport() })
    })
  })

  describe('edge case: session creation fails', () => {
    let consoleWarn: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // describeApiError uses console.warn (not console.error) so Next.js's dev-mode
      // error overlay doesn't hijack this recoverable, in-app error state.
      consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleWarn.mockRestore()
    })

    it('sets status=error with the real Google error detail and logs it', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: 403, message: 'Photos Picker API has not been used in this project', status: 'PERMISSION_DENIED' },
        }),
      })

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toContain('Photos Picker API has not been used in this project')
      expect(result.current.error).not.toBe('Failed to create import session')
      expect(consoleWarn).toHaveBeenCalled()
    })

    it('falls back to a status-qualified message when the error body has no detail', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toContain('500')
    })

    it('falls back to a status-qualified message when the error body is not valid JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toContain('500')
    })

    it('sets a generic network-failure message when fetch itself rejects', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toBeTruthy()
    })

    it('sets status=error when the response is ok but the body is not valid JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toBeTruthy()
      expect(mockWindowOpen).not.toHaveBeenCalled()
    })
  })

  describe('edge case: fetch selected photos fails', () => {
    let consoleWarn: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      consoleWarn.mockRestore()
    })

    it('sets status=error with the real Google error detail', async () => {
      const session = makeSession()

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: { code: 400, message: 'sessionId is invalid', status: 'INVALID_ARGUMENT' } }),
        })
        .mockResolvedValue({ ok: true }) // DELETE cleanup

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toContain('sessionId is invalid')
      expect(result.current.error).not.toBe('Failed to fetch selected photos')
    })

    it('sets status=error when the response is ok but the body is not valid JSON', async () => {
      const session = makeSession()

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token')
          },
        })
        .mockResolvedValue({ ok: true }) // DELETE cleanup

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toBeTruthy()
      expect(addPhotos).not.toHaveBeenCalled()
    })
  })

  describe('edge case: polling timeout', () => {
    it('sets status=error with timeout message and cleans up session', async () => {
      const session = makeSession({ pollingConfig: { pollInterval: '1s', timeoutIn: '5s' } })

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        // All polls return mediaItemsSet: false
        .mockResolvedValue({ ok: true, json: async () => ({ ...session, mediaItemsSet: false }) })

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        // Advance past the 5-second timeout
        await vi.advanceTimersByTimeAsync(6_000)
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('Import timed out. Please try again.')
      // Cleanup DELETE should have been called
      const deleteCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === `/api/google-photos/sessions/${session.id}` && c[1]?.method === 'DELETE'
      )
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('edge case: cancelImport while polling', () => {
    it('stops polling and resets to idle', async () => {
      const session = makeSession()

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValue({ ok: true, json: async () => ({ ...session, mediaItemsSet: false }) })

      const addPhotos = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      // Start import (hangs in poll)
      act(() => { result.current.startImport() })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })

      // Cancel while picking
      act(() => { result.current.cancelImport() })

      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBeNull()
      expect(addPhotos).not.toHaveBeenCalled()
    })
  })

  describe('edge case: one download fails', () => {
    it('calls addPhotos with only the successfully downloaded files', async () => {
      const session = makeSession()
      const itemsResp = makeMediaItemsResponse(3)
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => itemsResp })
        // Download 0: success
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        // Download 1: failure
        .mockResolvedValueOnce({ ok: false, status: 403 })
        // Download 2: success
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValue({ ok: true }) // DELETE

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('idle')
      expect(addPhotos).toHaveBeenCalledOnce()
      const [files] = addPhotos.mock.calls[0]
      expect(files).toHaveLength(2) // only the 2 that succeeded
    })
  })

  describe('edge case: empty media items list', () => {
    it('goes idle without calling addPhotos when no items selected', async () => {
      const session = makeSession()
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ mediaItems: [] }) })
        .mockResolvedValue({ ok: true })

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('idle')
      expect(addPhotos).not.toHaveBeenCalled()
    })
  })

  describe('edge case: videos in picker selection are filtered out', () => {
    it('calls addPhotos with only the photo files when selection is mixed photos and videos', async () => {
      const session = makeSession()
      const photoItems = makeMediaItemsResponse(2).mediaItems
      const videoItems = [makeVideoItem('vid-0'), makeVideoItem('vid-1')]
      const itemsResp = { mediaItems: [photoItems[0], videoItems[0], photoItems[1], videoItems[1]] }
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => itemsResp })
        // Only 2 downloads should happen — one per photo, videos never reach downloadBatch
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValue({ ok: true }) // DELETE

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('idle')
      expect(addPhotos).toHaveBeenCalledOnce()
      const [files] = addPhotos.mock.calls[0]
      expect(files).toHaveLength(2)

      // Confirm no download request was made for either video item's baseUrl
      const downloadCalls = mockFetch.mock.calls.filter((c) => c[0] === '/api/google-photos/download')
      expect(downloadCalls).toHaveLength(2)
      for (const call of downloadCalls) {
        const body = JSON.parse(call[1].body)
        expect(body.baseUrl).not.toBe(videoItems[0].mediaFile.baseUrl)
        expect(body.baseUrl).not.toBe(videoItems[1].mediaFile.baseUrl)
      }
    })

    it('behaves exactly like an empty selection when only videos were picked', async () => {
      const session = makeSession()
      const itemsResp = { mediaItems: [makeVideoItem('vid-0'), makeVideoItem('vid-1')] }
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => itemsResp })
        .mockResolvedValue({ ok: true }) // DELETE cleanup

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBeNull()
      expect(addPhotos).not.toHaveBeenCalled()

      // No download requests were ever made for the all-video selection
      const downloadCalls = mockFetch.mock.calls.filter((c) => c[0] === '/api/google-photos/download')
      expect(downloadCalls).toHaveLength(0)

      // Cleaned up via the same path as "nothing selected": session DELETE fired
      const deleteCalls = mockFetch.mock.calls.filter(
        (c) => c[0] === `/api/google-photos/sessions/${session.id}` && c[1]?.method === 'DELETE'
      )
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1)
    })

    it('excludes an item whose type and mimeType disagree, in either direction', async () => {
      const session = makeSession()
      const mismatchedItems = [
        // type: PHOTO but mimeType is not an image
        {
          id: 'mismatch-video-mime',
          type: 'PHOTO',
          mediaFile: {
            baseUrl: 'https://lh3.googleusercontent.com/mismatch-video-mime',
            mimeType: 'video/mp4',
            filename: 'mismatch-video-mime.mp4',
          },
          mediaMetadata: { creationTime: '2025-01-15T10:00:00Z', width: '1920', height: '1080' },
        },
        // type: VIDEO but mimeType is an image
        {
          id: 'mismatch-image-mime',
          type: 'VIDEO',
          mediaFile: {
            baseUrl: 'https://lh3.googleusercontent.com/mismatch-image-mime',
            mimeType: 'image/jpeg',
            filename: 'mismatch-image-mime.jpg',
          },
          mediaMetadata: { creationTime: '2025-01-15T10:00:00Z', width: '1920', height: '1080' },
        },
      ]
      const itemsResp = { mediaItems: mismatchedItems }
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => itemsResp })
        .mockResolvedValue({ ok: true }) // DELETE cleanup

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'tok', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('idle')
      expect(addPhotos).not.toHaveBeenCalled()
      const downloadCalls = mockFetch.mock.calls.filter((c) => c[0] === '/api/google-photos/download')
      expect(downloadCalls).toHaveLength(0)
    })
  })

  describe('edge case: media items response is paginated', () => {
    it('follows nextPageToken across multiple pages and imports every item, not just the first page', async () => {
      const session = makeSession()
      const page1 = { mediaItems: makeMediaItemsResponse(2).mediaItems, nextPageToken: 'page-2-token' }
      const page2 = { mediaItems: makeMediaItemsResponse(1).mediaItems }
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => page1 })
        .mockResolvedValueOnce({ ok: true, json: async () => page2 })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValue({ ok: true }) // DELETE

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'test-token', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBeNull()
      expect(addPhotos).toHaveBeenCalledOnce()
      const [files] = addPhotos.mock.calls[0]
      // 2 items from page 1 + 1 item from page 2 = 3, not just page 1's 2.
      expect(files).toHaveLength(3)

      // The second items-fetch call must have carried the page-1 token.
      const itemsCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('items=true'),
      )
      expect(itemsCalls).toHaveLength(2)
      expect(itemsCalls[0][0]).toBe('/api/google-photos/sessions/session-123?items=true')
      expect(itemsCalls[1][0]).toBe(
        '/api/google-photos/sessions/session-123?items=true&pageToken=page-2-token',
      )
    })

    it('stops paginating once a page has no nextPageToken, making exactly one items-fetch call for a single page', async () => {
      const session = makeSession()
      const itemsResp = makeMediaItemsResponse(2)
      const addPhotos = vi.fn().mockResolvedValue(undefined)

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => session })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ...session, mediaItemsSet: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => itemsResp })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValueOnce({ ok: true, blob: async () => makeImageBlob() })
        .mockResolvedValue({ ok: true }) // DELETE

      const { result } = renderHook(() =>
        useGooglePhotosPicker({ accessToken: 'test-token', addPhotos })
      )

      await act(async () => {
        result.current.startImport()
        await vi.runAllTimersAsync()
      })

      expect(result.current.status).toBe('idle')
      const itemsCalls = mockFetch.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('items=true'),
      )
      expect(itemsCalls).toHaveLength(1)
    })
  })
})
