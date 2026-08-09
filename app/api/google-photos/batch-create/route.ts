import { NextResponse } from 'next/server'
import { extractBearer } from '@/lib/google-photos-server'
import type { UploadToken, NewMediaItem } from '@/lib/google-photos-types'

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 })
  }

  let body: { uploadTokens?: UploadToken[]; albumId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { uploadTokens, albumId } = body
  if (!uploadTokens || uploadTokens.length === 0) {
    return NextResponse.json(
      { error: 'Missing or empty required field: uploadTokens' },
      { status: 400 },
    )
  }

  const newMediaItems: NewMediaItem[] = uploadTokens.map(({ token, filename }) => ({
    simpleMediaItem: {
      fileName: filename,
      uploadToken: token,
    },
  }))

  const requestBody: {
    newMediaItems: NewMediaItem[]
    albumId?: string
  } = { newMediaItems }

  if (albumId) {
    requestBody.albumId = albumId
  }

  const upstream = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  const data = await upstream.json()

  if (!upstream.ok) {
    return NextResponse.json(data, { status: upstream.status })
  }

  return NextResponse.json(data)
}
