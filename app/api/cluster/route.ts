import { NextResponse } from 'next/server'
import { fetchUpstreamWithTimeout, parseUpstreamJson } from '@/lib/cluster-api-server'
import { upstreamErrorBody } from '@/lib/google-photos-server'

// Set above this app's existing longest proxy timeout (45s for uploads) to
// absorb photo-tidy-api's documented slow first request while its CLIP
// model loads lazily on first use.
const CLUSTER_TIMEOUT_MS = 60_000

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(upstreamErrorBody('Invalid JSON body', 'INVALID_REQUEST'), { status: 400 })
  }

  const clusterApiUrl = process.env.CLUSTER_API_URL ?? 'http://localhost:8000'

  const result = await fetchUpstreamWithTimeout(
    `${clusterApiUrl}/api/cluster`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    CLUSTER_TIMEOUT_MS,
  )
  if ('errorResponse' in result) return result.errorResponse
  const upstream = result.response

  const parsed = await parseUpstreamJson(upstream)
  if ('errorResponse' in parsed) return parsed.errorResponse

  // Dumb pass-through: forward the upstream status and body unchanged for
  // both success and every non-2xx (including a 400 naming one rejected
  // photo). Interpreting that case differently is a later unit's job.
  return NextResponse.json(parsed.data, { status: upstream.status })
}
