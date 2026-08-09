import { NextResponse } from 'next/server'
import { extractBearer } from '@/lib/google-photos-server'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 })
  }

  const { id } = await params
  const { searchParams } = new URL(request.url)
  const items = searchParams.get('items') === 'true'

  const url = items
    ? `https://photospicker.googleapis.com/v1/mediaItems?sessionId=${encodeURIComponent(id)}`
    : `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(id)}`

  const upstream = await fetch(url, {
    headers: { Authorization: authHeader },
  })

  const data = await upstream.json()

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
    return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 })
  }

  const { id } = await params

  const upstream = await fetch(`https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader },
  })

  if (!upstream.ok) {
    const data = await upstream.json().catch(() => ({ error: 'Delete failed' }))
    return NextResponse.json(data, { status: upstream.status })
  }

  return new NextResponse(null, { status: 204 })
}
