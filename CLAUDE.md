# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**photo-tidy-web** — a Next.js web app that lets users upload images, reads their EXIF metadata, displays photos ordered by timestamp, and supports drag & drop reordering that writes updated timestamps back into EXIF data.

## Commands

```bash
npm run dev       # start dev server
npm run build     # production build
npm run lint      # ESLint
npm run test      # run tests (once added)
```

## Architecture

- **Framework**: Next.js (App Router)
- **EXIF reading**: parse EXIF metadata from uploaded images client-side
- **EXIF writing**: modify DateTimeOriginal (and related tags) to reflect drag & drop order
- **State**: photo list is ordered by EXIF timestamp; drag & drop reordering reassigns timestamps to persist the new order
- **File handling**: all image processing happens in the browser — no server-side storage

## Documented Solutions

`docs/solutions/` — past bugs and best practices organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

`CONCEPTS.md` — shared domain vocabulary (entities, named processes, status concepts) — relevant when orienting to the codebase or discussing domain concepts.
