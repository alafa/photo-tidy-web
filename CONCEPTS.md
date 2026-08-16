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
A group of photos in the currently loaded batch produced by complete-linkage agglomerative clustering over cosine distance between perceptual hashes (each hash read as a bit vector, L2-normalized), purely for display and manual review — a Cluster carries no automatic behavior of its own. A photo with no match to anything else in the batch renders plainly (not as a one-photo Cluster). The grouping aggressiveness is user-adjustable live via a "Similarity" slider shown as a 0-100% value (0% = only exact duplicates, 100% = very loose grouping), mapped internally to a cosine-distance threshold; moving it re-groups the batch immediately.

Clusters are ordered by visual similarity, not chronologically: each Cluster's centroid is compared against every other Cluster's via the same hierarchical-clustering technique (`leaves_list`-style traversal), so related Clusters land near each other. Within a Cluster, members are ordered the same way by their direct similarity to each other, so the most similar photos sit adjacent — this supersedes an earlier, session-settled decision to order Clusters chronologically.

The user manually selects which member(s) of a Cluster to delete; nothing is ever removed automatically. (An earlier iteration auto-resolved "identical" photos without confirmation — removed after it proved confusing that removed photos weren't visible. Smart auto-suggestions may return once grouping itself is trustworthy.)

A Debug Mode toggle shows the cosine distance between every pair of photos within a Cluster, plus a click-any-two-photos comparison showing their raw hashes and distance — for verifying the hashing/threshold behavior directly rather than inferring it from grouping outcomes.
