import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { ApiCluster } from '@/hooks/useClusterApi'

// Mock fetch globally, same convention as hooks/useClusterApi.test.ts.
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@/lib/generate-thumbnail', () => ({
  generateThumbnail: vi.fn(),
}))

import { scanForExactDuplicateGroups } from './duplicate-scan'
import { generateThumbnail } from './generate-thumbnail'

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

function clusterOk(clusters: ApiCluster[]) {
  return { ok: true, status: 200, json: async () => ({ clusters }) }
}

function clusterRejected(photoId: string, reason = 'invalid base64 image data') {
  return { ok: false, status: 400, json: async () => ({ detail: `Photo '${photoId}': ${reason}` }) }
}

function clusterFail(status = 500) {
  return { ok: false, status, json: async () => ({ error: { message: 'boom' } }) }
}

let clusterQueue: unknown[] = []

function queueCluster(...responses: unknown[]) {
  clusterQueue.push(...responses)
}

function clusterCallCount(): number {
  return mockFetch.mock.calls.filter((c) => c[0] === '/api/cluster').length
}

function clusterRequestBody(callIndex: number): {
  photos: { id: string; image: string }[]
  threshold: number
} {
  const call = mockFetch.mock.calls.filter((c) => c[0] === '/api/cluster')[callIndex]
  return JSON.parse(call[1].body as string) as { photos: { id: string; image: string }[]; threshold: number }
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clusterQueue = []
  mockGenerateThumbnail.mockImplementation(async (file: File) => `thumb-${file.name}`)

  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/cluster') {
      const next = clusterQueue.shift()
      if (!next) return Promise.reject(new Error('no mock cluster response queued'))
      return Promise.resolve(next)
    }
    return Promise.reject(new Error(`unexpected fetch url: ${String(url)}`))
  })
})

