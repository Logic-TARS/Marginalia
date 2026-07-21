"""Server-side EPUB books — scan and serve from backend/data/books/."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

from fastapi import HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger("marginalia.books")

BOOKS_DIR = Path(__file__).parent / "data" / "books"
BOOKS_DIR.mkdir(parents=True, exist_ok=True)

# EPUB MIME type for FileResponse
EPUB_MIME = "application/epub+zip"


def _extract_epub_meta(filepath: Path) -> dict[str, str]:
    """Extract title and author from an EPUB file. Falls back to filename."""
    title = filepath.stem
    author = ""

    try:
        with ZipFile(filepath, "r") as zf:
            # Step 1: read META-INF/container.xml to find OPF path
            container_xml = zf.read("META-INF/container.xml")
            container = ElementTree.fromstring(container_xml)

            # Find the rootfile element (namespace-aware)
            opf_path = None
            for rf in container.iter():
                if rf.tag.endswith("rootfile"):
                    opf_path = rf.attrib.get("full-path", "")
                    break

            if not opf_path:
                return {"title": title, "author": author, "filename": filepath.name}

            # Step 2: read OPF and extract Dublin Core metadata
            opf_data = zf.read(opf_path)
            # EPUB OPF uses these namespaces
            namespaces = {
                "dc": "http://purl.org/dc/elements/1.1/",
                "opf": "http://www.idpf.org/2007/opf",
            }

            # Strip namespaces for ElementTree (it handles them poorly)
            opf_text = opf_data.decode("utf-8", errors="replace")
            # Simple regex extraction as fallback — reliable across namespace variants
            title_match = re.search(
                r"<dc:title[^>]*>(.*?)</dc:title>", opf_text, re.DOTALL
            )
            creator_match = re.search(
                r"<dc:creator[^>]*>(.*?)</dc:creator>", opf_text, re.DOTALL
            )

            if title_match:
                title = title_match.group(1).strip()
            if creator_match:
                author = creator_match.group(1).strip()

    except Exception as e:
        logger.warning(f"Failed to extract metadata from {filepath.name}: {e}")

    return {"title": title, "author": author, "filename": filepath.name}


def list_books() -> list[dict]:
    """Scan the books directory and return metadata for all EPUBs found."""
    books = []
    if not BOOKS_DIR.is_dir():
        return books

    for f in sorted(BOOKS_DIR.iterdir()):
        if f.suffix.lower() == ".epub":
            books.append(_extract_epub_meta(f))

    return books


def serve_book(filename: str) -> FileResponse:
    """Serve an EPUB file from the books directory."""
    filepath = BOOKS_DIR / filename

    # Security: prevent path traversal
    filepath = filepath.resolve()
    if not str(filepath).startswith(str(BOOKS_DIR.resolve())):
        raise HTTPException(status_code=403, detail="Forbidden")

    if not filepath.is_file():
        raise HTTPException(status_code=404, detail="Book not found")

    return FileResponse(
        path=str(filepath),
        media_type=EPUB_MIME,
        filename=filename,
    )
