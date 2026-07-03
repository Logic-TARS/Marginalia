# Repository Guidelines

## Project Structure & Module Organization

Marginalia is a small FastAPI plus static PWA project.

- `backend/` contains the Python API, persistence, Feishu integration, and script agent logic. `main.py` defines routes, `database.py` handles SQLite access, `models.py` owns Pydantic schemas, and `config.py` reads environment settings.
- `frontend/` contains the browser reader PWA: `index.html`, `style.css`, `app.js`, `sw.js`, and `manifest.json`.
- `docs/` stores architecture and Feishu setup notes.
- `scripts/` contains utility scripts such as Feishu-to-agent workflows.
- Runtime data belongs under `backend/data/` and is ignored by Git.

## Build, Test, and Development Commands

- `cd backend && pip install -r requirements.txt` installs Python dependencies.
- `cd backend && uvicorn main:app --reload` runs the API at `http://localhost:8000`.
- `docker compose up --build` runs the backend container with hot reload and a persistent data volume.
- Open `frontend/index.html` directly in a browser to run the PWA. The frontend expects the API at `http://localhost:8000`.
- `codegraph status` verifies the local CodeGraph index; use `codegraph sync` after larger code changes.

## Coding Style & Naming Conventions

Python uses 4-space indentation, type hints where useful, async route handlers, and snake_case for functions and variables. Keep API request and response shapes in `models.py`. JavaScript uses an IIFE, `const`/`let`, 2-space indentation, camelCase functions, and DOM references grouped near the top of `frontend/app.js`. Keep user-facing strings consistent with the existing Chinese UI.

## Testing Guidelines

No automated test suite is currently configured. For backend changes, add focused `pytest` tests under a future `backend/tests/` directory and name files `test_*.py`. For frontend changes, manually verify EPUB import, highlighting, note editing, sync badge behavior, and API sync against a running backend.

## Commit & Pull Request Guidelines

This checkout does not include Git history, so no repository-specific commit convention can be inferred. Use concise imperative commits such as `Add highlight sync validation`. Pull requests should include a short summary, manual test notes, linked issues when relevant, and screenshots or screen recordings for visible frontend changes.

## Security & Configuration Tips

Copy `.env.example` to `.env` for local secrets. Do not commit `.env`, Feishu webhook URLs, app secrets, generated SQLite databases, EPUB files, or local CodeGraph database contents.
