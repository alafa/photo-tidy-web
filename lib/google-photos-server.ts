export function extractBearer(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) return null
  return auth
}

export interface UpstreamErrorBody {
  error: { message: string; status: string }
}

export function upstreamErrorBody(message: string, status: string): UpstreamErrorBody {
  return { error: { message, status } }
}
