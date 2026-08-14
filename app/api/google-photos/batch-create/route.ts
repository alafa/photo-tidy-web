import { NextResponse } from 'next/server'
import {
  extractBearer,
  isTimeoutError,
  parseRetryAfterMs,
  upstreamErrorBody,
} from '@/lib/google-photos-server'
import type { UploadToken, NewMediaItem } from '@/lib/google-photos-types'

// Small JSON body — this and albums get a shorter budget than the raw-byte
// upload route.
const BATCH_CREATE_TIMEOUT_MS = 12_000

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json(
      upstreamErrorBody('Missing or invalid Authorization header', 'UNAUTHENTICATED'),
      { status: 401 },
    )
  }

  let body: { uploadTokens?: UploadToken[]; albumId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(upstreamErrorBody('Invalid JSON body', 'INVALID_REQUEST'), { status: 400 })
  }

  const { uploadTokens, albumId } = body
  if (!uploadTokens || uploadTokens.length === 0) {
    return NextResponse.json(
      upstreamErrorBody('Missing or empty required field: uploadTokens', 'INVALID_REQUEST'),
      { status: 400 },
    )
  }

  const newMediaItems: NewMediaItem[] = uploadTokens.map(({ token, filename }) => ({
    simpleMediaItem: {
      fileName: filename,
      uploadToken: token,
    },
  }))

  const requestBody: {
    newMediaItems: NewMediaItem[]
    albumId?: string
  } = { newMediaItems }

  if (albumId) {
    requestBody.albumId = albumId
  }

  let upstream: Response
  try {
    upstream = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(BATCH_CREATE_TIMEOUT_MS),
    })
  } catch (err) {
    if (isTimeoutError(err)) {
      return NextResponse.json(
        upstreamErrorBody('Request to Google Photos timed out', 'REQUEST_TIMEOUT'),
        { status: 504 },
      )
    }
    return NextResponse.json(
      upstreamErrorBody('Failed to reach Google Photos API', 'UPSTREAM_UNREACHABLE'),
      { status: 502 },
    )
  }

  if (upstream.status === 429) {
    const retryAfterMs = parseRetryAfterMs(upstream.headers.get('Retry-After'))
    return NextResponse.json(
      upstreamErrorBody('Rate limited by Google Photos', 'RATE_LIMITED', retryAfterMs),
      { status: 429 },
    )
  }

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
