# Marginalia Architecture

## Overview

Marginalia is an end-to-end pipeline: EPUB highlights → Feishu → short video scripts.

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Reader PWA     │────▶│  Backend API     │────▶│  Feishu      │
│  (epub.js)      │     │  (FastAPI)       │     │  Webhook/Bot │
│                 │     │                  │     │              │
│  IndexedDB      │     │  SQLite          │     │  Group Chat  │
│  Highlights     │     │  Highlights      │     │  / Bitable   │
└─────────────────┘     └────────┬─────────┘     └──────┬───────┘
                                 │                       │
                                 ▼                       ▼
                        ┌──────────────────┐    ┌────────────────┐
                        │  Video Agent     │◀───│  Automation    │
                        │  (Python)        │    │  (Future)      │
                        │                  │    │                │
                        │  Script Output   │    │  Trigger on    │
                        │  Hook/Body/CTA   │    │  new record    │
                        └──────────────────┘    └────────────────┘
```

## Components

### 1. Reader PWA (`frontend/`)
- **Stack**: Vanilla HTML/JS/CSS + epub.js (CDN)
- **Storage**: IndexedDB (books + highlights)
- **Key features**: EPUB import, CFI-based highlighting, inline notes, manual sync
- **Offline**: Service worker caches app shell + epub.js; highlights work offline

### 2. Backend API (`backend/`)
- **Stack**: Python FastAPI + aiosqlite
- **Endpoints**:
  - `POST /api/highlights` — receive highlights from reader
  - `GET /api/highlights` — list highlights (for debugging/agent consumption)
  - `GET /health` — health check
  - `POST /api/generate-script` — generate video script from highlights
- **Database**: SQLite (embedded, zero-config)

### 3. Feishu Integration (`backend/feishu.py`)
- **MVP**: Custom bot webhook → HTTP POST to group chat
- **Message format**: Interactive card (v2) with highlight text, notes, tags
- **Fire-and-forget**: Doesn't block the sync response
- **Future**: Bitable structured storage via lark-cli

### 4. Video Agent (`backend/agent.py`)
- **Approach**: "Editing-first, shooting-second"
- **Output**: Hook (3-5s) + Body (40-55s) + CTA (5-10s)
- **Input**: 3-5 highlights with notes/tags
- **Duration**: Estimated from Chinese speech rate (~4 chars/sec)

## Data Flow

```
1. User imports EPUB → file_blob stored in IndexedDB
2. User reads, selects text → epub.js fires "selected" event with CFI
3. User clicks highlight color → rendition.annotations.highlight() + IndexedDB write
4. User clicks "Sync" → batch POST to /api/highlights
5. Backend saves to SQLite → fire-and-forget POST to Feishu webhook
6. Feishu card message appears in group chat
7. User triggers POST /api/generate-script → agent.py generates video outline
8. Script ready for voiceover recording + video editing
```

## Key Design Decisions

| Decision | Why |
|----------|-----|
| IndexedDB over localStorage | EPUB blobs can be 10MB+; need indexed queries |
| epub.js CDN over npm | No build step; SW caches for offline |
| SQLite over PostgreSQL | Zero setup for MVP; embedded in process |
| Webhook over Bitable | Immediate validation; no OAuth setup needed |
| Manual sync over auto | User control; clear data boundary |
| Fire-and-forget Feishu | Sync response stays fast; Feishu failures don't block |
| No auth | MVP scope; add API key for deployment |
