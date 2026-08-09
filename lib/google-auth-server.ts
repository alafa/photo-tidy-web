if (typeof window !== 'undefined') {
  throw new Error('google-auth-server must only be used on the server side')
}

export function getGoogleClientId(): string {
  const value = process.env.GOOGLE_CLIENT_ID
  if (!value) {
    throw new Error('Missing required environment variable: GOOGLE_CLIENT_ID')
  }
  return value
}

export function getGoogleClientSecret(): string {
  const value = process.env.GOOGLE_CLIENT_SECRET
  if (!value) {
    throw new Error('Missing required environment variable: GOOGLE_CLIENT_SECRET')
  }
  return value
}
