import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'

afterEach(cleanup)

// Mock dnd-kit so tests don't need a real DndContext
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: () => ({
    attributes: { 'aria-roledescription': 'sortable item' },
    listeners: { 'data-testid': 'drag-listener' },
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  rectSortingStrategy: vi.fn(),
}))

import PhotoGrid from './PhotoGrid'

function makeEntry(name: string, index: number): PhotoEntry {
  return {
    file: new File([], name, { type: 'image/jpeg' }),
    filename: name,
    capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
    uploadIndex: index,
  }
}

const getObjectUrl = (file: File) => `blob:${file.name}`

describe('PhotoGrid', () => {
  it('renders all photo filenames', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)
    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('b.jpg')).toBeDefined()
  })

  it('renders SortablePhotoCard (with drag attributes) when onReorder is provided', () => {
    const photos = [makeEntry('a.jpg', 0)]
    render(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        onReorder={vi.fn()}
      />
    )
    // useSortable adds aria-roledescription="sortable item" via attributes spread
    expect(document.querySelector('[aria-roledescription="sortable item"]')).not.toBeNull()
  })

  it('does NOT add drag attributes when onReorder is absent', () => {
    const photos = [makeEntry('a.jpg', 0)]
    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)
    expect(document.querySelector('[aria-roledescription="sortable item"]')).toBeNull()
  })

  it('renders the correct number of cards', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })
})
