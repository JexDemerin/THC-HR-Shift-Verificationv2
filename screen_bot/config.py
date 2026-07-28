import os

from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
SHEETS_WEBAPP_URL = os.environ.get("SHEETS_WEBAPP_URL")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5")


def require_config():
    missing = []
    if not ANTHROPIC_API_KEY:
        missing.append("ANTHROPIC_API_KEY")
    if not SHEETS_WEBAPP_URL:
        missing.append("SHEETS_WEBAPP_URL")
    if missing:
        raise RuntimeError(
            "Missing required config: " + ", ".join(missing) + ". Copy .env.example to .env and fill it in."
        )
