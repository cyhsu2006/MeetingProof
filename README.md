# MeetingProof — autonomous coordination, evidence-backed minutes

**Local development prototype · v0.3.0 · 28 October 2026**

## What the local prototype does

The primary workflow is **autonomous meeting coordination after one bounded initial delegation**, not approval of every email. In this prototype every participant, mailbox event, and calendar invitation is **synthetic / MOCK / SIMULATED**. The coordinator is deterministic Python; it does not use an LLM, send real email, read a real inbox, or create a real calendar event.

1. Specify the meeting purpose, duration, allowed time window/timezone, named synthetic attendees, required/optional roles, reminder limit, and preauthorized minutes audience/rule.
2. Authorize that bounded mock workflow once. Availability requests are then automatically prepared in the simulated outbox.
3. Load structured synthetic replies. The engine intersects complete availability for **all required attendees**, prefers slots that also fit optional attendees, and uses earliest UTC as a tie-breaker. It then automatically prepares invitations—no per-email approval.
4. A conflict automatically starts the second/final negotiation round. A second conflict becomes a human exception rather than a fabricated time. Missing required replies schedule due reminder-check jobs. Explicit virtual-clock advancement automatically executes due jobs within the authorized per-person reminder cap; silence never means availability. Jobs never execute before due time, and stale/superseded jobs are cancelled.
5. Cancel or reschedule with versioned commands. Rescheduling must remain inside the immutable original time window; different dates or a wider window require a new delegation. Superseded reply cycles cannot change the new meeting. Repeated request IDs are idempotent, so repeated clicks do not duplicate messages.
6. Inject correlated synthetic RSVP responses. Each response must match the meeting cycle and invitation revision. All required attendees must explicitly accept before completion; missing, tentative or declined responses are never assumed accepted. Optional declines do not block completion. Then mark the mock meeting completed and separately record **actual attendees**. Open **Evidence review from that coordinator**. Explicitly confirm that the supplied transcript belongs to that meeting/cycle: this is manual source association, not automatic identity verification. The server immutably binds the new review run to the meeting ID, cycle, round and exact transcript hash. Then confirm/edit/reject evidence cards and export approved minutes.
7. Return to Coordination, select the approved minutes record, and attach it. The engine automatically prepares minutes messages for the **initially authorized audience**, or its intersection with actual attendees when `attended_only` was delegated. No new recipient can be introduced by a reply or minutes command. Only records bound to this same meeting/cycle/round/source are eligible; unbound, other-meeting and stale records are rejected without mock delivery. Existing review runs cannot be rebound.

Invited attendees, RSVP responses, actual attendees, and minutes recipients remain distinct in the UI and downloadable coordination audit. All times are normalized to UTC internally; the delegated IANA timezone controls display. Candidate starts are on a 15-minute UTC grid. Adjacent/overlapping availability intervals are merged.

The existing v0.1 post-meeting workflow remains available at `/review`: synthetic/manual transcript → offline fixture or separately gated cloud adapter → exact evidence cards → human review → JSON/text export. **Live OpenAI access is still unverified and disabled by default.**

**Not implemented:** real mail/calendar integrations, real reply monitoring, a wall-clock scheduler daemon, natural-language reply parsing, ASR/audio recording, actual speaker identification, camera/PTZ control, or hardware inference. UGen300 is a future Stage II plan, not a verified capability. This repository publishes only the competition prototype source; publishing it does not submit a competition entry.

## Run locally

Requires Python 3.11+ and the packages in `requirements.txt`. Development used Python 3.12, FastAPI 0.141.1, Uvicorn 0.52.1, Pydantic 2.13.4, and HTTPX 0.28.1; all were already present. No dependency installation was needed for the recorded checks.

```bash
cd MeetingProof
# If needed in your own environment: python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log
```

Open `http://127.0.0.1:8000` for **Coordination**. Use the synthetic template, check the single bounded-delegation authorization, and start. Load matching replies to see automatic slot selection and mock invitations. Inject **All accept** RSVP replies (or individual correlated synthetic responses) before recording actual attendance, then use its contextual **Evidence review** link to create confirmed minutes and check the explicit manual source-binding confirmation. Exporting JSON or text registers those approved minutes and their immutable meeting/source binding in the same server session; return to Coordination, refresh approved records, and attach one for automatic simulated distribution.

