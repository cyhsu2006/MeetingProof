"""Deterministic, synthetic-only autonomous meeting coordination state machine.

This module has no mail/calendar/network client and cannot send external messages.
"""
from __future__ import annotations
import copy
import hashlib
import json
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

router = APIRouter(prefix="/api/coordination", tags=["mock-coordination"])
STATES: dict[str, dict] = {}
CREATE_KEYS: dict[str, tuple[str, str]] = {}
LOCK = threading.RLock()
MAX_STATES = 20
MAX_ROUNDS = 2


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def instant(value: str) -> datetime:
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None or date.utcoffset() is None or not 2020 <= date.year <= 2100:
            raise ValueError()
        return date.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Use an ISO timestamp with an explicit UTC offset (2020–2100).") from None


def stamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Person(Strict):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,30}$")
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(min_length=5, max_length=150)
    required: bool

    @field_validator("email")
    @classmethod
    def synthetic_only(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.example", value):
            raise ValueError("Use synthetic .example addresses only. Real email addresses are not permitted in this simulator.")
        return value

    @field_validator("name")
    @classmethod
    def name_nonempty(cls, value):
        if not value.strip():
            raise ValueError("Name cannot be blank.")
        return value.strip()


class Slot(Strict):
    start: str
    end: str

    @field_validator("start", "end")
    @classmethod
    def normalize_time(cls, value):
        return stamp(instant(value))

    @model_validator(mode="after")
    def positive(self):
        if instant(self.end) <= instant(self.start):
            raise ValueError("Slot end must follow its start.")
        return self


class Delegation(Strict):
    purpose: str = Field(min_length=1, max_length=180)
    duration_minutes: int = Field(ge=15, le=120)
    timezone: str = Field(min_length=1, max_length=80)
    window_start: str
    window_end: str
    attendees: list[Person] = Field(min_length=2, max_length=8)
    max_reminders: int = Field(ge=0, le=2)
    reminder_interval_minutes: int = Field(default=60, ge=15, le=1440)
    minutes_audience_ids: list[str] = Field(min_length=1, max_length=8)
    minutes_rule: Literal["authorized_audience", "attended_only"]
    authorize_autonomous: bool

    @field_validator("purpose")
    @classmethod
    def purpose_nonempty(cls, value):
        if not value.strip():
            raise ValueError("Purpose cannot be blank.")
        return value.strip()

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Choose a valid IANA timezone.") from None
        return value

    @field_validator("window_start", "window_end")
    @classmethod
    def normalize_time(cls, value):
        return stamp(instant(value))

    @model_validator(mode="after")
    def bounded_delegation(self):
        start, end = instant(self.window_start), instant(self.window_end)
        if end - start < timedelta(minutes=self.duration_minutes) or end - start > timedelta(days=7):
            raise ValueError("Window must fit the meeting and be no longer than seven days.")
        if self.duration_minutes % 15:
            raise ValueError("Duration must be a multiple of 15 minutes.")
        ids, emails = [p.id for p in self.attendees], [p.email for p in self.attendees]
        if len(set(ids)) != len(ids) or len(set(emails)) != len(emails):
            raise ValueError("Attendee IDs and email addresses must be unique.")
        if not any(p.required for p in self.attendees):
            raise ValueError("At least one attendee must be required.")
        if len(set(self.minutes_audience_ids)) != len(self.minutes_audience_ids) or not set(self.minutes_audience_ids) <= set(ids):
            raise ValueError("Minutes audience must be a unique subset of the initially delegated attendees.")
        if not self.authorize_autonomous:
            raise ValueError("Authorize this bounded MOCK workflow before starting. No real messages are sent.")
        return self


class Create(Delegation):
    request_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")


class Command(Strict):
    version: int = Field(ge=1)
    request_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")


class Simulate(Command):
    scenario: Literal["matching", "conflict", "no_response"]


class Reply(Command):
    attendee_id: str = Field(max_length=30)
    cycle: int = Field(ge=1)
    round: int = Field(ge=1, le=MAX_ROUNDS)
    slots: list[Slot] = Field(max_length=12)
    message: str = Field(max_length=2000, default="Synthetic availability reply.")


class Reschedule(Command):
    window_start: str
    window_end: str

    @field_validator("window_start", "window_end")
    @classmethod
    def normalize_time(cls, value):
        return stamp(instant(value))


class Complete(Command):
    attended_ids: list[str] = Field(max_length=8)


class AdvanceClock(Command):
    advance_minutes: int = Field(ge=1, le=1440)


class RSVP(Command):
    attendee_id: str = Field(max_length=30)
    cycle: int = Field(ge=1)
    invitation_revision: int = Field(ge=1)
    status: Literal["accepted", "declined", "tentative"]
    message: str = Field(default="Synthetic RSVP response.", max_length=2000)


class SimulateRSVP(Command):
    scenario: Literal["all_accept", "decline_required", "tentative_required"]


class Minutes(Command):
    review_run_id: str = Field(min_length=1, max_length=60)


def public(state):
    return copy.deepcopy({k: v for k, v in state.items() if not k.startswith("_")})


def event(state, kind, message):
    state["events"].append({"id": f"e{len(state['events']) + 1:03d}", "kind": kind, "message": message, "created_at": now(), "virtual_at": state.get("virtual_now")})


def person(state, person_id):
    return next((p for p in state["delegation"]["attendees"] if p["id"] == person_id), None)


def mock_mail(state, kind, target, subject, body, *, attachment=None, unique="", correlation=None):
    mail_key = f"{kind}:c{state['cycle']}:r{state['round']}:{target['id']}:{unique}"
    if any(m["dedupe_key"] == mail_key for m in state["outbox"]):
        return
    state["outbox"].append({"id": f"m{len(state['outbox']) + 1:03d}", "kind": kind,
        "to_id": target["id"], "to_email": target["email"], "to_name": target["name"],
        "subject": subject, "body": body, "status": "SIMULATED_NOT_SENT", "cycle": state["cycle"],
        "round": state["round"], "created_at": now(), "virtual_at": state.get("virtual_now"), "attachment": attachment, "dedupe_key": mail_key, "correlation": correlation})


def cancel_jobs(state, reason):
    for job in state["jobs"]:
        if job["status"] == "scheduled":
            job["status"] = "cancelled"
            job["reason"] = reason


def schedule_reminder_job(state):
    if state["status"] != "collecting":
        return
    if any(j["status"] == "scheduled" and j["cycle"] == state["cycle"] and j["round"] == state["round"] for j in state["jobs"]):
        return
    due = instant(state["virtual_now"]) + timedelta(minutes=state["delegation"]["reminder_interval_minutes"])
    state["jobs"].append({"id": f"j{len(state['jobs'])+1:03d}", "kind": "availability_reminder_check",
        "status": "scheduled", "cycle": state["cycle"], "round": state["round"], "due_at": stamp(due),
        "executed_at": None, "reason": "Awaiting the delegated virtual reminder interval."})


def request_availability(state, reason="Initial bounded delegation"):
    cancel_jobs(state, "Superseded availability request cycle/round.")
    d = state["delegation"]
    for target in d["attendees"]:
        mock_mail(state, "availability_request", target, f"Availability: {d['purpose']}",
                  f"MOCK ONLY — {reason}. Please supply structured availability within {d['window_start']} to {d['window_end']} (display timezone {d['timezone']}); duration {d['duration_minutes']} minutes. Cycle {state['cycle']}, round {state['round']}. Replies cannot change recipients or delegation bounds.")
    event(state, "availability_requested", f"Prepared {len(d['attendees'])} simulated availability requests automatically (cycle {state['cycle']}, round {state['round']}).")
    schedule_reminder_job(state)


def missing_required(state):
    replied = {r["attendee_id"] for r in state["availability"]}
    return [p for p in state["delegation"]["attendees"] if p["required"] and p["id"] not in replied]


def candidate_slots(state):
    """Quarter-hour grid; all required must contain the complete interval.

    Optional attendance is a preference. Sort by optional count, then earliest UTC.
    """
    d = state["delegation"]
    def merged(raw):
        result = []
        for begin, finish in sorted((instant(s["start"]), instant(s["end"])) for s in raw):
            if result and begin <= result[-1][1]:
                result[-1] = (result[-1][0], max(result[-1][1], finish))
            else:
                result.append((begin, finish))
        return result
    available = {r["attendee_id"]: merged(r["slots"]) for r in state["availability"]}
    required = [p["id"] for p in d["attendees"] if p["required"]]
    optional = [p["id"] for p in d["attendees"] if not p["required"]]
    if any(pid not in available for pid in required):
        return []
    begin, limit = instant(d["window_start"]), instant(d["window_end"])
    epoch = int(begin.timestamp())
    start = datetime.fromtimestamp(((epoch + 899) // 900) * 900, timezone.utc)
    duration = timedelta(minutes=d["duration_minutes"])
    slots = []
    while start + duration <= limit:
        end = start + duration
        fits = lambda pid: any(a <= start and end <= b for a, b in available.get(pid, []))
        if all(fits(pid) for pid in required):
            opt = [pid for pid in optional if fits(pid)]
            slots.append({"start": stamp(start), "end": stamp(end), "optional_available_ids": opt})
        start += timedelta(minutes=15)
    slots.sort(key=lambda s: (-len(s["optional_available_ids"]), s["start"]))
    return slots[:8]


def decide(state):
    if missing_required(state):
        return
    slots = candidate_slots(state)
    state["candidate_slots"] = slots
    if not slots:
        if state["round"] < MAX_ROUNDS:
            state["round"] += 1
            state["availability"] = []
            event(state, "conflict", "No full-duration overlap for all required attendees. Automatically starting the final negotiation round within the same authorized window.")
            request_availability(state, "Second-round request after conflicting required availability")
        else:
            state["status"] = "exception"
            cancel_jobs(state, "Negotiation exhausted; no further reminder jobs may run.")
            state["exception"] = "No common slot after two rounds. Human decision required; no invitation was created."
            event(state, "exception", state["exception"])
        return
    chosen = slots[0]
    state["selected_slot"] = chosen
    state["status"] = "scheduled"
    cancel_jobs(state, "Required availability received and invitation prepared.")
    state["invitation_revision"] += 1
    state["rsvps"] = []
    state["rsvp_attention"] = [p["id"] for p in state["delegation"]["attendees"] if p["required"]]
    state["invited_ids"] = [p["id"] for p in state["delegation"]["attendees"]]
    event(state, "slot_selected", f"Selected {chosen['start']}–{chosen['end']}: all required attendees fit; {len(chosen['optional_available_ids'])} optional attendee(s) fit. Earliest UTC breaks ties.")
    for target in state["delegation"]["attendees"]:
        mock_mail(state, "invitation", target, f"Meeting invitation: {state['delegation']['purpose']}",
                  f"MOCK INVITATION — {chosen['start']} to {chosen['end']}. Display timezone: {state['delegation']['timezone']}. No external calendar event exists. RSVP must reference this exact cycle and invitation revision.",
                  correlation={"coordination_id":state["id"],"cycle":state["cycle"],"invitation_revision":state["invitation_revision"],"attendee_id":target["id"]})
    event(state, "invitation_prepared", "Prepared the authorized invitations automatically, with no per-email approval step. No actual mail or calendar action occurred.")


def accept_reply(state, attendee_id, slots, message, cycle, round_number):
    if state["status"] != "collecting":
        raise HTTPException(409, "Availability is not being collected for this state.")
    if cycle != state["cycle"] or round_number != state["round"]:
        raise HTTPException(409, "Stale reply cycle/round rejected. Use the current availability request.")
    if not person(state, attendee_id):
        raise HTTPException(422, "Unknown sender. Replies cannot add attendees or recipients.")
    d = state["delegation"]
    for slot in slots:
        if instant(slot["start"]) < instant(d["window_start"]) or instant(slot["end"]) > instant(d["window_end"]):
            raise HTTPException(422, "Reply slot is outside the authorized meeting window.")
    state["availability"] = [r for r in state["availability"] if r["attendee_id"] != attendee_id]
    state["availability"].append({"attendee_id": attendee_id, "cycle": cycle, "round": round_number, "slots": slots})
    state["inbox"].append({"id": f"r{len(state['inbox']) + 1:03d}", "attendee_id": attendee_id,
        "message": message, "slots": slots, "cycle": cycle, "round": round_number, "created_at": now()})
    event(state, "reply_received", f"Accepted structured availability from {person(state, attendee_id)['name']}. Message text was treated as data, not authority.")
    decide(state)


def mutate(coordinator_id, command: Command, operation, action):
    with LOCK:
        state = STATES.get(coordinator_id)
        if not state:
            raise HTTPException(404, "Coordination not found. This local simulator clears state on restart.")
        digest = fingerprint({"operation": operation, "body": command.model_dump()})
        previous = state["_processed"].get(command.request_id)
        if previous:
            if previous != digest:
                raise HTTPException(409, "Request ID was already used for different content.")
            response = public(state)
            response["idempotent_replay"] = True
            return response
        if command.version != state["version"]:
            raise HTTPException(409, "State changed. Refresh this coordination before retrying; stale action rejected.")
        if len(state["_processed"]) >= 120:
            raise HTTPException(429, "This bounded demo has reached 120 commands. Start a new synthetic coordination.")
        backup = copy.deepcopy(state)
        try:
            action(state)
        except Exception:
            STATES[coordinator_id] = backup
            raise
        state["version"] += 1
        state["_processed"][command.request_id] = digest
        return public(state)


@router.get("/template")
def template():
    return {"mode": "MOCK", "delegation": {"purpose": "Synthetic product design review", "duration_minutes": 30,
        "timezone": "Asia/Taipei", "window_start": "2026-10-29T01:00:00Z", "window_end": "2026-10-29T09:00:00Z",
        "attendees": [{"id": "ava", "name": "Ava (synthetic)", "email": "ava@demo.example", "required": True},
                      {"id": "ben", "name": "Ben (synthetic)", "email": "ben@demo.example", "required": True},
                      {"id": "chloe", "name": "Chloe (synthetic)", "email": "chloe@demo.example", "required": False}],
        "max_reminders": 2, "reminder_interval_minutes": 60, "minutes_audience_ids": ["ava", "ben", "chloe"], "minutes_rule": "authorized_audience", "authorize_autonomous": True},
        "limits": {"max_attendees": 8, "max_rounds": MAX_ROUNDS, "max_reminders": 2, "max_window_days": 7, "max_clock_advance_minutes": 1440},
        "notice": "Deterministic synthetic simulator. No LLM, actual email, external calendar, or real attendee information is used."}


@router.get("")
def list_coordinations():
    with LOCK:
        return {"coordinations": [{"id": s["id"], "purpose": s["delegation"]["purpose"], "status": s["status"], "version": s["version"]} for s in reversed(list(STATES.values()))]}


@router.post("")
def create(body: Create):
    with LOCK:
        delegation = body.model_dump(exclude={"request_id"})
        digest = fingerprint(delegation)
        if body.request_id in CREATE_KEYS:
            old_digest, existing_id = CREATE_KEYS[body.request_id]
            if digest != old_digest:
                raise HTTPException(409, "Creation request ID reused for different delegation.")
            return public(STATES[existing_id])
        if len(STATES) >= MAX_STATES:
            raise HTTPException(429, "The local simulator holds at most 20 coordinations. Export audits before restarting to clear state.")
        cid = uuid.uuid4().hex
        state = {"id": cid, "version": 1, "mode": "MOCK", "status": "collecting", "cycle": 1, "round": 1,
                 "delegation": delegation, "authorization_window": {"start": delegation["window_start"], "end": delegation["window_end"]},
                 "virtual_now": now(), "jobs": [], "invitation_revision": 0, "rsvps": [], "rsvp_attention": [],
                 "availability": [], "outbox": [], "inbox": [], "events": [],
                 "selected_slot": None, "candidate_slots": [], "invited_ids": [], "attended_ids": [], "minutes_recipient_ids": [],
                 "reminder_counts": {p["id"]: 0 for p in delegation["attendees"]}, "exception": None, "approved_minutes": None, "_processed": {}}
        event(state, "delegated", "Bounded autonomous MOCK delegation accepted. All recipients and minutes rules were fixed before any simulated messages.")
        request_availability(state)
        STATES[cid] = state
        CREATE_KEYS[body.request_id] = (digest, cid)
        return public(state)


@router.get("/{coordinator_id}")
def get_state(coordinator_id: str):
    with LOCK:
        if coordinator_id not in STATES:
            raise HTTPException(404, "Coordination not found; local state clears on server restart.")
        return public(STATES[coordinator_id])


@router.post("/{coordinator_id}/reply")
def reply(coordinator_id: str, body: Reply):
    return mutate(coordinator_id, body, "reply", lambda s: accept_reply(s, body.attendee_id, [x.model_dump() for x in body.slots], body.message, body.cycle, body.round))


@router.post("/{coordinator_id}/simulate")
def simulate(coordinator_id: str, body: Simulate):
    def action(state):
        if state["status"] != "collecting":
            raise HTTPException(409, "Reply fixtures require an active collection round.")
        if body.scenario == "no_response":
            event(state, "no_response_fixture", "SIMULATION: no attendee replies have arrived. Use the reminder-interval control to advance the bounded reminder policy.")
            return
        d = state["delegation"]
        start, end = instant(d["window_start"]), instant(d["window_end"])
        duration = timedelta(minutes=d["duration_minutes"])
        people = sorted(d["attendees"], key=lambda p: p["required"])  # optional first, required last triggers choice
        required = [p for p in people if p["required"]]
        if body.scenario == "conflict" and len(required) < 2:
            raise HTTPException(422, "Conflict fixture needs at least two required attendees.")
        cycle, round_number = state["cycle"], state["round"]
        for target in people:
            if body.scenario == "matching":
                slots = [{"start": stamp(start), "end": stamp(end)}]
            else:
                # One required person offers only the early interval; the others only the late interval.
                if end - start < duration * 2:
                    slots = [] if target["id"] == required[0]["id"] else [{"start": stamp(start), "end": stamp(end)}]
                elif target["id"] == required[0]["id"]:
                    slots = [{"start": stamp(start), "end": stamp(start + duration)}]
                else:
                    slots = [{"start": stamp(end - duration), "end": stamp(end)}]
            accept_reply(state, target["id"], slots, f"SIMULATED {body.scenario} structured reply. No email was received from a real person.", cycle, round_number)
    return mutate(coordinator_id, body, "simulate", action)


def run_reminder_policy(state):
    missing = missing_required(state)
    if not missing:
        decide(state)
        return
    exhausted = [p for p in missing if state["reminder_counts"][p["id"]] >= state["delegation"]["max_reminders"]]
    if exhausted:
        state["status"] = "exception"
        state["exception"] = "Reminder limit reached without required replies: " + ", ".join(p["name"] for p in exhausted) + ". No time was assumed and no invitation was created."
        cancel_jobs(state, "Reminder budget exhausted.")
        event(state, "exception", state["exception"])
        return
    for target in missing:
        count = state["reminder_counts"][target["id"]] + 1
        state["reminder_counts"][target["id"]] = count
        mock_mail(state, "reminder", target, f"Availability reminder {count}", "MOCK ONLY — please reply to the current request. Silence does not count as availability.", unique=str(count))
    event(state, "reminder", f"A due virtual-clock job automatically prepared {len(missing)} reminders within the delegated per-person/per-cycle cap.")
    schedule_reminder_job(state)


def advance_virtual_clock(state, target):
    if target <= instant(state["virtual_now"]):
        raise HTTPException(422, "Virtual clock must move forward.")
    for _ in range(10):  # Max two reminders + exhaustion; defensive work bound.
        due = sorted((j for j in state["jobs"] if j["status"] == "scheduled" and instant(j["due_at"]) <= target), key=lambda j:j["due_at"])
        if not due:
            break
        job = due[0]
        if state["status"] != "collecting" or job["cycle"] != state["cycle"] or job["round"] != state["round"]:
            job["status"] = "cancelled"; job["reason"] = "Stale lifecycle correlation."
            continue
        state["virtual_now"] = job["due_at"]
        job["status"] = "executed"; job["executed_at"] = state["virtual_now"]; job["reason"] = "Executed once by the explicit virtual-clock driver."
        event(state, "job_executed", f"Executed {job['id']} for cycle {job['cycle']}, round {job['round']}; no wall-clock daemon or real delivery.")
        run_reminder_policy(state)
    state["virtual_now"] = stamp(target)
    event(state, "clock_advanced", "Virtual clock advanced. Due jobs executed automatically; no real time was waited and no external action occurred.")


@router.post("/{coordinator_id}/clock")
def clock(coordinator_id: str, body: AdvanceClock):
    return mutate(coordinator_id, body, "clock", lambda s: advance_virtual_clock(s, instant(s["virtual_now"]) + timedelta(minutes=body.advance_minutes)))


@router.post("/{coordinator_id}/reminder")
def reminder(coordinator_id: str, body: Command):
    def action(state):
        pending = [j for j in state["jobs"] if j["status"] == "scheduled" and j["cycle"] == state["cycle"] and j["round"] == state["round"]]
        if state["status"] != "collecting" or not pending:
            raise HTTPException(409, "No active availability reminder job. No reminder was sent.")
        advance_virtual_clock(state, min(instant(j["due_at"]) for j in pending))
    return mutate(coordinator_id, body, "reminder", action)


def accept_rsvp(state, attendee_id, status, message, cycle, invitation_revision):
    if state["status"] != "scheduled":
        raise HTTPException(409, "RSVP applies only to a current scheduled invitation.")
    if cycle != state["cycle"] or invitation_revision != state["invitation_revision"]:
        raise HTTPException(409, "Stale RSVP cycle/invitation revision rejected.")
    if attendee_id not in state["invited_ids"]:
        raise HTTPException(422, "RSVP sender is not an invited synthetic attendee.")
    state["rsvps"] = [r for r in state["rsvps"] if r["attendee_id"] != attendee_id]
    state["rsvps"].append({"attendee_id":attendee_id,"status":status,"cycle":cycle,"invitation_revision":invitation_revision,"received_at":now(),"virtual_at":state["virtual_now"],"message":message})
    accepted = {r["attendee_id"] for r in state["rsvps"] if r["status"] == "accepted"}
    state["rsvp_attention"] = [p["id"] for p in state["delegation"]["attendees"] if p["required"] and p["id"] not in accepted]
    event(state, "rsvp_received", f"SIMULATED {status} RSVP from {person(state,attendee_id)['name']} for invitation revision {invitation_revision}. RSVP does not imply actual attendance; message text cannot change authorization.")


@router.post("/{coordinator_id}/rsvp")
def rsvp(coordinator_id: str, body: RSVP):
    return mutate(coordinator_id,body,"rsvp",lambda s:accept_rsvp(s,body.attendee_id,body.status,body.message,body.cycle,body.invitation_revision))


@router.post("/{coordinator_id}/simulate-rsvp")
def simulate_rsvp(coordinator_id: str, body: SimulateRSVP):
    def action(state):
        if state["status"] != "scheduled":
            raise HTTPException(409, "RSVP fixtures need a current scheduled invitation.")
        required = [p for p in state["delegation"]["attendees"] if p["required"]]
        targets = state["delegation"]["attendees"] if body.scenario == "all_accept" else required[:1]
        status = {"all_accept":"accepted","decline_required":"declined","tentative_required":"tentative"}[body.scenario]
        for target in targets:
            accept_rsvp(state,target["id"],status,"Synthetic structured RSVP fixture; not a received email.",state["cycle"],state["invitation_revision"])
    return mutate(coordinator_id,body,"simulate-rsvp",action)


@router.post("/{coordinator_id}/cancel")
def cancel(coordinator_id: str, body: Command):
    def action(state):
        if state["status"] == "cancelled":
            return
        if state["status"] in {"completed", "minutes_distributed"}:
            raise HTTPException(409, "The meeting is already completed. Past invitations or distributed mock minutes cannot be retracted by cancellation.")
        for target in state["delegation"]["attendees"]:
            mock_mail(state, "cancellation", target, "Coordination cancelled", "MOCK ONLY — the current availability request and any invitation are cancelled. Old replies will no longer be accepted.")
        state["status"] = "cancelled"
        cancel_jobs(state, "Workflow cancelled; old jobs cannot execute.")
        state["selected_slot"] = None
        state["candidate_slots"] = []
        state["availability"] = []
        state["rsvps"] = []
        state["rsvp_attention"] = []
        state["cycle"] += 1
        event(state, "cancelled", "Cancelled the current cycle and invalidated its replies. No external messages were sent.")
    return mutate(coordinator_id, body, "cancel", action)


@router.post("/{coordinator_id}/reschedule")
def reschedule(coordinator_id: str, body: Reschedule):
    def action(state):
        if state["status"] in {"completed", "minutes_distributed"}:
            raise HTTPException(409, "Completed meetings cannot be rescheduled. Start a new delegation.")
        boundary = state["authorization_window"]
        if instant(body.window_start) < instant(boundary["start"]) or instant(body.window_end) > instant(boundary["end"]):
            raise HTTPException(422, "Rescheduling must stay inside the original authorized window. Start a new delegation to authorize different dates or a wider window.")
        candidate = {**state["delegation"], "window_start": body.window_start, "window_end": body.window_end}
        try:
            validated = Delegation.model_validate(candidate)
        except ValueError:
            raise HTTPException(422, "New window must fit the meeting and remain within seven days.") from None
        if state["selected_slot"]:
            for target in state["delegation"]["attendees"]:
                mock_mail(state, "reschedule_cancellation", target, "Prior mock invitation superseded", "MOCK ONLY — the old slot is invalid. A new availability round follows.")
        state["delegation"] = validated.model_dump()
        state["cycle"] += 1
        state["round"] = 1
        state["status"] = "collecting"
        state["availability"] = []
        state["selected_slot"] = None
        state["candidate_slots"] = []
        state["invited_ids"] = []
        state["attended_ids"] = []
        state["minutes_recipient_ids"] = []
        state["approved_minutes"] = None
        state["rsvps"] = []
        state["rsvp_attention"] = []
        state["exception"] = None
        state["reminder_counts"] = {p["id"]: 0 for p in state["delegation"]["attendees"]}
        event(state, "rescheduled", "A search window inside the original authorization started a fresh cycle; prior replies, slot, attendance, and minutes are invalidated. Original time bounds and recipients remain unchanged.")
        request_availability(state, "Reschedule: reply to this fresh cycle, not the superseded request")
    return mutate(coordinator_id, body, "reschedule", action)


@router.post("/{coordinator_id}/complete")
def complete(coordinator_id: str, body: Complete):
    def action(state):
        if state["status"] != "scheduled":
            raise HTTPException(409, "Only a scheduled mock meeting can be marked completed.")
        if state["rsvp_attention"]:
            raise HTTPException(409, "Required attendees have not all accepted this current invitation. Record their correlated RSVPs or explicitly reschedule/cancel; silence and tentative replies are not acceptance.")
        if len(set(body.attended_ids)) != len(body.attended_ids) or not set(body.attended_ids) <= set(state["invited_ids"]):
            raise HTTPException(422, "Actual attendance must be a unique subset of the invited attendees. It never expands the minutes audience.")
        state["attended_ids"] = body.attended_ids
        state["status"] = "completed"
        event(state, "completed", f"Marked the synthetic meeting completed with {len(body.attended_ids)} actual attendees. Invitations and attendance remain separate records.")
    return mutate(coordinator_id, body, "complete", action)


def bind_review_source(context: dict, transcript_hash: str):
    """One-time human source association for a new run; never infer meeting identity."""
    with LOCK:
        state = STATES.get(context["coordination_id"])
        if not state:
            raise HTTPException(404, "Source-binding meeting not found. Return to the current coordinator.")
        if not context.get("manual_source_confirmed"):
            raise HTTPException(422, "Explicitly confirm that this supplied transcript belongs to this meeting/cycle. This is manual source binding, not automatic identity verification.")
        if state["status"] not in {"scheduled", "completed"}:
            raise HTTPException(409, "Bind review sources only to a scheduled or completed meeting, before minutes distribution.")
        if context["cycle"] != state["cycle"] or context["round"] != state["round"]:
            raise HTTPException(409, "Stale source-binding cycle/round. Open Evidence review from the current coordinator again.")
        return {"coordination_id": state["id"], "cycle": state["cycle"], "round": state["round"],
                "source_hash": transcript_hash, "method": "manual_source_confirmation"}


def review_matches(state: dict, approved: dict):
    binding = approved.get("review_binding")
    return bool(binding and binding.get("coordination_id") == state["id"]
                and binding.get("cycle") == state["cycle"] and binding.get("round") == state["round"]
                and binding.get("method") == "manual_source_confirmation"
                and binding.get("source_hash") == approved.get("provenance", {}).get("source_hash"))


def distribute_minutes(coordinator_id: str, body: Minutes, approved: dict):
    def action(state):
        if state["status"] != "completed":
            raise HTTPException(409, "Complete the meeting and record actual attendance before distributing minutes.")
        if not review_matches(state, approved):
            raise HTTPException(422, "Minutes are unbound or belong to another meeting, cycle, round, or source. Open Evidence review from this coordinator and manually confirm the correct source; existing runs cannot be rebound.")
        if not approved.get("confirmed_items"):
            raise HTTPException(422, "At least one human-confirmed minutes item is required.")
        audience = state["delegation"]["minutes_audience_ids"]
        if state["delegation"]["minutes_rule"] == "attended_only":
            audience = [pid for pid in audience if pid in state["attended_ids"]]
        if not audience:
            raise HTTPException(422, "No actual attendees are in the preauthorized minutes audience. No messages were prepared; sharing was not expanded.")
        metadata = {"run_id": body.review_run_id, "title": approved["title"], "confirmed_count": len(approved["confirmed_items"]), "source_hash": approved["provenance"]["source_hash"], "review_binding": copy.deepcopy(approved["review_binding"])}
        state["approved_minutes"] = metadata
        state["minutes_recipient_ids"] = audience
        for pid in audience:
            mock_mail(state, "minutes", person(state, pid), f"Reviewed minutes: {state['delegation']['purpose']}",
                      "MOCK ONLY — automatically prepared under the initial minutes-sharing delegation. Only human-confirmed review items are attached. No external email was sent.",
                      attachment={**metadata, "confirmed_items": copy.deepcopy(approved["confirmed_items"])})
        state["status"] = "minutes_distributed"
        event(state, "minutes_distributed", f"Automatically prepared reviewed minutes for {len(audience)} preauthorized recipients. No per-email approval and no audience expansion; all delivery is simulated.")
    return mutate(coordinator_id, body, "minutes", action)


@router.get("/{coordinator_id}/audit")
def audit(coordinator_id: str):
    state = get_state(coordinator_id)
    return Response(json.dumps(state, ensure_ascii=False, indent=2), media_type="application/json", headers={"Content-Disposition": 'attachment; filename="meetingproof-mock-coordination-audit.json"'})
