import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PhotoEntry } from '@/hooks/usePhotos'
import PhotoCard from './PhotoCard'

type Props = {
  id: string
  entry: PhotoEntry
  objectUrl: string
}

export default function SortablePhotoCard({ id, entry, objectUrl }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    cursor: 'grab',
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <PhotoCard entry={entry} objectUrl={objectUrl} />
    </div>
  )
}