For the original evidence-only demonstration, open `http://127.0.0.1:8000/review`, click **Run sample demo**, review cards, then export. No key is needed for either offline workflow. Standalone `/review` exports remain unbound and cannot be attached for distribution; reopen review through the target coordinator and create a new explicitly bound run instead.

The checked-in `package.json` provides a `dev` command on port 3000 only for the managed internal preview tool. It is not a deployment configuration. For ordinary local use, prefer the loopback command above. Do not expose this unauthenticated development server publicly.

## Truthful mode boundaries

### Offline fixture demo — no network inference

- Always works without an API key.
- Uses prewritten `fixture.json` results for the **exact, unchanged** `sample.json` input, including its title.
- An edited or imported transcript is rejected in this mode. It does not pretend to analyze arbitrary text.
- The synthetic sample deliberately contrasts a tentative Friday proposal with Ben's later Monday commitment, leaves a privacy-check deadline unknown, and includes an action with an unknown speaker/owner.
- Every card still goes through evidence validation and human review.

### OpenAI cloud mode — opt-in, never a silent fallback

The adapter uses the OpenAI **Responses API** and `text.format` with a strict JSON schema. The key stays on the server and is never returned to the browser. There is no automatic model selection or fallback.

Cloud calls are disabled by default. Before enabling them, confirm that the selected OpenAI organization/project, billing, and data-sharing authorization are appropriate. The local credential file is `.env.local`; it must remain private and excluded from source bundles.

Set server environment variables after authorization:

- `MEETINGPROOF_CLOUD_ENABLED=1` — explicit cloud enablement gate.
- `OPENAI_MODEL` — an **account-available** model supporting Responses Structured Outputs; no model availability is assumed.
- `OPENAI_API_KEY` — server environment or the approved `.env.local` file.

The app does **not read `.env.local` while the cloud gate is disabled**. It only accepts `OPENAI_API_KEY` and `OPENAI_MODEL` from that file; it never evaluates shell syntax. File symlinks are ignored. Do not place a key into browser code, chat, screenshots, or source control.

