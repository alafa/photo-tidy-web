import { NextResponse } from 'next/server'
import { extractBearer, upstreamErrorBody } from '@/lib/google-photos-server'

export async function GET(
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

  const { id } = await params
  const { searchParams } = new URL(request.url)
  const items = searchParams.get('items') === 'true'

  const url = items
    ? `https://photospicker.googleapis.com/v1/mediaItems?sessionId=${encodeURIComponent(id)}`
    : `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(id)}`

  let upstream: Response
  try {
    upstream = await fetch(url, {
      headers: { Authorization: authHeader },
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

export async function DELETE(
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

  const { id } = await params

  let upstream: Response
  try {
    upstream = await fetch(`https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: authHeader },
    })
  } catch {
    return NextResponse.json(
      upstreamErrorBody('Failed to reach Google Photos API', 'UPSTREAM_UNREACHABLE'),
      { status: 502 },
    )
  }

  if (!upstream.ok) {
    const data = await upstream
      .json()
      .catch(() => upstreamErrorBody('Delete failed', 'INVALID_UPSTREAM_RESPONSE'))
    return NextResponse.json(data, { status: upstream.status })
  }

  return new NextResponse(null, { status: 204 })
}
