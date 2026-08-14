import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeRequest(authorization?: string, body?: unknown): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (authorization) headers.set('Authorization', authorization)
  return new Request('http://localhost/api/google-photos/batch-create', {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? { uploadTokens: [{ token: 't1', filename: 'a.jpg' }] }),
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('POST /api/google-photos/batch-create', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns the upstream batch-create result on success', async () => {
    const result = { newMediaItemResults: [{ uploadToken: 't1', status: { message: 'Success' } }] }
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => result })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
  })

  it('passes an AbortSignal to the upstream fetch so the request can be bounded', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ newMediaItemResults: [] }),
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

  it('returns 429 with error.status RATE_LIMITED, falling back to the 30s floor when Retry-After is absent', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
      json: async () => ({ error: { code: 429, message: 'Rate limit exceeded', status: 'RESOURCE_EXHAUSTED' } }),
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.status).toBe('RATE_LIMITED')
    expect(body.error.retryAfterMs).toBe(30000)
  })

  it('derives retryAfterMs from the Retry-After header (seconds) when present on a 429', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '12' }),
      json: async () => ({}),
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.retryAfterMs).toBe(12000)
  })

  it('still forwards the parsed upstream body for other non-2xx statuses unchanged', async () => {
    const googleError = { error: { code: 400, message: 'Invalid request', status: 'INVALID_ARGUMENT' } }
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, headers: new Headers(), json: async () => googleError })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(googleError)
  })
})
