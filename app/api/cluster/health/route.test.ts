import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GET } from './route'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/cluster/health', () => {
  it('forwards to photo-tidy-api /health and returns its body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ status: 'ok' }) })

    const res = await GET()

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8000/health', expect.objectContaining({ method: 'GET' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('passes an AbortSignal with a short timeout to the upstream fetch, unlike the cluster route (KTD15: /health never touches the CLIP model)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ status: 'ok' }) })

    await GET()

    const options = mockFetch.mock.calls[0][1]
    expect(options.signal).toBeInstanceOf(AbortSignal)
    const timeoutMs = timeoutSpy.mock.calls[0][0]
    expect(timeoutMs).toBeLessThan(45_000)
  })

  it('returns a structured 502 error when photo-tidy-api is unreachable (connection refused)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    const res = await GET()

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('UPSTREAM_UNREACHABLE')
  })

  it('returns a 504 when the upstream fetch times out', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))

    const res = await GET()

    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.error.status).toBe('REQUEST_TIMEOUT')
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

    const res = await GET()

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('INVALID_UPSTREAM_RESPONSE')
  })

  it('passes any other non-2xx status and body through unchanged', async () => {
    const serviceError = { detail: 'CLIP model unavailable: no network' }
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(), json: async () => serviceError })

    const res = await GET()

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(serviceError)
  })

  it('respects a custom CLUSTER_API_URL from the environment', async () => {
    vi.stubEnv('CLUSTER_API_URL', 'http://cluster-host:9000')
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ status: 'ok' }) })

    await GET()

    expect(mockFetch).toHaveBeenCalledWith('http://cluster-host:9000/health', expect.anything())
    vi.unstubAllEnvs()
  })
})
