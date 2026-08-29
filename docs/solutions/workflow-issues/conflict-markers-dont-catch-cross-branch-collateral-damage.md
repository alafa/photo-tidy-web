---
title: Verifying a Merge Is More Than Resolving Its Conflict Markers
date: 2026-08-28
category: workflow-issues
module: photo clustering merge (PhotoGrid / useClusteredPhotos)
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Merging two long-lived feature branches into a shared branch (e.g. develop)
  - One branch deletes, renames, or moves something (a type export, helper module, or test fixture shape) that the other branch's new code depends on, inside a file that has zero conflicting lines
  - Deciding whether a merge is safe once all conflict markers have been resolved
symptoms:
  - "npm run build, npm run test, or npm run lint fails after every conflict marker has been resolved, in files that had no marked conflicts at all"
  - A file with zero conflict markers still imports or calls helpers/types that were deleted on the other branch (git kept the pre-merge version silently)
  - vi.mock factory functions in test files are missing a field that newly merged production code now depends on
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components: [testing_framework, tooling]
tags: [git-merge, conflict-markers, merge-verification, dead-code, type-exports, vi-mock, cross-branch-collateral-damage]
---

# Verifying a Merge Is More Than Resolving Its Conflict Markers

## Context

Merging `feat/photo-similarity-dedup` and `feat/integrate-cluster-api` into `develop` produced textual conflict markers in three files: `components/PhotoGrid.tsx`, `components/PhotoUploadPage.tsx`, and `components/PhotoUploadPage.test.tsx`. All three were resolved, and a repo-wide check confirmed zero markers remained:

```
grep -rn "^<<<<<<<\|^=======\|^>>>>>>>" --include="*.ts" --include="*.tsx" .
```

That check returning clean felt like the merge was done. It wasn't. Running the actual verification suite (`npm run test`) surfaced three failures that had **no relationship to any marked conflict region**:

