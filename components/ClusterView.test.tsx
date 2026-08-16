import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import ClusterView from './ClusterView'

afterEach(cleanup)

const getObjectUrl = (file: File) => `blob:${file.name}`
const noopRemovePhotos = () => {}
const noopBatchSetTimestamps = () => {}

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

function makeMetrics(hash: string | null, width = 100, height = 100, size = 1000): PhotoMetrics {
  return { width, height, size, hash }
}

describe('ClusterView', () => {
  // --- Grouping / clustering ------------------------------------------------

  it('renders clusters ordered ascending by earliest member capturedAt', () => {
    // Cluster 1: A, B, C — all mutually within the default threshold,
    // earliest member is B (2024-01-15).
    const a = makeEntry('a', 'a.jpg', '2024-03-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-15T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-02-01T00:00:00Z', 2)
    // Cluster 2 (singleton): D — later than cluster 1's earliest member.
    const d = makeEntry('d', 'd.jpg', '2024-05-01T00:00:00Z', 3)

    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')], // distance to a: 0
      ['c', makeMetrics('000000000000000f')], // distance to a/b: 4
      ['d', makeMetrics('ffffffffffffffff')], // distance to everything: 64 (unrelated)
    ])

    render(<ClusterView photos={[a, b, c, d]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    const headings = screen.getAllByRole('heading', { level: 2 })
    // First section (cluster 1, earliest = b's 2024-01-15) should list a/b/c
    // before the singleton d, which renders plainly (no heading — singles
    // don't display as clusters).
    const sections = screen.getAllByRole('img').map((img) => img.getAttribute('alt'))
    expect(sections.indexOf('d.jpg')).toBeGreaterThan(sections.indexOf('b.jpg'))
    expect(headings.length).toBe(1)
  })

  it('renders a photo with no similarity match plainly, not as a one-member cluster', () => {
    const solo = makeEntry('solo', 'solo.jpg', '2024-01-01T00:00:00Z', 0)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['solo', makeMetrics('ffffffffffffffff')],
    ])

    render(<ClusterView photos={[solo]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.getByText('solo.jpg')).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
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

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /show more|expand|collapse/i })).toBeNull()
  })

  it('renders without any drag-and-drop wiring', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const metrics = new Map<string, PhotoMetrics | undefined>([['a', makeMetrics(null)]])

    // No DndContext provider is set up around this render at all — if
    // ClusterView (or anything it renders) required dnd-kit's sortable
    // context, this would throw. It doesn't, and no sortable-specific
    // attributes appear anywhere in the output.
    expect(() =>
      render(<ClusterView photos={[a]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)
    ).not.toThrow()

    expect(document.querySelector('[aria-roledescription="sortable item"]')).toBeNull()
  })

  it('renders a photo with in-flight metrics (absent or undefined map entry) as a temporary singleton', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const stillComputing = makeEntry('pending', 'pending.jpg', '2024-01-02T00:00:00Z', 1)

    // 'pending' has no entry at all in the map; 'a' is present but explicitly undefined.
    const metrics = new Map<string, PhotoMetrics | undefined>([['a', undefined]])

    render(<ClusterView photos={[a, stillComputing]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('pending.jpg')).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    // Neither has a resolved hash, so neither should be clustered together.
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  })

  it('never removes anything automatically — no auto-dedup of any kind', () => {
    // Three photos with an identical hash — the old auto-dedup behavior
    // would have auto-removed two of these with no confirmation. That
    // behavior is removed entirely; grouping is display-only.
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000', 400, 300)],
      ['b', makeMetrics('0000000000000000', 100, 100)],
      ['c', makeMetrics('0000000000000000', 100, 100)],
    ])
    const removePhotos = vi.fn()

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(removePhotos).not.toHaveBeenCalled()
    expect(screen.getAllByRole('img')).toHaveLength(3)
    // No "keep best quality" / auto-resolve affordance anywhere.
    expect(screen.queryByText(/keep best quality/i)).toBeNull()
  })

  // --- Manual delete selection ----------------------------------------------

  it('lets the user manually select photos within a cluster and delete only the selected ones on explicit confirm', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')],
      ['c', makeMetrics('000000000000000f')],
    ])
    const removePhotos = vi.fn()

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    // Nothing pre-selected: the delete button is disabled with a zero count.
    const deleteButton = screen.getByRole('button', { name: /delete selected \(0\)/i })
    expect(deleteButton).toHaveProperty('disabled', true)

    // Selecting b and c (clicking their images, same pattern as the rest of
    // the app) enables the button and updates its count.
    fireEvent.click(screen.getByAltText('b.jpg'))
    fireEvent.click(screen.getByAltText('c.jpg'))

    const updatedButton = screen.getByRole('button', { name: /delete selected \(2\)/i })
    expect(updatedButton).toHaveProperty('disabled', false)
    expect(removePhotos).not.toHaveBeenCalled()

    fireEvent.click(updatedButton)

    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0].slice().sort()).toEqual(['b', 'c'])
  })

  it('does not misapply a delete selection to a different cluster that inherits its old discovery-order id', () => {
    // Three mutually-unrelated pairs: {m1,m2}, {f,g}, {h,i}. clusterPhotos
    // assigns cluster.id purely by discovery order over the `photos` array,
    // so in this render {m1,m2}=cluster-0, {f,g}=cluster-1, {h,i}=cluster-2.
    const m1 = makeEntry('m1', 'm1.jpg', '2024-01-01T00:00:00Z', 0)
    const m2 = makeEntry('m2', 'm2.jpg', '2024-01-02T00:00:00Z', 1)
    const f = makeEntry('f', 'f.jpg', '2024-01-03T00:00:00Z', 2)
    const g = makeEntry('g', 'g.jpg', '2024-01-04T00:00:00Z', 3)
    const h = makeEntry('h', 'h.jpg', '2024-01-05T00:00:00Z', 4)
    const i = makeEntry('i', 'i.jpg', '2024-01-06T00:00:00Z', 5)
    // Marker nibbles are 3-wide (12 bits) per pair, at non-overlapping
    // positions, so every cross-pair distance is >=24 bits — comfortably
    // above the default threshold (20).
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['m1', makeMetrics('fff0000000000000')],
      ['m2', makeMetrics('ffff000000000000')], // distance to m1: 4
      ['f', makeMetrics('00000fff00000000')],
      ['g', makeMetrics('00000ffff0000000')], // distance to f: 4
      ['h', makeMetrics('0000000000fff000')],
      ['i', makeMetrics('0000000000ffff00')], // distance to h: 4
    ])
    const removePhotos = vi.fn()

    const { rerender } = render(
      <ClusterView
        photos={[m1, m2, f, g, h, i]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={removePhotos}
        batchSetTimestamps={noopBatchSetTimestamps}
      />
    )

    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3)

    // Select f for deletion within {f,g} — an id that never overlaps with
    // {h,i}'s real member ids.
    fireEvent.click(screen.getByAltText('f.jpg'))

    // Simulate {m1,m2}'s cluster disappearing entirely from the batch. This
    // shifts {f,g} from cluster-1 to cluster-0, and {h,i} from cluster-2 to
    // cluster-1 — the exact numeric id that used to belong to {f,g}.
    rerender(
      <ClusterView
        photos={[f, g, h, i]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={removePhotos}
        batchSetTimestamps={noopBatchSetTimestamps}
      />
    )

    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2)

    // {f,g}'s own selection survives the shift correctly (content-derived
    // key, not the reassigned numeric cluster.id): f is still selected.
    expect(screen.getByAltText('f.jpg').parentElement?.className).toContain('ring-zinc-900')

    // {h,i} — now occupying the numeric slot {f,g} used to hold — must NOT
    // inherit {f,g}'s stale selection: neither h nor i is pre-selected.
    expect(screen.getByAltText('h.jpg').parentElement?.className).not.toContain('ring-zinc-900')
    expect(screen.getByAltText('i.jpg').parentElement?.className).not.toContain('ring-zinc-900')

    // {f,g}'s section renders first (earlier capturedAt), {h,i}'s second.
    const deleteButtons = screen.getAllByRole('button', { name: /delete selected/i })
    expect(deleteButtons).toHaveLength(2)
    expect(deleteButtons[1]).toHaveProperty('disabled', true) // {h,i}: nothing selected

    fireEvent.click(deleteButtons[0]) // {f,g}'s delete button — only f selected

    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0]).toEqual(['f'])
  })

  // --- Threshold + live slider -----------------------------------------------

  it('clusters two photos with a moderate difference (e.g. one has a line drawn on it) under the default threshold', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    // Distance 16: within the default threshold (20).
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('ffff000000000000')], // distance to a: 16
    ])

    render(<ClusterView photos={[a, b]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading.textContent).toContain('2 related photos')
  })

  it('renders a similarity threshold slider that re-clusters live as it moves', () => {
    const x = makeEntry('x', 'x.jpg', '2024-01-01T00:00:00Z', 0)
    // Distance 24: outside the default threshold (20), so x/y start out
    // unrelated (rendered plainly, no cluster heading).
    const y = makeEntry('y', 'y.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['x', makeMetrics('0000000000000000')],
      ['y', makeMetrics('ffffff0000000000')], // distance to x: 24
    ])

    render(<ClusterView photos={[x, y]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()

    const slider = screen.getByRole('slider', { name: /similarity grouping threshold/i })
    fireEvent.change(slider, { target: { value: '25' } })

    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading.textContent).toContain('2 related photos')
  })

  it('re-clusters live when the slider moves stricter, splitting a cluster apart', () => {
    const x = makeEntry('x', 'x.jpg', '2024-01-01T00:00:00Z', 0)
    const y = makeEntry('y', 'y.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['x', makeMetrics('0000000000000000')],
      ['y', makeMetrics('ffff000000000000')], // distance to x: 16 — within default (20)
    ])

    render(<ClusterView photos={[x, y]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.getByRole('heading', { level: 2 })).toBeDefined()

    const slider = screen.getByRole('slider', { name: /similarity grouping threshold/i })
    fireEvent.change(slider, { target: { value: '10' } })

    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  })

  // --- Debug mode ------------------------------------------------------------

  it('debug mode is off by default and shows no distance info or Compare affordance', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')],
    ])

    render(<ClusterView photos={[a, b]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.queryByText(/bits/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^compare$/i })).toBeNull()
  })

  it('debug mode shows the Hamming distance between every pair of photos in a cluster', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')], // distance to a: 0
      ['c', makeMetrics('000000000000000f')], // distance to a/b: 4
    ])

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /debug mode/i }))

    expect(screen.getByText(/a\.jpg ↔ b\.jpg: 0 bits/)).toBeDefined()
    expect(screen.getByText(/a\.jpg ↔ c\.jpg: 4 bits/)).toBeDefined()
    expect(screen.getByText(/b\.jpg ↔ c\.jpg: 4 bits/)).toBeDefined()
  })

  it('lets the user click any two photos in debug mode to see their hashes and distance', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('000000000000000f')], // distance to a: 4
    ])

    render(<ClusterView photos={[a, b]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /debug mode/i }))

    const compareButtons = screen.getAllByRole('button', { name: /^compare$/i })
    expect(compareButtons).toHaveLength(2)

    fireEvent.click(compareButtons[0])
    expect(screen.getByText(/a\.jpg — hash: 0000000000000000/)).toBeDefined()
    expect(screen.getByText(/click a second photo to compare/i)).toBeDefined()

    fireEvent.click(compareButtons[1])
    expect(screen.getByText(/b\.jpg — hash: 000000000000000f/)).toBeDefined()
    expect(screen.getByText(/distance: 4 bits/i)).toBeDefined()
  })

  it('resets the debug compare selection to a fresh pick after a third click', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('000000000000000f')],
      ['c', makeMetrics('ffffffffffffffff')],
    ])

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /debug mode/i }))

    const [compareA, compareB, compareC] = screen.getAllByRole('button', { name: /^compare$/i })
    fireEvent.click(compareA)
    fireEvent.click(compareB)
    expect(screen.getByText(/distance: 4 bits/i)).toBeDefined()

    // Third click starts a fresh comparison rather than adding a third slot.
    fireEvent.click(compareC)
    expect(screen.getByText(/click a second photo to compare/i)).toBeDefined()
    expect(screen.getByText(/c\.jpg — hash: ffffffffffffffff/)).toBeDefined()
  })

  // --- U5: cluster-scoped batch timestamp editing --------------------------

  it('does not show the timestamp-edit UI for a cluster until at least one member is selected for timestamp editing', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')],
    ])

    render(
      <ClusterView
        photos={[a, b]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={noopRemovePhotos}
        batchSetTimestamps={noopBatchSetTimestamps}
      />
    )

    expect(screen.queryByLabelText('Custom timestamp')).toBeNull()
    expect(screen.queryByText(/set timestamp for/i)).toBeNull()

    fireEvent.click(screen.getByLabelText('Select a.jpg for timestamp edit'))

    expect(screen.getByLabelText('Custom timestamp')).toBeDefined()
    expect(screen.getByText(/set timestamp for 1 selected/i)).toBeDefined()
  })

  it('offers the cluster\'s distinct existing timestamps as quick-picks, deduping shared ones, once members are selected for timestamp editing', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T10:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T11:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T12:00:00Z', 2)
    // d shares a's exact timestamp — selecting both a and d should still
    // produce only one quick-pick option for that shared timestamp.
    const d = makeEntry('d', 'd.jpg', '2024-01-01T10:00:00Z', 3)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')],
      ['c', makeMetrics('0000000000000000')],
      ['d', makeMetrics('0000000000000000')],
    ])
    const batchSetTimestamps = vi.fn()

    render(
      <ClusterView
        photos={[a, b, c, d]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={noopRemovePhotos}
        batchSetTimestamps={batchSetTimestamps}
      />
    )

    fireEvent.click(screen.getByLabelText('Select a.jpg for timestamp edit'))
    fireEvent.click(screen.getByLabelText('Select b.jpg for timestamp edit'))
    fireEvent.click(screen.getByLabelText('Select c.jpg for timestamp edit'))
    fireEvent.click(screen.getByLabelText('Select d.jpg for timestamp edit'))

    // Three distinct timestamps (a/d share one) -> three quick-pick buttons.
    const quickPicks = screen.getAllByRole('button', { name: /^use /i })
    expect(quickPicks).toHaveLength(3)

    // Custom date input is also present alongside the quick-picks.
    expect(screen.getByLabelText('Custom timestamp')).toBeDefined()

    // Choosing a quick-pick calls batchSetTimestamps with the cluster's
    // currently-selected-for-timestamp-editing ids and the chosen date.
    fireEvent.click(quickPicks[0])
    expect(batchSetTimestamps).toHaveBeenCalledTimes(1)
    expect(batchSetTimestamps.mock.calls[0][0].slice().sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(batchSetTimestamps.mock.calls[0][1]).toBeInstanceOf(Date)
  })

  it('applying a custom date calls batchSetTimestamps with the selected ids and the parsed custom date', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T10:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T11:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000')],
      ['b', makeMetrics('0000000000000000')],
    ])
    const batchSetTimestamps = vi.fn()

    render(
      <ClusterView
        photos={[a, b]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={noopRemovePhotos}
        batchSetTimestamps={batchSetTimestamps}
      />
    )

    fireEvent.click(screen.getByLabelText('Select a.jpg for timestamp edit'))
    fireEvent.click(screen.getByLabelText('Select b.jpg for timestamp edit'))

    fireEvent.change(screen.getByLabelText('Custom timestamp'), { target: { value: '2025-06-15T09:30' } })
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }))

    expect(batchSetTimestamps).toHaveBeenCalledTimes(1)
    expect(batchSetTimestamps.mock.calls[0][0].slice().sort()).toEqual(['a', 'b'])
    expect(batchSetTimestamps.mock.calls[0][1]).toEqual(new Date(Date.UTC(2025, 5, 15, 9, 30, 0)))
  })

  it('keeps timestamp-edit selection independent of the manual delete selection', () => {
    const w = makeEntry('w', 'w.jpg', '2024-01-01T00:00:00Z', 0)
    const x = makeEntry('x', 'x.jpg', '2024-01-02T00:00:00Z', 1)
    const y = makeEntry('y', 'y.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['w', makeMetrics('0000000000000000')],
      ['x', makeMetrics('f000000000000000')], // distance to w: 4
      ['y', makeMetrics('0f00000000000000')], // distance to w: 4, to x: 8
    ])
    const removePhotos = vi.fn()
    const batchSetTimestamps = vi.fn()

    render(
      <ClusterView
        photos={[w, x, y]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={removePhotos}
        batchSetTimestamps={batchSetTimestamps}
      />
    )

    // Select w for deletion, and independently select w and x for timestamp editing.
    fireEvent.click(screen.getByAltText('w.jpg'))
    fireEvent.click(screen.getByLabelText('Select w.jpg for timestamp edit'))
    fireEvent.click(screen.getByLabelText('Select x.jpg for timestamp edit'))

    fireEvent.click(screen.getByRole('button', { name: /delete selected \(1\)/i }))
    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0]).toEqual(['w'])

    // Timestamp-edit selection (w, x) is unaffected by the delete call above.
    fireEvent.change(screen.getByLabelText('Custom timestamp'), { target: { value: '2025-01-01T00:00' } })
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }))

    expect(batchSetTimestamps).toHaveBeenCalledTimes(1)
    expect(batchSetTimestamps.mock.calls[0][0].slice().sort()).toEqual(['w', 'x'])
  })
})
