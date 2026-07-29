# Marginalia Architecture

## Overview

Marginalia is an end-to-end local reading workflow: EPUB highlights -> backend notes library -> creation outputs.

```text
┌─────────────────┐     ┌──────────────────┐
│  Reader PWA     │────▶│  Backend API     │
│  (epub.js)      │     │  (FastAPI)       │
│                 │     │                  │
│  IndexedDB      │     │  SQLite          │
│  Highlights     │     │  Notes + Drafts  │
└─────────────────┘     └────────┬─────────┘
                                 │
                ┌────────────────┴────────────────┐
                ▼                                 ▼
       ┌──────────────────┐              ┌────────────────┐
       │  Creation Agent  │              │  Obsidian      │
       │  Rules + LLM     │              │  Markdown      │
       │                  │              │  Export        │
       │  Scripts/Drafts  │              │                │
       └──────────────────┘              └────────────────┘
```

## Components

### 1. Reader PWA (`frontend/`)

- **Stack**: Vanilla HTML/JS/CSS + epub.js
- **Storage**: IndexedDB (`books`, `highlights`, `bookmarks`, `sync_queue`) as an offline cache
- **Key features**: server-first EPUB import, CFI-based highlighting, inline notes, tags, search, bookmarks, AI Q&A, cross-device sync
- **Offline**: Service worker caches the app shell and server EPUB responses; mutations queue locally until the server is reachable

### 2. Backend API (`backend/`)

- **Stack**: Python FastAPI + aiosqlite
- **Endpoints**:
  - `POST /api/highlights` — receive highlights from reader
  - `GET /api/highlights` — list highlights
  - `GET /api/materials` — filter creation materials
  - `POST /api/books/ask` — answer questions using local reading context
  - `POST /api/knowledge/books/upload` — upload and queue a local EPUB index
  - `GET /api/knowledge/books/{id}` — inspect persisted index state
  - `GET/POST /api/knowledge/books/{id}/conversations` — manage per-book chats
  - `POST /api/knowledge/conversations/{id}/messages/stream` — stream grounded answers
  - `POST /api/generate-script` — generate a rule-based video script from highlights
  - `POST /api/drafts/generate` and `/api/drafts/*` — generate and manage LLM drafts
  - `POST /api/obsidian/export` — export book materials or drafts
  - `POST /api/books/upload` — validate, deduplicate, persist, and index an EPUB
  - `GET /api/books` and `GET /api/books/{id}/file` — list and read canonical server EPUBs
  - `GET/POST /api/books/{id}/sync` — pull state or apply idempotent progress/bookmark/highlight operations
  - `DELETE /api/books/{id}` — delete the EPUB, reader state, and AI data on every device
  - `GET /health` — health check
- **Database**: SQLite (embedded, zero-config)

### 3. Creation Agent (`backend/agent.py`, `backend/llm.py`)

- **Rule engine**: Produces a short video structure with hook, body, CTA, and duration estimate.
- **LLM draft generation**: Produces video or article drafts from selected highlights when an OpenAI-compatible endpoint is configured.
- **Book Q&A**: Uploads EPUBs into a persistent SQLite knowledge base, combines
  embedding similarity with lexical retrieval, streams grounded answers, stores
  per-book conversations, and returns navigable source citations.

### 4. Obsidian Export (`backend/obsidian.py`)

- Exports book materials and generated drafts as Markdown files.
- Requires `OBSIDIAN_VAULT_PATH` to point at the target vault.

## Data Flow

1. User imports EPUB -> backend stores a canonical hash-deduplicated copy; the importing browser keeps an offline copy.
2. User reads and selects text -> epub.js returns a CFI range.
3. User picks a highlight color -> the annotation is rendered and saved in IndexedDB.
4. User edits notes/tags -> local highlight material is updated.
5. Reader changes enter an IndexedDB operation queue and automatically sync through `POST /api/books/{id}/sync`.
6. Backend refreshes `backend/data/notes.json` from SQLite.
7. User generates scripts/drafts or exports materials to Obsidian.
8. EPUB imports are hashed and queued for background indexing without blocking reading.
9. Questions retrieve relevant book chunks and notes, then stream a source-grounded answer.
10. Conversations and citation snapshots remain available after reopening the book.

## Key Design Decisions

| Decision | Why |
|----------|-----|
| IndexedDB over localStorage | EPUB blobs can be 10MB+; notes need indexed local queries |
| epub.js with a static frontend | No frontend build step; easy local deployment |
| SQLite over PostgreSQL | Zero setup for MVP; embedded in process |
| Idempotent auto-sync with a local queue | Progress, bookmarks, highlights, and notes survive offline use and converge across devices |
| JSON notes export | Simple machine-readable bridge for local workflows |
| Backend serves frontend | One local server and same-origin API calls |
| No auth | MVP scope; add API key before exposed deployment |
| SQLite vectors over a vector service | Keeps a single-user deployment zero-infrastructure |
| Persistent index queue | Interrupted EPUB indexing can resume after a backend restart |
