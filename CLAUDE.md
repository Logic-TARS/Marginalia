# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

Marginalia is a local-first reading and creation workflow: **EPUB highlights -> Backend API -> Notes Library -> Scripts, Drafts, and Obsidian exports**. A browser PWA lets users read EPUBs, create color-coded highlights with inline notes/tags, and sync them to a FastAPI/SQLite backend.

## Commands

```bash
# Backend: install deps and run with hot reload (default port 8720)
cd backend && pip install -r requirements.txt && uvicorn main:app --reload --port 8720

# Run via python __main__ (same thing, port 8720)
cd backend && python main.py

# Docker Compose (hot reload + persistent data volume, port 8720)
docker compose up --build

# Backend tests
cd backend && pytest

# Frontend Playwright tests
cd frontend && npm test
```

All run methods use port 8720. The backend mounts `frontend/` as static files at `/`, so visiting `http://localhost:8720` serves the PWA automatically.

## Architecture

```text
frontend/          PWA Reader (vanilla JS + epub.js + IndexedDB)
  app.js           IIFE; DOM refs near the top; stores books, highlights, bookmarks
                   API_BASE is '' because the backend serves the frontend
  sw.js            Cache-first app shell; network-first API calls
  index.html       Library, reader, creation workspace, modal, toast
  manifest.json    PWA manifest
  style.css        Highlight colors and responsive layout

backend/           FastAPI
  main.py          Routes: health, highlights CRUD, materials, book Q&A,
                   scripts, drafts, Obsidian export, server-side books
  models.py        Pydantic schemas
  database.py      aiosqlite storage for highlights and drafts
  agent.py         Rule-based short-video script generator
  llm.py           OpenAI-compatible client for drafts and book Q&A
  obsidian.py      Markdown export for book materials and drafts
  books_api.py     Server-side EPUB listing and serving
  config.py        Environment configuration
  Dockerfile       python:3.12-slim, uvicorn on port 8720

docs/              Architecture notes
```

## Data Flow

1. User imports EPUB -> blob stored in IndexedDB (`books` store, `file_blob` field).
2. User selects text -> epub.js fires `selected` event with a CFI range.
3. User picks color -> `rendition.annotations.highlight()` renders the highlight and IndexedDB stores it.
4. User edits note/tags -> local highlight material is updated.
5. User clicks Sync -> batch `POST /api/highlights` saves or updates SQLite rows and refreshes `backend/data/notes.json`.
6. User generates a rule-based video script, an LLM draft, asks a book question, or exports to Obsidian.

## Key Design Decisions

- **IndexedDB over localStorage**: EPUB blobs can be 10MB+.
- **Static frontend over build pipeline**: Keeps local deployment simple.
- **SQLite over PostgreSQL**: Zero setup for MVP.
- **Manual sync over auto**: User controls when browser-local reading data is sent to the backend.
- **JSON notes export**: Simple local bridge for automation and backups.
- **Backend serves frontend**: One server, one origin; `API_BASE = ''` works locally.
- **No authentication**: MVP scope; add API key before exposed deployment.

## Environment

Copy `.env.example` to `.env` for local configuration. The frontend uses `API_BASE = ''` (same-origin requests), so it must be served from the same origin as the API, either via the backend static file mount or behind a reverse proxy.

Never commit `.env`, `backend/data/` SQLite databases, EPUB files, LLM API keys, or Obsidian vault contents.
