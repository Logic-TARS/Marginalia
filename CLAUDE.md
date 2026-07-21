# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Marginalia is a pipeline: **EPUB highlights → Backend API → Feishu → Short video scripts**. A browser PWA lets users read EPUBs, create color-coded highlights with inline notes/tags, and sync to a FastAPI backend that forwards them to Feishu (Lark) and can generate video scripts from selected highlights.

## Commands

```bash
# Backend: install deps and run with hot reload (default port 8720)
cd backend && pip install -r requirements.txt && uvicorn main:app --reload --port 8720

# Run via python __main__ (same thing, port 8720):
cd backend && python main.py

# Docker Compose (hot reload + persistent data volume, port 8720):
docker compose up --build

# All methods serve the frontend at http://localhost:8720 via StaticFiles mount.

# Generate video script from highlight IDs:
curl -X POST http://localhost:8720/api/generate-script \
  -H "Content-Type: application/json" \
  -d '{"highlight_ids": ["uuid1", "uuid2", "uuid3"]}'

# Test the video script generator standalone (uses sample data):
cd backend && python agent.py
```

There is no automated test suite yet. For backend changes, add `pytest` tests under `backend/tests/test_*.py`. For frontend changes, manually verify EPUB import, highlighting, note editing, sync badge behavior, and API sync.

All run methods use port 8720. The backend mounts `frontend/` as static files at `/` — visiting `http://localhost:8720` in a browser serves the PWA automatically.

## Architecture

```
frontend/          PWA Reader (vanilla JS + epub.js CDN + IndexedDB)
  app.js           IIFE; DOM refs at top; IndexedDB stores: books, highlights
                   API_BASE is '' (same-origin) — backend must serve the frontend
  sw.js            Cache-first for app shell/CDN; network-first for /api/*
  index.html       Declares all views (library, reader, selection toolbar, modal, toast)
  manifest.json    PWA manifest (zh-CN, standalone display)
  style.css        4 highlight colors, responsive (mobile slide-over notes panel)

backend/           FastAPI (Python 3.12+)
  main.py          App + routes: /health, POST/GET /api/highlights, POST /api/generate-script
                   Sync is fire-and-forget to Feishu (doesn't block response)
                   Mounts frontend/ as static files at / (so backend serves the PWA)
  models.py        Pydantic schemas: HighlightCreate, Highlight, SyncRequest/Response,
                   ScriptRequest (highlight_ids, optional book_title), ScriptResponse
  database.py      aiosqlite — init_db, save_highlights, get_all/by_ids, mark_feishu_synced
                   Tags stored as JSON string in SQLite; parsed back to list on read
  agent.py         Video script generator — "editing-first, shooting-second" approach
                   Output: Hook (3-5s) + Body (40-55s) + CTA (5-10s)
                   Scores highlights (notes > tags > length), spreads across book
                   Estimates duration from Chinese speech rate (~4 chars/sec)
  feishu.py        Feishu custom bot webhook (interactive card v2, 10 highlights/card cap)
                   Returns bool; fire-and-forget from main.py
  config.py        Settings from env vars with sensible defaults (cors_origins, webhook URLs)
  Dockerfile       python:3.12-slim, uvicorn on port 8720

scripts/           generate_from_feishu.sh — WIP, uses sample data (lark-cli not yet wired)
docs/              ARCHITECTURE.md (data flow diagram, design decisions), FEISHU_SETUP.md
```

## Data Flow

1. User imports EPUB → blob stored in IndexedDB (`books` store, `file_blob` field)
2. User selects text → epub.js fires `selected` event with CFI range → floating toolbar appears
3. User picks color → `rendition.annotations.highlight()` + IndexedDB write (`highlights` store)
4. User clicks Sync → batch `POST /api/highlights` → SQLite insert → fire-and-forget to Feishu webhook
5. User triggers `POST /api/generate-script` → `agent.py` produces structured video outline

## Key Design Decisions

- **IndexedDB over localStorage**: EPUB blobs can be 10MB+
- **epub.js via CDN over npm**: No build step; Service Worker caches for offline
- **SQLite (aiosqlite) over PostgreSQL**: Zero setup for MVP
- **Feishu webhook over Bitable**: Immediate validation, no OAuth needed
- **Manual sync over auto**: User controls when data leaves the device
- **Fire-and-forget Feishu**: Sync response stays fast; Feishu failures don't block
- **No authentication**: MVP scope
- **Backend serves frontend**: `StaticFiles` mount at `/` means one server, one origin — no CORS issues for local use; `API_BASE = ''` in app.js works because frontend and API share an origin

## Environment

Copy `.env.example` to `.env` and set `FEISHU_WEBHOOK_URL` for Feishu integration. The frontend uses `API_BASE = ''` (same-origin requests), so it must be served from the same origin as the API — either via the backend's static file mount or behind a reverse proxy.

Never commit `.env`, `backend/data/` (SQLite databases), or EPUB files.
