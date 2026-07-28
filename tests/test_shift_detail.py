from unittest.mock import patch

from screen_bot.models import ShiftCell
from screen_bot.shift_detail import build_missed_shift_row, extract_green_shift

GREEN_SHIFT = ShiftCell(
    caregiver_name="Barberi, Miku",
    client_name="Kozuka-Ssenyan, Mia",
    date="2026-07-27",
    status_color="green",
    click_x=482,
    click_y=560,
)

RED_SHIFT = ShiftCell(
    caregiver_name="Amato, Savani",
    client_name="Joyner, Yusuf",
    date="2026-07-27",
    status_color="red",
    click_x=305,
    click_y=402,
)


def fake_ask_structured(image_path, prompt, tool_name, schema):
    if tool_name == "report_summary_popup":
        return {"edit_link": {"x": 700, "y": 300}}
    if tool_name == "report_edit_care_log":
        return {
            "status": "Complete",
            "official_start": "07/27/2026 09:00 AM",
            "official_end": "07/27/2026 04:00 PM",
            "bill_hours": "7",
            "pay_hours": "7",
            "client_name": "Kozuka-Ssenyan, Mia",
            "caregiver_name": "Barberi, Miku",
            "actual_start_link": {"x": 210, "y": 240},
            "scheduled_start_link": {"x": 260, "y": 240},
            "actual_end_link": {"x": 410, "y": 240},
            "scheduled_end_link": {"x": 460, "y": 240},
            "close_button": {"x": 900, "y": 150},
        }
    if tool_name == "report_tooltip":
        # distinguish which hover this is by inspecting the image path label baked in by capture_region
        if "actual_in" in image_path:
            return {"tooltip_text": "07/27/2026 01:35:33 PM"}
        if "scheduled_in" in image_path:
            return {"tooltip_text": "07/27/2026 09:00:00 AM"}
        if "actual_out" in image_path:
            return {"tooltip_text": "07/27/2026 04:00:00 PM"}
        if "scheduled_out" in image_path:
            return {"tooltip_text": "07/27/2026 04:00:00 PM"}
    raise AssertionError(f"unexpected tool_name {tool_name}")


@patch("screen_bot.shift_detail.mouse.hover")
@patch("screen_bot.shift_detail.mouse.click")
@patch("screen_bot.shift_detail.capture.capture_region", side_effect=lambda run_id, label, x, y, width, height: label)
@patch("screen_bot.shift_detail.capture.capture_full_screen", side_effect=lambda run_id, label: label)
@patch("screen_bot.shift_detail.vision.ask_structured", side_effect=fake_ask_structured)
def test_extract_green_shift_reads_all_four_time_fields(mock_ask, mock_full, mock_region, mock_click, mock_hover):
    row = extract_green_shift("run1", GREEN_SHIFT)

    assert row.status == "Complete"
    assert row.official_start == "07/27/2026 09:00 AM"
    assert row.official_end == "07/27/2026 04:00 PM"
    assert row.actual_clock_in == "07/27/2026 01:35:33 PM"
    assert row.scheduled_clock_in == "07/27/2026 09:00:00 AM"
    assert row.actual_clock_out == "07/27/2026 04:00:00 PM"
    assert row.scheduled_clock_out == "07/27/2026 04:00:00 PM"
    assert row.bill_hours == "7"
    assert row.pay_hours == "7"

    # Never clicks Save -- only ever the dialog's close button.
    clicked_points = [call.args for call in mock_click.call_args_list]
    assert (900, 150) in clicked_points


def test_build_missed_shift_row_is_zero_hours_no_click():
    row = build_missed_shift_row(RED_SHIFT)

    assert row.status == "Missed Clock-in/out"
    assert row.bill_hours == "0"
    assert row.pay_hours == "0"
    assert row.official_start is None
    assert row.actual_clock_in is None
