import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PhotoEntry } from '@/hooks/usePhotos'
import PhotoCard from './PhotoCard'

type Props = {
  id: string
  entry: PhotoEntry
  objectUrl: string
  onNameChange?: (newName: string) => void
  onTimestampChange?: (newDate: Date | null) => void
  onSelect?: (checked: boolean) => void
  checked?: boolean
  onDelete?: () => void
}

export default function SortablePhotoCard({
  id,
  entry,
  objectUrl,
  onNameChange,
  onTimestampChange,
  onSelect,
  checked,
  onDelete,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    // listeners are on the wrapper; inputs/checkboxes inside PhotoCard stop propagation
    <div ref={setNodeRef} style={{ ...style, cursor: 'grab' }} {...attributes} {...listeners}>
      <PhotoCard
        entry={entry}
        objectUrl={objectUrl}
        onNameChange={onNameChange}
        onTimestampChange={onTimestampChange}
        onSelect={onSelect}
        checked={checked}
        onDelete={onDelete}
      />
    </div>
  )
}
