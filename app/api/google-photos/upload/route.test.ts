import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeRequest(authorization?: string): Request {
  const headers = new Headers()
  if (authorization) headers.set('Authorization', authorization)
  headers.set('X-Goog-Upload-Content-Type', 'image/jpeg')
  headers.set('X-Goog-Upload-Filename', 'photo.jpg')
  return new Request('http://localhost/api/google-photos/upload', {
    method: 'POST',
    headers,
    body: new Uint8Array([1, 2, 3]),
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('POST /api/google-photos/upload', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns the upload token on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => 'token-abc',
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('token-abc')
  })

  it('passes an AbortSignal to the upstream fetch so the request can be bounded', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => 'token-abc',
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

  it('returns 502 UPSTREAM_UNREACHABLE for a non-timeout network failure (unaffected by the new timeout handling)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network error'))

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('UPSTREAM_UNREACHABLE')
  })

  it('returns 429 with error.status RATE_LIMITED and retryAfterMs derived from the Retry-After header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '5' }),
      text: async () => '',
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.status).toBe('RATE_LIMITED')
    expect(body.error.retryAfterMs).toBe(5000)
  })

  it('falls back to the 30s floor for retryAfterMs when Retry-After is absent on a 429', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => '',
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.status).toBe('RATE_LIMITED')
    expect(body.error.retryAfterMs).toBe(30000)
  })

  it('still returns the generic UPLOAD_FAILED status for other non-2xx statuses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => 'Internal Server Error',
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.status).toBe('UPLOAD_FAILED')
  })
})
