import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'

afterEach(cleanup)

vi.mock('@/lib/perceptual-hash', () => ({
  computePhotoMetrics: vi.fn(),
}))

import { usePhotoMetrics } from './usePhotoMetrics'
import { computePhotoMetrics } from '@/lib/perceptual-hash'
import type { PhotoEntry } from './usePhotos'

const mockComputePhotoMetrics = vi.mocked(computePhotoMetrics)

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

/** A controllable, never-auto-resolving decode promise, for concurrency/race tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drains the microtask queue several times over, for chained await/Promise.all resolution. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('usePhotoMetrics', () => {
  it('returns undefined for a photo whose metrics are still in flight', async () => {
    const { promise } = deferred<{ width: number; height: number; size: number; hash: string | null }>()
    mockComputePhotoMetrics.mockReturnValue(promise)

    const file = makeFile('a.jpg')
    const photo = makePhoto(file)

    const { result } = renderHook(({ photos }) => usePhotoMetrics(photos), {
      initialProps: { photos: [photo] },
    })

    expect(result.current.get(photo.id)).toBeUndefined()
  })

  it('populates the map once the decode resolves', async () => {
    const metrics = { width: 100, height: 80, size: 500, hash: 'abc' }
    mockComputePhotoMetrics.mockResolvedValue(metrics)

    const file = makeFile('a.jpg')
    const photo = makePhoto(file)

    const { result } = renderHook(({ photos }) => usePhotoMetrics(photos), {
      initialProps: { photos: [photo] },
    })

    await waitFor(() => expect(result.current.get(photo.id)).toEqual(metrics))
  })

  it('computes metrics only once per unique File across re-renders', async () => {
    const metrics = { width: 100, height: 80, size: 500, hash: 'abc' }
    mockComputePhotoMetrics.mockResolvedValue(metrics)

    const file = makeFile('a.jpg')
    const photo = makePhoto(file)

    const { result, rerender } = renderHook(({ photos }) => usePhotoMetrics(photos), {
      initialProps: { photos: [photo] },
    })

    await waitFor(() => expect(result.current.get(photo.id)).toEqual(metrics))
    expect(mockComputePhotoMetrics).toHaveBeenCalledTimes(1)

    // Re-render with a NEW array reference containing the same photo/File —
    // exercises the cache-by-File-identity path, not just React bailing out
    // on an identical prop reference.
    rerender({ photos: [{ ...photo }] })

    await waitFor(() => expect(result.current.get(photo.id)).toEqual(metrics))
    expect(mockComputePhotoMetrics).toHaveBeenCalledTimes(1)
  })

  it('respects METRICS_CONCURRENCY: never more than 5 decodes in flight at once', async () => {
    const files = Array.from({ length: 12 }, (_, i) => makeFile(`p${i}.jpg`))
    const photos = files.map((f) => makePhoto(f))

    let inFlight = 0
    let maxInFlight = 0
    const resolvers: Array<() => void> = []

    mockComputePhotoMetrics.mockImplementation(() => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve) => {
        resolvers.push(() => {
          inFlight--
          resolve({ width: 1, height: 1, size: 1, hash: 'h' })
        })
      })
    })

    const { result } = renderHook(({ p }) => usePhotoMetrics(p), { initialProps: { p: photos } })

    // Drain in waves, same shape as the hook's own chunking loop: resolve
    // whatever's currently in flight, then wait (by polling rather than
    // counting microtask ticks, which is fragile) for the next wave to be
    // registered, until all 12 have been resolved.
    let resolvedCount = 0
    while (resolvedCount < 12) {
      await waitFor(() => expect(resolvers.length).toBeGreaterThan(0))
      const toResolve = resolvers.splice(0, resolvers.length)
      resolvedCount += toResolve.length
      await act(async () => {
        toResolve.forEach((r) => r())
        await flushMicrotasks()
      })
    }

    await waitFor(() => {
      for (const p of photos) expect(result.current.get(p.id)).toBeDefined()
    })

    expect(maxInFlight).toBeLessThanOrEqual(5)
    expect(mockComputePhotoMetrics).toHaveBeenCalledTimes(12)
  })

  it('drops a stale in-flight result when the batch changes before decode resolves', async () => {
    const fileA = makeFile('a.jpg')
    const fileB = makeFile('b.jpg')
    const photoA = makePhoto(fileA, 'photo-a')
    const photoB = makePhoto(fileB, 'photo-b')

    const deferredA = deferred<{ width: number; height: number; size: number; hash: string | null }>()
    const metricsB = { width: 20, height: 20, size: 20, hash: 'b-hash' }

    mockComputePhotoMetrics.mockImplementation((file: File) => {
      if (file === fileA) return deferredA.promise
      if (file === fileB) return Promise.resolve(metricsB)
      return Promise.resolve({ width: 0, height: 0, size: 0, hash: null })
    })

    const { result, rerender } = renderHook(({ photos }) => usePhotoMetrics(photos), {
      initialProps: { photos: [photoA] },
    })

    // A's decode is in flight (never resolved yet).
    expect(result.current.get(photoA.id)).toBeUndefined()

    // Batch changes before A resolves: A drops out, B comes in.
    rerender({ photos: [photoB] })

    await waitFor(() => expect(result.current.get(photoB.id)).toEqual(metricsB))

    // Now let A's stale decode resolve.
    await act(async () => {
      deferredA.resolve({ width: 999, height: 999, size: 999, hash: 'stale' })
      await flushMicrotasks()
    })

    // A is gone from the current batch entirely — its stale result must not
    // reappear under its own id, and must not have clobbered B's slot.
    expect(result.current.get(photoA.id)).toBeUndefined()
    expect(result.current.get(photoB.id)).toEqual(metricsB)

    // Switching back to a batch containing A must recompute it rather than
    // silently reuse the stale write — proves the stale write never landed
    // in the cache at all.
    mockComputePhotoMetrics.mockClear()
    const freshMetricsA = { width: 1, height: 1, size: 1, hash: 'fresh-a' }
    mockComputePhotoMetrics.mockImplementation((file: File) => {
      if (file === fileA) return Promise.resolve(freshMetricsA)
      return Promise.resolve(metricsB)
    })
    rerender({ photos: [photoA, photoB] })

    await waitFor(() => expect(result.current.get(photoA.id)).toEqual(freshMetricsA))
    expect(mockComputePhotoMetrics).toHaveBeenCalledWith(fileA)
  })
})