The current low-cost recommendation (not account-verified) is `gpt-6-luna`, for which this adapter explicitly uses `reasoning.effort: none` and `service_tier: default`. The [official model page](https://developers.openai.com/api/docs/models/gpt-6-luna) lists Responses/Structured Outputs support and standard short-context pricing of $0.10 input / $0.50 output per million tokens as checked on 28 October 2026. A conservative 12K-input-token / 4K-output-token estimate is about $0.0032 per attempt, before any applicable surcharges; the bounded three-attempt demonstration is expected to remain below $0.02. This is an estimate, not a billing guarantee. No model calls have been authorized merely by this recommendation.

The UI reports configuration separately from verification. Missing configuration, network errors, unsupported/unavailable models, refusals, invalid evidence, and incomplete outputs are explicit failures. They do not trigger an offline fallback, automatic retries, or partial cards. A maximum of one cloud extraction may run at a time. Each request has a 60-second timeout and a 4,000-output-token cap. A persistent, non-secret `.runtime/cloud_attempts.json` counter permits at most **three attempted cloud calls**, including failures, across server restarts. There are no automatic retries. The cloud payload is capped at 12,000 serialized UTF-8 bytes. The unchanged synthetic sample is the only permitted cloud input by default; an operator must explicitly authorize custom data before setting `MEETINGPROOF_ALLOW_CUSTOM_CLOUD=1`. Do not reset the attempt counter without new budget authorization. Billing and account usage limits must be managed in the authorized OpenAI project.

**Data boundary:** cloud mode transmits the supplied title, speaker labels, timestamps, and transcript text to OpenAI. Do not use confidential recordings without the required permission. The request sets `store: false`; that is not a claim that all provider retention is disabled. Consult the project's actual data controls.

Official implementation references checked on 28 October 2026:

- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Responses API](https://developers.openai.com/api/reference/resources/responses)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

## Transcript format

`sample.json` is the canonical example. Uploads are limited to 100,000 bytes, with at most 120 segments and 30,000 total text characters. Server requests are capped at 120,000 bytes; large audit exports may hit this cap and need a shorter transcript. Segment IDs are unique; segments must be ordered by start time. Overlapping times and `speaker: null` are allowed. Timestamps are numeric seconds and each end must be at or after its start. Unknown speaker names must not be invented.

```json
{
  "title": "Synthetic sample",
  "segments": [
    {"id":"s01","start":12,"end":20,"speaker":"Ava","text":"Perhaps Friday, but this is not confirmed."},
    {"id":"s02","start":24,"end":33,"speaker":"Ben","text":"I will prepare the draft. I can commit to Monday."}
  ]
}
```

The UI also accepts one line per timestamp:

```text
[00:12] Ava: Perhaps Friday, but this is not confirmed.
[00:24] Ben: I will prepare the draft. I can commit to Monday.
[00:54] ?: We should check the privacy notice.
```

Pasted timestamps are point observations (`end = start`); no duration is inferred. English UI supports Chinese transcript content. Relative dates remain literal words (for example, `Monday`) unless the source establishes an actual calendar date.

## Evidence and human-review guarantees

- Every card requires one or more existing source segment IDs and nonempty **exact contiguous quote substrings**.
- Dangling IDs, paraphrased evidence, missing evidence, invented owner names, or deadlines not verbatim in a cited quote are rejected before cards are created.
- These are mechanical checks, not proof that the model interpreted the conversation correctly. The model can still make a semantic mistake; a human must review it.
- Tentative proposals are not decisions. Unknown owners/deadlines are `null`, not guessed values.
- Supplied transcripts are untrusted data, not instructions. The extraction request has no tools and cannot trigger external actions.
- Summary, kind, owner, deadline, and notes can be human-edited. Original extraction and source evidence cannot be overwritten through export.
- Editing a confirmed card requires confirmation again. Confirming a proposal means “reviewed as a proposal,” not “adopted as a decision.”
- JSON contains confirmed items, all review statuses, original extractions, exact source transcript, source SHA-256, and `human_edited_fields`. Text exports contain only confirmed review items, retain kind labels, show evidence, and disclose human edits.
- Exports are downloads to the browser's device. The application does not send them anywhere.
- Coordinator-bound review runs have immutable server-side meeting ID / cycle / round / source-hash provenance. Source association is a human assertion, not proof that a transcript actually belongs to the meeting. Distribution rejects wrong or missing bindings; it never silently rebinds a prior run.

## State and privacy

No database, analytics, external fonts, cookies, or browser localStorage are used. The v0.3 virtual clock, reminder jobs and RSVP records are also temporary in-memory state, not durable background automation. Unexported review state is held in the current tab. The coordination engine holds up to 20 synthetic meetings, their mock inbox/outbox, and audit events in server memory until restart; this is not durable delivery. Each coordination permits at most 120 state-changing commands. Export your audit before restarting. Approved minutes records are held alongside their review runs and are removed when those runs expire or disappear. The backend retains up to 30 recent original extractions in memory to validate export provenance; they expire after two hours, are pruned on subsequent run/export requests, and disappear on server restart. Closing the tab does not immediately purge the server's in-memory originals. Do not present this as production-grade multi-user access control.

Source files are served through an allowlist; `.env.local`, Python files, and fixture files are not served as static assets. Cross-origin POSTs are rejected, inputs are bounded, and browser content is rendered as text. This is defense-in-depth for a **single-user local prototype**, not a production security certification.

## Tests and verification

```bash
cd MeetingProof
python -m unittest discover -s tests -v
node --check static/app.js
node --check static/coordination.js
python -m py_compile app.py coordinator.py devserver.py
```

The unit/integration suite is intentionally network-free. It disables the cloud gate and mocks the cloud boundary; a passing test is **not proof of live API access**. Run the checks above to verify your local environment.

## Files

- `app.py` — FastAPI server, evidence validator, cloud adapter, review/export provenance checks, approved-minutes bridge.
- `coordinator.py` — bounded deterministic coordination state machine and synthetic mail/calendar ledger, with no network client.
- `static/` — buildless responsive browser UI.
- `sample.json`, `fixture.json` — labelled synthetic scenario and deterministic fixture.
- `tests/test_app.py`, `tests/test_coordinator.py` — network-free regression, lifecycle, conflict, reminder, cancellation/reschedule, authorization, dedupe, and recipient-boundary tests.
- `.gitignore` — excludes secrets, logs, dependencies, and generated exports.

## Before a future public or multi-user release

Add authentication/authorization, isolated user sessions, deliberate retention/deletion controls, CSRF/session policy, robust deployment secret management, model evaluations on consented data, monitored rate/cost controls, and deployment security review. Audio transcription, hardware input, camera control, and UGen300 inference each require their own implementation and validation. This prototype does not imply those milestones are complete.

## Coordinator API and boundaries

- `GET /api/coordination/template` supplies the canonical synthetic delegation.
- `POST /api/coordination` starts one bounded mock delegation. Only `.example` email addresses are accepted.
- Every mutating command carries `version` and a unique `request_id`. Stale versions fail with 409; repeated identical IDs return the current state without repeating side effects.
- `POST /api/coordination/{id}/reply` accepts structured slots from one initially delegated attendee, with the current `cycle` and `round`. The `message` field is display-only data and cannot add recipients, change sharing, or alter meeting constraints.
- `/simulate` supplies matching/conflicting/no-response fixtures; `/reminder` simulates the next reminder interval. These controls inject synthetic events, not approvals for individual messages.
- `/rsvp` accepts accepted/declined/tentative structured synthetic responses with attendee_id, current cycle and invitation_revision. `/simulate-rsvp` provides all_accept, decline_required and tentative_required fixtures. Responses do not set actual attendance.
- `/clock` advances a per-meeting virtual clock by 1–1440 minutes and executes all due eligible reminder-check jobs within a bounded loop. `/reminder` is a convenience advance to the next due job, not a direct send or real-time wait. Initial reminder_interval_minutes is 15–1440 (default 60).
- `/cancel`, `/reschedule`, `/complete`, and `/minutes` implement explicit lifecycle transitions. Completed meetings cannot be rescheduled or cancelled retroactively.
- `GET /api/coordination/{id}/audit` downloads the synthetic lifecycle ledger. All outbox entries have `status: SIMULATED_NOT_SENT`.
- A maximum of two negotiation rounds is fixed. The chosen reminder cap is per required person per cycle, across both rounds. An explicit reschedule starts a new cycle but cannot expand the original authorized time window. The window is the scheduling boundary, not a wall-clock expiry. The virtual clock is advanced explicitly; the in-memory due-job runner automatically processes eligible jobs. No wall-clock/background daemon or natural-language reply parser is implemented. Invitation acceptance tracking is now implemented for synthetic correlated RSVP events, not a real mailbox/calendar.
- Custom attendees must still use reserved `.example` addresses. There is no real identity or email verification, delivery receipt, authentication, persistent state, or multi-user isolation.

Before connecting real providers, add recipient resolution/verification, authenticated calendar/mail scopes, a durable event/queue/outbox with provider idempotency, delivery and reply correlation, real clocks, consent/retention policy, exception notifications, and authority validation. Approval for this simulator is **not** permission to send real messages or connect a real mailbox/calendar.

## v0.2.1 safety correction

The earlier v0.2 prototype allowed any confirmed review run to be manually selected for a meeting. v0.2.1 closes that cross-meeting distribution gap with explicit manual source binding before extraction, immutable server provenance, filtered approved-record listings, and no-mail rejection of mismatched or stale bindings. This is not automatic meeting/source identity recognition. Real integrations remain disabled and unimplemented.

## v0.3 bounded additions

- **RSVP correlation:** mock invitation records carry meeting ID, cycle, invitation revision and attendee ID. Unknown senders and stale revisions/cycles are rejected. Required missing/declined/tentative responses block completion; the operator may inject a later accepted response or explicitly reschedule/cancel. Optional RSVP does not override required constraints. Actual attendance remains a separate post-meeting observation.
- **Virtual-clock jobs:** one due reminder-check job is scheduled for an active availability round. Advancing the virtual clock runs due jobs automatically, schedules the next bounded check, and escalates at the reminder cap. Replies that complete matching cancel outstanding availability jobs. Conflict round changes, cancellation and rescheduling invalidate superseded jobs. Duplicate clock commands do not repeat messages or advance twice.
- This is **not** real-time inbox monitoring, a durable worker/queue, a running wall-clock daemon, natural-language parsing, or an external mail/calendar service. RSVP reminders are not implemented; the due-job policy covers missing availability replies.
- `FEATURE_CATALOG.md` separates the complete target service from what this release actually implements or simulates.
