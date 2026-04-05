'use client'

import { useState } from 'react'

type Props = {
  selectedCount: number
  onBatchRename: (baseName: string) => void
  onBatchSetTimestamp: (anchor: Date) => void
  onClearSelection: () => void
}

function parseDatetimeLocalAsUTC(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0))
}

export default function BatchEditPanel({
  selectedCount,
  onBatchRename,
  onBatchSetTimestamp,
  onClearSelection,
}: Props) {
  const [baseName, setBaseName] = useState('')
  const [tsValue, setTsValue] = useState('')
  const [renameApplied, setRenameApplied] = useState(false)
  const [tsApplied, setTsApplied] = useState(false)

  function handleRename() {
    if (!baseName.trim()) return
    onBatchRename(baseName.trim())
    setRenameApplied(true)
    setTimeout(() => setRenameApplied(false), 1500)
  }

  function handleSetTimestamp() {
    const parsed = parseDatetimeLocalAsUTC(tsValue)
    if (!parsed) return
    onBatchSetTimestamp(parsed)
    setTsApplied(true)
    setTimeout(() => setTsApplied(false), 1500)
  }

  const padLen = String(selectedCount).length
  const exampleSuffix = `${'1'.padStart(padLen, '0')}`

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {selectedCount} photo{selectedCount !== 1 ? 's' : ''} selected
        </span>
        <button
          onClick={onClearSelection}
          className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline"
        >
          Clear selection
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Batch rename */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase tracking-wide">
            Rename selected
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Base name (e.g. vacation)"
              value={baseName}
              onChange={(e) => setBaseName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRename()}
              className="flex-1 text-sm border border-zinc-300 dark:border-zinc-600 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <button
              onClick={handleRename}
              disabled={!baseName.trim()}
              className="px-3 py-1.5 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed min-w-[70px]"
            >
              {renameApplied ? 'Applied ✓' : 'Apply'}
            </button>
          </div>
          {baseName.trim() && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              Preview: {baseName.trim()}-{exampleSuffix}.ext … ({selectedCount} files)
            </p>
          )}
        </div>

        {/* Batch timestamp */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase tracking-wide">
            Set start timestamp
          </label>
          <div className="flex gap-2">
            <input
              type="datetime-local"
              value={tsValue}
              onChange={(e) => setTsValue(e.target.value)}
              className="flex-1 text-sm border border-zinc-300 dark:border-zinc-600 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <button
              onClick={handleSetTimestamp}
              disabled={!tsValue}
              className="px-3 py-1.5 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed min-w-[70px]"
            >
              {tsApplied ? 'Applied ✓' : 'Apply'}
            </button>
          </div>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Selected photos get times 1 second apart from this start, in display order.
          </p>
        </div>
      </div>
    </div>
  )
}
