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
  isSoleSelected?: boolean
  onCopyTimestamp?: () => void
  showKeepBest?: boolean
  isComparingBest?: boolean
  onKeepBest?: () => void
  /**
   * Whether this card is a member of the frozen multi-photo drag group
   * (U4, KTD6) currently in flight -- `components/PhotoUploadPage.tsx`'s
   * `dragGroupIds`, threaded per-card through `PhotoGrid.tsx`'s `renderCard`
   * (mirroring `isCopySource`'s `id === copySourceId` derivation). Only the
   * actively-grabbed card gets `isDragging` from its own `useSortable`
   * instance above; every OTHER dragged-group member needs this prop
   * instead to pick up the same dimmed treatment (R10).
   */
  isInDragGroup?: boolean
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
  isCopySource,
  isCopyModeActive,
  onPaste,
  isSoleSelected,
  onCopyTimestamp,
  showKeepBest,
  isComparingBest,
  onKeepBest,
  isInDragGroup,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging || isInDragGroup ? 0.4 : 1,
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
        isCopySource={isCopySource}
        isCopyModeActive={isCopyModeActive}
        onPaste={onPaste}
        isSoleSelected={isSoleSelected}
        onCopyTimestamp={onCopyTimestamp}
        showKeepBest={showKeepBest}
        isComparingBest={isComparingBest}
        onKeepBest={onKeepBest}
      />
    </div>
  )
}
