import { NextResponse } from 'next/server'
import { fetchUpstreamWithTimeout, parseUpstreamJson } from '@/lib/cluster-api-server'

// Short, unlike CLUSTER_TIMEOUT_MS: /health never touches the CLIP model
// (photo-tidy-api's handler is a bare {"status": "ok"}), so it doesn't need
// the long allowance that absorbs the model's slow first load. A short
// timeout here means a hung connection surfaces as "unavailable" in
// seconds rather than leaving the slider silently disabled for up to a
// minute with no explanation.
const HEALTH_TIMEOUT_MS = 8_000

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
