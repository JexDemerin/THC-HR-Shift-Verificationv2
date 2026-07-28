import requests

from . import config
from .models import LogRow


def post_rows(rows: list[LogRow], webapp_url: str = None) -> dict:
    """POST the scanned rows to the Apps Script Web App, which appends them to the log tab."""
    url = webapp_url or config.SHEETS_WEBAPP_URL
    payload = {"rows": [row.to_dict() for row in rows]}
    response = requests.post(url, json=payload, timeout=30)
    response.raise_for_status()
    return response.json()
