import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import BatchEditPanel from './BatchEditPanel'

afterEach(cleanup)

const defaultProps = {
  selectedCount: 2,
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
