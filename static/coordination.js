'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { template: null, current: null, busy: false, tab: 'timeline', records: [], attendance: [], formPeople: [], nextPerson: 4, loadVersion: 0, createAttempt: null, commandAttempts: new Map() };
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = String(text); return n; };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const uuid = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `request-${Date.now()}-${Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const clearMessages = () => { $('notice').hidden = true; $('error').hidden = true; };
  const notify = (text, error = false) => { $(error ? 'error' : 'notice').textContent = text; $(error ? 'error' : 'notice').hidden = false; $(error ? 'notice' : 'error').hidden = true; };
  function errorText(data, fallback) {
    if (typeof data.detail === 'string') return data.detail;
    if (Array.isArray(data.detail)) return data.detail.map((e) => `${(e.loc || []).slice(1).join('.')}: ${e.msg}`).join('\n');
    return data.message || fallback;
  }
  async function api(url, body) {
    const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    let response;
    try { response = await fetch(url, options); } catch (_) { throw new Error('The local server could not be reached. No automatic retry was made. Refresh the coordination to check the latest state before continuing.'); }
    if (!response.ok) { let data = {}; try { data = await response.json(); } catch (_) {} throw new Error(errorText(data, `Request failed (${response.status}). No external action was performed.`)); }
    return response.json();
  }
  function partsAt(instant, timezone) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
    return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  }
  function localValue(instant, timezone) { const p = partsAt(instant, timezone); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
  function localToISO(value, timezone) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose both a date and a time for the meeting window.');
    try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date()); } catch (_) { throw new Error('Use a valid IANA timezone, such as Asia/Taipei or UTC.'); }
    const [y, m, d, h, min] = value.match(/\d+/g).map(Number);
    const desired = Date.UTC(y, m - 1, d, h, min);
    let candidate = desired;
    for (let i = 0; i < 4; i++) {
      const p = partsAt(candidate, timezone);
      const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
      candidate += desired - seen;
    }
    if (localValue(candidate, timezone) !== value) throw new Error('That local time does not exist in this timezone. Choose a different time or use UTC.');
    if ([-7200000, -3600000, 3600000, 7200000].some((offset) => localValue(candidate + offset, timezone) === value)) throw new Error('That local time is ambiguous during a daylight-saving transition. Use UTC to specify the intended instant.');
    return new Date(candidate).toISOString();
  }
  function formatDate(instant, short = false) {
    if (!instant) return 'Not yet recorded';
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: state.current?.delegation.timezone || 'Asia/Taipei', month: 'short', day: 'numeric', ...(short ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant)); } catch (_) { return String(instant); }
  }
  function formatSlot(slot) {
    if (!slot) return 'Not selected';
    const zone = state.current?.delegation.timezone || 'Asia/Taipei';
    try {
      const start = new Date(slot.start), end = new Date(slot.end);
      const date = new Intl.DateTimeFormat('en-GB', { timeZone: zone, month: 'short', day: 'numeric' }).format(start);
      const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const endDate = new Intl.DateTimeFormat('en-GB', { timeZone: zone, month: 'short', day: 'numeric' }).format(end);
      return `${date} · ${clock.format(start)}–${endDate === date ? '' : `${endDate} `}${clock.format(end)}`;
    } catch (_) { return `${slot.start}–${slot.end}`; }
  }
  function person(id) { return state.current?.delegation.attendees.find((p) => p.id === id); }
  function personName(id) { return person(id)?.name || id; }
  function renderTemplate() {
    const d = state.template.delegation;
    $('purpose').value = d.purpose; $('purpose').maxLength = 180;
    $('duration').value = d.duration_minutes;
    $('timezone').value = d.timezone; $('timezone').maxLength = 80;
    $('window-start').value = localValue(d.window_start, d.timezone);
    $('window-end').value = localValue(d.window_end, d.timezone);
    $('reminder-limit').value = d.max_reminders;
    $('reminder-interval').value = d.reminder_interval_minutes ?? 60;
    $('minutes-audience').value = d.minutes_rule;
    $('authorize').checked = false;
    state.formPeople = d.attendees.map((p) => ({ ...clone(p), inAudience: d.minutes_audience_ids.includes(p.id) }));
    state.nextPerson = 4;
    renderFormPeople();
  }
  function renderFormPeople() {
    $('attendee-inputs').replaceChildren(...state.formPeople.map((p, index) => {
      const row = el('div', 'attendee-row');
      row.append(el('span', `avatar tone-${index % 3}`, p.name.slice(0, 1) || '?'));
      const info = el('div', 'person-info editable-person');
      const name = el('input'); name.type = 'text'; name.value = p.name; name.maxLength = 80; name.required = true; name.setAttribute('aria-label', `Synthetic participant ${index + 1} name`);
      name.addEventListener('input', () => { p.name = name.value; });
      const email = el('input'); email.type = 'email'; email.value = p.email; email.maxLength = 150; email.required = true; email.setAttribute('aria-label', `Synthetic participant ${index + 1} email, .example only`);
      email.addEventListener('input', () => { p.email = email.value; });
      info.append(name, email); row.append(info);
      [['required', 'Required', p.required], ['inAudience', 'Minutes audience', p.inAudience]].forEach(([key, text, checked]) => {
        const label = el('label', 'attendee-option'), input = el('input'); input.type = 'checkbox'; input.checked = checked;
        input.setAttribute('aria-label', `${text}: ${p.name}`); input.addEventListener('change', () => { p[key] = input.checked; });
        label.append(input, document.createTextNode(text)); row.append(label);
      });
      const remove = el('button', 'remove-person', '×'); remove.type = 'button'; remove.disabled = state.formPeople.length <= 2; remove.setAttribute('aria-label', `Remove synthetic participant ${index + 1}`);
      remove.addEventListener('click', () => { if (state.busy || state.formPeople.length <= 2) return; state.formPeople = state.formPeople.filter((item) => item.id !== p.id); renderFormPeople(); }); row.append(remove);
      return row;
    }));
    $('participant-count').textContent = `${state.formPeople.length} of 8`;
    $('add-person').disabled = state.busy || state.formPeople.length >= 8;
  }
  function getDelegation() {
    if (!state.template) throw new Error('Load the synthetic template before starting.');
    const zone = $('timezone').value.trim();
    const attendees = state.formPeople.map((p) => ({ id: p.id, name: p.name.trim(), email: p.email.trim().toLowerCase(), required: p.required }));
    const audience = state.formPeople.filter((p) => p.inAudience).map((p) => p.id);
    if (attendees.length < 2 || attendees.length > 8) throw new Error('Choose between 2 and 8 synthetic participants.');
    if (attendees.some((p) => !p.name)) throw new Error('Each synthetic participant needs a name.');
    if (attendees.some((p) => !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.example$/.test(p.email))) throw new Error('Use synthetic email addresses ending in .example only, such as ava@demo.example. Real addresses are not allowed.');
    if (new Set(attendees.map((p) => p.email)).size !== attendees.length) throw new Error('Each synthetic participant needs a unique email address.');
    if (!attendees.some((p) => p.required)) throw new Error('Choose at least one required attendee.');
    if (!audience.length) throw new Error('Choose at least one preauthorized minutes recipient.');
    if (!$('authorize').checked) throw new Error('Authorize the bounded mock workflow before starting.');
    const purpose = $('purpose').value.trim(); if (!purpose) throw new Error('Add a meeting purpose.');
    const interval = Number($('reminder-interval').value);
    if (!Number.isInteger(interval) || interval < 15 || interval > 1440) throw new Error('Virtual reminder interval must be a whole number from 15 to 1,440 minutes.');
    const start = localToISO($('window-start').value, zone), end = localToISO($('window-end').value, zone);
    const duration = Number($('duration').value), windowMinutes = (new Date(end) - new Date(start)) / 60000;
    if (windowMinutes < duration || windowMinutes > 7 * 24 * 60) throw new Error('The window must fit the meeting and be no longer than seven days.');
    return { purpose, duration_minutes: duration, timezone: zone, window_start: start, window_end: end, attendees, max_reminders: Number($('reminder-limit').value), reminder_interval_minutes: interval, minutes_audience_ids: audience, minutes_rule: $('minutes-audience').value, authorize_autonomous: true };
  }
  function acceptState(data, updateUrl = true) {
    if (!data || data.mode !== 'MOCK' || !data.id || !data.delegation) throw new Error('The server returned an invalid simulation state. No live integration was used.');
    if (!state.current || state.current.id !== data.id || state.current.cycle !== data.cycle || state.current.round !== data.round || state.current.invitation_revision !== data.invitation_revision) { state.attendance = []; state.records = []; $('rsvp-message').value = ''; $('rsvp-status').value = 'accepted'; }
    state.current = data;
    if (updateUrl) history.replaceState({ coordination: data.id }, '', `/coordination?id=${encodeURIComponent(data.id)}`);
    $('setup').hidden = true; $('workspace').hidden = false;
    render();
  }
  function currentRsvps() {
    const s = state.current;
    return (s?.rsvps || []).filter((r) => r.cycle === s.cycle && r.invitation_revision === s.invitation_revision);
  }
  function rsvpAttention() {
    const s = state.current;
    if (!s || s.status !== 'scheduled') return [];
    if (Array.isArray(s.rsvp_attention)) return s.rsvp_attention;
    const accepted = new Set(currentRsvps().filter((r) => r.status === 'accepted').map((r) => r.attendee_id));
    return s.delegation.attendees.filter((p) => p.required && !accepted.has(p.id)).map((p) => p.id);
  }
  function renderLifecycle() {
    const status = state.current.status;
    const index = { collecting: 1, exception: 1, scheduled: 2, completed: 3, minutes_distributed: 4, cancelled: -1 }[status] ?? 0;
    const steps = [['Delegated', 'Boundaries set'], ['Availability', 'Structured replies'], ['Invitation', state.current.status === 'scheduled' ? (rsvpAttention().length ? 'Required RSVP pending' : 'Required accepted') : 'Synthetic RSVPs'], ['Meeting', 'Attendance recorded'], ['Minutes', 'Authorized audience']];
    $('lifecycle').replaceChildren(...steps.map(([title, sub], i) => {
      const done = status !== 'cancelled' && (i < index || status === 'minutes_distributed');
      const step = el('div', `life-step ${done ? 'done' : ''} ${i === index ? 'current' : ''}`);
      step.append(el('b', '', done ? '✓' : String(i + 1)));
      const text = el('div'); text.append(el('strong', '', title), el('small', '', sub)); step.append(text);
      if (i === index) step.setAttribute('aria-current', 'step');
      return step;
    }));
  }
  function renderStatus() {
    const s = state.current, d = s.delegation;
    const attention = rsvpAttention();
    const messages = {
      collecting: ['COLLECTING AVAILABILITY', s.round > 1 ? 'No shared time yet. A final round has started.' : 'The coordinator has taken the handoff.', `Cycle ${s.cycle}, round ${s.round} of 2. Requests are prepared in the mock outbox. Silence is never treated as availability.`],
      exception: ['PAUSED · HUMAN DECISION NEEDED', 'The boundary was reached. Nothing was guessed.', s.exception || 'Choose a narrower window inside the original bounds, cancel, or start a New handoff for different dates.'],
      scheduled: attention.length ? ['AWAITING REQUIRED RSVP · MOCK INVITATION', 'Availability matched. Acceptance is still separate.', `${formatSlot(s.selected_slot)} · ${d.timezone}. Required acceptance pending: ${attention.map(personName).join(', ')}. Missing, declined, or tentative replies block completion; reschedule or cancel if needed.`] : ['REQUIRED RSVPS ACCEPTED · SIMULATED', 'Required participants accepted this invitation.', `${formatSlot(s.selected_slot)} · ${d.timezone}. Invitation revision ${s.invitation_revision}. Actual attendance is still unrecorded; acceptance never implies attendance.`],
      completed: ['MEETING COMPLETE · MINUTES PENDING', 'Attendance is recorded. Now attach reviewed minutes.', 'The original audience rule remains in force. Attaching a human-confirmed record triggers simulated distribution without a separate send approval.'],
      minutes_distributed: ['LIFECYCLE COMPLETE · SIMULATED DELIVERY', 'The loop is closed, inside the authorization.', `${s.minutes_recipient_ids.length} preauthorized recipient(s) have a simulated minutes message. No actual email was sent.`],
      cancelled: ['WORKFLOW CANCELLED', 'The current coordination cycle is closed.', 'Old replies are no longer accepted. The audit remains available. Start a New handoff, or explicitly reopen a scheduling cycle inside the original authorized window.'],
    };
    const [label, title, detail] = messages[s.status] || ['UNKNOWN STATE', 'Refresh the simulation.', ''];
    $('state-label').textContent = label; $('state-title').textContent = title; $('state-detail').textContent = detail;
    $('session-id').textContent = s.id.slice(0, 8).toUpperCase();
    $('session-title').textContent = d.purpose;
    $('session-subtitle').textContent = `${d.duration_minutes} minutes · ${d.timezone} · Cycle ${s.cycle} / round ${s.round} · Revision ${s.version}`;
    $('download-audit').href = `/api/coordination/${encodeURIComponent(s.id)}/audit`;
    $('minutes-review-link').href = `/review?coordination=${encodeURIComponent(s.id)}&cycle=${s.cycle}&round=${s.round}`;
  }
  function scopeRow(label, value) { const n = el('div', 'scope-row'); n.append(el('span', '', label), el('strong', '', value)); return n; }
  function renderScope() {
    const s = state.current, d = s.delegation;
    const audience = d.minutes_audience_ids.map(personName).join(', ');
    const reminders = d.attendees.filter((p) => p.required).map((p) => `${p.name.split(' ')[0]} ${s.reminder_counts[p.id] || 0}/${d.max_reminders}`).join(' · ');
    $('scope-summary').replaceChildren(
      scopeRow('Original authorized window', `${formatDate(s.authorization_window?.start || d.window_start)} → ${formatDate(s.authorization_window?.end || d.window_end)}`),
      scopeRow('Current search window', `${formatDate(d.window_start)} → ${formatDate(d.window_end)}`),
      scopeRow('Timezone & duration', `${d.timezone} · ${d.duration_minutes} minutes`),
      scopeRow('Scheduling rule', 'All required attendees fit; optional matches first, then earliest UTC.'),
      scopeRow('Reminder budget · per person / cycle', reminders || `Maximum ${d.max_reminders}`),
      scopeRow('Availability reminder interval', `${d.reminder_interval_minutes} minutes · explicit clock ticks only`),
      scopeRow('Invitation acceptance gate', 'Every required participant must accept the current correlated invitation. RSVP is not attendance.'),
      scopeRow('Preauthorized minutes audience', audience),
      scopeRow('Minutes distribution rule', d.minutes_rule === 'attended_only' ? 'Only authorized people who actually attended' : 'All preauthorized people, whether or not they attended'),
      scopeRow('Delivery adapter', 'MOCK · no external messages or calendar events'),
    );
  }
  function renderPeople() {
    const s = state.current;
    const groups = [['invited', s.invited_ids, 'No invitation has been prepared.'], ['attended', s.attended_ids, s.status === 'completed' || s.status === 'minutes_distributed' ? 'No actual attendees were recorded.' : 'Attendance is not assumed from invitations.'], ['recipient', s.minutes_recipient_ids, 'No minutes distribution has been prepared.']];
    groups.forEach(([prefix, ids, empty]) => {
      $(`${prefix}-count`).textContent = ids.length;
      const nodes = ids.map((id, index) => {
        const p = person(id), row = el('div', 'person-row'); row.append(el('span', `avatar tone-${index % 3}`, (p?.name || '?').slice(0, 1)));
        const info = el('div', 'person-info'); info.append(el('strong', '', p?.name || id), el('small', '', p?.email || 'Unknown synthetic attendee')); row.append(info);
        if (prefix === 'invited') row.append(el('span', 'pill neutral', p?.required ? 'REQUIRED' : 'OPTIONAL'));
        return row;
      });
      $(`${prefix}-list`).replaceChildren(...(nodes.length ? nodes : [el('p', 'people-empty', empty)]));
    });
  }
  function renderCandidates() {
    const s = state.current, list = $('candidate-list'), candidates = s.candidate_slots || [];
    $('candidate-count').textContent = `${candidates.length} CANDIDATE${candidates.length === 1 ? '' : 'S'}`;
    list.replaceChildren();
    if (!candidates.length) {
      list.append(el('p', 'empty-mini', s.status === 'exception' ? 'No eligible time was selected. The workflow will not invent availability or schedule outside its bounds.' : s.status === 'cancelled' ? 'The previous slot is invalidated. No active invitation remains.' : 'Waiting for enough structured replies. All required attendees must be available for the full meeting.'));
      return;
    }
    const make = (slot) => {
      const selected = s.selected_slot && slot.start === s.selected_slot.start && slot.end === s.selected_slot.end;
      const row = el('div', `candidate ${selected ? 'selected' : ''}`); row.append(el('span', 'candidate-icon', selected ? '✓' : '◷'));
      const info = el('div'); info.append(el('strong', '', formatSlot(slot)), el('p', '', `All required fit · ${(slot.optional_available_ids || []).length} optional available · ${s.delegation.timezone}`)); row.append(info);
      if (selected) row.append(el('span', 'pill success', 'AUTO-SELECTED'));
      return row;
    };
    candidates.slice(0, 3).forEach((slot) => list.append(make(slot)));
    if (candidates.length > 3) { const details = el('details', 'extra-candidates'); details.append(el('summary', '', `Show ${candidates.length - 3} other eligible times`)); candidates.slice(3).forEach((slot) => details.append(make(slot))); list.append(details); }
  }
  function renderClock() {
    const s = state.current, jobs = s.jobs || [];
    const scheduled = jobs.filter((job) => job.status === 'scheduled');
    $('virtual-now').textContent = s.virtual_now ? formatDate(s.virtual_now) : 'No virtual time supplied';
    $('clock-zone').textContent = `${s.delegation.timezone} · not wall-clock time`;
    $('job-count').textContent = `${scheduled.length} SCHEDULED JOB${scheduled.length === 1 ? '' : 'S'}`;
    $('clock-note').textContent = scheduled.length ? 'Explicit virtual-clock ticks execute due availability-reminder jobs once, within the delegated cap. A larger jump may run several due checks. No RSVP reminders, real waiting, or background daemon.' : 'No pending availability-reminder jobs; RSVP reminders are not implemented. Advancing virtual time cannot revive cancelled or executed jobs. No real-time daemon or external delivery.';
    const list = $('job-list'); list.replaceChildren();
    if (!jobs.length) { list.append(el('p', 'empty-mini', 'No reminder jobs are recorded for this simulation.')); return; }
    const table = el('table', 'jobs-table'); table.append(el('caption', 'sr-only', 'Virtual reminder jobs, including due times, execution state, and lifecycle scope'));
    const head = el('thead'), row = el('tr');
    ['Job', 'Due · virtual time', 'Status', 'Scope'].forEach((text) => { const th = el('th', '', text); th.scope = 'col'; row.append(th); }); head.append(row); table.append(head);
    const body = el('tbody');
    [...jobs].reverse().forEach((job) => {
      const tr = el('tr'), identity = el('td'); identity.append(el('span', 'job-id', job.id), el('span', 'job-kind', 'Availability reminder check'));
      const due = el('td', '', formatDate(job.due_at, true));
      if (job.executed_at) due.append(el('span', 'job-detail', `Executed: ${formatDate(job.executed_at, true)}`));
      const status = el('td'); status.append(el('span', `job-status ${job.status}`, job.status));
      if (job.reason) status.append(el('p', 'job-reason', job.reason));
      const scope = el('td', '', `Cycle ${job.cycle}
