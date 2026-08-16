'use client'

import { useEffect, useRef, useState } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import { clusterPhotos, type Cluster } from '@/lib/photo-clustering'
import PhotoCard from './PhotoCard'

// KTD2's starting Hamming-distance thresholds (out of a 64-bit hash) — kept
// as a local constant so they're easy to find and tune once real
// WhatsApp-sourced photos are validated per the plan's Definition of Done.
const CLUSTER_THRESHOLDS = { identical: 3, similar: 12 }

interface ClusterViewProps {
  photos: PhotoEntry[]
  metrics: Map<string, PhotoMetrics | undefined>
  /**
   * Not part of the original ClusterViewProps sketch in the plan excerpt,
   * but required in practice: `PhotoCard` needs an `objectUrl` per member,
   * and the only correct source for that is `PhotoUploadPage`'s existing
   * `useObjectUrls` cache (mirrors how `PhotoGrid` already receives
   * `getObjectUrl` as a prop rather than creating its own object URLs).
   */
  getObjectUrl: (file: File) => string
  /**
   * `hooks/usePhotos.ts`'s `removePhotos`, called unchanged (KTD10) both for
   * U4's automatic identical-tier resolution and its confirmed similar-tier
   * removal.
   */
  removePhotos: (ids: string[]) => void
}

type MemberTier = 'identical' | 'similar' | null

/**
 * A cluster's `relationships` are per-pair, not per-member. This derives a
 * single "highest tier this member participates in" label for rendering: a
 * member touched by any `identical`-tier relationship is identical-flagged
 * (identical wins over similar); else similar-flagged if touched by any
 * `similar`-tier relationship; else (a true singleton with zero
 * relationships) no flag at all.
 */
function memberTier(cluster: Cluster, memberId: string): MemberTier {
  let sawSimilar = false
  for (const relationship of cluster.relationships) {
    if (relationship.a !== memberId && relationship.b !== memberId) continue
    if (relationship.tier === 'identical') return 'identical'
    sawSimilar = true
  }
  return sawSimilar ? 'similar' : null
}

/**
 * Earliest `capturedAt` (in ms) among a cluster's members, for R3's
 * chronological ordering. Null timestamps are excluded from the min and the
 * result falls back to `Infinity` when every member is null — mirroring
 * `hooks/usePhotos.ts`'s `sortPhotos` null-last convention, so an all-null
 * cluster sorts after every dated cluster.
 */
function earliestCapturedAtMs(cluster: Cluster, photosById: Map<string, PhotoEntry>): number {
  let earliest = Infinity
  for (const id of cluster.members) {
    const capturedAt = photosById.get(id)?.capturedAt ?? null
    if (capturedAt === null) continue
    earliest = Math.min(earliest, capturedAt.getTime())
  }
  return earliest
}

/**
 * KTD9's "best quality" ordering: pixel count (width * height) descending,
 * file size descending as a tie-breaker. A member with no metrics yet (still
 * computing) sorts as 0x0/0 bytes, i.e. last — this only matters in practice
 * for members that already participate in an identical/similar relationship,
 * which requires a resolved (non-null) hash and therefore resolved metrics.
 */
function compareByQualityDescending(
  a: string,
  b: string,
  metrics: Map<string, PhotoMetrics | undefined>
): number {
  const metricsA = metrics.get(a)
  const metricsB = metrics.get(b)
  const pixelsA = (metricsA?.width ?? 0) * (metricsA?.height ?? 0)
  const pixelsB = (metricsB?.width ?? 0) * (metricsB?.height ?? 0)
  if (pixelsA !== pixelsB) return pixelsB - pixelsA
  return (metricsB?.size ?? 0) - (metricsA?.size ?? 0)
}

/** The single best-by-quality (KTD9) member id among `ids`. `ids` must be non-empty. */
function bestQualityMember(ids: string[], metrics: Map<string, PhotoMetrics | undefined>): string {
  return [...ids].sort((a, b) => compareByQualityDescending(a, b, metrics))[0]
}

const TIER_STYLES: Record<'identical' | 'similar', string> = {
  identical: 'ring-2 ring-emerald-500 dark:ring-emerald-400 rounded-lg',
  similar: 'ring-2 ring-amber-500 dark:ring-amber-400 rounded-lg',
}

const TIER_LABELS: Record<'identical' | 'similar', string> = {
  identical: 'Identical',
  similar: 'Similar',
}

