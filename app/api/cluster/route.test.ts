import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { POST } from './route'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeRequest(body?: unknown): Request {
  return new Request('http://localhost/api/cluster', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { photos: [{ id: 'abc123', image: 'base64data' }], threshold: 0.2 }),
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/cluster', () => {
  it('forwards a valid photos/threshold body and returns the upstream clusters response unchanged', async () => {
    const clusters = { clusters: [{ clusterIndex: 0, photoIds: ['abc123', 'def456'] }, { clusterIndex: 1, photoIds: ['ghi789'] }] }
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => clusters })

    const res = await POST(makeRequest())

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/cluster',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ photos: [{ id: 'abc123', image: 'base64data' }], threshold: 0.2 }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(clusters)
  })

  it('passes an AbortSignal with a timeout above the 45s upload-route timeout to the upstream fetch', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ clusters: [] }) })

    await POST(makeRequest())

    const options = mockFetch.mock.calls[0][1]
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Number))
    const timeoutMs = timeoutSpy.mock.calls[0][0]
    expect(timeoutMs).toBeGreaterThan(45_000)
  })

  it('returns a structured 502 error when photo-tidy-api is unreachable (connection refused)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    const res = await POST(makeRequest())

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('UPSTREAM_UNREACHABLE')
    expect(typeof body.error.message).toBe('string')
  })

  it('returns a 504 when the upstream fetch times out', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))

    const res = await POST(makeRequest())

    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.error.status).toBe('REQUEST_TIMEOUT')
    expect(body.error.message.toLowerCase()).toContain('timed out')
  })

  it('returns an explicit error, not a false-success pass-through, when photo-tidy-api responds 200 with a non-JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })

    const res = await POST(makeRequest())

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('INVALID_UPSTREAM_RESPONSE')
  })

  it('passes a 400 naming one rejected photo through unchanged', async () => {
    const rejection = { detail: "Photo 'abc123': image could not be decoded" }
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, headers: new Headers(), json: async () => rejection })

    const res = await POST(makeRequest())

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(rejection)
  })

  it('passes any other non-2xx status and body through unchanged', async () => {
    const serviceError = { detail: 'CLIP model unavailable: no network' }
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(), json: async () => serviceError })

    const res = await POST(makeRequest())

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(serviceError)
  })

  it('respects a custom CLUSTER_API_URL from the environment', async () => {
    vi.stubEnv('CLUSTER_API_URL', 'http://cluster-host:9000')
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ clusters: [] }) })

    await POST(makeRequest())

    expect(mockFetch).toHaveBeenCalledWith('http://cluster-host:9000/api/cluster', expect.anything())
    vi.unstubAllEnvs()
  })
})
