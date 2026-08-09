import { NextResponse } from 'next/server'
import { extractBearer } from '@/lib/google-photos-server'

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 })
  }

  let body: { title?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { title } = body
  if (!title) {
    return NextResponse.json({ error: 'Missing required field: title' }, { status: 400 })
  }

  const trimmedTitle = title.trim().slice(0, 500)

  const upstream = await fetch('https://photoslibrary.googleapis.com/v1/albums', {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ album: { title: trimmedTitle } }),
  })

  const data = await upstream.json()

  if (!upstream.ok) {
    return NextResponse.json(data, { status: upstream.status })
  }

  return NextResponse.json(data)
}
