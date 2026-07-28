from dataclasses import dataclass
from typing import Optional


@dataclass
class ShiftCell:
    caregiver_name: str
    client_name: str
    date: str  # ISO YYYY-MM-DD
    status_color: str  # green | red | yellow | blue | orange | gray | other
    click_x: int
    click_y: int


@dataclass
class LogRow:
    date: str
    caregiver_name: str
    client_name: str
    status: str
    official_start: Optional[str] = None
    official_end: Optional[str] = None
    actual_clock_in: Optional[str] = None
    scheduled_clock_in: Optional[str] = None
    actual_clock_out: Optional[str] = None
    scheduled_clock_out: Optional[str] = None
    bill_hours: Optional[str] = None
    pay_hours: Optional[str] = None

    def to_dict(self):
        return {
            "date": self.date,
            "caregiver_name": self.caregiver_name,
            "client_name": self.client_name,
            "status": self.status,
            "official_start": self.official_start or "",
            "official_end": self.official_end or "",
            "actual_clock_in": self.actual_clock_in or "",
            "scheduled_clock_in": self.scheduled_clock_in or "",
            "actual_clock_out": self.actual_clock_out or "",
            "scheduled_clock_out": self.scheduled_clock_out or "",
            "bill_hours": self.bill_hours or "",
            "pay_hours": self.pay_hours or "",
        }
