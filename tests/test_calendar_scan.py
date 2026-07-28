from datetime import date

from screen_bot.calendar_scan import filter_past_dates
from screen_bot.models import ShiftCell


def make_shift(d, color="green"):
    return ShiftCell(
        caregiver_name="Barberi, Miku",
        client_name="Kozuka-Ssenyan, Mia",
        date=d,
        status_color=color,
        click_x=100,
        click_y=200,
    )


def test_filter_past_dates_drops_today_and_future():
    today = date(2026, 7, 28)
    shifts = [
        make_shift("2026-07-27"),  # past -> kept
        make_shift("2026-07-28"),  # today -> dropped
        make_shift("2026-07-29"),  # future -> dropped
    ]

    result = filter_past_dates(shifts, today=today)

    assert [s.date for s in result] == ["2026-07-27"]


def test_filter_past_dates_keeps_multiple_past_days():
    today = date(2026, 7, 28)
    shifts = [make_shift("2026-07-25"), make_shift("2026-07-26"), make_shift("2026-07-27")]

    result = filter_past_dates(shifts, today=today)

    assert len(result) == 3