Round ${job.round}`);
      tr.append(identity, due, status, scope); body.append(tr);
    });
    table.append(body); list.append(table);
  }
  function renderRsvps() {
    const s = state.current, replies = currentRsvps(), attention = rsvpAttention();
    const show = ['scheduled', 'completed', 'minutes_distributed'].includes(s.status) && s.invited_ids.length > 0;
    $('rsvp-panel').hidden = !show;
    if (!show) return;
    const accepted = replies.filter((r) => r.status === 'accepted').length;
    $('rsvp-count').textContent = `${accepted} / ${s.invited_ids.length} ACCEPTED`;
    $('rsvp-summary').textContent = s.status === 'scheduled' ? (attention.length ? `Waiting on required acceptance: ${attention.map(personName).join(', ')}. Completion remains blocked.` : 'All required participants accepted. Optional declines do not block completion; record actual attendance separately.') : 'These correlated RSVP records are preserved for the completed meeting. They remain separate from actual attendance.';
    $('rsvp-correlation').textContent = `Meeting ${s.id.slice(0, 8)} · Cycle ${s.cycle} · Invitation revision ${s.invitation_revision}. Responses to older cycles or revisions are rejected.`;
    $('rsvp-roster').replaceChildren(...s.invited_ids.map((id, index) => {
      const p = person(id), reply = replies.find((r) => r.attendee_id === id), status = reply?.status || 'missing';
      const row = el('div', 'rsvp-person'); row.append(el('span', `avatar tone-${index % 3}`, (p?.name || '?').slice(0, 1)));
      const info = el('div', 'person-info'); info.append(el('strong', '', p?.name || id), el('small', '', `${p?.required ? 'Required' : 'Optional'} · ${p?.email || ''}`));
      if (reply?.message) info.append(el('p', '', reply.message));
      row.append(info, el('span', `rsvp-status ${status}`, status === 'missing' ? 'No reply' : status)); return row;
    }));
    $('rsvp-controls').hidden = s.status !== 'scheduled';
    const previous = $('rsvp-person').value;
    $('rsvp-person').replaceChildren(...s.invited_ids.map((id) => { const option = el('option', '', `${personName(id)}${person(id)?.required ? ' · required' : ' · optional'}`); option.value = id; return option; }));
    if (s.invited_ids.includes(previous)) $('rsvp-person').value = previous;
  }
  function renderAttendance() {
    const s = state.current;
    $('completion-panel').hidden = s.status !== 'scheduled';
    if (s.status !== 'scheduled') return;
    const attention = rsvpAttention();
    $('completion-gate').textContent = attention.length ? `Completion blocked: ${attention.map(personName).join(', ')} must accept the current invitation, or you must explicitly reschedule/cancel. Checking attendance does not bypass this gate.` : 'Required RSVP gate passed. Check only the people who actually attended; acceptance alone does not mark anyone present.';
    $('completion-gate').className = `completion-gate ${attention.length ? '' : 'ready'}`;
    $('actual-attendance').replaceChildren(...s.invited_ids.map((id) => {
      const label = el('label', 'attendance-choice'), input = el('input'); input.type = 'checkbox'; input.value = id; input.checked = state.attendance.includes(id); input.disabled = state.busy;
      input.addEventListener('change', () => { state.attendance = Array.from($('actual-attendance').querySelectorAll('input:checked')).map((n) => n.value); });
      label.append(input, document.createTextNode(personName(id))); return label;
    }));
  }
  function renderRecords() {
    const previous = $('approved-record').value;
    const options = state.records.map((r) => { const option = el('option', '', `${r.title} · ${r.confirmed_count} confirmed · ${r.mode === 'fixture' ? 'synthetic fixture' : 'cloud extraction'}`); option.value = r.run_id; return option; });
    const placeholder = el('option', '', options.length ? 'Choose a matching source-bound export' : 'No source-bound export for this meeting cycle'); placeholder.value = '';
    $('approved-record').replaceChildren(placeholder, ...options);
    if (state.records.some((r) => r.run_id === previous)) $('approved-record').value = previous;
    $('attach-minutes').disabled = state.busy || state.current?.status !== 'completed' || !$('approved-record').value;
  }
  function renderMinutes() {
    const s = state.current;
    $('minutes-panel').hidden = !['completed', 'minutes_distributed'].includes(s.status);
    $('minutes-summary').hidden = !s.approved_minutes;
    if (s.approved_minutes) $('minutes-summary').textContent = `${s.approved_minutes.title}\n${s.approved_minutes.confirmed_count} human-confirmed item(s) attached.\nSimulated minutes recipients: ${s.minutes_recipient_ids.map(personName).join(', ')}.\nDelivery status: SIMULATED_NOT_SENT.`;
    $('approved-record').disabled = state.busy || s.status !== 'completed';
    $('refresh-records').disabled = state.busy || s.status === 'minutes_distributed';
    renderRecords();
  }
  function renderActivity() {
    const s = state.current;
    $('timeline-count').textContent = s.events.length; $('inbox-count').textContent = s.inbox.length; $('outbox-count').textContent = s.outbox.length;
    document.querySelectorAll('[data-tab]').forEach((n) => { n.classList.toggle('active', n.dataset.tab === state.tab); n.setAttribute('aria-pressed', String(n.dataset.tab === state.tab)); });
    const container = $('activity-content'); container.replaceChildren();
    if (state.tab === 'timeline') {
      [...s.events].reverse().forEach((entry) => {
        const row = el('div', 'event'); row.append(el('span', 'event-dot'));
        const text = el('div', 'event-text'); text.append(el('div', 'event-kind', entry.kind.replaceAll('_', ' ')), el('div', '', entry.message), el('span', 'event-time', `${formatDate(entry.created_at, true)} audit time${entry.virtual_at ? ` · Virtual: ${formatDate(entry.virtual_at, true)}` : ''}`)); row.append(text); container.append(row);
      });
    } else if (state.tab === 'inbox') {
      [...s.inbox].reverse().forEach((entry) => {
        const card = el('article', 'message-card'), top = el('div', 'message-top'); top.append(el('strong', '', personName(entry.attendee_id)), el('span', 'pill mock', 'SYNTHETIC REPLY')); card.append(top);
        card.append(el('div', 'message-meta', `Cycle ${entry.cycle} · Round ${entry.round} · ${formatDate(entry.created_at, true)}`), el('p', 'message-body', entry.message));
        card.append(el('div', 'message-slots', entry.slots.length ? entry.slots.map(formatSlot).join('\n') : 'No available slots supplied.'));
        container.append(card);
      });
    } else {
      [...s.outbox].reverse().forEach((entry) => {
        const card = el('article', 'message-card'), top = el('div', 'message-top'); top.append(el('strong', '', entry.subject), el('span', 'pill mock', 'SIMULATED · NOT SENT')); card.append(top);
        card.append(el('div', 'message-meta', `To: ${entry.to_name} <${entry.to_email}>\n${entry.kind.replaceAll('_', ' ')} · Cycle ${entry.cycle} / round ${entry.round} · ${formatDate(entry.created_at, true)}`), el('p', 'message-body', entry.body));
        if (entry.correlation) card.append(el('div', 'message-slots', `RSVP correlation: meeting ${String(entry.correlation.coordination_id).slice(0, 8)} · cycle ${entry.correlation.cycle} · invitation revision ${entry.correlation.invitation_revision} · attendee ${entry.correlation.attendee_id}`));
        if (entry.virtual_at) card.append(el('div', 'message-slots', `Virtual event time: ${formatDate(entry.virtual_at, true)}`));
        if (entry.attachment) {
          const details = el('details', 'attachment-details'); details.append(el('summary', '', `Attached: ${entry.attachment.confirmed_count} human-confirmed item(s)`));
          const ul = el('ul'); (entry.attachment.confirmed_items || []).forEach((item) => ul.append(el('li', '', `${item.kind}: ${item.summary}`))); details.append(ul); card.append(details);
        }
        container.append(card);
      });
    }
    if (!container.children.length) container.append(el('p', 'empty-mini', state.tab === 'inbox' ? 'No structured availability replies yet. RSVP responses appear separately in the invitation-response roster.' : 'No activity in this view.'));
  }
  function renderControls() {
    $('delegation-form').querySelectorAll('input, select, button').forEach((node) => { node.disabled = state.busy || !state.template; });
    $('start').disabled = state.busy || !state.template;
    $('add-person').disabled = state.busy || !state.template || state.formPeople.length >= 8;
    document.querySelectorAll('.remove-person').forEach((node) => { node.disabled = state.busy || state.formPeople.length <= 2; });
    if (!state.current) return;
    const status = state.current.status, collecting = status === 'collecting';
    ['matching-replies', 'conflicting-replies', 'no-response', 'reminder-check'].forEach((id) => { $(id).disabled = state.busy || !collecting; });
    $('reschedule').disabled = state.busy || ['completed', 'minutes_distributed'].includes(status);
    $('cancel').disabled = state.busy || ['completed', 'cancelled', 'minutes_distributed'].includes(status);
    $('refresh').disabled = state.busy; $('new-session').disabled = state.busy;
    $('complete-meeting').disabled = state.busy || status !== 'scheduled' || rsvpAttention().length > 0;
    ['clock-15', 'clock-60', 'clock-180'].forEach((id) => { $(id).disabled = state.busy; });
    ['rsvp-all-accept', 'rsvp-decline', 'rsvp-tentative', 'rsvp-person', 'rsvp-status', 'rsvp-message', 'rsvp-inject'].forEach((id) => { $(id).disabled = state.busy || status !== 'scheduled'; });
    $('reminder-check').disabled = state.busy || !collecting || !(state.current.jobs || []).some((job) => job.status === 'scheduled' && job.cycle === state.current.cycle && job.round === state.current.round);
    $('apply-reschedule').disabled = state.busy; $('cancel-reschedule').disabled = state.busy;
    $('controls-note').textContent = collecting ? 'Inject events below. The coordinator advances automatically within the initial authorization; these are not per-email permission requests.' : status === 'scheduled' ? (rsvpAttention().length ? 'A slot and mock invitations were prepared. Inject correlated RSVPs below; required participants must accept before completion.' : 'Required RSVPs are accepted. Record actual attendance separately; acceptance does not imply presence.') : status === 'exception' ? 'The workflow is paused. Narrow the search within the original window or cancel. Wider bounds or new dates require a New handoff.' : 'This collection round is closed. All prior simulated messages remain in the audit.';
  }
  function render() {
    if (!state.current) { renderControls(); return; }
    renderStatus(); renderLifecycle(); renderScope(); renderPeople(); renderCandidates(); renderClock(); renderRsvps(); renderAttendance(); renderMinutes(); renderActivity(); renderControls();
  }
  async function loadRecords(announce = false) {
    if (!state.current) { state.records = []; renderRecords(); return; }
    const { id, cycle, round } = state.current;
    try {
      const data = await api(`/api/approved-minutes?coordination_id=${encodeURIComponent(id)}`);
      if (!state.current || state.current.id !== id || state.current.cycle !== cycle || state.current.round !== round) return;
      state.records = Array.isArray(data.records) ? data.records : [];
      renderRecords();
      if (announce) notify(state.records.length ? `${state.records.length} human-confirmed export(s) bound to this exact meeting cycle are available.` : 'No matching source-bound export exists. Open Evidence review from this meeting, confirm the transcript belongs to this cycle, review at least one item, and export JSON + audit. Standalone or stale-cycle exports cannot be attached.');
    } catch (error) { if (announce) notify(error.message, true); }
  }
  async function refresh() {
    if (!state.current || state.busy) return;
    const id = state.current.id, load = ++state.loadVersion;
    state.busy = true; renderControls(); clearMessages();
    try { const data = await api(`/api/coordination/${encodeURIComponent(id)}`); if (load !== state.loadVersion) return; acceptState(data); await loadRecords(); }
    catch (error) { notify(error.message, true); }
    finally { if (load === state.loadVersion) { state.busy = false; render(); } }
  }
  async function command(path, extra = {}) {
    if (!state.current || state.busy) return;
    clearMessages();
    const view = ++state.loadVersion;
    const current = state.current, key = JSON.stringify({ id: current.id, version: current.version, path, extra });
    if (!state.commandAttempts.has(key)) state.commandAttempts.set(key, uuid());
    const request_id = state.commandAttempts.get(key), body = { version: current.version, request_id, ...extra };
    state.busy = true; renderControls(); renderMinutes();
    try {
      const data = await api(`/api/coordination/${encodeURIComponent(current.id)}/${path}`, body);
      if (view !== state.loadVersion) return;
      acceptState(data); $('reschedule-editor').hidden = true;
      if (data.status === 'completed') await loadRecords();
      if (data.status === 'minutes_distributed') notify('Human-confirmed minutes were automatically prepared for the original authorized audience. All delivery is SIMULATED_NOT_SENT; no per-email approval was needed.');
      else if (data.status === 'scheduled') notify(rsvpAttention().length ? 'Current mock invitation is awaiting required acceptance. Missing, declined, or tentative required RSVPs block meeting completion.' : 'All required participants accepted the current correlated invitation. Actual attendance is still separate and must be recorded explicitly.');
      else if (data.status === 'exception') notify(data.exception || 'The workflow paused at its authorized boundary.');
      if (path === 'rsvp') $('rsvp-message').value = '';
    } catch (error) { if (view === state.loadVersion) notify(error.message, true); }
    finally { if (view === state.loadVersion) { state.busy = false; render(); } }
  }
  $('add-person').addEventListener('click', () => {
    if (state.busy || state.formPeople.length >= 8) return;
    const number = state.nextPerson++;
    state.formPeople.push({ id: `p${number}`, name: `Participant ${number} (synthetic)`, email: `person${number}@demo.example`, required: false, inAudience: true });
    renderFormPeople();
  });
  $('delegation-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (state.busy) return; clearMessages();
    let delegation; try { delegation = getDelegation(); } catch (error) { notify(error.message, true); return; }
    const fingerprint = JSON.stringify(delegation);
    if (!state.createAttempt || state.createAttempt.fingerprint !== fingerprint) state.createAttempt = { fingerprint, request_id: uuid() };
    const view = ++state.loadVersion;
    state.busy = true; renderControls();
    try {
      const data = await api('/api/coordination', { ...delegation, request_id: state.createAttempt.request_id });
      if (view !== state.loadVersion) return;
      acceptState(data); state.createAttempt = null; state.tab = 'timeline';
      notify('Bounded mock delegation accepted. Availability requests were prepared automatically. Use the event controls to simulate replies—not to approve individual messages.');
      $('session-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { if (view === state.loadVersion) notify(error.message, true); }
    finally { if (view === state.loadVersion) { state.busy = false; render(); } }
  });
  $('matching-replies').addEventListener('click', () => command('simulate', { scenario: 'matching' }));
  $('conflicting-replies').addEventListener('click', () => command('simulate', { scenario: 'conflict' }));
  $('no-response').addEventListener('click', () => command('simulate', { scenario: 'no_response' }));
  $('reminder-check').addEventListener('click', () => command('reminder'));
  [['clock-15', 15], ['clock-60', 60], ['clock-180', 180]].forEach(([id, minutes]) => $(id).addEventListener('click', () => command('clock', { advance_minutes: minutes })));
  [['rsvp-all-accept', 'all_accept'], ['rsvp-decline', 'decline_required'], ['rsvp-tentative', 'tentative_required']].forEach(([id, scenario]) => $(id).addEventListener('click', () => command('simulate-rsvp', { scenario })));
  $('rsvp-inject').addEventListener('click', () => {
    if (!state.current || state.busy || state.current.status !== 'scheduled') return;
    const attendee_id = $('rsvp-person').value;
    if (!state.current.invited_ids.includes(attendee_id)) { notify('Choose a participant from the current mock invitation.', true); return; }
    command('rsvp', { attendee_id, cycle: state.current.cycle, invitation_revision: state.current.invitation_revision, status: $('rsvp-status').value, message: $('rsvp-message').value.trim() || 'Structured synthetic RSVP supplied through the demo control.' });
  });
  $('cancel').addEventListener('click', () => { if (state.current && !state.busy && window.confirm('Cancel this mock workflow and invalidate current replies? The audit will remain. No external cancellation message will be sent.')) command('cancel'); });
  $('reschedule').addEventListener('click', () => {
    if (!state.current || state.busy) return;
    const d = state.current.delegation;
    const bound = state.current.authorization_window || { start: d.window_start, end: d.window_end };
    ['reschedule-start', 'reschedule-end'].forEach((id) => { $(id).min = localValue(bound.start, d.timezone); $(id).max = localValue(bound.end, d.timezone); });
    $('reschedule-help').textContent = `Keep the search window inside the original authorization: ${formatDate(bound.start)} → ${formatDate(bound.end)} · ${d.timezone}. Wider bounds or new dates require a New handoff. Prior replies and schedule are invalidated; the audit remains.`;
    $('reschedule-start').value = localValue(d.window_start, d.timezone); $('reschedule-end').value = localValue(d.window_end, d.timezone);
    $('reschedule-editor').hidden = false; $('reschedule-editor').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('reschedule-start').focus();
  });
  $('cancel-reschedule').addEventListener('click', () => { $('reschedule-editor').hidden = true; });
  $('apply-reschedule').addEventListener('click', () => {
    if (!state.current || state.busy) return;
    try {
      const timezone = state.current.delegation.timezone;
      const window_start = localToISO($('reschedule-start').value, timezone), window_end = localToISO($('reschedule-end').value, timezone);
      const d = state.current.delegation;
      const bound = state.current.authorization_window || { start: d.window_start, end: d.window_end };
      if (new Date(window_start) < new Date(bound.start) || new Date(window_end) > new Date(bound.end)) throw new Error('The search must stay inside the original authorized window. Use New handoff for wider bounds or new dates.');
      if (new Date(window_end) - new Date(window_start) < d.duration_minutes * 60000) throw new Error('The narrowed window must fit the full meeting duration.');
      command('reschedule', { window_start, window_end });
    } catch (error) { notify(error.message, true); }
  });
  $('complete-meeting').addEventListener('click', () => {
    if (rsvpAttention().length) { notify('Required participants must accept the current invitation before meeting completion. RSVP is separate from actual attendance.', true); return; }
    command('complete', { attended_ids: [...state.attendance] });
  });
  $('refresh-records').addEventListener('click', () => loadRecords(true));
  $('approved-record').addEventListener('change', () => { $('attach-minutes').disabled = state.busy || state.current?.status !== 'completed' || !$('approved-record').value; });
  $('attach-minutes').addEventListener('click', () => { if ($('approved-record').value) command('minutes', { review_run_id: $('approved-record').value }); });
  $('refresh').addEventListener('click', refresh);
  $('new-session').addEventListener('click', () => {
    if (state.busy) return;
    state.current = null; state.attendance = []; state.records = []; state.tab = 'timeline'; state.loadVersion++;
    history.pushState({}, '', '/'); $('workspace').hidden = true; $('setup').hidden = false; $('reschedule-editor').hidden = true;
    renderTemplate(); renderControls(); clearMessages(); notify('Start a new bounded handoff. Previous simulations remain on this server until restart; browser Back can reopen the previous coordination.');
  });
  document.querySelectorAll('[data-tab]').forEach((node) => node.addEventListener('click', () => { state.tab = node.dataset.tab; renderActivity(); }));
  async function restoreFromUrl() {
    const load = ++state.loadVersion;
    const id = new URLSearchParams(location.search).get('id');
    if (!id) { state.busy = false; state.current = null; $('workspace').hidden = true; $('setup').hidden = false; renderControls(); return; }
    if (!/^[a-f0-9]{32}$/.test(id)) { notify('Invalid coordination reference. Start a new synthetic handoff.', true); return; }
    state.busy = true; renderControls();
    try { const data = await api(`/api/coordination/${encodeURIComponent(id)}`); if (load !== state.loadVersion) return; acceptState(data, false); await loadRecords(); }
    catch (error) { if (load === state.loadVersion) notify(error.message, true); }
    finally { if (load === state.loadVersion) { state.busy = false; render(); } }
  }
  window.addEventListener('popstate', restoreFromUrl);
  async function init() {
    renderControls();
    try { state.template = await api('/api/coordination/template'); if (state.template.mode !== 'MOCK') throw new Error('Expected a synthetic mock template.'); renderTemplate(); }
    catch (error) { notify(error.message, true); }
    renderControls(); await restoreFromUrl();
  }
  init();
})();
