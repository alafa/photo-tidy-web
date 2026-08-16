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

    render(<ClusterView photos={[a, b, c, d]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

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

    render(<ClusterView photos={[solo]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

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

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

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

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={noopRemovePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

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
    // Neither has a resolved hash, so neither should carry an identical/similar flag.
    expect(screen.queryByRole('group', { name: 'Identical' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Similar' })).toBeNull()
  })

  // --- U4: deduplication actions -------------------------------------------

  it('R6: automatically resolves an identical-tier cluster, keeping the highest pixel-count member, with no confirmation UI', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    // All three mutually identical (distance 0); a has the highest pixel count.
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000', 400, 300)], // 120,000 px
      ['b', makeMetrics('0000000000000000', 100, 100)], // 10,000 px
      ['c', makeMetrics('0000000000000000', 100, 100)], // 10,000 px
    ])
    const removePhotos = vi.fn()

    render(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    // Fired automatically, with no button/confirmation, exactly once, for the losers only.
    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0].slice().sort()).toEqual(['b', 'c'])
    expect(screen.queryByRole('button', { name: /remove non-selected/i })).toBeNull()

    // This test's removePhotos stub doesn't mutate `photos`, so all three
    // still render — the highest pixel-count member (a) is among them.
    expect(screen.getByAltText('a.jpg')).toBeDefined()
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })

  it('R7: pre-selects the highest pixel-count member for a similar-tier cluster, lets the user change the selection, and only removes on explicit confirm', () => {
    const w = makeEntry('w', 'w.jpg', '2024-01-01T00:00:00Z', 0)
    const x = makeEntry('x', 'x.jpg', '2024-01-02T00:00:00Z', 1)
    const y = makeEntry('y', 'y.jpg', '2024-01-03T00:00:00Z', 2)
    const z = makeEntry('z', 'z.jpg', '2024-01-04T00:00:00Z', 3)
    // Pairwise Hamming distances all in (3, 12] (similar, never identical):
    // w-x/w-y/w-z = 4, x-y/x-z/y-z = 8. One connected, all-similar cluster.
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['w', makeMetrics('0000000000000000', 1000, 1000)], // highest pixel count
      ['x', makeMetrics('f000000000000000', 200, 200)],
      ['y', makeMetrics('0f00000000000000', 200, 200)],
      ['z', makeMetrics('00f0000000000000', 200, 200)],
    ])
    const removePhotos = vi.fn()

    render(<ClusterView photos={[w, x, y, z]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    // Purely similar-tier — no automatic removal.
    expect(removePhotos).not.toHaveBeenCalled()
    expect(screen.getAllByRole('group', { name: 'Similar' })).toHaveLength(4)

    // w (highest pixel count) is pre-selected as the suggested keep; x is not.
    expect(screen.getByAltText('w.jpg').parentElement?.className).toContain('ring-zinc-900')
    expect(screen.getByAltText('x.jpg').parentElement?.className).not.toContain('ring-zinc-900')

    // User overrides the suggestion: also keep x.
    fireEvent.click(screen.getByAltText('x.jpg'))
    expect(screen.getByAltText('x.jpg').parentElement?.className).toContain('ring-zinc-900')

    // Nothing removed yet.
    expect(removePhotos).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /remove non-selected/i }))

    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0].slice().sort()).toEqual(['y', 'z'])
  })

  it('AE3: a mixed cluster resolves its identical-tier pair automatically, independent of its similar-tier trio\'s pending confirmation', () => {
    const p1 = makeEntry('p1', 'p1.jpg', '2024-01-01T00:00:00Z', 0)
    const p2 = makeEntry('p2', 'p2.jpg', '2024-01-02T00:00:00Z', 1)
    const p3 = makeEntry('p3', 'p3.jpg', '2024-01-03T00:00:00Z', 2)
    const p4 = makeEntry('p4', 'p4.jpg', '2024-01-04T00:00:00Z', 3)
    const p5 = makeEntry('p5', 'p5.jpg', '2024-01-05T00:00:00Z', 4)
    // p1-p2: distance 0 (identical). p1/p2 to p3/p4/p5: distance 4 (similar,
    // keeps the whole thing one connected component). p3-p4/p3-p5/p4-p5:
    // distance 8 (similar). No other identical-tier edges.
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['p1', makeMetrics('0000000000000000', 1000, 1000)], // identical pair, higher quality
      ['p2', makeMetrics('0000000000000000', 200, 200)], // identical pair, lower quality
      ['p3', makeMetrics('f000000000000000', 1000, 1000)], // similar trio, higher quality
      ['p4', makeMetrics('0f00000000000000', 200, 200)],
      ['p5', makeMetrics('00f0000000000000', 200, 200)],
    ])
    const removePhotos = vi.fn()

    render(
      <ClusterView photos={[p1, p2, p3, p4, p5]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />
    )

    // The identical pair (p1/p2) auto-resolved on render, keeping p1.
    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0]).toEqual(['p2'])

    // The similar trio's confirm UI is present and untouched by the above.
    const confirmButton = screen.getByRole('button', { name: /remove non-selected/i })
    expect(removePhotos).toHaveBeenCalledTimes(1) // still just the automatic call

    fireEvent.click(confirmButton)

    expect(removePhotos).toHaveBeenCalledTimes(2)
    expect(removePhotos.mock.calls[1][0].slice().sort()).toEqual(['p4', 'p5'])
    // The identical pair's ids never appear in the similar-trio's removal call.
    expect(removePhotos.mock.calls[1][0]).not.toContain('p1')
    expect(removePhotos.mock.calls[1][0]).not.toContain('p2')
  })

  it('resolves two disjoint identical-tier pairs within one connected cluster independently, never removing a photo only weakly similar to the kept survivor', () => {
    // p1-p2: identical (distance 0). p3-p4: identical (distance 0), a
    // completely separate duplicate pair. p1/p2 to p3/p4: distance 4
    // (similar) — this bridges the two pairs into ONE connected component
    // (clusterPhotos merges transitively, KTD4), but they are NOT the same
    // duplicate: p3/p4 must survive as their own pair, resolved
    // independently of p1/p2's resolution.
    const p1 = makeEntry('p1', 'p1.jpg', '2024-01-01T00:00:00Z', 0)
    const p2 = makeEntry('p2', 'p2.jpg', '2024-01-02T00:00:00Z', 1)
    const p3 = makeEntry('p3', 'p3.jpg', '2024-01-03T00:00:00Z', 2)
    const p4 = makeEntry('p4', 'p4.jpg', '2024-01-04T00:00:00Z', 3)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['p1', makeMetrics('0000000000000000', 400, 300)], // p1-p2 pair, p1 higher quality
      ['p2', makeMetrics('0000000000000000', 100, 100)],
      ['p3', makeMetrics('000000000000000f', 300, 300)], // p3-p4 pair, p3 higher quality
      ['p4', makeMetrics('000000000000000f', 100, 100)],
    ])
    const removePhotos = vi.fn()

    render(
      <ClusterView photos={[p1, p2, p3, p4]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />
    )

    // All four are one connected component (single heading), but two
    // independent identical-tier removals fire — never one removal that
    // treats all four as a single "keep one" group.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
    expect(removePhotos).toHaveBeenCalledTimes(2)
    const removedIds = removePhotos.mock.calls.map((call) => call[0])
    expect(removedIds).toContainEqual(['p2'])
    expect(removedIds).toContainEqual(['p4'])
    // Neither call ever removes more than one id, and the two calls never
    // cross-contaminate (p2's removal never bundles in p3/p4, and vice versa).
    for (const ids of removedIds) {
      expect(ids).toHaveLength(1)
    }
  })

  it('KTD9: breaks a pixel-count tie by file size, keeping/pre-selecting the larger file', () => {
    const m1 = makeEntry('m1', 'm1.jpg', '2024-01-01T00:00:00Z', 0)
    const m2 = makeEntry('m2', 'm2.jpg', '2024-01-02T00:00:00Z', 1)
    // Similar-tier pair (distance 4): identical pixel count (100x100), but m2
    // has a larger file size, so m2 should win the tie-break.
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['m1', makeMetrics('0000000000000000', 100, 100, 500)],
      ['m2', makeMetrics('f000000000000000', 100, 100, 900)],
    ])
    const removePhotos = vi.fn()

    render(<ClusterView photos={[m1, m2]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(screen.getByAltText('m2.jpg').parentElement?.className).toContain('ring-zinc-900')
    expect(screen.getByAltText('m1.jpg').parentElement?.className).not.toContain('ring-zinc-900')
  })

  it('disables the "Remove non-selected" action once every similar-tier member is deselected, and never calls removePhotos in that state', () => {
    const w = makeEntry('w', 'w.jpg', '2024-01-01T00:00:00Z', 0)
    const x = makeEntry('x', 'x.jpg', '2024-01-02T00:00:00Z', 1)
    const y = makeEntry('y', 'y.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['w', makeMetrics('0000000000000000', 1000, 1000)],
      ['x', makeMetrics('f000000000000000', 200, 200)],
      ['y', makeMetrics('0f00000000000000', 200, 200)],
    ])
    const removePhotos = vi.fn()

    render(<ClusterView photos={[w, x, y]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    // Deselect the only pre-selected keeper (w) — selection becomes empty.
    fireEvent.click(screen.getByAltText('w.jpg'))

    const confirmButton = screen.getByRole('button', { name: /remove non-selected/i })
    expect(confirmButton).toHaveProperty('disabled', true)

    fireEvent.click(confirmButton)
    expect(removePhotos).not.toHaveBeenCalled()
  })

  it('lets every similar-tier member be selected as a keeper without erroring or removing anything', () => {
    const w = makeEntry('w', 'w.jpg', '2024-01-01T00:00:00Z', 0)
    const x = makeEntry('x', 'x.jpg', '2024-01-02T00:00:00Z', 1)
    const y = makeEntry('y', 'y.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['w', makeMetrics('0000000000000000', 1000, 1000)],
      ['x', makeMetrics('f000000000000000', 200, 200)],
      ['y', makeMetrics('0f00000000000000', 200, 200)],
    ])
    const removePhotos = vi.fn()

    render(<ClusterView photos={[w, x, y]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    // w is already pre-selected; select the remaining two as well.
    fireEvent.click(screen.getByAltText('x.jpg'))
    fireEvent.click(screen.getByAltText('y.jpg'))

    fireEvent.click(screen.getByRole('button', { name: /remove non-selected/i }))

    // Either not called at all, or called with an empty list — never a
    // non-empty/incorrect id list.
    if (removePhotos.mock.calls.length > 0) {
      expect(removePhotos).toHaveBeenCalledWith([])
    }
  })

  it('does not call removePhotos more than once for the same already-resolved identical-tier subset across re-renders', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics('0000000000000000', 400, 300)],
      ['b', makeMetrics('0000000000000000', 100, 100)],
      ['c', makeMetrics('0000000000000000', 100, 100)],
    ])
    const removePhotos = vi.fn()

    const { rerender } = render(
      <ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />
    )
    expect(removePhotos).toHaveBeenCalledTimes(1)

    // Re-render with the exact same (unremoved, since this stub is a no-op)
    // photos/metrics — the same identical-tier subset recomputes identically
    // and must not be re-issued.
    rerender(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)
    rerender(<ClusterView photos={[a, b, c]} metrics={metrics} getObjectUrl={getObjectUrl} removePhotos={removePhotos} batchSetTimestamps={noopBatchSetTimestamps} />)

    expect(removePhotos).toHaveBeenCalledTimes(1)
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

  it('keeps timestamp-edit selection independent of a similar-tier member\'s dedup-keeper selection', () => {
    const w = makeEntry('w', 'w.jpg', '2024-01-01T00:00:00Z', 0)
    const x = makeEntry('x', 'x.jpg', '2024-01-02T00:00:00Z', 1)
    const y = makeEntry('y', 'y.jpg', '2024-01-03T00:00:00Z', 2)
    const z = makeEntry('z', 'z.jpg', '2024-01-04T00:00:00Z', 3)
    // Same similar-tier cluster shape as the R7 test: w is the pre-selected
    // dedup keeper.
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['w', makeMetrics('0000000000000000', 1000, 1000)],
      ['x', makeMetrics('f000000000000000', 200, 200)],
      ['y', makeMetrics('0f00000000000000', 200, 200)],
      ['z', makeMetrics('00f0000000000000', 200, 200)],
    ])
    const removePhotos = vi.fn()
    const batchSetTimestamps = vi.fn()

    render(
      <ClusterView
        photos={[w, x, y, z]}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        removePhotos={removePhotos}
        batchSetTimestamps={batchSetTimestamps}
      />
    )

    // w is already the dedup keeper by default. Also select w for timestamp
    // editing — a second, independent selection on the same member.
    fireEvent.click(screen.getByLabelText('Select w.jpg for timestamp edit'))
    // Also select x for timestamp editing only (not touching dedup selection).
    fireEvent.click(screen.getByLabelText('Select x.jpg for timestamp edit'))

    // Dedup selection (w only) is unaffected by the timestamp-edit selection.
    fireEvent.click(screen.getByRole('button', { name: /remove non-selected/i }))
    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0].slice().sort()).toEqual(['x', 'y', 'z'])

    // Timestamp-edit selection (w, x) is unaffected by the dedup removal call
    // above — applying a custom date still targets exactly w and x.
    fireEvent.change(screen.getByLabelText('Custom timestamp'), { target: { value: '2025-01-01T00:00' } })
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }))

    expect(batchSetTimestamps).toHaveBeenCalledTimes(1)
    expect(batchSetTimestamps.mock.calls[0][0].slice().sort()).toEqual(['w', 'x'])
  })

  it('does not misapply a similar-tier selection to a different cluster that inherits its old discovery-order id', () => {
    // Three mutually-unrelated similar-tier pairs: {m1,m2}, {f,g}, {h,i}.
    // clusterPhotos assigns cluster.id purely by discovery order over the
    // `photos` array, so in this render {m1,m2}=cluster-0, {f,g}=cluster-1,
    // {h,i}=cluster-2.
    const m1 = makeEntry('m1', 'm1.jpg', '2024-01-01T00:00:00Z', 0)
    const m2 = makeEntry('m2', 'm2.jpg', '2024-01-02T00:00:00Z', 1)
    const f = makeEntry('f', 'f.jpg', '2024-01-03T00:00:00Z', 2)
    const g = makeEntry('g', 'g.jpg', '2024-01-04T00:00:00Z', 3)
    const h = makeEntry('h', 'h.jpg', '2024-01-05T00:00:00Z', 4)
    const i = makeEntry('i', 'i.jpg', '2024-01-06T00:00:00Z', 5)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['m1', makeMetrics('ff00000000000000', 500, 500)],
      ['m2', makeMetrics('fff0000000000000', 500, 500)], // distance to m1: 4 (similar)
      ['f', makeMetrics('0000ff0000000000', 200, 200)],
      ['g', makeMetrics('0000fff000000000', 1000, 1000)], // distance to f: 4 (similar); default keeper
      ['h', makeMetrics('00000000ff000000', 1000, 1000)], // default keeper
      ['i', makeMetrics('00000000fff00000', 200, 200)], // distance to h: 4 (similar)
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

    // Override {f,g}'s dedup selection: g is already the default keeper;
    // also select f, so the {f,g} cluster's selection becomes {f, g} —
    // ids that never overlap with {h,i}'s real member ids.
    fireEvent.click(screen.getByAltText('f.jpg'))

    // Simulate {m1,m2}'s cluster disappearing entirely from the batch (e.g.
    // already resolved and removed via some earlier interaction). This
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
    // key, not the reassigned numeric cluster.id): both f and g still show
    // as selected keepers.
    expect(screen.getByAltText('f.jpg').parentElement?.className).toContain('ring-zinc-900')
    expect(screen.getByAltText('g.jpg').parentElement?.className).toContain('ring-zinc-900')

    // {h,i} — now occupying the numeric slot {f,g} used to hold — must NOT
    // inherit {f,g}'s stale selection. It falls back to its own fresh
    // default: h (higher quality) pre-selected, i not.
    expect(screen.getByAltText('h.jpg').parentElement?.className).toContain('ring-zinc-900')
    expect(screen.getByAltText('i.jpg').parentElement?.className).not.toContain('ring-zinc-900')

    // {f,g}'s section renders first (earlier capturedAt), {h,i}'s second.
    const confirmButtons = screen.getAllByRole('button', { name: /remove non-selected/i })
    expect(confirmButtons).toHaveLength(2)
    fireEvent.click(confirmButtons[1]) // {h,i}'s confirm button

    // Only i (the correctly-computed non-keeper) is removed — never both h
    // and i, and never anything derived from {f,g}'s stale selection.
    expect(removePhotos).toHaveBeenCalledTimes(1)
    expect(removePhotos.mock.calls[0][0]).toEqual(['i'])
  })
})