1. `hooks/useClusteredPhotos.ts`'s `Cluster` interface wasn't exported, even though the day-bucketing code newly added to `components/PhotoGrid.tsx` (from the `photo-similarity-dedup` side) needed to import that exact type from the hook. Neither parent branch had this combination in one place — one branch added the consumer, the other owned the producer, and they never touched the same line, so git had nothing to flag.
2. Two separate `vi.mock` factories standing in for `useClusteredPhotos` in test files were missing an export/field the newly-merged code now depended on at runtime (`earliestCapturedAtMs`, used by `PhotoGrid.tsx`'s day-bucketing pass). Mocks aren't type-checked against the real module's surface the way real imports are, so this only showed up as failing assertions, not a compile error.
3. `components/PhotoGrid.test.tsx` had **zero conflict markers** — git's merge silently auto-resolved it by keeping one branch's version outright — yet it still referenced helpers and fixtures (`makeMetrics`, `hashFromPositions`, `PhotoMetrics`, `emptyMetrics`, `range(`) belonging to the client-side perceptual-hash clustering module that the `integrate-cluster-api` branch had deleted entirely. Nothing about resolving markers would ever touch this file, because there was nothing marked.

All three were found by running the full suite and reading failures, then explicitly grepping the tree for stale symbol names — not by re-reading the three conflicted files more carefully.

## Guidance

**A merge is "safe" only after build + test + lint pass clean — not after conflict markers are gone.** Marker resolution and correctness are two different claims. Marker resolution says: "the lines both branches touched now agree." It says nothing about:

- Whether a symbol one side's new code needs was ever exported by the other side (no line-level overlap possible, since one branch added the *consumer* and the other owns the *producer* — see `hooks/useClusteredPhotos.ts:16`, `export interface Cluster { id: string; members: string[] }`, which the day-bucketing code in `PhotoGrid.tsx` needs to import).
- Whether test doubles (`vi.mock` factories, stubs, fakes) still match the real module's current surface. Mocks are hand-maintained and untyped against the real export list, so a real module gaining a new export a caller relies on can leave every hand-written mock silently behind — TypeScript won't catch it, only a failing test assertion will.
- Whether a file with **zero conflict markers** is actually still correct. Git auto-resolves non-overlapping files by picking one side outright; if that file references something the *other* side deleted or renamed, the merge is broken there too, and nothing about the conflict-resolution workflow will ever surface it, because the file was never flagged as conflicted in the first place.

Concretely, in this merge, `components/PhotoGrid.test.tsx` still imported/used identifiers tied to a whole clustering approach (`makeMetrics`, `hashFromPositions`, `PhotoMetrics`, `emptyMetrics`, `range(`) that no longer existed anywhere in the tree, in a file git never flagged.

## Why This Matters

Two branches can each be internally consistent and still produce a broken merge with no textual conflicts, whenever:

- One branch adds a new *consumer* of something (a type, a function, a field) that the other branch's version of that thing doesn't yet expose — the two never touch the same line, so there's no marker, but the combination doesn't compile or doesn't run.
- One branch deletes or renames something the other branch's *unrelated-looking* file (often a test file) still depends on — git's auto-merge picks a side for the non-overlapping file and never checks it against what the other branch removed.
- Hand-maintained test doubles (mocks, fixtures, fakes) drift from the real modules they stand in for, because nothing enforces that a `vi.mock('...')` factory's shape tracks the real module's exports as those exports change on either branch.

Treating "no marker" as "verified" in these cases means shipping code that looks resolved but is actually broken — and the breakage surfaces later, further from the merge, and harder to trace back to it.

## When to Apply

- Any merge or rebase where two long-lived feature branches both touch a shared module (a hook, a type, a utility) from different angles — one adding a consumer, one owning the producer.
- Any merge where one side deletes or substantially rewrites a module (e.g. removing client-side computation in favor of an API call), even if the affected test/consumer files show no conflict markers.
- Any merge touching files with `vi.mock` / `jest.mock` factories for a module that changed shape on either branch.
- Before trusting a merge commit is safe to push — i.e., before treating conflict-marker resolution as the finish line.

## Examples

`hooks/useClusteredPhotos.ts:16-19` — the export the cross-branch consumer needed:

```ts
export interface Cluster {
  id: string
  members: string[]
}
```

`components/PhotoGrid.test.tsx:42-60` — the `vi.mock` factory that has to track the real module's full surface, including the function the merged `PhotoGrid.tsx` day-bucketing code calls directly:

```ts
vi.mock('@/hooks/useClusteredPhotos', () => ({
  useClusteredPhotos: (photos: PhotoEntry[], similarityPercent: number) =>
    mockUseClusteredPhotos(photos, similarityPercent),
  clusterKey: (cluster: { members: string[] }) => [...cluster.members].sort().join(','),
  // Mirrors the real hook's semantics exactly (earliest non-null capturedAt
  // among members, Infinity when every member is null) -- PhotoGrid.tsx's
  // day-bucketing pass calls this directly, so a stub that always returned
  // 0 (or omitted the export) would either sort every test cluster into one
  // bucket or crash with "no export defined on the mock".
  earliestCapturedAtMs: (cluster: { members: string[] }, photosById: Map<string, PhotoEntry>) => {
    let earliest = Infinity
    for (const id of cluster.members) {
      const capturedAt = photosById.get(id)?.capturedAt ?? null
      if (capturedAt === null) continue
      earliest = Math.min(earliest, capturedAt.getTime())
    }
    return earliest
  },
}))
```

A second `vi.mock('@/hooks/useClusteredPhotos', ...)` factory in `components/PhotoUploadPage.test.tsx` needed the identical fix — the same real module, mocked independently in a second test file, drifted the same way.

By contrast, `components/PhotoGrid.test.tsx` currently has no references to `makeMetrics`, `hashFromPositions`, `PhotoMetrics`, `emptyMetrics`, or `range(` — those were the dangling symbols from the deleted client-side clustering module that a zero-conflict auto-merge had silently left behind, found only by grepping the tree after the test suite pointed at failures in this file.

## Prevention Checklist

Run this after every marked-conflict merge, before trusting the merge is safe — not just after touching conflicted files:

1. **Confirm zero markers first, but treat it as step one, not the finish line:**
   `grep -rn "^<<<<<<<\|^=======\|^>>>>>>>" --include="*.ts" --include="*.tsx" .`
2. **Run the full build, test, and lint suite before trusting anything** — this is what actually finds cross-branch breakage, since conflict markers only cover lines both branches touched:
   `npm run test && npm run lint && npm run build`
3. **When two branches both touch a shared hook/type/module from different angles** (one adds a consumer, one owns the producer), explicitly check that the type or function surface the merged code needs is actually exported — don't assume it compiled cleanly just because there was no marker on that line.
4. **Grep the whole tree — not just the conflicted files — for symbols either parent branch deleted or renamed.** A file with zero conflict markers can still hold dangling references, because git's auto-merge silently keeps one side's content without checking it against what the other side removed:
   `grep -rn "<deleted-symbol-1>\|<deleted-symbol-2>\|..." --include="*.ts" --include="*.tsx" .`
5. **Re-check every hand-written test double (`vi.mock`/`jest.mock` factory) for a module either branch changed**, since mocks aren't type-checked against the real module's current exports — a failing assertion, not a compiler error, is often the only signal.
6. Only after (2)-(5) pass clean, treat the merge as verified and proceed to the merge commit.

## Related

- [`cluster-drag-timestamp-visual-order-divergence.md`](../logic-errors/cluster-drag-timestamp-visual-order-divergence.md) — a different problem class (a rendering-order logic bug, not a merge-process gap), but touches the same `hooks/useClusteredPhotos.ts` and cluster test suite, so worth cross-checking when working in this area.
