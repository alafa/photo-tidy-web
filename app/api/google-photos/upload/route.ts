import { NextResponse } from 'next/server'
import {
  extractBearer,
  isTimeoutError,
  parseRetryAfterMs,
  upstreamErrorBody,
} from '@/lib/google-photos-server'

// Raw-byte upload bodies can be large, so this gets more headroom than the
// small-JSON-body routes (batch-create, albums).
const UPLOAD_TIMEOUT_MS = 45_000

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json(
      upstreamErrorBody('Missing or invalid Authorization header', 'UNAUTHENTICATED'),
      { status: 401 },
    )
  }

  const contentType = request.headers.get('X-Goog-Upload-Content-Type') ?? ''
  const filename = request.headers.get('X-Goog-Upload-Filename') ?? ''

  const bytes = await request.arrayBuffer()

  let upstream: Response
  try {
    upstream = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': contentType,
        'X-Goog-Upload-Filename': filename,
        'X-Goog-Upload-Protocol': 'raw',
      },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
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

  if (!upstream.ok) {
    return NextResponse.json(upstreamErrorBody('Upload failed', 'UPLOAD_FAILED'), { status: upstream.status })
  }

  const uploadToken = await upstream.text()

  return new NextResponse(uploadToken, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
