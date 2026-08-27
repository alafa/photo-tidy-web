import { NextResponse } from 'next/server'
import { fetchUpstreamWithTimeout, parseUpstreamJson } from '@/lib/cluster-api-server'

// Set above this app's existing longest proxy timeout (45s for uploads) to
// absorb photo-tidy-api's documented slow first request while its CLIP
// model loads lazily on first use.
const HEALTH_TIMEOUT_MS = 60_000

export async function GET(): Promise<NextResponse> {
  const clusterApiUrl = process.env.CLUSTER_API_URL ?? 'http://localhost:8000'

  const result = await fetchUpstreamWithTimeout(
    `${clusterApiUrl}/health`,
    { method: 'GET' },
    HEALTH_TIMEOUT_MS,
  )
  if ('errorResponse' in result) return result.errorResponse
  const upstream = result.response

  const parsed = await parseUpstreamJson(upstream)
  if ('errorResponse' in parsed) return parsed.errorResponse

  return NextResponse.json(parsed.data, { status: upstream.status })
}
