import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeRequest(authorization?: string, body?: unknown): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (authorization) headers.set('Authorization', authorization)
  return new Request('http://localhost/api/google-photos/albums', {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? { title: 'My Album' }),
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('POST /api/google-photos/albums', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns the upstream album on success', async () => {
    const album = { id: 'album-123', title: 'My Album' }
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => album })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(album)
  })

  it('passes an AbortSignal to the upstream fetch so the request can be bounded', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: 'album-1' }),
    })

    await POST(makeRequest('Bearer token-abc'))

    const options = mockFetch.mock.calls[0][1]
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns 504 with error.status REQUEST_TIMEOUT when the upstream fetch times out, not an unhandled rejection', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.error.status).toBe('REQUEST_TIMEOUT')
    expect(body.error.message.toLowerCase()).toContain('timed out')
  })

  it('returns 429 with error.status RATE_LIMITED and a retryAfterMs value', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '8' }),
      json: async () => ({}),
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.status).toBe('RATE_LIMITED')
    expect(body.error.retryAfterMs).toBe(8000)
  })

  it('falls back to the 30s floor for retryAfterMs when Retry-After is absent on a 429', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
      json: async () => ({}),
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    const body = await res.json()
    expect(body.error.retryAfterMs).toBe(30000)
  })

  it('still forwards the parsed upstream body for other non-2xx statuses unchanged', async () => {
    const googleError = { error: { code: 403, message: 'Forbidden', status: 'PERMISSION_DENIED' } }
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, headers: new Headers(), json: async () => googleError })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(googleError)
  })
})
