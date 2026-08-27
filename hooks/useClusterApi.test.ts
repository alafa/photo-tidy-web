import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'

afterEach(cleanup)

// Mock fetch globally, same convention as hooks/useGooglePhotosPicker.test.ts.
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@/lib/generate-thumbnail', () => ({
  generateThumbnail: vi.fn(),
}))

import { useClusterApi, type ApiCluster } from './useClusterApi'
import { generateThumbnail } from '@/lib/generate-thumbnail'

const mockGenerateThumbnail = vi.mocked(generateThumbnail)

// ---- helpers ------------------------------------------------------------

function makeFile(name: string): File {
  return new File([], name, { type: 'image/jpeg' })
}

function makePhoto(file: File, id?: string): PhotoEntry {
  return {
    id: id ?? file.name,
    file,
    filename: file.name,
    capturedAt: null,
    uploadIndex: 0,
    source: 'local',
  }
}

function healthOk() {
  return { ok: true, status: 200, json: async () => ({ status: 'ok' }) }
}

function healthFail(status = 503) {
  return { ok: false, status, json: async () => ({ error: { message: 'down' } }) }
}

function clusterOk(clusters: ApiCluster[]) {
  return { ok: true, status: 200, json: async () => ({ clusters }) }
}

function clusterRejected(photoId: string, reason = 'invalid base64 image data') {
  return { ok: false, status: 400, json: async () => ({ detail: `Photo '${photoId}': ${reason}` }) }
}

function clusterFail(status = 500) {
  return { ok: false, status, json: async () => ({ error: { message: 'boom' } }) }
}

/**
 * Renders `useClusterApi` through a props object threaded via
 * `initialProps`/`rerender`, mirroring the convention the old (now-removed)
 * local-clustering metrics hook's own test file used — critical here
 * because `photos` array *identity* is a
 * trigger (KTD9): a callback that reconstructs `[photo]` inline on every
 * call would hand the hook a new array on every internal state-driven
 * re-render (not just explicit `rerender()` calls), which the hook would
 * then correctly, but spuriously, treat as a photo-set change. Tests hold a
 * `photos` array reference in a local const and reuse it across
 * `rerender()` calls that only mean to change `percent`.
 *
 * Every test mounts at `percent: 0` so the health check resolving never
 * itself triggers a cluster call (R5) — each real request is then driven
 * deterministically by an explicit `rerender()` to a nonzero percent (or a
 * `photos` identity change), after the test has queued the response it
 * wants that specific call to receive.
 */
function renderClusterApi(photos: PhotoEntry[]) {
  return renderHook(
    (props: { photos: PhotoEntry[]; percent: number }) => useClusterApi(props.photos, props.percent),
    { initialProps: { photos, percent: 0 } },
  )
}

/** URL-dispatching fetch mock: health is a single fixed response, cluster
 * responses come off a FIFO queue so each POST /api/cluster call in a test
 * can be scripted independently (including the same-generation retry). */
let healthResponse: unknown = healthOk()
let clusterQueue: unknown[] = []

function queueCluster(...responses: unknown[]) {
  clusterQueue.push(...responses)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  healthResponse = healthOk()
  clusterQueue = []
  mockGenerateThumbnail.mockImplementation(async (file: File) => `thumb-${file.name}`)

  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/cluster/health') return Promise.resolve(healthResponse)
    if (url === '/api/cluster') {
      const next = clusterQueue.shift()
      if (!next) return Promise.reject(new Error('no mock cluster response queued'))
      return Promise.resolve(next)
    }
    return Promise.reject(new Error(`unexpected fetch url: ${String(url)}`))
  })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Flushes the health-check microtask (no timer involved) without advancing
 * the 500ms debounce, so tests can inspect the immediate post-mount state. */
async function flushHealthCheck() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function settleDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
}

function clusterCallCount(): number {
  return mockFetch.mock.calls.filter((c) => c[0] === '/api/cluster').length
}

function clusterRequestBody(callIndex: number): { photos: { id: string; image: string }[]; threshold: number } {
  const call = mockFetch.mock.calls.filter((c) => c[0] === '/api/cluster')[callIndex]
  return JSON.parse(call[1].body as string) as { photos: { id: string; image: string }[]; threshold: number }
}

