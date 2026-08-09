import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, DELETE } from './route'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeRequest(url: string, authorization?: string): Request {
  const headers = new Headers()
  if (authorization) headers.set('Authorization', authorization)
  return new Request(url, { headers })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('GET /api/google-photos/sessions/[id]', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await GET(makeRequest('http://localhost/api/google-photos/sessions/abc'), makeParams('abc'))
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.error.status).toBe('UNAUTHENTICATED')
  })

  it('polls session status when no items query param is present', async () => {
    const session = { id: 'abc', mediaItemsSet: true }
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => session })

    const res = await GET(makeRequest('http://localhost/api/google-photos/sessions/abc', 'Bearer tok'), makeParams('abc'))

    expect(mockFetch).toHaveBeenCalledWith(
      'https://photospicker.googleapis.com/v1/sessions/abc',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(session)
  })

  it('fetches media items when items=true', async () => {
    const mediaItems = { mediaItems: [{ id: 'item-1' }] }
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mediaItems })

    const res = await GET(makeRequest('http://localhost/api/google-photos/sessions/abc?items=true', 'Bearer tok'), makeParams('abc'))

    expect(mockFetch).toHaveBeenCalledWith(
      'https://photospicker.googleapis.com/v1/mediaItems?sessionId=abc',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(mediaItems)
  })

  it('returns a structured 502 JSON error when the fetch to Google throws', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network error'))

    const res = await GET(makeRequest('http://localhost/api/google-photos/sessions/abc', 'Bearer tok'), makeParams('abc'))

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('UPSTREAM_UNREACHABLE')
  })

  it('returns valid JSON with the upstream status when Google responds with a non-JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })

    const res = await GET(makeRequest('http://localhost/api/google-photos/sessions/abc', 'Bearer tok'), makeParams('abc'))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.status).toBe('INVALID_UPSTREAM_RESPONSE')
  })

  it('returns a structured 502 error, not a 200, when Google responds ok but with a non-JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })

    const res = await GET(makeRequest('http://localhost/api/google-photos/sessions/abc', 'Bearer tok'), makeParams('abc'))

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('INVALID_UPSTREAM_RESPONSE')
  })
})

describe('DELETE /api/google-photos/sessions/[id]', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await DELETE(makeRequest('http://localhost/api/google-photos/sessions/abc'), makeParams('abc'))
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.error.status).toBe('UNAUTHENTICATED')
  })

  it('returns 204 on successful delete', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 })

    const res = await DELETE(makeRequest('http://localhost/api/google-photos/sessions/abc', 'Bearer tok'), makeParams('abc'))

    expect(res.status).toBe(204)
  })

  it('returns a structured 502 JSON error when the fetch to Google throws', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network error'))

    const res = await DELETE(makeRequest('http://localhost/api/google-photos/sessions/abc', 'Bearer tok'), makeParams('abc'))

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('UPSTREAM_UNREACHABLE')
  })

  it('returns valid JSON with the upstream status when Google responds with a non-JSON error body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })

    const res = await DELETE(makeRequest('http://localhost/api/google-photos/sessions/abc', 'Bearer tok'), makeParams('abc'))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.status).toBe('INVALID_UPSTREAM_RESPONSE')
  })
})
