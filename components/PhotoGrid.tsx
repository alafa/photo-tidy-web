import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import type { PhotoEntry } from '@/hooks/usePhotos'
import PhotoCard from './PhotoCard'
import SortablePhotoCard from './SortablePhotoCard'

type Props = {
  photos: PhotoEntry[]
  getObjectUrl: (file: File) => string
  onReorder?: (from: number, to: number) => void
  onNameChange?: (id: string, newName: string) => void
  onTimestampChange?: (id: string, newDate: Date | null) => void
  selectedIds?: Set<string>
  onSelect?: (id: string, checked: boolean) => void
}

export default function PhotoGrid({
  photos,
  getObjectUrl,
  onReorder,
  onNameChange,
  onTimestampChange,
  selectedIds,
  onSelect,
}: Props) {
  const grid = (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
      {photos.map((entry) => {
        const id = entry.id
        if (onReorder) {
          return (
            <SortablePhotoCard
              key={id}
              id={id}
              entry={entry}
              objectUrl={getObjectUrl(entry.file)}
              onNameChange={onNameChange ? (name) => onNameChange(id, name) : undefined}
              onTimestampChange={onTimestampChange ? (date) => onTimestampChange(id, date) : undefined}
              onSelect={onSelect ? (checked) => onSelect(id, checked) : undefined}
              checked={selectedIds?.has(id)}
            />
          )
        }
        return (
          <PhotoCard
            key={id}
            entry={entry}
            objectUrl={getObjectUrl(entry.file)}
            onNameChange={onNameChange ? (name) => onNameChange(id, name) : undefined}
            onTimestampChange={onTimestampChange ? (date) => onTimestampChange(id, date) : undefined}
            onSelect={onSelect ? (checked) => onSelect(id, checked) : undefined}
            checked={selectedIds?.has(id)}
          />
        )
      })}
    </div>
  )

  if (onReorder) {
    return (
      <SortableContext items={photos.map((p) => p.id)} strategy={rectSortingStrategy}>
        {grid}
      </SortableContext>
    )
  }

  return grid
}
