import time

from . import calendar_scan, capture, sheets_client, shift_detail
from .models import LogRow


def run(confirm_each: bool = True, dry_run: bool = False) -> list[LogRow]:
    """Scan whatever's currently visible in WellSky and log every completed/past-due shift.

    Assumes the user is already logged into WellSky and on the weekly schedule view --
    this bot never logs in and never scrolls/pages on its own.
    """
    run_id = str(int(time.time()))

    print("Taking a screenshot of the current WellSky view...")
    calendar_shot = capture.capture_full_screen(run_id, "calendar")

    print("Reading the calendar (this calls the Claude API)...")
    all_shifts = calendar_scan.scan_calendar(calendar_shot)
    shifts = calendar_scan.filter_past_dates(all_shifts)
    skipped = len(all_shifts) - len(shifts)
    print(f"Found {len(all_shifts)} shifts on screen, {skipped} skipped (today/future), {len(shifts)} to process.")

    rows: list[LogRow] = []
    for shift in shifts:
        if shift.status_color == "green":
            if confirm_each:
                answer = input(
                    f"About to click {shift.caregiver_name} / {shift.client_name} on {shift.date} "
                    f"at ({shift.click_x}, {shift.click_y}). Enter=go, s=skip, q=quit: "
                ).strip().lower()
                if answer == "q":
                    break
                if answer == "s":
                    continue
            print(f"Reading detail for {shift.caregiver_name} / {shift.client_name} ({shift.date})...")
            row = shift_detail.extract_green_shift(run_id, shift)
            rows.append(row)
        elif shift.status_color == "red":
            print(f"Missed clock-in/out: {shift.caregiver_name} / {shift.client_name} ({shift.date}) -> 0 hours.")
            rows.append(shift_detail.build_missed_shift_row(shift))
        else:
            print(f"Skipping {shift.status_color} shift for {shift.caregiver_name} ({shift.date}) -- not in scope yet.")

    print(f"Collected {len(rows)} rows.")
    if dry_run:
        print("Dry run -- not writing to the Sheet. Rows would have been:")
        for row in rows:
            print(row.to_dict())
        return rows

    if rows:
        print("Writing rows to the Sheet...")
        sheets_client.post_rows(rows)
        print("Done.")
    else:
        print("Nothing to write.")

    return rows
