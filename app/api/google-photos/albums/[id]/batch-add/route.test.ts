import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeRequest(authorization?: string, body?: unknown): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (authorization) headers.set('Authorization', authorization)
  return new Request('http://localhost/api/google-photos/albums/album-123/batch-add', {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? { mediaItemIds: ['m1', 'm2'] }),
  })
}

function makeParams(id = 'album-123'): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('POST /api/google-photos/albums/[id]/batch-add', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await POST(makeRequest(), makeParams())
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns the upstream result on success', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) })

    const res = await POST(makeRequest('Bearer token-abc'), makeParams())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('encodes the album id into the upstream URL path segment', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) })

    await POST(makeRequest('Bearer token-abc'), makeParams('album/with spaces'))

    const url = mockFetch.mock.calls[0][0]
    expect(url).toBe(
      `https://photoslibrary.googleapis.com/v1/albums/${encodeURIComponent('album/with spaces')}:batchAddMediaItems`,
    )
  })

  it('sends the mediaItemIds in the request body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) })

    await POST(makeRequest('Bearer token-abc', { mediaItemIds: ['m1', 'm2', 'm3'] }), makeParams())

    const options = mockFetch.mock.calls[0][1]
    expect(JSON.parse(options.body)).toEqual({ mediaItemIds: ['m1', 'm2', 'm3'] })
  })

  it('returns 400 when mediaItemIds is missing or empty', async () => {
    const res = await POST(makeRequest('Bearer token-abc', { mediaItemIds: [] }), makeParams())
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('passes an AbortSignal to the upstream fetch so the request can be bounded', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) })

    await POST(makeRequest('Bearer token-abc'), makeParams())

    const options = mockFetch.mock.calls[0][1]
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns 504 with error.status REQUEST_TIMEOUT when the upstream fetch times out, not an unhandled rejection', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))

    const res = await POST(makeRequest('Bearer token-abc'), makeParams())

    expect(res.status).toBe(504)
    const body = await res.json()
    expect(body.error.status).toBe('REQUEST_TIMEOUT')
    expect(body.error.message.toLowerCase()).toContain('timed out')
  })

  it('returns 429 with error.status RATE_LIMITED and a retryAfterMs value derived from Retry-After', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '8' }),
      json: async () => ({}),
    })

    const res = await POST(makeRequest('Bearer token-abc'), makeParams())

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

    const res = await POST(makeRequest('Bearer token-abc'), makeParams())

    const body = await res.json()
    expect(body.error.retryAfterMs).toBe(30000)
  })

  it('still forwards the parsed upstream body for other non-2xx statuses unchanged', async () => {
    const googleError = { error: { code: 403, message: 'Forbidden', status: 'PERMISSION_DENIED' } }
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, headers: new Headers(), json: async () => googleError })

    const res = await POST(makeRequest('Bearer token-abc'), makeParams())

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(googleError)
  })
})
