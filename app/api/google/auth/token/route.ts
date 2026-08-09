import { NextResponse } from 'next/server'
import { getGoogleClientId, getGoogleClientSecret } from '@/lib/google-auth-server'

interface TokenRequestBody {
  code: string
  codeVerifier: string
  redirectUri: string
}

interface GoogleTokenResponse {
  access_token: string
  expires_in: number
  token_type: string
  id_token?: string
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: TokenRequestBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { code, codeVerifier, redirectUri } = body

  if (!code || !codeVerifier || !redirectUri) {
    return NextResponse.json(
      { error: 'Missing required fields: code, codeVerifier, redirectUri' },
      { status: 400 },
    )
  }

  let clientId: string
  let clientSecret: string
  try {
    clientId = getGoogleClientId()
    clientSecret = getGoogleClientSecret()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server configuration error'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
  })

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text()
    return NextResponse.json(
      { error: 'Token exchange failed', details: errorText },
      { status: 502 },
    )
  }

  const tokenData: GoogleTokenResponse = await tokenResponse.json()

  return NextResponse.json({
    accessToken: tokenData.access_token,
    expiresIn: tokenData.expires_in,
    idToken: tokenData.id_token ?? null,
  })
}
