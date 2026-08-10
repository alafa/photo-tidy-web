'use client'

import type { PhotoEntry } from '@/hooks/usePhotos'
import type { UploadState, PhotoUploadState } from '@/hooks/useGooglePhotosUpload'

type Props = {
  photos: PhotoEntry[]
  accessToken: string | null
  uploadState: UploadState
  photoStates: Map<string, PhotoUploadState>
  albumName: string
  onAlbumNameChange: (name: string) => void
  onStartUpload: () => void
  onRetryFailed: () => void
}

export default function GooglePhotosUploadPanel({
  photos,
  uploadState,
  photoStates,
  albumName,
  onAlbumNameChange,
  onStartUpload,
  onRetryFailed,
}: Props) {
  const doneCount = photos.filter((p) => photoStates.get(p.id)?.status === 'done').length
  const hasFailures = photos.some((p) => photoStates.get(p.id)?.status === 'failed')
  const isNameEmpty = albumName.trim() === ''
  const hasDoneGooglePhotosOrigin = photos.some(
    (p) => p.source === 'google-photos' && photoStates.get(p.id)?.status === 'done'
  )
  // If no photo ever progressed past 'pending', the failure happened before any
  // per-photo attempt (e.g. album creation failed) — there's nothing to retry
  // per-photo, so offer a full restart instead of "Retry failed".
  const noPhotoStarted = photos.every((p) => (photoStates.get(p.id)?.status ?? 'pending') === 'pending')

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 mb-6">
      {/* Album name input */}
      <div className="mb-3">
        <input
          type="text"
          maxLength={487}
          placeholder="Album name"
          value={albumName}
          onChange={(e) => onAlbumNameChange(e.target.value)}
          className="text-sm border border-zinc-300 dark:border-zinc-600 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-400 focus:outline-none w-full"
        />
        {isNameEmpty && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Enter a name to enable upload
          </p>
        )}
      </div>

      {/* Upload button */}
      <div className="mb-3">
        <button
          onClick={onStartUpload}
          disabled={uploadState === 'uploading' || isNameEmpty}
          className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Upload to Google Photos
        </button>
      </div>

      {/* Progress summary */}
      {uploadState === 'uploading' && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
          Uploading {doneCount} of {photos.length}…
        </p>
      )}

      {/* Error banner */}
      {uploadState === 'error' && (
        <div className="bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300 rounded-lg px-3 py-2 text-sm mb-3">
          {noPhotoStarted
            ? 'Upload failed before any photos could be sent — the album could not be created.'
            : 'Upload failed.'}
        </div>
      )}

      {/* Retry action: full restart when nothing was attempted yet, otherwise
          reuse the per-photo "Retry failed" flow for the photos that failed. */}
      {uploadState === 'error' && noPhotoStarted && (
        <div className="mb-3">
          <button
            onClick={onStartUpload}
            className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Retry upload
          </button>
        </div>
      )}
      {uploadState === 'error' && !noPhotoStarted && hasFailures && (
        <div className="mb-3">
          <button
            onClick={onRetryFailed}
            className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Retry failed
          </button>
        </div>
      )}

      {/* Success banner: full success (green) vs partial success (amber) */}
      {uploadState === 'done' && !hasFailures && (
        <div className="bg-green-50 border border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-700 dark:text-green-300 rounded-lg px-3 py-2 text-sm mb-3">
          {albumName.trim()
            ? `${doneCount} photos uploaded to album '${albumName.trim()}'`
            : `${doneCount} photos uploaded to Google Photos`}
          {hasDoneGooglePhotosOrigin && (
            <p className="mt-1">
              If these photos came from an existing Google Photos album, you can now delete it manually.
            </p>
          )}
        </div>
      )}
      {uploadState === 'done' && hasFailures && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-300 rounded-lg px-3 py-2 text-sm mb-3">
          {doneCount} of {photos.length} photos uploaded — see failures below
          {hasDoneGooglePhotosOrigin && (
            <p className="mt-1">
              If these photos came from an existing Google Photos album, you can now delete it manually.
            </p>
          )}
        </div>
      )}

      {/* Retry failed button */}
      {uploadState === 'done' && hasFailures && (
        <div className="mb-3">
          <button
            onClick={onRetryFailed}
            className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Retry failed
          </button>
        </div>
      )}

      {/* Per-photo progress list */}
      {uploadState !== 'idle' && (
        <ul className="space-y-1">
          {photos.map((photo) => {
            const state = photoStates.get(photo.id)
            const status = state?.status ?? 'pending'
            return (
              <li key={photo.id} className="text-sm text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
                <span className="truncate">{photo.filename}</span>
                <span className="ml-auto shrink-0">
                  {status === 'pending' && <span className="text-zinc-400">⏳</span>}
                  {status === 'uploading' && <span className="text-zinc-500">↑ Uploading</span>}
                  {status === 'done' && <span className="text-green-600 dark:text-green-400">✓ Done</span>}
                  {status === 'failed' && (
                    <span className="text-red-600 dark:text-red-400">
                      ✗ Failed{state?.error ? `: ${state.error}` : ''}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
