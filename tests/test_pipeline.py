from unittest.mock import patch

from screen_bot.models import LogRow, ShiftCell
from screen_bot.pipeline import run

GREEN = ShiftCell("Barberi, Miku", "Kozuka-Ssenyan, Mia", "2026-07-27", "green", 482, 560)
RED = ShiftCell("Amato, Savani", "Joyner, Yusuf", "2026-07-27", "red", 305, 402)
FUTURE_BLUE = ShiftCell("Afu, Ilisapeti", "Dawit, Naomi", "2026-07-29", "blue", 480, 300)


@patch("screen_bot.pipeline.sheets_client.post_rows")
@patch("screen_bot.pipeline.shift_detail.build_missed_shift_row")
@patch("screen_bot.pipeline.shift_detail.extract_green_shift")
@patch("screen_bot.pipeline.calendar_scan.scan_calendar")
@patch("screen_bot.pipeline.capture.capture_full_screen", return_value="fake.png")
def test_run_dry_run_skips_future_and_branches_by_color(
    mock_capture, mock_scan, mock_extract_green, mock_build_missed, mock_post
):
    mock_scan.return_value = [GREEN, RED, FUTURE_BLUE]
    mock_extract_green.return_value = LogRow(date="2026-07-27", caregiver_name="Barberi, Miku",
                                              client_name="Kozuka-Ssenyan, Mia", status="Complete")
    mock_build_missed.return_value = LogRow(date="2026-07-27", caregiver_name="Amato, Savani",
                                             client_name="Joyner, Yusuf", status="Missed Clock-in/out",
                                             bill_hours="0", pay_hours="0")

    rows = run(confirm_each=False, dry_run=True)

    assert mock_extract_green.call_args[0][1] is GREEN
    mock_build_missed.assert_called_once_with(RED)
    mock_post.assert_not_called()  # dry run never writes to the Sheet
    assert len(rows) == 2
    assert {r.status for r in rows} == {"Complete", "Missed Clock-in/out"}


@patch("screen_bot.pipeline.sheets_client.post_rows")
@patch("screen_bot.pipeline.shift_detail.build_missed_shift_row")
@patch("screen_bot.pipeline.shift_detail.extract_green_shift")
@patch("screen_bot.pipeline.calendar_scan.scan_calendar")
@patch("screen_bot.pipeline.capture.capture_full_screen", return_value="fake.png")
def test_run_writes_to_sheet_when_not_dry_run(
    mock_capture, mock_scan, mock_extract_green, mock_build_missed, mock_post
):
    mock_scan.return_value = [RED]
    mock_build_missed.return_value = LogRow(date="2026-07-27", caregiver_name="Amato, Savani",
                                             client_name="Joyner, Yusuf", status="Missed Clock-in/out",
                                             bill_hours="0", pay_hours="0")

    run(confirm_each=False, dry_run=False)

    mock_post.assert_called_once()
