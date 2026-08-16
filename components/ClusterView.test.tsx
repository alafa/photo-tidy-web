import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import ClusterView from './ClusterView'

afterEach(cleanup)

const getObjectUrl = (file: File) => `blob:${file.name}`
const noopRemovePhotos = () => {}
const noopBatchSetTimestamps = () => {}

// --- test helpers -------------------------------------------------------
//
// Hashes are built from explicit "on" bit positions (not raw hex literals)
// so cosine distances between fixtures are exactly predictable by hand —
// same technique as lib/photo-clustering.test.ts. This matters here because
// an all-zero hash is a *zero vector*, and cosineDistance special-cases
// zero vectors (0 vs. another zero is "identical", 0 vs. anything non-zero
// is "maximally distant") rather than reflecting bit overlap — a trap for
// hand-picked hex literals meant to encode a specific Hamming distance.

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

  it('orders clusters by their earliest member\'s timestamp, not array/discovery order', () => {
    // Cluster X ({p1,p2}) is placed first in the photos array but carries
    // LATER capturedAt timestamps than cluster Y ({p3,p4}), placed second
    // in the array with EARLIER timestamps. Cluster position is driven by
    // chronological order (earliest member's capturedAt) — the same rule
    // every other view in the app uses (hooks/usePhotos.ts's sortPhotos) —
    // so Y must render first despite appearing later in the input array.
    const p1 = makeEntry('p1', 'p1.jpg', '2024-06-01T00:00:00Z', 0)
    const p2 = makeEntry('p2', 'p2.jpg', '2024-06-02T00:00:00Z', 1)
    const p3 = makeEntry('p3', 'p3.jpg', '2024-01-01T00:00:00Z', 2)
    const p4 = makeEntry('p4', 'p4.jpg', '2024-01-02T00:00:00Z', 3)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['p1', makeMetrics(hashFromPositions(range(0, 9)))],
      ['p2', makeMetrics(hashFromPositions(range(0, 9)))], // identical to p1
      ['p3', makeMetrics(hashFromPositions(range(60, 69)))],
      ['p4', makeMetrics(hashFromPositions(range(60, 69)))], // identical to p3, orthogonal to p1/p2
    ])

    render(
      <ClusterView
        photos={[p1, p2, p3, p4]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={noopRemovePhotos}
        batchSetTimestamps={noopBatchSetTimestamps}
      />
    )

    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2)
    const order = screen.getAllByRole('img').map((img) => img.getAttribute('alt'))
    const xIndices = [order.indexOf('p1.jpg'), order.indexOf('p2.jpg')]
    const yIndices = [order.indexOf('p3.jpg'), order.indexOf('p4.jpg')]
    expect(Math.max(...yIndices)).toBeLessThan(Math.min(...xIndices))
  })

  it('never reorders an individual photo when the similarity slider moves, even as an unrelated pair clusters', () => {
    // a and b are a moderate-distance pair (0.3) that only clusters once
    // the slider loosens; c and d are unrelated singles with no match to
    // anything at any threshold this test uses. Before and after the
    // slider change, c and d must stay exactly where their own timestamps
    // place them — the bug this fixes was the whole grid reshuffling on
    // every threshold tick even for photos whose clustering didn't change.
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const d = makeEntry('d', 'd.jpg', '2024-01-04T00:00:00Z', 3)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(3, 12)))], // distance to a: 0.3
      ['c', makeMetrics(hashFromPositions(range(50, 59)))], // orthogonal to everything
      ['d', makeMetrics(hashFromPositions(range(80, 89)))], // orthogonal to everything
    ])

    render(
      <ClusterView
        photos={[a, b, c, d]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={noopRemovePhotos}
        batchSetTimestamps={noopBatchSetTimestamps}
      />
    )

    // At the 40% default (threshold 0.2), a/b's 0.3 distance is too far —
    // all four render as plain, chronologically-ordered singles.
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual([
      'a.jpg',
      'b.jpg',
      'c.jpg',
      'd.jpg',
    ])

    // 70% maps to threshold 0.35 — loose enough to merge a/b, but c and d
    // remain untouched singles at their own chronological positions.
    const slider = screen.getByRole('slider', { name: /similarity/i })
    fireEvent.change(slider, { target: { value: '70' } })

    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual([
      'a.jpg',
      'b.jpg',
      'c.jpg',
      'd.jpg',
    ])
  })

  it('reorders members within a cluster by mutual similarity rather than preserving the original array order', () => {
    // a and c are hash-identical; b is a moderate outlier that still falls
    // within the default threshold. Input order is [a, b, c] (the outlier
    // in the middle) — similarity ordering should surface the outlier
    // adjacent to, not between, the identical pair: b merges into the
    // dendrogram last, and hierarchicalOrder's leaf-index tie-break always
    // visits the item outside the closest pair first (its leaf index is
    // necessarily lower than any synthetic merge-node index).
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(2, 11)))], // distance to a and c: 0.2
      ['c', makeMetrics(hashFromPositions(range(0, 9)))], // identical to a
    ])

    render(
      <ClusterView
        photos={[a, b, c]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={noopRemovePhotos}
        batchSetTimestamps={noopBatchSetTimestamps}
      />
    )

    const order = screen.getAllByRole('img').map((img) => img.getAttribute('alt'))
    expect(order).toEqual(['b.jpg', 'a.jpg', 'c.jpg'])
  })

  it('renders a photo with no similarity match plainly, not as a one-member cluster', () => {
    const solo = makeEntry('solo', 'solo.jpg', '2024-01-01T00:00:00Z', 0)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['solo', makeMetrics(hashFromPositions(range(0, 9)))],
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
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(0, 9)))], // identical to a
      ['c', makeMetrics(hashFromPositions(range(2, 11)))], // distance to a/b: 0.2
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
    const sharedHash = hashFromPositions(range(0, 9))
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(sharedHash, 400, 300)],
      ['b', makeMetrics(sharedHash, 100, 100)],
      ['c', makeMetrics(sharedHash, 100, 100)],
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
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(0, 9)))], // identical to a
      ['c', makeMetrics(hashFromPositions(range(2, 11)))], // distance to a/b: 0.2
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
    // Three mutually-unrelated pairs: {m1,m2}, {f,g}, {h,i}, each an
    // internal-shift-by-2 pair (distance 0.2, right at the default
    // threshold) with bit ranges far enough apart that every cross-pair
    // distance is 1.0 (orthogonal) — comfortably outside the threshold.
    const m1 = makeEntry('m1', 'm1.jpg', '2024-01-01T00:00:00Z', 0)
    const m2 = makeEntry('m2', 'm2.jpg', '2024-01-02T00:00:00Z', 1)
    const f = makeEntry('f', 'f.jpg', '2024-01-03T00:00:00Z', 2)
    const g = makeEntry('g', 'g.jpg', '2024-01-04T00:00:00Z', 3)
    const h = makeEntry('h', 'h.jpg', '2024-01-05T00:00:00Z', 4)
    const i = makeEntry('i', 'i.jpg', '2024-01-06T00:00:00Z', 5)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['m1', makeMetrics(hashFromPositions(range(0, 9)))],
      ['m2', makeMetrics(hashFromPositions(range(2, 11)))],
      ['f', makeMetrics(hashFromPositions(range(30, 39)))],
      ['g', makeMetrics(hashFromPositions(range(32, 41)))],
      ['h', makeMetrics(hashFromPositions(range(60, 69)))],
      ['i', makeMetrics(hashFromPositions(range(62, 71)))],
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
    // shifts {f,g} and {h,i} up by one discovery-order slot each — the
    // exact numeric cluster.id churn this test guards against.
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

    // {f,g} was discovered first in the rerendered array, so its section
    // (and delete button) renders first; {h,i}'s second.
    const deleteButtons = screen.getAllByRole('button', { name: /delete selected/i })
    expect(deleteButtons).toHaveLength(2)
    expect(deleteButtons[1]).toHaveProperty('disabled', true) // {h,i}: nothing selected

    fireEvent.click(deleteButtons[0]) // {f,g}'s delete button — only f selected

    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0]).toEqual(['f'])
  })

  // --- Threshold + live slider -----------------------------------------------

  it('clusters two photos with a moderate difference under the default threshold', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(2, 11)))], // distance to a: 0.2 (default threshold)
    ])

    render(<ClusterView photos={[a, b]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading.textContent).toContain('2 related photos')
  })

  it('gives a cluster a visually distinct bordered/shaded container that a single photo does not have', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const solo = makeEntry('solo', 'solo.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(2, 11)))], // distance to a: 0.2 (default threshold)
      ['solo', makeMetrics(hashFromPositions(range(80, 89)))], // orthogonal — stays a single
    ])

    render(<ClusterView photos={[a, b, solo]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    const heading = screen.getByRole('heading', { level: 2 })
    const clusterContainer = heading.closest('section')
    expect(clusterContainer?.className).toMatch(/border/)

    // The single photo's own container (its PhotoCard wrapper div) carries
    // no such border/background — only real clusters get the card chrome.
    const soloContainer = screen.getByAltText('solo.jpg').closest('div.flex.flex-col')
    expect(soloContainer?.className).not.toMatch(/border/)
  })

  it('renders a percentage-based similarity slider that re-clusters live as it moves looser', () => {
    const x = makeEntry('x', 'x.jpg', '2024-01-01T00:00:00Z', 0)
    const y = makeEntry('y', 'y.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['x', makeMetrics(hashFromPositions(range(0, 9)))],
      ['y', makeMetrics(hashFromPositions(range(3, 12)))], // distance to x: 0.3 — outside the 40%/0.2 default
    ])

    render(<ClusterView photos={[x, y]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.getByText('40%')).toBeDefined()
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()

    // 70% maps to a distance_threshold of 0.35 (0.7 * MAX_DISTANCE_THRESHOLD
    // of 0.5) — loose enough to merge the 0.3-distance pair.
    const slider = screen.getByRole('slider', { name: /similarity/i })
    fireEvent.change(slider, { target: { value: '70' } })

    expect(screen.getByText('70%')).toBeDefined()
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading.textContent).toContain('2 related photos')
  })

  it('re-clusters live when the slider moves stricter, splitting a cluster apart', () => {
    const x = makeEntry('x', 'x.jpg', '2024-01-01T00:00:00Z', 0)
    const y = makeEntry('y', 'y.jpg', '2024-01-02T00:00:00Z', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['x', makeMetrics(hashFromPositions(range(0, 9)))],
      ['y', makeMetrics(hashFromPositions(range(2, 11)))], // distance to x: 0.2 — within the default
    ])

    render(<ClusterView photos={[x, y]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.getByRole('heading', { level: 2 })).toBeDefined()

    // 10% maps to a distance_threshold of 0.05 — too strict for the 0.2 pair.
    const slider = screen.getByRole('slider', { name: /similarity/i })
    fireEvent.change(slider, { target: { value: '10' } })

    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  })

  // --- Debug mode ------------------------------------------------------------

  it('debug mode is off by default and shows no distance info or Compare affordance', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const sharedHash = hashFromPositions(range(0, 9))
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(sharedHash)],
      ['b', makeMetrics(sharedHash)],
    ])

    render(<ClusterView photos={[a, b]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.queryByText(/cosine distance/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^compare$/i })).toBeNull()
  })

  it('debug mode shows the cosine distance between every pair of photos in a cluster', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(0, 9)))], // identical to a: distance 0
      ['c', makeMetrics(hashFromPositions(range(2, 11)))], // distance to a/b: 0.2
    ])

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /debug mode/i }))

    // c is the outlier relative to the identical a/b pair, so similarity
    // ordering places it first within the cluster (see the member-reorder
    // test above for why) — pairs are listed in that [c, a, b] order.
    expect(screen.getByText(/c\.jpg ↔ a\.jpg: 0\.200 cosine distance/)).toBeDefined()
    expect(screen.getByText(/c\.jpg ↔ b\.jpg: 0\.200 cosine distance/)).toBeDefined()
    expect(screen.getByText(/a\.jpg ↔ b\.jpg: 0\.000 cosine distance/)).toBeDefined()
  })

  it('lets the user click any two photos in debug mode to see their hashes and distance', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const hashA = hashFromPositions(range(0, 9))
    const hashB = hashFromPositions(range(2, 11)) // distance to a: 0.2
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashA)],
      ['b', makeMetrics(hashB)],
    ])

    render(<ClusterView photos={[a, b]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /debug mode/i }))

    const compareButtons = screen.getAllByRole('button', { name: /^compare$/i })
    expect(compareButtons).toHaveLength(2)

    fireEvent.click(compareButtons[0])
    expect(screen.getByText(new RegExp(`a\\.jpg — hash: ${hashA}`))).toBeDefined()
    expect(screen.getByText(/click a second photo to compare/i)).toBeDefined()

    fireEvent.click(compareButtons[1])
    expect(screen.getByText(new RegExp(`b\\.jpg — hash: ${hashB}`))).toBeDefined()
    expect(screen.getByText(/cosine distance: 0\.200/i)).toBeDefined()
  })

  it('resets the debug compare selection to a fresh pick after a third click', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const hashC = hashFromPositions(range(50, 59)) // orthogonal to a and b
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(2, 11)))], // distance to a: 0.2 — clusters with a
      ['c', makeMetrics(hashC)],
    ])

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /debug mode/i }))

    // a and b cluster together (compare buttons render in that cluster's
    // member order); c renders separately as a single. With only two
    // top-level items feeding the cluster-ordering pass (the {a,b} cluster
    // and c), hierarchicalOrder preserves discovery order, so DOM order is
    // a, b, then c — matching the array order below.
    const [compareA, compareB, compareC] = screen.getAllByRole('button', { name: /^compare$/i })
    fireEvent.click(compareA)
    fireEvent.click(compareB)
    expect(screen.getByText(/cosine distance: 0\.200/i)).toBeDefined()

    // Third click starts a fresh comparison rather than adding a third slot.
    fireEvent.click(compareC)
    expect(screen.getByText(/click a second photo to compare/i)).toBeDefined()
    expect(screen.getByText(new RegExp(`c\\.jpg — hash: ${hashC}`))).toBeDefined()
  })

  // --- U5: cluster-scoped batch timestamp editing --------------------------

  it('does not show the timestamp-edit UI for a cluster until at least one member is selected for timestamp editing', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const sharedHash = hashFromPositions(range(0, 9))
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(sharedHash)],
      ['b', makeMetrics(sharedHash)],
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
    const sharedHash = hashFromPositions(range(0, 9))
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(sharedHash)],
      ['b', makeMetrics(sharedHash)],
      ['c', makeMetrics(sharedHash)],
      ['d', makeMetrics(sharedHash)],
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
    const sharedHash = hashFromPositions(range(0, 9))
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(sharedHash)],
      ['b', makeMetrics(sharedHash)],
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
    // Sliding window: dist(w,x)=0.1, dist(x,y)=0.1, dist(w,y)=0.2 — all
    // within the default 0.2 threshold, so all three merge into one cluster.
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['w', makeMetrics(hashFromPositions(range(0, 9)))],
      ['x', makeMetrics(hashFromPositions(range(1, 10)))],
      ['y', makeMetrics(hashFromPositions(range(2, 11)))],
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
