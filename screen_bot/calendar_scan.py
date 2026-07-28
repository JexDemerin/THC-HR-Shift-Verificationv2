from datetime import date

from . import vision
from .models import ShiftCell

SHIFTS_TOOL = "report_shifts"

SHIFTS_SCHEMA = {
    "type": "object",
    "properties": {
        "shifts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "caregiver_name": {
                        "type": "string",
                        "description": "Name from the left-hand caregiver column for this shift's row",
                    },
                    "client_name": {
                        "type": "string",
                        "description": "Name shown inside the colored shift label",
                    },
                    "date": {
                        "type": "string",
                        "description": "ISO date YYYY-MM-DD for this shift's day column, using the year/month visible on screen",
                    },
                    "status_color": {
                        "type": "string",
                        "enum": ["green", "red", "yellow", "blue", "orange", "gray", "other"],
                        "description": (
                            "green=Completed, red=Missed Clock-in/out, yellow=In Progress, "
                            "blue=Scheduled/upcoming, orange/gray=Cancelled variants, other=anything else"
                        ),
                    },
                    "click_x": {
                        "type": "integer",
                        "description": "Pixel x coordinate of the center of this shift's colored label, in this screenshot",
                    },
                    "click_y": {
                        "type": "integer",
                        "description": "Pixel y coordinate of the center of this shift's colored label, in this screenshot",
                    },
                },
                "required": ["caregiver_name", "client_name", "date", "status_color", "click_x", "click_y"],
            },
        }
    },
    "required": ["shifts"],
}

PROMPT = (
    "This is a screenshot of the WellSky weekly caregiver schedule. Each row is one caregiver "
    "(left-hand column). Each colored label in a day's column is one shift for that caregiver, "
    "and the client's name is printed inside the label. Report every visible shift cell: caregiver "
    "name, client name, the shift's date (use the day-column header plus the year/month shown at "
    "the top of the page), its status color, and the approximate pixel coordinates of the center of "
    "that colored label so it can be clicked later. Do not skip any visible shift."
)


def scan_calendar(image_path: str) -> list[ShiftCell]:
    result = vision.ask_structured(image_path, PROMPT, SHIFTS_TOOL, SHIFTS_SCHEMA)
    return [ShiftCell(**s) for s in result["shifts"]]


def filter_past_dates(shifts: list[ShiftCell], today: date = None) -> list[ShiftCell]:
    """Drop any shift whose date is today or later -- only fully-elapsed days get scanned."""
    if today is None:
        today = date.today()
    past = []
    for shift in shifts:
        shift_date = date.fromisoformat(shift.date)
        if shift_date < today:
            past.append(shift)
    return past
