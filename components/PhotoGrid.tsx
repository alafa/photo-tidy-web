import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import type { PhotoEntry } from '@/hooks/usePhotos'
import PhotoCard from './PhotoCard'
import SortablePhotoCard from './SortablePhotoCard'

type Props = {
  photos: PhotoEntry[]
  getObjectUrl: (file: File) => string
  onReorder?: (from: number, to: number) => void
}

function photoId(entry: PhotoEntry): string {
  return `${entry.filename}-${entry.file.lastModified}-${entry.uploadIndex}`
}

export { photoId }

export default function PhotoGrid({ photos, getObjectUrl, onReorder }: Props) {
  const grid = (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
      {photos.map((entry) => {
        const id = photoId(entry)
        if (onReorder) {
          return (
            <SortablePhotoCard
              key={id}
              id={id}
              entry={entry}
              objectUrl={getObjectUrl(entry.file)}
            />
          )
        }
        return (
          <PhotoCard
            key={id}
            entry={entry}
            objectUrl={getObjectUrl(entry.file)}
          />
        )
      })}
    </div>
  )

  if (onReorder) {
    return (
      <SortableContext items={photos.map(photoId)} strategy={rectSortingStrategy}>
        {grid}
      </SortableContext>
    )
  }

  return grid
}
