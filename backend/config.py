"""Application configuration loaded from environment variables."""

import os
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv(Path(__file__).parent / ".env")


def _env_token(name: str, fallback: str = "") -> str:
    """Read an API token without accidentally including an inline annotation."""
    value = os.getenv(name, fallback).strip()
    return value.split(maxsplit=1)[0] if value else ""


class Settings:
    """Settings with defaults, reads from .env via os.environ."""

    # Database
    database_url: str = os.getenv(
        "DATABASE_URL",
        f"sqlite+aiosqlite:///{Path(__file__).parent / 'data' / 'marginalia.db'}"
    )

    # CORS
    cors_origins: str = os.getenv("CORS_ORIGINS", "*")
    allowed_hosts: str = os.getenv(
        "ALLOWED_HOSTS", "localhost,127.0.0.1,testserver"
    )

    # OpenAI-compatible chat endpoint
    llm_base_url: str = os.getenv("LLM_BASE_URL", "").rstrip("/")
    llm_api_key: str = _env_token("LLM_API_KEY")
    llm_model: str = os.getenv("LLM_MODEL", "")

    # OpenAI-compatible embedding endpoint. The LLM_* fallbacks preserve
    # compatibility with deployments that used one endpoint for both jobs.
    embedding_base_url: str = os.getenv(
        "EMBEDDING_BASE_URL", os.getenv("LLM_BASE_URL", "")
    ).rstrip("/")
    embedding_api_key: str = _env_token(
        "EMBEDDING_API_KEY", _env_token("LLM_API_KEY")
    )
    embedding_model: str = os.getenv(
        "EMBEDDING_MODEL", os.getenv("LLM_EMBEDDING_MODEL", "")
    )
    # Deprecated compatibility alias for third-party imports.
    llm_embedding_model: str = embedding_model

    # Knowledge base
    max_epub_upload_mb: int = int(os.getenv("MAX_EPUB_UPLOAD_MB", "90"))

    # Obsidian export
    obsidian_vault_path: str = os.getenv("OBSIDIAN_VAULT_PATH", "")

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins == "*":
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def allowed_host_list(self) -> list[str]:
        return [host.strip() for host in self.allowed_hosts.split(",") if host.strip()]


settings = Settings()