describe('scanForExactDuplicateGroups', () => {
  it('drops single-member clusters, keeping only groups of 2+ (R3, R4)', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photoB = makePhoto(makeFile('b.jpg'), 'b')
    const photoC = makePhoto(makeFile('c.jpg'), 'c')
    const photos = [photoA, photoB, photoC]

    queueCluster(
      clusterOk([
        { clusterIndex: 0, photoIds: ['a', 'b'] },
        { clusterIndex: 1, photoIds: ['c'] },
      ]),
    )

    const result = await scanForExactDuplicateGroups(photos)

    expect(result).toEqual({ ok: true, groups: [['a', 'b']] })
    expect(clusterRequestBody(0).threshold).toBe(0.0)
  })

  it('includes every cluster of 2+ members (R3)', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photoB = makePhoto(makeFile('b.jpg'), 'b')
    const photoC = makePhoto(makeFile('c.jpg'), 'c')
    const photoD = makePhoto(makeFile('d.jpg'), 'd')
    const photos = [photoA, photoB, photoC, photoD]

    queueCluster(
      clusterOk([
        { clusterIndex: 0, photoIds: ['a', 'b'] },
        { clusterIndex: 1, photoIds: ['c', 'd'] },
      ]),
    )

    const result = await scanForExactDuplicateGroups(photos)

    expect(result).toEqual({
      ok: true,
      groups: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    })
    expect(clusterRequestBody(0).threshold).toBe(0.0)
  })

  it('resolves ok:true with an empty groups array when no cluster has 2+ members', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photoB = makePhoto(makeFile('b.jpg'), 'b')
    const photos = [photoA, photoB]

    queueCluster(
      clusterOk([
        { clusterIndex: 0, photoIds: ['a'] },
        { clusterIndex: 1, photoIds: ['b'] },
      ]),
    )

    const result = await scanForExactDuplicateGroups(photos)

    expect(result).toEqual({ ok: true, groups: [] })
    expect(clusterRequestBody(0).threshold).toBe(0.0)
  })

  it('excludes a photo whose thumbnail generation failed from the request', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photoB = makePhoto(makeFile('b.jpg'), 'b')
    const photos = [photoA, photoB]
    mockGenerateThumbnail.mockImplementation(async (file: File) =>
      file.name === 'a.jpg' ? null : `thumb-${file.name}`,
    )

    queueCluster(clusterOk([{ clusterIndex: 0, photoIds: ['b'] }]))

    const result = await scanForExactDuplicateGroups(photos)

    expect(clusterRequestBody(0).photos.map((p) => p.id)).toEqual(['b'])
    expect(clusterRequestBody(0).threshold).toBe(0.0)
    expect(result).toEqual({ ok: true, groups: [] })
  })

  it('retries exactly once, excluding the rejected photo, and returns the retry success result', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photoB = makePhoto(makeFile('b.jpg'), 'b')
    const photoC = makePhoto(makeFile('c.jpg'), 'c')
    const photos = [photoA, photoB, photoC]

    queueCluster(clusterRejected('a'), clusterOk([{ clusterIndex: 0, photoIds: ['b', 'c'] }]))

    const result = await scanForExactDuplicateGroups(photos)

    expect(clusterCallCount()).toBe(2)
    expect(clusterRequestBody(0).photos.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(clusterRequestBody(0).threshold).toBe(0.0)
    expect(clusterRequestBody(1).photos.map((p) => p.id)).toEqual(['b', 'c'])
    expect(clusterRequestBody(1).threshold).toBe(0.0)
    expect(result).toEqual({ ok: true, groups: [['b', 'c']] })
  })

  it('resolves ok:false when the API returns a non-photo-specific failure', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photos = [photoA]

    queueCluster(clusterFail())

    const result = await scanForExactDuplicateGroups(photos)

    expect(clusterRequestBody(0).threshold).toBe(0.0)
    expect(result).toEqual({ ok: false })
  })

  it('resolves ok:false when the retry after a single-photo rejection also fails', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photoB = makePhoto(makeFile('b.jpg'), 'b')
    const photos = [photoA, photoB]

    queueCluster(clusterRejected('a'), clusterRejected('a', 'still bad'))

    const result = await scanForExactDuplicateGroups(photos)

    expect(clusterCallCount()).toBe(2)
    expect(result).toEqual({ ok: false })
  })

  it('resolves ok:false, not an uncaught rejection, when postCluster throws (network error)', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photos = [photoA]
    mockFetch.mockImplementation(() => Promise.reject(new TypeError('network error')))

    const result = await scanForExactDuplicateGroups(photos)

    expect(result).toEqual({ ok: false })
  })

  it('resolves ok:false when the retry attempt itself throws (network error)', async () => {
    const photoA = makePhoto(makeFile('a.jpg'), 'a')
    const photoB = makePhoto(makeFile('b.jpg'), 'b')
    const photos = [photoA, photoB]
    let callCount = 0
    mockFetch.mockImplementation((url: string) => {
      if (url !== '/api/cluster') return Promise.reject(new Error('unexpected url'))
      callCount += 1
      if (callCount === 1) return Promise.resolve(clusterRejected('a'))
      return Promise.reject(new TypeError('network error on retry'))
    })

    const result = await scanForExactDuplicateGroups(photos)

    expect(callCount).toBe(2)
    expect(result).toEqual({ ok: false })
  })

  it('generates thumbnails in fixed-size concurrency-bounded batches, not one unbounded Promise.all', async () => {
    const totalPhotos = 12
    const photos = Array.from({ length: totalPhotos }, (_, i) => makePhoto(makeFile(`p${i}.jpg`), `id${i}`))
    let resolvers: Array<(v: string | null) => void> = []
    mockGenerateThumbnail.mockImplementation(
      () => new Promise<string | null>((resolve) => resolvers.push(resolve)),
    )
    queueCluster(clusterOk([{ clusterIndex: 0, photoIds: photos.map((p) => p.id) }]))

    const scanPromise = scanForExactDuplicateGroups(photos)
    await flushMicrotasks()

    // The whole batch must NOT have been requested in one unbounded wave.
    const firstBatchCalls = mockGenerateThumbnail.mock.calls.length
    expect(firstBatchCalls).toBeGreaterThan(0)
    expect(firstBatchCalls).toBeLessThan(totalPhotos)
    expect(resolvers.length).toBe(firstBatchCalls)

    // Resolving waves progressively unlocks more calls, confirming chunking.
    let waves = 0
    while (mockGenerateThumbnail.mock.calls.length < totalPhotos) {
      const toResolve = resolvers
      resolvers = []
      toResolve.forEach((resolve) => resolve('thumb'))
      await flushMicrotasks()
      waves += 1
      if (waves > totalPhotos) throw new Error('thumbnail batching never completed')
    }
    expect(waves).toBeGreaterThan(0)

    // Resolve the final wave so the scan settles.
    const finalWave = resolvers
    resolvers = []
    finalWave.forEach((resolve) => resolve('thumb'))

    const result = await scanPromise
    expect(result).toEqual({ ok: true, groups: [photos.map((p) => p.id)] })
    expect(clusterRequestBody(0).threshold).toBe(0.0)
  })
})
