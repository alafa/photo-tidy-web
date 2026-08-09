import { NextResponse } from 'next/server'
import { extractBearer } from '@/lib/google-photos-server'

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 })
  }

  const contentType = request.headers.get('X-Goog-Upload-Content-Type') ?? ''
  const filename = request.headers.get('X-Goog-Upload-Filename') ?? ''

  const bytes = await request.arrayBuffer()

  const upstream = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-Content-Type': contentType,
      'X-Goog-Upload-Filename': filename,
      'X-Goog-Upload-Protocol': 'raw',
    },
    body: bytes,
  })

  if (!upstream.ok) {
    return NextResponse.json({ error: 'Upload failed' }, { status: upstream.status })
  }

  const uploadToken = await upstream.text()

  return new NextResponse(uploadToken, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
