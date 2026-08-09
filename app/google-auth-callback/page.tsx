'use client'

import { Suspense, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'

function GoogleAuthCallbackContent() {
  const searchParams = useSearchParams()

  useEffect(() => {
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    if (!window.opener) {
      return
    }

    window.opener.postMessage(
      { type: 'GOOGLE_AUTH_CALLBACK', code, state, error },
      window.location.origin,
    )

    window.close()
  }, [searchParams])

  const error = searchParams.get('error')
  const hasOpener = typeof window !== 'undefined' && window.opener !== null

  if (!hasOpener) {
    return (
      <p style={{ fontFamily: 'sans-serif', padding: '1rem' }}>
        Authentication window opened in wrong context. Please try again.
      </p>
    )
  }

  if (error) {
    return null
  }

  return null
}

export default function GoogleAuthCallbackPage() {
  return (
    <Suspense>
      <GoogleAuthCallbackContent />
    </Suspense>
  )
}
