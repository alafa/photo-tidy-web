import { NextResponse } from 'next/server'

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url)
  const error = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (error) {
    return NextResponse.redirect(
      `${url.origin}/google-auth-callback?error=${encodeURIComponent(error)}`,
    )
  }

  if (!code || !state) {
    return new NextResponse('Missing required parameters: code and state', { status: 400 })
  }

  const redirectUrl = new URL('/google-auth-callback', url.origin)
  redirectUrl.searchParams.set('code', code)
  redirectUrl.searchParams.set('state', state)

  return NextResponse.redirect(redirectUrl.toString())
}
