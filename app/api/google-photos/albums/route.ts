import { NextResponse } from 'next/server'
import { extractBearer, upstreamErrorBody } from '@/lib/google-photos-server'

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

  let upstream: Response
  try {
    upstream = await fetch('https://photoslibrary.googleapis.com/v1/albums', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ album: { title: trimmedTitle } }),
    })
  } catch {
    return NextResponse.json(
      upstreamErrorBody('Failed to reach Google Photos API', 'UPSTREAM_UNREACHABLE'),
      { status: 502 },
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
