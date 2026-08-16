import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import ClusterView from './ClusterView'

afterEach(cleanup)

const getObjectUrl = (file: File) => `blob:${file.name}`

function makeEntry(id: string, name: string, capturedAt: string | null, uploadIndex: number): PhotoEntry {
  return {
    id,
    file: new File([], name, { type: 'image/jpeg' }),
    filename: name,
    capturedAt: capturedAt ? new Date(capturedAt) : null,
    uploadIndex,
    source: 'local',
  }
}

function makeMetrics(hash: string | null): PhotoMetrics {
  return { width: 100, height: 100, size: 1000, hash }
}

describe('ClusterView', () => {
  it('renders clusters ordered ascending by earliest member capturedAt', () => {
    // Cluster 1: A, B, C — all mutually related via hash distance, earliest
    // member is B (2024-01-15).
    const a = makeEntry('a', 'a.jpg', '2024-03-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-15T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-02-01T00:00:00Z', 2)
    // Cluster 2 (singleton): D — later than cluster 1's earliest member.
    const d = makeEntry('d', 'd.jpg', '2024-05-01T00:00:00Z', 3)

    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')], // distance to a: 0 (identical)
      ['c', makeMetrics('000000000000000f')], // distance to a/b: 4 (similar)
      ['d', makeMetrics('ffffffffffffffff')], // distance to everything: 64 (unrelated)
    ])

    render(<ClusterView photos={[a, b, c, d]} metrics={metrics} getObjectUrl={getObjectUrl} />)

    const headings = screen.getAllByRole('heading', { level: 2 })
    // First section (cluster 1, earliest = b's 2024-01-15) should list a/b/c
    // before the singleton cluster containing d.
    const sections = screen.getAllByRole('img').map((img) => img.getAttribute('alt'))
    expect(sections.indexOf('d.jpg')).toBeGreaterThan(sections.indexOf('b.jpg'))
    expect(headings.length).toBe(2)
  })

  it('renders a singleton photo (no relationships) as its own one-member cluster', () => {
    const solo = makeEntry('solo', 'solo.jpg', '2024-01-01T00:00:00Z', 0)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['solo', makeMetrics('ffffffffffffffff')],
    ])

    render(<ClusterView photos={[solo]} metrics={metrics} getObjectUrl={getObjectUrl} />)

    expect(screen.getByText('solo.jpg')).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it('renders all cluster members fully expanded with no collapse/expand interaction', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')],
      ['c', makeMetrics('000000000000000f')],
    ])

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} />)

    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /show more|expand|collapse/i })).toBeNull()
  })

  it('distinguishes identical vs similar members with both a visual attribute and an accessible-name equivalent', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    // a-b distance 0 -> identical; a-c and b-c distance 4 -> similar.
    // a and b are each touched by the identical relationship -> "identical".
    // c is only touched by similar relationships -> "similar".
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')],
      ['c', makeMetrics('000000000000000f')],
    ])

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} />)

    const identicalGroups = screen.getAllByRole('group', { name: 'Identical' })
    expect(identicalGroups.length).toBe(2) // a and b

    const similarGroups = screen.getAllByRole('group', { name: 'Similar' })
    expect(similarGroups.length).toBe(1) // c

    // Visual attribute: a distinguishing class is present on each tier's wrapper.
    for (const group of identicalGroups) {
      expect(group.className).toContain('ring-emerald-500')
    }
    for (const group of similarGroups) {
      expect(group.className).toContain('ring-amber-500')
    }

    // Accessible-name equivalent: sr-only text is also present, not just color/border.
    expect(screen.getAllByText('Identical', { selector: '.sr-only' }).length).toBe(2)
    expect(screen.getAllByText('Similar', { selector: '.sr-only' }).length).toBe(1)
  })

  it('renders without any drag-and-drop wiring', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const metrics = new Map<string, PhotoMetrics | undefined>([['a', makeMetrics(null)]])

    // No DndContext provider is set up around this render at all — if
    // ClusterView (or anything it renders) required dnd-kit's sortable
    // context, this would throw. It doesn't, and no sortable-specific
    // attributes appear anywhere in the output.
    expect(() =>
      render(<ClusterView photos={[a]} metrics={metrics} getObjectUrl={getObjectUrl} />)
    ).not.toThrow()

    expect(document.querySelector('[aria-roledescription="sortable item"]')).toBeNull()
  })

  it('renders a photo with in-flight metrics (absent or undefined map entry) as a temporary singleton', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const stillComputing = makeEntry('pending', 'pending.jpg', '2024-01-02T00:00:00Z', 1)

    // 'pending' has no entry at all in the map; 'a' is present but explicitly undefined.
    const metrics = new Map<string, PhotoMetrics | undefined>([['a', undefined]])

    render(<ClusterView photos={[a, stillComputing]} metrics={metrics} getObjectUrl={getObjectUrl} />)

    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('pending.jpg')).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    // Neither has a resolved hash, so neither should carry an identical/similar flag.
    expect(screen.queryByRole('group', { name: 'Identical' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Similar' })).toBeNull()
  })
})
