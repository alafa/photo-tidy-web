import type { PhotoEntry } from '@/hooks/usePhotos'
import PhotoCard from './PhotoCard'

type Props = {
  photos: PhotoEntry[]
  getObjectUrl: (file: File) => string
}

export default function PhotoGrid({ photos, getObjectUrl }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
      {photos.map((entry) => (
        <PhotoCard
          key={`${entry.filename}-${entry.file.lastModified}-${entry.uploadIndex}`}
          entry={entry}
          objectUrl={getObjectUrl(entry.file)}
        />
      ))}
    </div>
  )
}
