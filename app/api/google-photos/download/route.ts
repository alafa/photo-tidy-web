import { NextResponse } from 'next/server'
import { extractBearer } from '@/lib/google-photos-server'

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 })
  }

  let body: { baseUrl?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { baseUrl } = body
  if (!baseUrl) {
    return NextResponse.json({ error: 'Missing required field: baseUrl' }, { status: 400 })
  }

  const upstream = await fetch(`${baseUrl}=d`, {
    headers: { Authorization: authHeader },
  })

  if (!upstream.ok) {
    return NextResponse.json({ error: 'Download failed' }, { status: upstream.status })
  }

  return new NextResponse(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  })
}
