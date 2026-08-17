import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import BatchEditPanel from './BatchEditPanel'

afterEach(cleanup)

const defaultProps = {
  selectedCount: 2,
  distinctTimestamps: [] as Date[],
  onBatchRename: vi.fn(),
  onBatchSetTimestamp: vi.fn(),
  onBatchDelete: vi.fn(),
  onClearSelection: vi.fn(),
}

describe('BatchEditPanel', () => {
  it('renders the selected count', () => {
    render(<BatchEditPanel {...defaultProps} selectedCount={3} />)

    expect(screen.getByText('3 photos selected')).toBeDefined()
  })

  it('renders "Delete selected" as a label and as a button', () => {
    render(<BatchEditPanel {...defaultProps} />)

    expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDefined()
  })

  it('calls onBatchDelete when "Delete selected" is clicked', () => {
    const onBatchDelete = vi.fn()

    render(<BatchEditPanel {...defaultProps} onBatchDelete={onBatchDelete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

    expect(onBatchDelete).toHaveBeenCalledOnce()
  })

  it('does not call onBatchRename or onBatchSetTimestamp when delete is clicked', () => {
    const onBatchRename = vi.fn()
    const onBatchSetTimestamp = vi.fn()

    render(
      <BatchEditPanel
        {...defaultProps}
        onBatchRename={onBatchRename}
        onBatchSetTimestamp={onBatchSetTimestamp}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

    expect(onBatchRename).not.toHaveBeenCalled()
    expect(onBatchSetTimestamp).not.toHaveBeenCalled()
  })

  it('calls onClearSelection when "Clear selection" is clicked', () => {
    const onClearSelection = vi.fn()

    render(<BatchEditPanel {...defaultProps} onClearSelection={onClearSelection} />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))

    expect(onClearSelection).toHaveBeenCalledOnce()
  })

  it('calls onBatchRename with the trimmed base name when Apply is clicked', () => {
    const onBatchRename = vi.fn()

    render(<BatchEditPanel {...defaultProps} onBatchRename={onBatchRename} />)

    const input = screen.getByPlaceholderText('Base name (e.g. vacation)')
    fireEvent.change(input, { target: { value: '  vacation  ' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[0])

    expect(onBatchRename).toHaveBeenCalledWith('vacation')
  })
})

// R8/KTD7: quick-pick timestamp buttons, generalized from ClusterView.tsx's
// former ClusterTimestampEditor to work identically for any selection —
// single cluster, cross-cluster, or plain timeline. `distinctTimestamps` is
// the prop contract: PhotoUploadPage is responsible for deduping by exact
// millisecond value and sorting ascending before passing it down (mirroring
// the rule ClusterTimestampEditor used), so these tests exercise
// BatchEditPanel's rendering/capping/callback behavior against inputs shaped
// the way that derivation produces.
const quickPickFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'UTC',
})

function quickPickLabel(date: Date) {
  return `Use ${quickPickFormatter.format(date)}`
}

describe('BatchEditPanel — quick-pick timestamps (U5)', () => {
  it('shows one quick-pick button per distinct timestamp, plus the custom input', () => {
    const timestamps = [
      new Date('2025-01-01T10:00:00Z'),
      new Date('2025-01-02T10:00:00Z'),
      new Date('2025-01-03T10:00:00Z'),
    ]

    render(<BatchEditPanel {...defaultProps} distinctTimestamps={timestamps} />)

    for (const date of timestamps) {
      expect(screen.getByRole('button', { name: quickPickLabel(date) })).toBeDefined()
    }
    // Custom datetime-local input is still present alongside the quick-picks.
    expect(document.querySelector('input[type="datetime-local"]')).toBeDefined()
  })

  it('renders one deduplicated quick-pick button when two selected photos share a timestamp', () => {
    // Simulates the derivation PhotoUploadPage performs: two selected
    // photos with the same capturedAt collapse to a single distinct entry
    // before this prop is ever set (AE3).
    const shared = new Date('2025-03-15T08:30:00Z')

    render(<BatchEditPanel {...defaultProps} selectedCount={2} distinctTimestamps={[shared]} />)

    expect(screen.getAllByRole('button', { name: quickPickLabel(shared) })).toHaveLength(1)
  })

  it('shows the union of distinct timestamps from a selection spanning two clusters', () => {
    // Simulates a selection with members from two different clusters, each
    // contributing its own distinct timestamp (AE3) — neither cluster's
    // timestamp alone, but the union of both.
    const fromClusterA = new Date('2025-02-01T09:00:00Z')
    const fromClusterB = new Date('2025-02-05T09:00:00Z')

    render(
      <BatchEditPanel
        {...defaultProps}
        selectedCount={4}
        distinctTimestamps={[fromClusterA, fromClusterB]}
      />
    )

    expect(screen.getByRole('button', { name: quickPickLabel(fromClusterA) })).toBeDefined()
    expect(screen.getByRole('button', { name: quickPickLabel(fromClusterB) })).toBeDefined()
  })

  it('caps quick-pick buttons at 8, showing the 8 most recent plus a count of the rest', () => {
    // 10 distinct ascending timestamps — sorted ascending is the contract
    // BatchEditPanel receives, mirroring what PhotoUploadPage derives.
    const timestamps = Array.from(
      { length: 10 },
      (_, i) => new Date(Date.UTC(2025, 0, i + 1, 12, 0, 0))
    )

    render(<BatchEditPanel {...defaultProps} distinctTimestamps={timestamps} />)

    const mostRecentEight = timestamps.slice(-8)
    const omitted = timestamps.slice(0, 2)

    for (const date of mostRecentEight) {
      expect(screen.getByRole('button', { name: quickPickLabel(date) })).toBeDefined()
    }
    for (const date of omitted) {
      expect(screen.queryByRole('button', { name: quickPickLabel(date) })).toBeNull()
    }
    expect(
      screen.getAllByRole('button').filter((el) => el.textContent?.startsWith('Use '))
    ).toHaveLength(8)
    expect(screen.getByText('+2 more')).toBeDefined()
  })

  it('applies the one-second-offset convention identically whether triggered via quick-pick or custom input', () => {
    const onBatchSetTimestamp = vi.fn()
    const anchor = new Date('2025-06-01T12:00:00Z')

    render(
      <BatchEditPanel
        {...defaultProps}
        distinctTimestamps={[anchor]}
        onBatchSetTimestamp={onBatchSetTimestamp}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: quickPickLabel(anchor) }))

    // BatchEditPanel's job is to hand the chosen anchor to the same
    // onBatchSetTimestamp callback the custom-input path already uses;
    // hooks/usePhotos.ts's batchSetTimestamps applies the actual
    // one-second-per-photo offset from whatever anchor it receives, so
    // identical anchors here guarantee identical computed timestamps
    // downstream regardless of which path produced the anchor.
    expect(onBatchSetTimestamp).toHaveBeenCalledOnce()
    expect(onBatchSetTimestamp).toHaveBeenCalledWith(anchor)
  })

  it('shows only the custom input, no quick-pick buttons, when no selected photo has a timestamp', () => {
    render(<BatchEditPanel {...defaultProps} distinctTimestamps={[]} />)

    expect(
      screen.queryAllByRole('button').filter((el) => el.textContent?.startsWith('Use '))
    ).toHaveLength(0)
    expect(document.querySelector('input[type="datetime-local"]')).toBeDefined()
  })
})
