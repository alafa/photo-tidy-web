import { NextResponse } from 'next/server'
import { extractBearer, upstreamErrorBody } from '@/lib/google-photos-server'

// Google Photos Picker API media URLs are always served from this host.
// Without this allowlist, a client-supplied baseUrl would let any caller
// direct this server to fetch (and echo back, with our own Authorization
// header attached) an arbitrary URL, including internal/metadata endpoints.
const ALLOWED_BASE_URL_HOST = 'lh3.googleusercontent.com'

export async function POST(request: Request): Promise<NextResponse> {
  const authHeader = extractBearer(request)
  if (!authHeader) {
    return NextResponse.json(
      upstreamErrorBody('Missing or invalid Authorization header', 'UNAUTHENTICATED'),
      { status: 401 },
    )
  }

  let body: { baseUrl?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(upstreamErrorBody('Invalid JSON body', 'INVALID_REQUEST'), { status: 400 })
  }

  const { baseUrl } = body
  if (!baseUrl) {
    return NextResponse.json(
      upstreamErrorBody('Missing required field: baseUrl', 'INVALID_REQUEST'),
      { status: 400 },
    )
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    return NextResponse.json(upstreamErrorBody('Invalid baseUrl', 'INVALID_REQUEST'), { status: 400 })
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== ALLOWED_BASE_URL_HOST) {
    return NextResponse.json(upstreamErrorBody('baseUrl is not an allowed host', 'INVALID_REQUEST'), { status: 400 })
  }

  let upstream: Response
  try {
    upstream = await fetch(`${baseUrl}=d`, {
      headers: { Authorization: authHeader },
    })
  } catch {
    return NextResponse.json(
      upstreamErrorBody('Failed to reach Google Photos API', 'UPSTREAM_UNREACHABLE'),
      { status: 502 },
    )
  }

  if (!upstream.ok) {
    return NextResponse.json(upstreamErrorBody('Download failed', 'DOWNLOAD_FAILED'), { status: upstream.status })
  }

  return new NextResponse(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  })
}
