'use client'

type Props = {
  isSignedIn: boolean
  accountEmail: string | null
  isExpiringSoon: boolean
  signIn: () => void
  signOut: () => void
}

export default function GoogleAuthStatus({
  isSignedIn,
  accountEmail,
  isExpiringSoon,
  signIn,
  signOut,
}: Props) {
  if (!isSignedIn) {
    return (
      <div className="mb-6">
        <button
          onClick={signIn}
          className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Connect Google Photos
        </button>
      </div>
    )
  }

  const displayName = accountEmail ?? 'Google account connected'

  return (
    <div className="mb-6 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-700 dark:text-zinc-300">{displayName}</span>
        <button
          onClick={signOut}
          className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline"
        >
          Disconnect
        </button>
      </div>

      {isExpiringSoon && (
        <div className="py-1.5 px-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-300 text-xs">
          Your Google session expires soon —{' '}
          <button
            onClick={signIn}
            className="underline hover:no-underline"
          >
            click to refresh
          </button>
        </div>
      )}
    </div>
  )
}