export default function ClusterView({ photos, metrics, getObjectUrl, removePhotos }: ClusterViewProps) {
  const photosById = new Map(photos.map((p) => [p.id, p]))

  const hashInputs = photos.map((photo) => ({
    id: photo.id,
    // A photo whose metrics are still in flight (absent map entry, or
    // present-but-`undefined`) is treated the same as "no hash" — it
    // renders as a temporary singleton and re-clusters correctly once its
    // real hash lands and `metrics` updates (KTD12).
    hash: metrics.get(photo.id)?.hash ?? null,
  }))

  const clusters = clusterPhotos(hashInputs, CLUSTER_THRESHOLDS)
  const sortedClusters = [...clusters].sort(
    (a, b) => earliestCapturedAtMs(a, photosById) - earliestCapturedAtMs(b, photosById)
  )

  // R6: per-cluster identical-tier auto-resolution. Computed fresh every
  // render from the current cluster shape; a ref (not state) tracks which
  // removals have already been *initiated* so the effect below never issues
  // the same `removePhotos` call twice, and never reacts to the smaller
  // post-removal cluster shape as if it were a new duplicate set.
  const identicalResolutions = sortedClusters.flatMap((cluster) => {
    const identicalIds = cluster.members.filter((id) => memberTier(cluster, id) === 'identical')
    if (identicalIds.length < 2) return [] // nothing to compare against — defensive guard
    const best = bestQualityMember(identicalIds, metrics)
    const toRemove = identicalIds.filter((id) => id !== best)
    if (toRemove.length === 0) return []
    // Keyed by the sorted ids being removed (not `cluster.id`, which is
    // reassigned on every `clusterPhotos` call) so the same real-world
    // removal is recognized as already-handled even across recomputes.
    const key = [...toRemove].sort().join(',')
    return [{ key, toRemove }]
  })

  const initiatedRemovalsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const { key, toRemove } of identicalResolutions) {
      if (initiatedRemovalsRef.current.has(key)) continue
      initiatedRemovalsRef.current.add(key)
      removePhotos(toRemove)
    }
  })

  // R7: per-cluster similar-tier suggested-keep selection, scoped by
  // `cluster.id`. A cluster with no recorded selection yet falls back to the
  // best-by-quality member as its suggested keep (KTD9) — computed lazily on
  // read rather than seeded via an effect, so there's no extra render/effect
  // cycle before the suggested selection is visible.
  const [similarSelections, setSimilarSelections] = useState<Map<string, Set<string>>>(new Map())

  function defaultSimilarSelection(similarIds: string[]): Set<string> {
    return new Set([bestQualityMember(similarIds, metrics)])
  }

  function toggleSimilarSelection(clusterId: string, similarIds: string[], id: string, checked: boolean) {
    setSimilarSelections((prev) => {
      const next = new Map(prev)
      const current = new Set(prev.get(clusterId) ?? defaultSimilarSelection(similarIds))
      if (checked) current.add(id)
      else current.delete(id)
      next.set(clusterId, current)
      return next
    })
  }

  function handleRemoveNonSelected(clusterId: string, similarIds: string[]) {
    const selected = similarSelections.get(clusterId) ?? defaultSimilarSelection(similarIds)
    removePhotos(similarIds.filter((id) => !selected.has(id)))
  }

  return (
    <div className="flex flex-col gap-8">
      {sortedClusters.map((cluster) => {
        const similarIds = cluster.members.filter((id) => memberTier(cluster, id) === 'similar')
        const selectedKeepers = similarIds.length > 0
          ? similarSelections.get(cluster.id) ?? defaultSimilarSelection(similarIds)
          : null

        return (
          <section key={cluster.id} className="flex flex-col gap-3">
            <h2 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
              {cluster.members.length > 1 ? `${cluster.members.length} related photos` : 'Photo'}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {cluster.members.map((id) => {
                const entry = photosById.get(id)
                if (!entry) return null
                const tier = memberTier(cluster, id)
                const isSimilar = tier === 'similar'
                return (
                  <div
                    key={id}
                    role={tier ? 'group' : undefined}
                    aria-label={tier ? TIER_LABELS[tier] : undefined}
                    className={tier ? TIER_STYLES[tier] : undefined}
                  >
                    {tier && <span className="sr-only">{TIER_LABELS[tier]}</span>}
                    <PhotoCard
                      entry={entry}
                      objectUrl={getObjectUrl(entry.file)}
                      onSelect={
                        isSimilar
                          ? (checked) => toggleSimilarSelection(cluster.id, similarIds, id, checked)
                          : undefined
                      }
                      checked={isSimilar ? (selectedKeepers?.has(id) ?? false) : undefined}
                    />
                  </div>
                )
              })}
            </div>
            {selectedKeepers && (
              <div>
                <button
                  type="button"
                  onClick={() => handleRemoveNonSelected(cluster.id, similarIds)}
                  disabled={selectedKeepers.size === 0}
                  className="px-3 py-1.5 text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Remove non-selected
                </button>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
