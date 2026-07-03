"""Application configuration loaded from environment variables."""

import os
from pathlib import Path


class Settings:
    """Settings with defaults, reads from .env via os.environ."""

    # Database
    database_url: str = os.getenv(
        "DATABASE_URL",
        f"sqlite+aiosqlite:///{Path(__file__).parent / 'data' / 'marginalia.db'}"
    )

    # Feishu webhook (MVP)
    feishu_webhook_url: str = os.getenv("FEISHU_WEBHOOK_URL", "")

    # Feishu app (future Bitable integration)
    feishu_app_id: str = os.getenv("FEISHU_APP_ID", "")
    feishu_app_secret: str = os.getenv("FEISHU_APP_SECRET", "")
    feishu_base_token: str = os.getenv("FEISHU_BASE_TOKEN", "")
    feishu_table_id: str = os.getenv("FEISHU_TABLE_ID", "")

    # CORS
    cors_origins: str = os.getenv("CORS_ORIGINS", "*")

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",")]


settings = Settings()
