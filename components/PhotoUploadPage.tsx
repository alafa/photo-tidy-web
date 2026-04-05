'use client'

import { usePhotos } from '@/hooks/usePhotos'
import { useObjectUrls } from '@/hooks/useObjectUrls'
import PhotoGrid from './PhotoGrid'

export default function PhotoUploadPage() {
  const { photos, processFiles } = usePhotos()
  const getObjectUrl = useObjectUrls()

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files)
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-6xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 mb-6">
          photo-tidy
        </h1>

        <label
          className="flex flex-col items-center justify-center w-full border-2 border-dashed border-zinc-300 rounded-xl p-10 cursor-pointer hover:border-zinc-400 transition-colors mb-8 bg-white dark:bg-zinc-900 dark:border-zinc-700"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <span className="text-zinc-500 dark:text-zinc-400 text-sm mb-2">
            Click to select photos, or drag & drop
          </span>
          <span className="text-zinc-400 dark:text-zinc-600 text-xs">
            JPEG, PNG, TIFF supported
          </span>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/tiff"
            onChange={handleChange}
            className="sr-only"
          />
        </label>

        {photos.length > 0 && (
          <PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />
        )}
      </div>
    </div>
  )
}
