import { NextResponse } from 'next/server'
import {
  extractBearer,
  fetchUpstreamWithTimeout,
  upstreamErrorBody,
} from '@/lib/google-photos-server'

// Small JSON body — matches batch-create's budget, shorter than the
// raw-byte upload route's.
const ALBUMS_TIMEOUT_MS = 12_000

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json(
      upstreamErrorBody('Missing or invalid Authorization header', 'UNAUTHENTICATED'),
      { status: 401 },
    )
  }

  let body: { title?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(upstreamErrorBody('Invalid JSON body', 'INVALID_REQUEST'), { status: 400 })
  }

  const { title } = body
  if (!title) {
    return NextResponse.json(
      upstreamErrorBody('Missing required field: title', 'INVALID_REQUEST'),
      { status: 400 },
    )
  }

  const trimmedTitle = title.trim().slice(0, 500)

  const result = await fetchUpstreamWithTimeout(
    'https://photoslibrary.googleapis.com/v1/albums',
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ album: { title: trimmedTitle } }),
    },
    ALBUMS_TIMEOUT_MS,
  )
  if ('errorResponse' in result) return result.errorResponse
  const upstream = result.response

  let data: unknown
  try {
    data = await upstream.json()
  } catch {
    return NextResponse.json(
      upstreamErrorBody('Upstream returned a non-JSON response', 'INVALID_UPSTREAM_RESPONSE'),
      { status: upstream.ok ? 502 : upstream.status },
    )
  }

  if (!upstream.ok) {
    return NextResponse.json(data, { status: upstream.status })
  }

  return NextResponse.json(data)
}
