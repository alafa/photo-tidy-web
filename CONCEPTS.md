# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Google Photos Import

### Picker Session
A short-lived, server-brokered handle representing one in-progress photo selection through Google's own Photos Picker UI. The app creates a Picker Session, the user picks photos inside Google's hosted picker, and the app polls the session until it reports the selection is ready, then fetches the selected items and discards the session.

A Picker Session has an expiry and a polling interval set by Google, not the app. Once its selected items have been fetched, the app is responsible for explicitly deleting it — the app never relies on Google to clean it up automatically.

Fetching a Picker Session's selected Media Items can require more than one retrieval for a large selection — Google returns them a page at a time, and the app must keep retrieving until it has drained every page. Stopping after the first retrieval silently loses whichever Media Items didn't fit on it.

### Media Item
A single photo the user selected inside a Picker Session, described by Google (filename, MIME type, capture metadata, and a temporary download URL) but not yet downloaded into the app. A Picker Session yields zero or more Media Items once the user's selection is complete.

## Google Photos Upload

### Album
The destination Google Photos album a batch of photos is uploaded into. The app creates exactly one Album per upload run, named from the user-supplied batch name. Running the upload again in the same session — even with no changes since the last run — creates a new, separate Album rather than reusing the one from a prior run, because a photo's own uploaded bytes can never be replaced in place inside a previously-created item; the Album is the unit that gets replaced instead.

## Photo Deduplication

### Cluster
A group of photos in the currently loaded batch produced by photo-tidy-api, a separate CLIP-embedding-based similarity service reached over HTTP, purely for display and manual review — a Cluster carries no automatic behavior of its own. A 300px client-side thumbnail is generated per photo and sent to the API along with the current similarity threshold; the API returns cluster assignments, which the app renders using its own grid — the API itself has no notion of layout, drag order, or timestamps. A photo with no match to anything else in the batch renders plainly (not as a one-photo Cluster), whether because the API reported it standalone or because it was excluded from the request (an oversized/malformed photo the API rejected, or one whose thumbnail failed to generate client-side). The grouping aggressiveness is user-adjustable live via a "Similarity" slider shown as a 0-100% value (0% = only exact duplicates, 100% = very loose grouping); moving it re-groups the batch after a short debounce, since each change re-queries the API. If the clustering service is unreachable, the slider disables with a "Clustering service unavailable" message and the batch keeps rendering with its last-known grouping (or ungrouped, if none has ever succeeded).

A Cluster's position in the grid is chronological — determined by the earliest capture timestamp among its members, the same rule the rest of the app uses — and a single, unclustered photo (a one-member Cluster) sorts by its own timestamp, so it never moves when the similarity slider changes unless its own Cluster membership actually does. (An earlier iteration ordered Clusters by visual similarity — a centroid-based hierarchical traversal — but that reshuffled the whole grid on every threshold tick, which read as random and was reverted back to chronological.) Members within a Cluster are also ordered chronologically, not by mutual similarity: the grid has a single drag-to-reorder mechanism spanning every photo, clustered or not, and a similarity-ordered member sequence would silently compute the wrong timestamp for a photo dragged within its own Cluster.

Because a Cluster renders as one grid block anchored at its earliest member's position, its members are not guaranteed to sit next to the same photos they would if the whole batch were laid out purely by timestamp — an unrelated photo whose own timestamp falls between two Cluster members still renders after the whole Cluster block, not between them. Drag-to-reorder must resolve a dropped photo's new timestamp from what's actually rendered next to it, not from a plain chronological lookup into the underlying photo list, or a drop near a Cluster can silently compute the wrong timestamp. A Cluster also renders with a visually distinct bordered/shaded container so it's immediately clear which photos are grouped versus standing alone.

The user manually selects which member(s) of a Cluster to delete; nothing is ever removed automatically. (An earlier iteration auto-resolved "identical" photos without confirmation — removed after it proved confusing that removed photos weren't visible. Smart auto-suggestions may return once grouping itself is trustworthy.)
