---
title: "Residual review findings — Photo similarity grouping & deduplication"
date: 2026-08-16
branch: feat/photo-similarity-dedup
plan: docs/plans/2026-08-15-001-feat-similar-photo-grouping-dedup-plan.md
---

# Residual Review Findings

`ce-code-review` (8 reviewers: correctness, project-standards, testing, maintainability, performance, reliability, adversarial, learnings — no cross-model peer available on this host) ran against this branch's diff (`develop...feat/photo-similarity-dedup`). Applied findings landed as commits on the branch; this record covers what was **not** applied, with the reason, so it isn't silently lost.

## Applied (for reference — see commit messages for full detail)

- **P0** — Identical-tier auto-resolution collapsed disjoint duplicate pairs bridged by a similar-tier edge into one "keep only the best" group, auto-deleting non-duplicate photos. Fixed: partition into per-identical-edge sub-components. (`75f825c`)
- **P0** — `similarSelections`/`timestampSelections` keyed by the positionally-reassigned `cluster.id`, letting a stale selection misapply to an unrelated cluster after a recompute shifted indices. Fixed: stable content-derived cluster key. (`75f825c`)
- **P2** (maintainability) — `parseDatetimeLocalAsUTC` triplicated; extracted to `lib/datetime-local.ts`. (`5f5ed4e`)
- **P2** (performance) — `memberTier` re-scanned relationships per member on every render; precomputed per-cluster tier map. (`5f5ed4e`)
- **P2** (reliability) — `usePhotoMetrics`'s fire-and-forget computation loop had no rejection handler; added a `.catch()` logging guard. (`5f5ed4e`)
- **P1** (testing) — `computePhotoMetrics`'s canvas-context-unavailable degrade path was untested; added coverage. (`da7f318`)

## Not applied — deferred with reason

| Severity | Reviewer(s) | Finding | File | Reason deferred |
|---|---|---|---|---|
| P1 (advisory) | adversarial | dHash discards aspect ratio when downscaling to a fixed 9x8 grid; two genuinely different photos could theoretically collide within the "identical" tolerance and be auto-deleted with no confirmation. | `lib/perceptual-hash.ts` | Already the plan's own acknowledged risk — the Definition of Done requires validating the starting Hamming thresholds (KTD2) against real WhatsApp-sourced photos before considering the feature done. No code change proposed by the reviewer beyond that already-planned validation step; a corroborating check (aspect-ratio guard) is a reasonable future hardening if real-photo validation surfaces false positives, not a pre-emptive fix. |
| P2 (advisory) | adversarial | Async metrics chunking (`METRICS_CONCURRENCY`) can split one N-way (N>=3) identical-tier duplicate group's auto-resolution into multiple separate no-confirmation deletion waves as hashes resolve across chunks, instead of one atomic resolution. Converges to the same correct final survivor either way — this is a UX/predictability concern, not data loss. | `hooks/usePhotoMetrics.ts`, `components/ClusterView.tsx` | Fixing cleanly requires threading a "batch fully settled" signal from `usePhotoMetrics` into `ClusterView`'s auto-resolution effect (deferring resolution until `pending.length === 0` for the whole hook, not per-chunk) — a real design change beyond this review pass's scope. Tracked here for a follow-up if real usage shows the multi-wave behavior is noticeable/confusing. |
| P2 (testing) | testing | `earliestCapturedAtMs`'s all-null-cluster `Infinity` sort-last fallback has no dedicated test (a regression here would silently reorder clusters). | `components/ClusterView.tsx` | Minor coverage gap, no behavior defect. Add a test pairing one dated cluster with one all-null-`capturedAt` cluster asserting sort order, when next touching this file. |
| P2 (testing) | testing | `usePhotoMetrics`'s "unchanged" bail-out (skip `setMetricsById` when the rebuilt map is value-identical) has no test proving the referential-stability optimization actually fires. | `hooks/usePhotoMetrics.ts` | Minor coverage gap for an optimization, not a correctness path. Add a test capturing the returned map by reference across a reorder/rename rerender, when next touching this file. |
| P3 (reliability) | reliability | `bitmap.close()` sits in a bare `finally` with no enclosing `catch`; if it ever threw, it would propagate out of `computePhotoMetrics` uncaught, breaking its "never throws" contract. | `lib/perceptual-hash.ts` | `ImageBitmap.close()` is spec'd not to throw in compliant browsers. Defensive-wrapping a call that cannot throw under normal operation is not warranted; revisit only if a real crash report ever implicates it. |

## Not findings — checked and confirmed sound

- `docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md`'s generation-token pattern is correctly applied in `usePhotoMetrics.ts` (generation captured once per effect run, checked before every chunk write).
- `ClusterView` is not wrapped in `DndContext` anywhere in its render tree, so the documented `PhotoCard`/dnd-kit selection-vs-drag interaction pitfall (`docs/solutions/best-practices/image-as-selection-target-dnd-kit-pattern-2026-04-05.md`) does not apply here.
- The correctness reviewer's third finding (an uncontrolled `ClusterTimestampEditor` draft input could visually leak across an unrelated cluster reusing the same stale `cluster.id` key) is resolved as a side effect of the P0 cluster-key-stability fix above — the `<section>` list key now uses the same stable `clusterKey`, so React correctly treats a different real-world cluster as a different element.
