import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeRequest(authorization?: string): Request {
  const headers = new Headers()
  if (authorization) headers.set('Authorization', authorization)
  return new Request('http://localhost/api/google-photos/sessions', {
    method: 'POST',
    headers,
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('POST /api/google-photos/sessions', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.error.status).toBe('UNAUTHENTICATED')
    expect(typeof body.error.message).toBe('string')
  })

  it('forwards the Bearer token and returns the upstream session on success', async () => {
    const session = { id: 'session-123', pickerUri: 'https://photos.google.com/picker', pollingConfig: { pollInterval: '2s', timeoutIn: '300s' }, expireTime: '2026-01-01T00:00:00Z', mediaItemsSet: false }
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => session })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(mockFetch).toHaveBeenCalledWith(
      'https://photospicker.googleapis.com/v1/sessions',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer token-abc' }) }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(session)
  })

  it('forwards a non-2xx JSON error body and status from Google unchanged', async () => {
    const googleError = { error: { code: 403, message: 'Photos Picker API has not been used in this project', status: 'PERMISSION_DENIED' } }
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => googleError })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(googleError)
  })

  it('returns a structured 502 JSON error when the fetch to Google throws', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network error'))

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('UPSTREAM_UNREACHABLE')
    expect(typeof body.error.message).toBe('string')
  })

  it('returns valid JSON with the upstream status when Google responds with a non-JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.status).toBe('INVALID_UPSTREAM_RESPONSE')
    expect(typeof body.error.message).toBe('string')
  })

  it('returns a structured 502 error, not a 200, when Google responds ok but with a non-JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })

    const res = await POST(makeRequest('Bearer token-abc'))

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.status).toBe('INVALID_UPSTREAM_RESPONSE')
  })
})
