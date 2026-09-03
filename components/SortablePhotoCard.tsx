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
  onZoom?: () => void
  onEditingChange?: (isEditing: boolean) => void
  /**
   * Threaded straight through to `PhotoCard` (U3's copy-mode props) --
   * `PhotoGrid.tsx` always renders `SortablePhotoCard` when `onReorder` is
   * provided, which is unconditionally true in the real app (drag-and-drop
   * is always wired), so copy mode's per-card highlight/paste button must
   * reach `PhotoCard` through here too, not just the plain-`PhotoCard`
   * branch used only when drag is disabled (e.g. `DragOverlay`).
   */
  isCopySource?: boolean
  isCopyModeActive?: boolean
  onPaste?: () => void
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
  onZoom,
  onEditingChange,
  isCopySource,
  isCopyModeActive,
  onPaste,
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
        onZoom={onZoom}
        onEditingChange={onEditingChange}
        isCopySource={isCopySource}
        isCopyModeActive={isCopyModeActive}
        onPaste={onPaste}
      />
    </div>
  )
}
