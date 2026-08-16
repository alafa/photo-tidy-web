'use client'

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

const TIER_STYLES: Record<'identical' | 'similar', string> = {
  identical: 'ring-2 ring-emerald-500 dark:ring-emerald-400 rounded-lg',
  similar: 'ring-2 ring-amber-500 dark:ring-amber-400 rounded-lg',
}

const TIER_LABELS: Record<'identical' | 'similar', string> = {
  identical: 'Identical',
  similar: 'Similar',
}

export default function ClusterView({ photos, metrics, getObjectUrl }: ClusterViewProps) {
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

  return (
    <div className="flex flex-col gap-8">
      {sortedClusters.map((cluster) => (
        <section key={cluster.id} className="flex flex-col gap-3">
          <h2 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
            {cluster.members.length > 1 ? `${cluster.members.length} related photos` : 'Photo'}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {cluster.members.map((id) => {
              const entry = photosById.get(id)
              if (!entry) return null
              const tier = memberTier(cluster, id)
              return (
                <div
                  key={id}
                  role={tier ? 'group' : undefined}
                  aria-label={tier ? TIER_LABELS[tier] : undefined}
                  className={tier ? TIER_STYLES[tier] : undefined}
                >
                  {tier && <span className="sr-only">{TIER_LABELS[tier]}</span>}
                  <PhotoCard entry={entry} objectUrl={getObjectUrl(entry.file)} />
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
