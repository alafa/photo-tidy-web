function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const randomBytes = new Uint8Array(32)
  crypto.getRandomValues(randomBytes)
  const verifier = base64UrlEncode(randomBytes.buffer as ArrayBuffer)

  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const challenge = base64UrlEncode(hashBuffer)

  return { verifier, challenge }
}

export interface BuildGoogleAuthUrlParams {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scopes: string[]
}

export function buildGoogleAuthUrl(params: BuildGoogleAuthUrlParams): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('scope', params.scopes.join(' '))
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'online')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}
