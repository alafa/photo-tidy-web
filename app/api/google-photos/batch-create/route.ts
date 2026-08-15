import { NextResponse } from 'next/server'
import {
  extractBearer,
  fetchUpstreamWithTimeout,
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

  let body: { uploadTokens?: UploadToken[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(upstreamErrorBody('Invalid JSON body', 'INVALID_REQUEST'), { status: 400 })
  }

  const { uploadTokens } = body
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

  // Album membership is no longer requested here — batchCreate's response
  // only reports media-item-creation status, never album-attachment status,
  // so passing albumId here would make Google attempt the album-add twice
  // (once here, once via the explicit reconciliation call in
  // albums/[id]/batch-add) without any confirmation this call's attempt
  // even succeeded. Reconciliation is now the sole album-add mechanism.
  const requestBody: { newMediaItems: NewMediaItem[] } = { newMediaItems }

  const result = await fetchUpstreamWithTimeout(
    'https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate',
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    },
    BATCH_CREATE_TIMEOUT_MS,
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
