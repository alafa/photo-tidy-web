import { NextResponse } from 'next/server'
import {
  extractBearer,
  fetchUpstreamWithTimeout,
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

  const result = await fetchUpstreamWithTimeout(
    'https://photoslibrary.googleapis.com/v1/uploads',
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': contentType,
        'X-Goog-Upload-Filename': filename,
        'X-Goog-Upload-Protocol': 'raw',
      },
      body: bytes,
    },
    UPLOAD_TIMEOUT_MS,
  )
  if ('errorResponse' in result) return result.errorResponse
  const upstream = result.response

  if (!upstream.ok) {
    return NextResponse.json(upstreamErrorBody('Upload failed', 'UPLOAD_FAILED'), { status: upstream.status })
  }

  const uploadToken = await upstream.text()

  return new NextResponse(uploadToken, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
