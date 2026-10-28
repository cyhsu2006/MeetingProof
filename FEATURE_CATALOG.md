# MeetingProof — full-service feature catalog and implementation boundary

This catalog describes the target service and the local prototype separately. A working simulation is not a connected production service. The coordinator is a deterministic state machine, not a collection of autonomous LLM agents.

Status definitions:
- **Implemented offline:** functional local logic, with explicit tests; no external provider needed.
- **Simulated integration:** the integration event/message is a synthetic ledger entry, never externally delivered.
- **Development:** code exists but release/browser validation is pending.
- **Planned / not connected:** target behavior not currently operational.

## End-to-end target behavior

The organizer gives one bounded delegation: purpose, participants, required/optional roles, duration, timezone/window, reminder limits and minutes-sharing policy. The service requests availability, correlates responses, resolves valid slots, creates the invitation, tracks responses, manages bounded exceptions, records meeting outcomes, and distributes reviewed minutes to the originally authorized audience. It should not request separate approval for every routine message inside that delegation. Scope changes, unresolved conflicts, uncertain identity/source and out-of-policy actions must pause for an explicit decision.

## Feature-by-feature status

| Function | Target service | Current local implementation |
|---|---|---|
| Delegation | Structured organizer handoff with scope and constraints | Implemented offline: 2–8 synthetic attendees, fixed recipient/audience lists, IANA timezone, duration and original time-window bounds |
| Identity resolution | Resolve named people to verified addresses and organizations | Planned / not connected. Only reserved .example addresses; no real identity verification |
| Availability outreach | Send requests automatically under delegation | Simulated integration: deterministic mock outbox, no SMTP/mailbox access |
| Reply ingestion | Authenticate/correlate incoming real mail/calendar replies | Structured API + synthetic fixtures implemented offline; real provider/webhooks/authentication planned |
| Natural-language parsing | Interpret free-form bilingual replies, clarify ambiguity | Planned. No LLM or free-text availability parser in this release; text is data, never authority |
| Availability validation | Normalize timezones, check full-duration overlap and bounds | Implemented offline: explicit UTC offsets, required intersection, optional preference, adjacent-range merge, earliest-UTC tie-break, 15-minute start grid |
| Calendar conflict checking | Check current calendars and travel/buffer constraints | Planned / not connected. No actual busy/free calendars or travel inference |
| Negotiation | Second round for conflicts, then escalate | Implemented offline: at most two rounds, no guessed availability; messages simulated |
| Reminder policy | Schedule bounded reminders and stop/escalate at limits | v0.3 offline job engine: explicit virtual clock triggers due jobs, cap/dedupe/correlation tested; no wall-clock daemon or durable queue |
| Invitation creation | Create/send a real calendar event with correlation | Simulated integration: mock invite ledger with cycle/revision/attendee correlation |
| RSVP tracking | Accept/decline/tentative, reject stale or unknown replies | v0.3 implemented offline for structured synthetic events; real RSVP provider not connected |
| Required-attendee exceptions | Do not treat silence/tentative/decline as acceptance | v0.3 implemented offline: completion blocked until required acceptance or explicit reschedule/cancel; optional decline does not block |
| Rescheduling | Stay within delegated bounds; supersede earlier invites | Implemented offline: immutable original window, cycle/revision invalidation, mock supersession messages; wider dates require new delegation |
| Cancellation | Cancel active workflow and invalidate late events | Implemented offline + simulated messages; completed/distributed meetings cannot be retroactively cancelled |
| Meeting capture | Obtain consent, record/transcribe live audio | Planned. No microphone/recording/ASR pipeline |
| Transcript input | Load timestamped meeting content | Implemented offline: JSON paste/import and timestamped lines, bounded size/schema; bilingual source text |
| AI extraction | Extract decisions/actions with structured output | Server adapter implemented but live API disabled/unverified. Offline sample is pre-authored fixture, never presented as AI |
| Evidence linkage | Trace every candidate to exact source IDs/quotes | Implemented offline: exact quote/source validation, unknown fields remain null, tentative proposals distinct |
| Source-to-meeting binding | Prevent wrong-meeting minutes attachment | Implemented offline: explicit human source assertion, immutable meeting/cycle/round/hash binding; not automatic identity/authenticity proof |
| Human review | Edit, confirm, reject; preserve original provenance | Implemented offline; JSON/text exports include clear review/audit boundaries |
| Attendance | Keep actual attendees separate from invited/accepted | Implemented offline: explicitly recorded actual attendance, never inferred from RSVP |
| Minutes distribution | Deliver approved minutes only to preauthorized audience | Audience logic implemented offline; delivery simulated. Attended-only rule intersects original audience; reply text cannot expand sharing |
| Action follow-through | Create tasks and track execution deadlines externally | Planned / not connected. Evidence action cards do not create real tasks |
| Audit/replay | Record state transitions, messages and correlation | Implemented offline: JSON audit, optimistic versions, idempotency; no durable event storage or multi-user isolation |
| Privacy/security | Authentication, tenant boundaries, retention/deletion, provider scopes | Planned production controls. Local prototype has bounded input/same-origin checks and secret exclusion, not production certification |
| Cost/model operations | Authorized account/model, budget controls, quality evaluation | Disabled cloud adapter has bounded attempt controls; no paid/live test. Real evaluation and account setup remain separate |
| Hardware Stage II | UGen300/DOA/PTZ/live capture integration | Planned, not implemented or connected |

## Release evidence and remaining work

v0.2.1 is the historical released baseline. v0.3.0 adds RSVP and virtual reminder jobs in an isolated checkout. On 28 October 2026, 73 offline tests and the desktop browser acceptance flows passed: due-only reminders and bounded escalation; required/optional RSVP gates; full source-bound minutes lifecycle; conflict/reschedule/cancel job invalidation. See `evidence/QA_REPORT.md` and its actual browser-download audits. These checks establish the local simulation only, not production or live-provider readiness.

Before real deployment, add authenticated sender/recipient verification, authorized mail/calendar adapters, durable outbox/queue with provider idempotency, real clock worker, real-time conflict checks, ambiguity handling, per-user state/permissions, consent/retention controls, operational alerts and failure recovery. These are target requirements, not hidden capabilities of this demo.
