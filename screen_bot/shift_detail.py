from . import capture, mouse, vision
from .models import LogRow, ShiftCell

POINT_SCHEMA = {
    "type": "object",
    "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}},
    "required": ["x", "y"],
}

SUMMARY_POPUP_TOOL = "report_summary_popup"
SUMMARY_POPUP_SCHEMA = {
    "type": "object",
    "properties": {"edit_link": POINT_SCHEMA},
    "required": ["edit_link"],
}
SUMMARY_POPUP_PROMPT = (
    "A shift summary popup is open over the WellSky schedule (it has a Care Log row with "
    "Summary / Notes / Edit / Copy / Delete links near the top). Report the pixel coordinates "
    "of the center of the 'Edit' link."
)

EDIT_CARE_LOG_TOOL = "report_edit_care_log"
EDIT_CARE_LOG_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string"},
        "official_start": {"type": "string", "description": "The date+time shown in the Official start field"},
        "official_end": {"type": "string", "description": "The date+time shown in the Official end field"},
        "bill_hours": {"type": "string"},
        "pay_hours": {"type": "string"},
        "client_name": {"type": "string"},
        "caregiver_name": {"type": "string"},
        "actual_start_link": POINT_SCHEMA,
        "scheduled_start_link": POINT_SCHEMA,
        "actual_end_link": POINT_SCHEMA,
        "scheduled_end_link": POINT_SCHEMA,
        "close_button": {**POINT_SCHEMA, "description": "The X (close) button in the top-right of this dialog -- NOT Save"},
    },
    "required": [
        "status",
        "official_start",
        "official_end",
        "bill_hours",
        "pay_hours",
        "client_name",
        "caregiver_name",
        "actual_start_link",
        "scheduled_start_link",
        "actual_end_link",
        "scheduled_end_link",
        "close_button",
    ],
}
EDIT_CARE_LOG_PROMPT = (
    "The 'Edit Care Log' dialog is open. It has a Status dropdown, an 'Official' row with a start "
    "date/time and an end date/time (each with 'Set to: Actual | Scheduled' links beneath it), "
    "Bill Hours and Pay Hours fields, and Client/Caregiver dropdowns. Report: the Status value, the "
    "Official start and end values exactly as shown, Bill Hours, Pay Hours, the selected Client and "
    "Caregiver names, the pixel coordinates of the 'Actual' link under the start time, the 'Scheduled' "
    "link under the start time, the 'Actual' link under the end time, the 'Scheduled' link under the "
    "end time, and the dialog's close (X) button -- never the Save button."
)

TOOLTIP_TOOL = "report_tooltip"
TOOLTIP_SCHEMA = {
    "type": "object",
    "properties": {"tooltip_text": {"type": "string", "description": "The exact date/time text shown in the tooltip"}},
    "required": ["tooltip_text"],
}
TOOLTIP_PROMPT = (
    "A small tooltip is showing a date and time (e.g. '07/27/2026 01:35:33 PM'). Report its exact text."
)


def _read_tooltip(run_id: str, label: str, x: int, y: int) -> str:
    shot = capture.capture_region(run_id, label, x, y, width=350, height=150)
    result = vision.ask_structured(shot, TOOLTIP_PROMPT, TOOLTIP_TOOL, TOOLTIP_SCHEMA)
    return result["tooltip_text"]


def extract_green_shift(run_id: str, shift: ShiftCell) -> LogRow:
    """Click a completed (green) shift through to its Edit Care Log form and read every field.

    Never clicks Save -- only ever closes via the dialog's X/close button, since this is a
    read-only inspection pass.
    """
    mouse.click(shift.click_x, shift.click_y)
    summary_shot = capture.capture_full_screen(run_id, "summary_popup")
    summary = vision.ask_structured(summary_shot, SUMMARY_POPUP_PROMPT, SUMMARY_POPUP_TOOL, SUMMARY_POPUP_SCHEMA)

    edit_link = summary["edit_link"]
    mouse.click(edit_link["x"], edit_link["y"])
    edit_shot = capture.capture_full_screen(run_id, "edit_care_log")
    edit = vision.ask_structured(edit_shot, EDIT_CARE_LOG_PROMPT, EDIT_CARE_LOG_TOOL, EDIT_CARE_LOG_SCHEMA)

    mouse.hover(edit["actual_start_link"]["x"], edit["actual_start_link"]["y"])
    actual_in = _read_tooltip(run_id, "actual_in", edit["actual_start_link"]["x"], edit["actual_start_link"]["y"])

    mouse.hover(edit["scheduled_start_link"]["x"], edit["scheduled_start_link"]["y"])
    scheduled_in = _read_tooltip(
        run_id, "scheduled_in", edit["scheduled_start_link"]["x"], edit["scheduled_start_link"]["y"]
    )

    mouse.hover(edit["actual_end_link"]["x"], edit["actual_end_link"]["y"])
    actual_out = _read_tooltip(run_id, "actual_out", edit["actual_end_link"]["x"], edit["actual_end_link"]["y"])

    mouse.hover(edit["scheduled_end_link"]["x"], edit["scheduled_end_link"]["y"])
    scheduled_out = _read_tooltip(
        run_id, "scheduled_out", edit["scheduled_end_link"]["x"], edit["scheduled_end_link"]["y"]
    )

    close = edit["close_button"]
    mouse.click(close["x"], close["y"])

    return LogRow(
        date=shift.date,
        caregiver_name=edit["caregiver_name"] or shift.caregiver_name,
        client_name=edit["client_name"] or shift.client_name,
        status=edit["status"],
        official_start=edit["official_start"],
        official_end=edit["official_end"],
        actual_clock_in=actual_in,
        scheduled_clock_in=scheduled_in,
        actual_clock_out=actual_out,
        scheduled_clock_out=scheduled_out,
        bill_hours=edit["bill_hours"],
        pay_hours=edit["pay_hours"],
    )


def build_missed_shift_row(shift: ShiftCell) -> LogRow:
    """Red (Missed Clock-in/out) shifts are never clicked -- just logged as zero hours."""
    return LogRow(
        date=shift.date,
        caregiver_name=shift.caregiver_name,
        client_name=shift.client_name,
        status="Missed Clock-in/out",
        bill_hours="0",
        pay_hours="0",
    )
