import { NextResponse } from 'next/server'
import {
  extractBearer,
  fetchUpstreamWithTimeout,
  upstreamErrorBody,
} from '@/lib/google-photos-server'

// Small JSON body — matches albums/batch-create's budget, shorter than the
// raw-byte upload route's.
const BATCH_ADD_TIMEOUT_MS = 12_000

// Reconciliation endpoint: confirms media items landed in the target album.
// batchCreate's own response only reports media-item-creation status, never
// album-attachment status, so this is the sole mechanism that ever adds an
// item to an album (see the removal of `albumId` from the batch-create
// route's request body).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json(
      upstreamErrorBody('Missing or invalid Authorization header', 'UNAUTHENTICATED'),
      { status: 401 },
    )
  }

  let body: { mediaItemIds?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(upstreamErrorBody('Invalid JSON body', 'INVALID_REQUEST'), { status: 400 })
  }

  const { mediaItemIds } = body
  if (!mediaItemIds || mediaItemIds.length === 0) {
    return NextResponse.json(
      upstreamErrorBody('Missing or empty required field: mediaItemIds', 'INVALID_REQUEST'),
      { status: 400 },
    )
  }
  if (mediaItemIds.length > 50) {
    return NextResponse.json(
      upstreamErrorBody('mediaItemIds exceeds the 50-item limit', 'INVALID_REQUEST'),
      { status: 400 },
    )
  }

  const { id } = await params

  const result = await fetchUpstreamWithTimeout(
    `https://photoslibrary.googleapis.com/v1/albums/${encodeURIComponent(id)}:batchAddMediaItems`,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mediaItemIds }),
    },
    BATCH_ADD_TIMEOUT_MS,
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