describe('useClusterApi', () => {
  describe('health gate', () => {
    it('becomes available when the health check succeeds', async () => {
      const { result } = renderClusterApi([])
      expect(result.current.availability).toBe('checking')

      await flushHealthCheck()

      expect(result.current.availability).toBe('available')
      expect(clusterCallCount()).toBe(0)
    })

    it('becomes unavailable when the health check fails, without attempting a cluster call', async () => {
      healthResponse = healthFail()
      const photo = makePhoto(makeFile('a.jpg'))
      const photos = [photo]
      const { result, rerender } = renderClusterApi(photos)

      await flushHealthCheck()
      rerender({ photos, percent: 50 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(result.current.availability).toBe('unavailable')
      expect(clusterCallCount()).toBe(0)
    })

    it('stays checking (no cluster call) between mount and health resolution even above 0%', async () => {
      let resolveHealth!: (v: unknown) => void
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/cluster/health') {
          return new Promise((resolve) => {
            resolveHealth = resolve
          })
        }
        if (url === '/api/cluster') {
          const next = clusterQueue.shift()
          return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected cluster call'))
        }
        return Promise.reject(new Error('unexpected url'))
      })

      const photo = makePhoto(makeFile('a.jpg'))
      const photos = [photo]
      const { result, rerender } = renderClusterApi(photos)
      rerender({ photos, percent: 50 })

      expect(result.current.availability).toBe('checking')
      await settleDebounce()
      expect(result.current.availability).toBe('checking')
      expect(clusterCallCount()).toBe(0)

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a.jpg'] }]))
      await act(async () => {
        resolveHealth(healthOk())
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(result.current.availability).toBe('available')
    })
  })

  describe('debounce and the 0% gate', () => {
    it('fires only one /api/cluster call, 500ms after the last of several rapid ticks', async () => {
      const photo = makePhoto(makeFile('a.jpg'))
      const photos = [photo]
      const { rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a.jpg'] }]))
      rerender({ photos, percent: 10 })
      rerender({ photos, percent: 20 })
      rerender({ photos, percent: 30 })
      rerender({ photos, percent: 40 })

      // Not yet 500ms since the last tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(clusterCallCount()).toBe(0)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(clusterCallCount()).toBe(1)
    })

    it('makes no /api/cluster call while the slider stays at 0%, even once available and after the debounce settles', async () => {
      const photo = makePhoto(makeFile('a.jpg'))
      const { result } = renderClusterApi([photo])

      await flushHealthCheck()
      await settleDebounce()

      expect(clusterCallCount()).toBe(0)
      expect(result.current.availability).toBe('available')
    })

    it('blocks a call using the live percent even when the debounced percent has not caught up to a just-dropped-to-0% slider', async () => {
      // The health check stays pending so we control exactly when
      // `availability` flips to 'available' relative to the debounce.
      let resolveHealth!: (v: unknown) => void
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/cluster/health') {
          return new Promise((resolve) => {
            resolveHealth = resolve
          })
        }
        if (url === '/api/cluster') {
          const next = clusterQueue.shift()
          return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected cluster call'))
        }
        return Promise.reject(new Error('unexpected url'))
      })

      const photo = makePhoto(makeFile('a.jpg'))
      const photos = [photo]
      const { result, rerender } = renderClusterApi(photos)

      // Go to 50%, then immediately back to 0% — this only *schedules* a
      // debounce commit to 0 500ms from now; `debouncedPercent` is still 50
      // (in transit) at this instant.
      rerender({ photos, percent: 50 })
      rerender({ photos, percent: 0 })

      // Health resolves now, while debouncedPercent is still stale at 50.
      // If the gate used debouncedPercent instead of the live value, this
      // would incorrectly fire a call at threshold 50%.
      await act(async () => {
        resolveHealth(healthOk())
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(result.current.availability).toBe('available')
      expect(clusterCallCount()).toBe(0)

      // Let the debounce settle to 0 too — still no call.
      await settleDebounce()
      expect(clusterCallCount()).toBe(0)
    })
  })

  describe('supersession (generation-token race safety)', () => {
    it('discards an in-flight response when the photo set changes, applying only the new request result', async () => {
      const photoA = makePhoto(makeFile('a.jpg'), 'a')
      const photoB = makePhoto(makeFile('b.jpg'), 'b')

      let resolveFirst!: (v: unknown) => void
      const firstPending = new Promise((resolve) => {
        resolveFirst = resolve
      })
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/cluster/health') return Promise.resolve(healthResponse)
        if (url === '/api/cluster') {
          const next = clusterQueue.shift()
          if (next === 'FIRST_PENDING') return firstPending
          return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected cluster call'))
        }
        return Promise.reject(new Error('unexpected url'))
      })

      const photosA = [photoA]
      const { result, rerender } = renderClusterApi(photosA)
      await flushHealthCheck()

      queueCluster('FIRST_PENDING')
      rerender({ photos: photosA, percent: 50 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(result.current.isLoading).toBe(true)

      // Photo set changes before the first request resolves.
      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a', 'b'] }]))
      rerender({ photos: [photoA, photoB], percent: 50 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      // Now let the stale first response resolve.
      await act(async () => {
        resolveFirst(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['a', 'b'] }])
      expect(result.current.isLoading).toBe(false)
    })

    it('discards an in-flight response when the threshold changes again before it resolves', async () => {
      const photo = makePhoto(makeFile('a.jpg'), 'a')
      const photos = [photo]

      let resolveFirst!: (v: unknown) => void
      const firstPending = new Promise((resolve) => {
        resolveFirst = resolve
      })
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/cluster/health') return Promise.resolve(healthResponse)
        if (url === '/api/cluster') {
          const next = clusterQueue.shift()
          if (next === 'FIRST_PENDING') return firstPending
          return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected cluster call'))
        }
        return Promise.reject(new Error('unexpected url'))
      })

      const { result, rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster('FIRST_PENDING')
      rerender({ photos, percent: 10 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(result.current.isLoading).toBe(true)

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos, percent: 40 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      await act(async () => {
        resolveFirst(clusterOk([{ clusterIndex: 0, photoIds: ['STALE'] }]))
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['a'] }])
    })
  })

  describe('stale-while-loading', () => {
    it('keeps the previous clusters and reports isLoading while a new request is in flight', async () => {
      const photo = makePhoto(makeFile('a.jpg'), 'a')
      const photos = [photo]
      const { result, rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos, percent: 10 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['a'] }])
      expect(result.current.isLoading).toBe(false)

      // Second request never resolves in this test — just checking the
      // stale-while-loading snapshot.
      queueCluster(new Promise(() => {}))
      rerender({ photos, percent: 40 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(result.current.isLoading).toBe(true)
      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['a'] }])
    })
  })

  describe('per-photo rejection retry (R15)', () => {
    it('excludes the named photo and resubmits once within the same generation, applying the retry result', async () => {
      const photoA = makePhoto(makeFile('a.jpg'), 'a')
      const photoB = makePhoto(makeFile('b.jpg'), 'b')
      const photos = [photoA, photoB]
      const { result, rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(
        clusterRejected('a'),
        clusterOk([{ clusterIndex: 0, photoIds: ['b'] }]),
      )
      rerender({ photos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(clusterCallCount()).toBe(2)
      expect(clusterRequestBody(0).photos.map((p) => p.id)).toEqual(['a', 'b'])
      expect(clusterRequestBody(1).photos.map((p) => p.id)).toEqual(['b'])
      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['b'] }])
      expect(result.current.availability).toBe('available')
    })

    it('becomes unavailable, keeping the last successful clusters, when the retry also fails', async () => {
      const photoA = makePhoto(makeFile('a.jpg'), 'a')
      const photoB = makePhoto(makeFile('b.jpg'), 'b')
      const photos = [photoA, photoB]
      const { result, rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      // First successful call establishes a baseline `clusters` value.
      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a', 'b'] }]))
      rerender({ photos, percent: 10 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['a', 'b'] }])

      // Next trigger: rejected, then the retry also fails (second 400).
      queueCluster(clusterRejected('a'), clusterRejected('a', 'still bad'))
      rerender({ photos, percent: 40 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(clusterCallCount()).toBe(3)
      expect(result.current.availability).toBe('unavailable')
      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['a', 'b'] }])
    })
  })

  describe('thumbnail failures (R16)', () => {
    it('omits a photo whose cached thumbnail is null from the request', async () => {
      const photoA = makePhoto(makeFile('a.jpg'), 'a')
      const photoB = makePhoto(makeFile('b.jpg'), 'b')
      const photos = [photoA, photoB]
      mockGenerateThumbnail.mockImplementation(async (file: File) =>
        file.name === 'a.jpg' ? null : `thumb-${file.name}`,
      )
      const { rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['b'] }]))
      rerender({ photos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(clusterRequestBody(0).photos.map((p) => p.id)).toEqual(['b'])
    })
  })

  describe('non-photo-specific failure (R13)', () => {
    it('becomes unavailable after a prior success, keeping the previously displayed clusters', async () => {
      const photo = makePhoto(makeFile('a.jpg'), 'a')
      const photos = [photo]
      const { result, rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos, percent: 10 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['a'] }])

      queueCluster(clusterFail())
      rerender({ photos, percent: 40 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(result.current.availability).toBe('unavailable')
      expect(result.current.clusters).toEqual([{ clusterIndex: 0, photoIds: ['a'] }])
    })
  })

  describe('photo-set changes trigger re-clustering (R8)', () => {
    it('fires a new request when photos change with no slider interaction', async () => {
      const photoA = makePhoto(makeFile('a.jpg'), 'a')
      const photoB = makePhoto(makeFile('b.jpg'), 'b')
      const photosA = [photoA]
      const { rerender } = renderClusterApi(photosA)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos: photosA, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(clusterCallCount()).toBe(1)

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a', 'b'] }]))
      rerender({ photos: [photoA, photoB], percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(clusterCallCount()).toBe(2)
    })
  })

  describe('skips a redundant request on a metadata-only photos change', () => {
    it('does not fire a new /api/cluster call on a rename/timestamp-edit (same Files, new array identity)', async () => {
      const photoA = makePhoto(makeFile('a.jpg'), 'a')
      const photoB = makePhoto(makeFile('b.jpg'), 'b')
      const photos = [photoA, photoB]
      const { rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a', 'b'] }]))
      rerender({ photos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(clusterCallCount()).toBe(1)

      // Simulate a rename: same underlying Files/ids, but a brand-new
      // `photos` array (as hooks/usePhotos.ts's updatePhotoName produces)
      // and a changed `filename` on one entry.
      const renamedPhotoA: PhotoEntry = { ...photoA, filename: 'renamed-a.jpg' }
      const renamedPhotos = [renamedPhotoA, photoB]
      rerender({ photos: renamedPhotos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(clusterCallCount()).toBe(1)
    })

    it('does not fire a new /api/cluster call on a reorder (same Files, different array order)', async () => {
      const photoA = makePhoto(makeFile('a.jpg'), 'a')
      const photoB = makePhoto(makeFile('b.jpg'), 'b')
      const photos = [photoA, photoB]
      const { rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a', 'b'] }]))
      rerender({ photos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(clusterCallCount()).toBe(1)

      // Simulate a reorder: same Files/ids, new array identity, different order.
      const reorderedPhotos = [photoB, photoA]
      rerender({ photos: reorderedPhotos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(clusterCallCount()).toBe(1)
    })
  })

  describe('thumbnail cache reuse (R10, KTD16)', () => {
    it('calls the API again for the same threshold submitted twice, but reads unchanged Files from cache', async () => {
      const photo = makePhoto(makeFile('a.jpg'), 'a')
      const photos = [photo]
      const { rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(clusterCallCount()).toBe(1)
      expect(mockGenerateThumbnail).toHaveBeenCalledTimes(1)

      // Slider moves away and back to the same value — a new debounced
      // commit either way, so a new call is expected each time.
      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos, percent: 60 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(clusterCallCount()).toBe(3)
      // The File never changed, so its thumbnail is read from cache, not regenerated.
      expect(mockGenerateThumbnail).toHaveBeenCalledTimes(1)
    })

    it('does not call generateThumbnail again for a File already cached from a prior trigger', async () => {
      const photo = makePhoto(makeFile('a.jpg'), 'a')
      const photos = [photo]
      const { rerender } = renderClusterApi(photos)
      await flushHealthCheck()

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos, percent: 30 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(mockGenerateThumbnail).toHaveBeenCalledTimes(1)

      queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['a'] }]))
      rerender({ photos, percent: 45 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(mockGenerateThumbnail).toHaveBeenCalledTimes(1)
    })
  })
})
