import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'

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

// --- test helpers -------------------------------------------------------
//
// Hashes are built from explicit "on" bit positions (not raw hex literals)
// so cosine distances between fixtures are exactly predictable by hand —
// same technique as hooks/useClusteredPhotos.test.ts and the old
// components/ClusterView.test.tsx.

const HASH_TOTAL_BITS = 128

function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i <= end; i++) out.push(i)
  return out
}

function hashFromPositions(positions: number[]): string {
  const bits = new Array(HASH_TOTAL_BITS).fill(0)
  for (const position of positions) bits[position] = 1
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16)
  }
  return hex
}

function makeEntry(name: string, index: number, capturedAt: string | null = `2025-0${index + 1}-01T10:00:00Z`): PhotoEntry {
  return {
    id: `${name}-${index}`,
    file: new File([], name, { type: 'image/jpeg' }),
    filename: name,
    capturedAt: capturedAt ? new Date(capturedAt) : null,
    uploadIndex: index,
    source: 'local',
  }
}

function makeMetrics(hash: string | null, width = 100, height = 100, size = 1000): PhotoMetrics {
  return { width, height, size, hash }
}

const getObjectUrl = (file: File) => `blob:${file.name}`
const emptyMetrics = new Map<string, PhotoMetrics | undefined>()

describe('PhotoGrid', () => {
  it('renders all photo filenames', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    render(<PhotoGrid photos={photos} metrics={emptyMetrics} getObjectUrl={getObjectUrl} />)
    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('b.jpg')).toBeDefined()
  })

  it('renders SortablePhotoCard (with drag attributes) when onReorder is provided', () => {
    const photos = [makeEntry('a.jpg', 0)]
    render(
      <PhotoGrid
        photos={photos}
        metrics={emptyMetrics}
        getObjectUrl={getObjectUrl}
        onReorder={vi.fn()}
      />
    )
    // useSortable adds aria-roledescription="sortable item" via attributes spread
    expect(document.querySelector('[aria-roledescription="sortable item"]')).not.toBeNull()
  })

  it('does NOT add drag attributes when onReorder is absent', () => {
    const photos = [makeEntry('a.jpg', 0)]
    render(<PhotoGrid photos={photos} metrics={emptyMetrics} getObjectUrl={getObjectUrl} />)
    expect(document.querySelector('[aria-roledescription="sortable item"]')).toBeNull()
  })

  it('renders the correct number of cards', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    render(<PhotoGrid photos={photos} metrics={emptyMetrics} getObjectUrl={getObjectUrl} />)
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })

  it('forwards selection props to cards (checked/onSelect reach the underlying card)', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    const onSelect = vi.fn()
    render(
      <PhotoGrid
        photos={photos}
        metrics={emptyMetrics}
        getObjectUrl={getObjectUrl}
        selectedIds={new Set(['a.jpg-0'])}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByAltText('b.jpg'))
    expect(onSelect).toHaveBeenCalledWith('b.jpg-1', true)
  })

  it('AE1: at the 0% default with no exact duplicates, the grid renders like a flat timeline — no bordered cluster sections', () => {
    const photos = [
      makeEntry('a.jpg', 0),
      makeEntry('b.jpg', 1),
      makeEntry('c.jpg', 2),
    ]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a.jpg-0', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b.jpg-1', makeMetrics(hashFromPositions(range(30, 39)))],
      ['c.jpg-2', makeMetrics(hashFromPositions(range(60, 69)))],
    ])

    render(<PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />)

    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('b.jpg')).toBeDefined()
    expect(screen.getByText('c.jpg')).toBeDefined()
    expect(document.querySelectorAll('section')).toHaveLength(0)
    // Similarity slider defaults to 0%.
    expect((screen.getByLabelText(/Similarity/) as HTMLInputElement).value).toBe('0')
  })

  it('a 3-member cluster at the current threshold renders one bordered section with a "3 related photos" header, positioned chronologically among singleton blocks', () => {
    // p1/p2/p3 are hash-identical (distance 0, clusters at 0%); solo1 sorts
    // chronologically before them, solo2 sorts chronologically after them.
    const solo1 = makeEntry('solo1.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const p3 = makeEntry('p3.jpg', 3, '2025-01-03T00:00:00Z')
    const solo2 = makeEntry('solo2.jpg', 4, '2025-06-01T00:00:00Z')
    const photos = [solo1, p1, p2, p3, solo2]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p3.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [solo1.id, makeMetrics(hashFromPositions(range(60, 69)))],
      [solo2.id, makeMetrics(hashFromPositions(range(90, 99)))],
    ])

    render(<PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />)

    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(1)
    expect(sections[0].textContent).toContain('3 related photos')

    // All five photos still render somewhere.
    expect(screen.getByText('solo1.jpg')).toBeDefined()
    expect(screen.getByText('p1.jpg')).toBeDefined()
    expect(screen.getByText('p2.jpg')).toBeDefined()
    expect(screen.getByText('p3.jpg')).toBeDefined()
    expect(screen.getByText('solo2.jpg')).toBeDefined()

    // Chronological position: the cluster section sits after solo1's card
    // and before solo2's card in document order.
    const solo1Img = screen.getByAltText('solo1.jpg')
    const solo2Img = screen.getByAltText('solo2.jpg')
    expect(solo1Img.compareDocumentPosition(sections[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sections[0].compareDocumentPosition(solo2Img) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('moving the slider live re-renders blocks without tearing down and recreating an unrelated card', () => {
    // Both photos have no resolved hash, so they remain singletons at every
    // threshold — proving the re-render is a live update, not a remount.
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    render(<PhotoGrid photos={photos} metrics={emptyMetrics} getObjectUrl={getObjectUrl} />)

    const imgBefore = screen.getByAltText('a.jpg')
    fireEvent.change(screen.getByLabelText(/Similarity/), { target: { value: '50' } })
    const imgAfter = screen.getByAltText('a.jpg')

    expect(imgAfter).toBe(imgBefore)
  })

  it('debug mode is off by default: no checked toggle, no PairwiseDistances panel, no active Compare affordances', () => {
    const p1 = makeEntry('p1.jpg', 0)
    const p2 = makeEntry('p2.jpg', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
    ])

    render(<PhotoGrid photos={[p1, p2]} metrics={metrics} getObjectUrl={getObjectUrl} />)

    const debugToggle = screen.getByRole('checkbox', { name: 'Debug mode' }) as HTMLInputElement
    expect(debugToggle.checked).toBe(false)
    expect(screen.queryByText(/cosine distance/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull()
  })

  it('toggling debug mode on renders the PairwiseDistances panel for each multi-member cluster and a Compare button on every card', () => {
    const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const photos = [solo, p1, p2]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [solo.id, makeMetrics(hashFromPositions(range(60, 69)))],
    ])

    render(<PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }))

    // Pairwise distance line for the two-member cluster.
    expect(screen.getByText(/p1\.jpg ↔ p2\.jpg/)).toBeDefined()

    // A Compare button renders as a sibling on every card, clustered or not.
    expect(screen.getAllByRole('button', { name: 'Compare' })).toHaveLength(3)
  })
})
