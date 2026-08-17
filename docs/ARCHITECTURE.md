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
- **Key features**: server-first EPUB import, CFI-based highlighting, inline notes, tags, search, bookmarks, AI Q&A, cross-device sync, and HTML5 Audio chapter narration
- **Offline**: Service worker caches the app shell and server EPUB responses; mutations queue locally until the server is reachable

### 2. Backend API (`backend/`)

- **Stack**: Python FastAPI + aiosqlite
- **Endpoints**:
  - `POST /api/highlights` — receive highlights from reader
  - `GET /api/highlights` — list highlights
  - `GET /api/materials` — filter creation materials
  - `GET /api/search` — full-text search over highlight text, notes, and tags (FTS5)
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
  - `GET /api/tts/voices` — list the small verified Chinese voice whitelist
  - `POST /api/books/{id}/chapters/{href}/tts` — create, merge, or reuse a chapter narration task
  - `GET /api/tts/tasks/{id}` and `/segments/{index}` — poll generation and stream controlled MP3 segments
  - `GET /health` — health check
- **Database**: SQLite (embedded, zero-config)

### 3. Creation Agent (`backend/agent.py`, `backend/llm.py`)

- **Rule engine**: Produces a short video structure with hook, body, CTA, and duration estimate.
- **LLM draft generation**: Produces video or article drafts from selected highlights when an OpenAI-compatible endpoint is configured.
- **Book Q&A**: Uploads EPUBs into a persistent SQLite knowledge base, combines
  embedding similarity with lexical retrieval, streams grounded answers, stores
  per-book conversations, and returns navigable source citations.

### 4. Chapter TTS (`backend/tts.py`)

- Reads chapter documents only from canonical EPUB files in `backend/data/books`; clients submit IDs and options, never arbitrary text.
- BeautifulSoup removes scripts, styles, navigation, invisible controls, and Markdown markers before content hashing.
- A deterministic key covers book ID, chapter href, cleaned content hash, voice, rate, and provider. Files are stored beneath `backend/data/tts/` with atomic `metadata.json` updates and `segment-NNN.mp3` files.
- An in-process task manager merges duplicates, limits global/client concurrency, retries only the failed segment, marks interrupted tasks failed on restart, and exposes a manual retention cleanup command.
- The existing deployment is a shared single-user app. Cloudflare Access protects production; if later authentication middleware sets `request.state.allowed_book_ids`, TTS enforces that per-book scope too.

### 5. Obsidian Export (`backend/obsidian.py`)

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
11. Narration requests resolve the current epub.js href to a server-side spine document; the first generated segment becomes playable while remaining segments continue in the background.
12. The browser stores only playback position/options in localStorage; reusable MP3 cache and status metadata remain on the server.

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
| Direct Python edge-tts integration | The backend is already FastAPI/Python, so no second service or API key is needed |
| File-backed TTS metadata + in-process workers | Keeps the single-process MVP zero-infrastructure; interrupted generation is explicitly failed and retryable |
| Controlled audio endpoint | Task/segment validation prevents arbitrary file reads and directory traversal |
