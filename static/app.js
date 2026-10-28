'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const reviewParams = new URLSearchParams(location.search);
  const coordinationParam = reviewParams.get('coordination') || '';
  const requestedBinding = ['coordination', 'cycle', 'round'].some((key) => reviewParams.has(key));
  const cycleParam = reviewParams.get('cycle') || '', roundParam = reviewParams.get('round') || '';
  const contextCycle = /^[1-9]\d{0,6}$/.test(cycleParam) ? Number(cycleParam) : null;
  const contextRound = /^[12]$/.test(roundParam) ? Number(roundParam) : null;
  const coordinationId = /^[a-f0-9]{32}$/.test(coordinationParam) ? coordinationParam : null;
  if (coordinationId) {
    const backLink = document.querySelector('.rail-item[href="/"]');
    if (backLink) backLink.href = `/coordination?id=${coordinationId}`;
    const mobileBackLink = document.getElementById('coordinator-return');
    if (mobileBackLink) mobileBackLink.href = `/coordination?id=${coordinationId}`;
  }
  const state = {
    transcript: { title: '', segments: [] }, origin: 'empty', sample: null,
    run: null, reviewBinding: null, contextStatus: requestedBinding ? 'loading' : 'standalone', contextMeeting: null, contextError: '', items: [], filter: 'all', busy: false, exporting: false,
    revision: 0, sourceReadVersion: 0, controller: null, status: null, editing: null, lastMode: 'fixture',
    limits: { max_segments: 120, max_text_chars: 30000, max_file_bytes: 100000 },
  };
  const KINDS = { decision: 'Decision', action: 'Action item', proposal: 'Tentative proposal', open_question: 'Open question' };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const bytes = (value) => new TextEncoder().encode(value).length;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const button = (text, className, action) => {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const displayTime = (seconds) => {
    const sec = Math.floor(Number(seconds) || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? `${String(h).padStart(2, '0')}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const itemSnapshot = (item) => ({ kind: item.kind, summary: item.summary, owner: item.owner, deadline: item.deadline, notes: item.notes, evidence: clone(item.evidence) });
  const changed = (item) => item.original && ['kind', 'summary', 'owner', 'deadline', 'notes'].some((key) => (item[key] ?? null) !== (item.original[key] ?? null));
  const hasReview = () => state.editing !== null || state.items.some((item) => item.review_status !== 'pending' || changed(item));
  const confirmDiscard = (action) => !hasReview() || window.confirm(`${action} will discard your reviewed items and edits from this tab. Export first if you want to keep them. Continue?`);
  const clearMessages = () => { $('notice').hidden = true; $('error').hidden = true; };
  const notify = (text, isError = false) => {
    const target = $(isError ? 'error' : 'notice');
    target.textContent = text;
    target.hidden = false;
    $(isError ? 'notice' : 'error').hidden = true;
  };
  const readableError = (body, fallback) => {
    if (typeof body.detail === 'string') return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join('\n');
    if (body.detail && typeof body.detail === 'object') return body.detail.message || body.detail.error || fallback;
    return body.error || body.message || fallback;
  };
  async function api(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch (_) { /* No raw server body is displayed. */ }
      throw new Error(readableError(body, `Request failed (${response.status}). No offline fallback was used.`));
    }
    return response;
  }
  function renderBinding() {
    const requested = requestedBinding;
    $('standalone-link').hidden = !requested;
    $('binding-return').href = coordinationId ? `/coordination?id=${coordinationId}` : '/';
    $('binding-confirm-label').hidden = state.contextStatus !== 'ready';
    $('binding-confirm').disabled = state.busy || Boolean(state.reviewBinding) || !$('import-panel').hidden || state.contextStatus !== 'ready';
    $('binding-error').hidden = !state.contextError;
    $('binding-error').textContent = state.contextError;
    if (!requested) {
      $('binding-title').textContent = 'Standalone review · not distributable';
      $('binding-badge').textContent = 'UNBOUND';
      $('binding-description').textContent = 'Standalone exports can be downloaded, but cannot be distributed by the coordinator. Open Evidence review from the target meeting to bind a source.';
      return;
    }
    $('binding-title').textContent = state.contextMeeting?.delegation?.purpose || (state.contextStatus === 'loading' ? 'Checking target meeting…' : 'Meeting context unavailable');
    $('binding-badge').textContent = state.reviewBinding ? 'MANUALLY BOUND' : state.contextStatus === 'ready' ? 'CONFIRM SOURCE' : 'BINDING BLOCKED';
    $('binding-description').textContent = state.contextStatus === 'ready' ? `Meeting ${coordinationId.slice(0, 8)} · Cycle ${contextCycle} / round ${contextRound}. A manual source confirmation is required before extraction. The server binds the exact source hash; this does not automatically verify meeting identity.` : 'This review will not silently switch to standalone or bind to a different cycle. Return to the current meeting and reopen Evidence review.';
  }
  async function loadReviewContext() {
    if (!requestedBinding) { state.contextStatus = 'standalone'; renderBinding(); return; }
    state.contextError = '';
    if (!coordinationId || contextCycle === null || contextRound === null) {
      state.contextStatus = 'invalid'; state.contextError = 'The review link is missing or has invalid meeting, cycle, or round information. Bound extraction is blocked.';
      $('binding-confirm').checked = false; renderControls(); return;
    }
    try {
      const meeting = await (await api(`/api/coordination/${coordinationId}`)).json();
      state.contextMeeting = meeting;
      if (meeting.id !== coordinationId || meeting.cycle !== contextCycle || meeting.round !== contextRound) throw new Error('This review link refers to a stale meeting cycle or round. Return to the coordinator and open a fresh review link.');
      if (!['scheduled', 'completed'].includes(meeting.status)) throw new Error('This meeting is not currently scheduled or awaiting reviewed minutes. Source binding is blocked for its current state.');
      state.contextStatus = 'ready';
    } catch (error) {
      state.contextStatus = 'invalid'; state.contextError = error.message || 'The target meeting could not be verified.'; $('binding-confirm').checked = false;
    }
    renderControls();
  }
  function resetBindingConfirmation() { $('binding-confirm').checked = false; }
  function invalidateResults(message = '') {
    state.revision++;
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.busy = false;
    state.run = null;
    state.reviewBinding = null;
    state.items = [];
    state.editing = null;
    state.filter = 'all';
    renderReview();
    renderControls();
    if (message) notify(message);
  }
  function validateTranscript(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use a JSON object with a title and a segments array.');
    if (!Array.isArray(value.segments) || value.segments.length === 0) throw new Error('Add at least one transcript segment.');
    if (value.segments.length > state.limits.max_segments) throw new Error(`Maximum ${state.limits.max_segments} segments per transcript.`);
    if (value.title !== undefined && typeof value.title !== 'string') throw new Error('Meeting title must be text.');
    const title = (value.title || 'Untitled meeting').trim();
    if (title.length > 200) throw new Error('Meeting title must be 200 characters or fewer.');
    const ids = new Set();
    let totalChars = 0;
    const segments = value.segments.map((seg, index) => {
      const prefix = `Segment ${index + 1}`;
      if (!seg || typeof seg !== 'object' || Array.isArray(seg)) throw new Error(`${prefix} must be an object.`);
      if (typeof seg.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(seg.id)) throw new Error(`${prefix} ID must be 1–40 letters, numbers, underscores, or hyphens.`);
      if (ids.has(seg.id)) throw new Error(`Duplicate segment ID: ${seg.id}`);
      ids.add(seg.id);
      if (typeof seg.start !== 'number' || typeof seg.end !== 'number' || !Number.isFinite(seg.start) || !Number.isFinite(seg.end) || seg.start < 0 || seg.end < seg.start) throw new Error(`${prefix} needs numeric seconds with 0 ≤ start ≤ end.`);
      if (typeof seg.text !== 'string' || !seg.text.trim() || seg.text.length > 4000) throw new Error(`${prefix} needs 1–4,000 characters of nonempty text.`);
      if (seg.start > 28800 || seg.end > 28800) throw new Error(`${prefix} timestamps must be within 8 hours.`);
      if (seg.speaker !== null && (typeof seg.speaker !== 'string' || seg.speaker.length > 100)) throw new Error(`${prefix} speaker must be text up to 100 characters, or null.`);
      totalChars += seg.text.length;
      return { id: seg.id, start: seg.start, end: seg.end, speaker: seg.speaker === '' ? null : seg.speaker, text: seg.text };
    });
    if (segments.some((segment, index) => index > 0 && segment.start < segments[index - 1].start)) throw new Error('Segments must be in chronological order. Overlapping timestamps are allowed.');
    if (totalChars > state.limits.max_text_chars) throw new Error(`Maximum ${state.limits.max_text_chars.toLocaleString()} transcript characters.`);
    return { title: title || 'Untitled meeting', segments };
  }
  function parseTimestamped(text) {
    const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
    const segments = lines.map((line, index) => {
      const match = line.match(/^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:：]+)[:：]\s*(.+)$/);
      if (!match) throw new Error(`Line ${index + 1}: use [00:00] Speaker: text. Each segment must be on one line.`);
      const parts = match[1].split(':').map(Number);
      if (parts.slice(1).some((n) => n > 59)) throw new Error(`Line ${index + 1}: timestamp seconds/minutes must be 00–59.`);
      const start = parts.reduce((time, part) => time * 60 + part, 0);
      const name = match[2].trim();
      const speaker = /^(\?|unknown|unidentified|不明|未知)$/i.test(name) ? null : name;
      return { id: `s${String(index + 1).padStart(2, '0')}`, start, end: start, speaker, text: match[3] };
    });
    return validateTranscript({ title: $('meeting-title').value || 'Imported meeting', segments });
  }
  function setTranscript(value, origin) {
    const transcript = validateTranscript(value);
    resetBindingConfirmation();
    invalidateResults();
    state.transcript = transcript;
    state.origin = origin;
    $('meeting-title').value = transcript.title;
    $('import-panel').hidden = true;
    renderSource();
    renderControls();
  }
  function renderSource() {
    const list = $('source-list');
    list.replaceChildren();
    const segments = state.transcript.segments;
    $('segment-count').textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'}`;
    $('source-duration').textContent = displayTime(segments.length ? Math.max(...segments.map((s) => s.end)) : 0);
    $('source-origin').textContent = state.origin === 'sample' ? 'SYNTHETIC SAMPLE' : state.origin === 'imported' ? 'IMPORTED TRANSCRIPT' : 'NO SOURCE';
    if (!segments.length) { list.append(el('div', 'source-empty', 'Paste a timestamped transcript, import JSON, or load the synthetic sample.')); return; }
    const speakers = new Map();
    segments.forEach((seg) => {
      const key = seg.speaker || '?';
      if (!speakers.has(key)) speakers.set(key, speakers.size);
      const section = el('article', 'segment');
      section.dataset.segmentId = seg.id;
      section.tabIndex = -1;
      const top = el('div', 'segment-top');
      top.append(el('span', `speaker-avatar tone-${speakers.get(key) % 4}`, seg.speaker ? seg.speaker.slice(0, 2).toUpperCase() : '?'));
      top.append(el('span', 'speaker-name', seg.speaker || 'Unidentified speaker'));
      const time = el('span', 'segment-time', displayTime(seg.start));
      time.title = seg.end === seg.start ? 'Point timestamp; segment duration not specified' : `${displayTime(seg.start)}–${displayTime(seg.end)}`;
      top.append(time, el('span', 'segment-id', seg.id));
      section.append(top, el('p', 'segment-text', seg.text));
      list.append(section);
    });
  }
  function locateSource(segmentId) {
    const nodes = Array.from($('source-list').querySelectorAll('.segment'));
    nodes.forEach((node) => node.classList.toggle('active-source', node.dataset.segmentId === segmentId));
    const target = nodes.find((node) => node.dataset.segmentId === segmentId);
    if (!target) { notify('This evidence source does not exist. The item cannot be trusted.', true); return; }
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
  }
  function renderControls() {
    const cloud = $('mode').value === 'cloud';
    state.lastMode = $('mode').value;
    $('mode-badge').className = `badge ${cloud ? 'cloud' : 'offline'}`;
    $('mode-badge').textContent = cloud ? 'CLOUD API' : 'OFFLINE DEMO';
    $('mode-description').textContent = cloud ? 'Extract sends this transcript to OpenAI. Custom transcripts require operator enablement. No external actions are executed.' : 'Prewritten results for the synthetic sample. No AI or network inference.';
    const status = state.status;
    $('cloud-status').textContent = status ? status.mode_note || (status.cloud_ready ? 'Cloud configured; access is not yet verified.' : 'Cloud is unavailable; no offline fallback is used.') : 'Server configuration unavailable.';
    $('cloud-policy').textContent = status?.cloud_policy || 'Demo cloud allowance: unchanged synthetic sample only · 3 attempted calls maximum · no automatic retry.';
    $('privacy-note').textContent = status?.privacy || 'No database. Review edits stay in this tab. The server temporarily caches original extractions; they expire after 2 hours and are pruned on later requests. Cloud mode sends the transcript to OpenAI.';
    $('extract').disabled = state.busy || state.transcript.segments.length === 0 || !$('import-panel').hidden || (requestedBinding && (state.contextStatus !== 'ready' || !$('binding-confirm').checked));
    $('meeting-title').disabled = !$('import-panel').hidden;
    $('extract-label').textContent = state.busy ? (cloud ? 'Extracting…' : 'Loading fixture…') : (cloud ? 'Extract with OpenAI' : 'Run sample demo');
    $('mode').disabled = state.busy;
    renderBinding();
  }
  function renderOriginal(item) {
    const details = el('details', 'original-details');
    details.append(el('summary', '', 'View original candidate'));
    const o = item.original || itemSnapshot(item);
    details.append(el('div', 'original-content', `${KINDS[o.kind] || o.kind}\n${o.summary}\nOwner: ${o.owner || 'Unassigned'}\nDeadline: ${o.deadline || 'Not stated'}${o.notes ? `\nNote: ${o.notes}` : ''}`));
    return details;
  }
  function setReviewStatus(item, status) {
    if (state.exporting) return;
    if (state.editing !== null) { notify('Save or cancel the edit before reviewing this item.', true); return; }
    item.review_status = status;
    clearMessages();
    renderReview();
  }
  function makeEditForm(item) {
    const form = el('form', 'edit-form');
    const field = (name, label, type = 'input', value = '') => {
      const box = el('div');
      const lab = el('label', '', label);
      const input = el(type);
      input.name = name;
      input.id = `edit-${item.id}-${name}`;
      lab.htmlFor = input.id;
      input.value = value ?? '';
      if (type !== 'select') input.maxLength = ({ summary: 800, notes: 1200, owner: 100, deadline: 150 })[name] || 200;
      box.append(lab, input);
      return { box, input };
    };
    const summary = field('summary', 'Candidate text', 'textarea', item.summary);
    summary.input.required = true;
    form.append(summary.box);
    const row = el('div', 'edit-row');
    const owner = field('owner', 'Owner · blank means unknown', 'input', item.owner);
    const deadline = field('deadline', 'Deadline · keep exact wording', 'input', item.deadline);
    owner.input.placeholder = 'Unassigned'; deadline.input.placeholder = 'Not stated';
    row.append(owner.box, deadline.box); form.append(row);
    const row2 = el('div', 'edit-row');
    const kind = field('kind', 'Classification', 'select');
    for (const [value, label] of Object.entries(KINDS)) {
      const option = el('option', '', label); option.value = value; kind.input.append(option);
    }
    kind.input.value = item.kind;
    const notes = field('notes', 'Review note', 'input', item.notes);
    row2.append(kind.box, notes.box); form.append(row2);
    form.append(el('p', 'edit-note', 'Edits are human-authored. Original evidence remains unchanged. Saving returns this item to pending review.'));
    const actions = el('div', 'edit-actions');
    actions.append(button('Cancel', 'button secondary small', () => { state.editing = null; renderReview(); }));
    const save = el('button', 'button primary small', 'Save edit'); save.type = 'submit'; actions.append(save); form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = summary.input.value.trim();
      if (!text) { summary.input.setCustomValidity('Candidate text cannot be empty.'); summary.input.reportValidity(); return; }
      summary.input.setCustomValidity('');
      item.summary = text;
      item.owner = owner.input.value.trim() || null;
      item.deadline = deadline.input.value.trim() || null;
      item.notes = notes.input.value.trim();
      item.kind = kind.input.value;
      item.review_status = 'pending';
      state.editing = null;
      clearMessages(); renderReview();
      notify('Edit saved as a human revision. Check the evidence, then confirm or reject.');
    });
    summary.input.addEventListener('input', () => summary.input.setCustomValidity(''));
    return form;
  }
  function renderCard(item) {
    const card = el('article', `review-card is-${item.review_status}`);
    card.dataset.itemId = item.id;
    const top = el('div', 'card-top');
    top.append(el('span', `kind-badge ${item.kind}`, KINDS[item.kind] || item.kind));
    top.append(el('span', `review-state ${item.review_status}`, item.review_status === 'confirmed' ? '✓ Confirmed by you' : item.review_status === 'rejected' ? '× Rejected by you' : '○ Needs review'));
    card.append(top);
    if (state.editing === item.id) {
      card.append(makeEditForm(item));
    } else {
      card.append(el('h3', 'card-summary', item.summary));
      const meta = el('div', 'item-meta');
      [['Owner', item.owner, 'Unassigned'], ['Due', item.deadline, 'Not stated']].forEach(([label, value, missing]) => {
        const entry = el('div'); entry.append(el('span', 'item-meta-label', label), el('span', value ? '' : 'unknown-value', value || missing)); meta.append(entry);
      });
      card.append(meta);
      if (changed(item)) card.append(el('span', 'human-edit', 'HUMAN-EDITED · original preserved'));
    }
    const evidence = el('div', 'evidence-box');
    evidence.append(el('div', 'evidence-label', `SOURCE EVIDENCE · ${item.evidence.length} REFERENCE${item.evidence.length === 1 ? '' : 'S'}`));
    item.evidence.forEach((reference) => {
      const source = state.transcript.segments.find((segment) => segment.id === reference.segment_id);
      const quote = button('', 'evidence-link', () => locateSource(reference.segment_id));
      quote.append(el('span', 'quote-ref', `${reference.segment_id} · ${displayTime(source?.start)}`), el('span', 'quote-text', `“${reference.quote}”`));
      quote.setAttribute('aria-label', `Show source ${reference.segment_id}: ${reference.quote}`);
      evidence.append(quote);
    });
    card.append(evidence);
    if (item.notes && state.editing !== item.id) card.append(el('p', 'item-notes', item.notes));
    if (changed(item)) card.append(renderOriginal(item));
    if (state.editing !== item.id) {
      const actions = el('div', 'card-actions');
      if (item.review_status === 'pending') {
        actions.append(button('✓ Confirm', 'review-button', () => setReviewStatus(item, 'confirmed')));
        actions.append(button('Reject', 'review-button reject', () => setReviewStatus(item, 'rejected')));
      } else {
        actions.append(button('Return to review', 'review-button', () => setReviewStatus(item, 'pending')));
      }
      actions.append(button('Edit candidate', 'text-button', () => { state.editing = item.id; renderReview(); document.getElementById(`edit-${item.id}-summary`)?.focus(); }));
      actions.querySelectorAll('button').forEach((node) => { node.disabled = state.editing !== null || state.exporting || !$('import-panel').hidden; });
      card.append(actions);
    }
    return card;
  }
  function renderReview() {
    const counts = { pending: 0, confirmed: 0, rejected: 0 };
    state.items.forEach((item) => counts[item.review_status]++);
    $('metric-total').textContent = state.run ? state.items.length : '—';
    $('metric-confirmed').textContent = counts.confirmed;
    $('metric-pending').textContent = counts.pending;
    $('metric-rejected').textContent = counts.rejected;
    $('count-all').textContent = state.items.length;
    $('run-mode').hidden = !state.run;
    if (state.run) {
      $('run-mode').textContent = state.run.mode === 'fixture' ? 'FIXTURE · NOT AI' : 'OPENAI · CLOUD';
      $('run-mode').className = `badge ${state.run.mode === 'fixture' ? 'offline' : 'cloud'}`;
    }
    document.querySelectorAll('[data-filter]').forEach((node) => {
      node.classList.toggle('active', node.dataset.filter === state.filter);
      node.setAttribute('aria-pressed', String(node.dataset.filter === state.filter));
      node.disabled = state.editing !== null;
    });
    const shown = state.items.filter((item) => state.filter === 'all' || item.review_status === state.filter);
    $('cards').replaceChildren(...shown.map(renderCard));
    $('empty-state').hidden = Boolean(state.run);
    $('filtered-empty').hidden = !state.run || shown.length > 0;
    $('filtered-empty').textContent = state.items.length === 0 && state.run ? 'No evidence-backed candidates were returned. Nothing is assumed or invented.' : 'No items in this view.';
    const allowed = counts.confirmed > 0 && !state.busy && !state.exporting && state.editing === null && $('import-panel').hidden;
    $('export-json').disabled = !allowed;
    $('export-text').disabled = !allowed;
    $('export-hint').textContent = counts.confirmed ? `${counts.confirmed} confirmed item${counts.confirmed === 1 ? '' : 's'} in minutes. JSON includes the full audit. ${state.reviewBinding ? 'Manually bound to this meeting cycle.' : 'Standalone: not distributable by Coordination.'}` : 'Confirm at least one item to enable export.';
    if (state.editing !== null) $('export-hint').textContent = 'Save or cancel the current edit before exporting.';
    if (!$('import-panel').hidden) $('export-hint').textContent = 'Apply or cancel the transcript edit before exporting.';
  }
  function validateCandidates(items) {
    if (!Array.isArray(items)) throw new Error('Server returned an invalid candidate list. No results were accepted.');
    const itemIds = new Set();
    return items.map((raw) => {
      if (!raw || typeof raw.id !== 'string' || itemIds.has(raw.id) || !KINDS[raw.kind] || typeof raw.summary !== 'string' || !raw.summary.trim()) throw new Error('Server returned an invalid candidate. No results were accepted.');
      itemIds.add(raw.id);
      if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) throw new Error('A candidate has no evidence. No results were accepted.');
      raw.evidence.forEach((reference) => {
        const source = state.transcript.segments.find((segment) => segment.id === reference.segment_id);
        if (!source || typeof reference.quote !== 'string' || !reference.quote.trim() || !source.text.includes(reference.quote)) throw new Error('A candidate contains a missing source or non-exact quote. No results were accepted.');
      });
      if (raw.owner !== null && typeof raw.owner !== 'string') throw new Error('Invalid owner field. No results were accepted.');
      if (raw.deadline !== null && typeof raw.deadline !== 'string') throw new Error('Invalid deadline field. No results were accepted.');
      const item = clone(raw);
      item.notes = typeof item.notes === 'string' ? item.notes : '';
      item.review_status = 'pending';
      item.original = item.original || itemSnapshot(item);
      return item;
    });
  }
  async function extract() {
    if (state.busy || !state.transcript.segments.length || !$('import-panel').hidden) return;
    if (requestedBinding && (state.contextStatus !== 'ready' || !$('binding-confirm').checked)) { notify('Confirm the supplied source belongs to this current meeting cycle before extracting.', true); return; }
    if (!confirmDiscard('Running extraction again')) return;
    clearMessages();
    invalidateResults();
    state.busy = true;
    state.controller = new AbortController();
    const revision = state.revision;
    const mode = $('mode').value;
    renderControls(); renderReview();
    try {
      if (requestedBinding) {
        await loadReviewContext();
        if (revision !== state.revision) return;
        if (state.contextStatus !== 'ready' || !$('binding-confirm').checked) throw new Error(state.contextError || 'Manual source confirmation is required.');
      }
      const payload = { mode, transcript: state.transcript };
      if (requestedBinding) payload.review_context = { coordination_id: coordinationId, cycle: contextCycle, round: contextRound, manual_source_confirmed: true };
      const response = await api('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: state.controller.signal });
      const result = await response.json();
      if (revision !== state.revision) return;
      if (result.mode !== mode) throw new Error('Server returned an unexpected extraction mode. Results were rejected; no silent fallback is allowed.');
      const items = validateCandidates(result.items);
      if (requestedBinding && (!result.review_binding || result.review_binding.coordination_id !== coordinationId || result.review_binding.cycle !== contextCycle || result.review_binding.round !== contextRound || result.review_binding.source_hash !== result.source_hash || result.review_binding.method !== 'manual_source_confirmation')) throw new Error('The server did not return the expected meeting/source binding. No cards were accepted.');
      if (!requestedBinding && result.review_binding) throw new Error('An unexpected meeting binding was returned for standalone review. No cards were accepted.');
      state.reviewBinding = result.review_binding || null;
      state.run = { run_id: result.run_id, mode: result.mode, model: result.model ?? null, created_at: result.created_at, source_hash: result.source_hash };
      state.items = items;
      state.filter = 'all';
      const intro = mode === 'fixture' ? 'Offline fixture loaded. These are prewritten demonstration candidates, not AI output.' : 'Cloud extraction returned candidates. Review each claim against its exact source before confirming.';
      const warnings = Array.isArray(result.warnings) ? result.warnings.join(' ') : '';
      notify([intro, warnings].filter(Boolean).join('\n'));
    } catch (error) {
      if (error.name !== 'AbortError' && revision === state.revision) notify(error.message || 'Extraction failed. No offline fallback was used.', true);
    } finally {
      if (revision === state.revision) { state.busy = false; state.controller = null; renderControls(); renderReview(); }
    }
  }
  async function exportMinutes(format) {
    if (state.exporting || state.editing || !$('import-panel').hidden || !state.run || !state.items.some((item) => item.review_status === 'confirmed')) return;
    state.exporting = true; renderReview(); clearMessages();
    const exportMode = state.run.mode;
    const boundExport = Boolean(state.reviewBinding);
    try {
      const response = await api('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, transcript: state.transcript, run: state.run, items: state.items }) });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = `meetingproof-${exportMode}-${format === 'json' ? 'review-audit.json' : 'minutes.txt'}`;
      a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`${format === 'json' ? 'JSON with review audit' : 'Reviewed text minutes'} prepared for download. Only confirmed candidates appear in the minutes.${boundExport ? ' This manually bound export is available only to its matching meeting cycle in Coordination.' : ' Standalone export: not bound to a meeting and not distributable by Coordination.'}`);
    } catch (error) { notify(error.message || 'Export failed.', true); }
    finally { state.exporting = false; renderReview(); }
  }
  function showEditor() {
    if (state.editing !== null) { notify('Save or cancel the current candidate edit before editing the transcript.', true); return; }
    state.sourceReadVersion++;
    clearMessages();
    $('import-panel').hidden = false;
    $('source-format').value = 'json';
    $('source-editor').value = state.transcript.segments.length ? JSON.stringify(state.transcript, null, 2) : '';
    updateFormatHelp(); renderControls(); renderReview(); $('source-editor').focus();
  }
  function updateFormatHelp() {
    $('format-help').textContent = $('source-format').value === 'json' ? 'Object with title and segments: id, start, end, speaker, text. Times are seconds; unknown speakers are null.' : 'One segment per line: [00:00] Alex: text. Use ?: for unknown speakers. End equals start because only a point timestamp is known.';
  }
  async function loadSample(announce = true) {
    if (!confirmDiscard('Loading the sample')) return;
    const readVersion = ++state.sourceReadVersion;
    clearMessages();
    const revision = state.revision;
    try {
      if (!state.sample) state.sample = await (await api('/api/sample')).json();
      if (revision !== state.revision || readVersion !== state.sourceReadVersion) return;
      setTranscript({ title: state.sample.title, segments: state.sample.segments }, 'sample');
      $('mode').value = 'fixture'; renderControls();
      if (announce) notify('Synthetic bilingual sample loaded. Friday is tentative; the later Monday commitment must remain distinct.');
    } catch (error) { notify(error.message || 'Could not load the sample.', true); }
  }
  $('extract').addEventListener('click', extract);
  $('binding-confirm').addEventListener('change', renderControls);
  $('mode').addEventListener('change', () => {
    if (!confirmDiscard('Changing extraction mode')) { $('mode').value = state.lastMode; return; }
    clearMessages(); invalidateResults(); renderControls();
  });
  $('load-sample').addEventListener('click', () => loadSample());
  $('edit-source').addEventListener('click', showEditor);
  $('cancel-import').addEventListener('click', () => { $('import-panel').hidden = true; clearMessages(); renderControls(); renderReview(); });
  $('source-format').addEventListener('change', () => { updateFormatHelp(); });
  $('meeting-title').addEventListener('input', () => {
    state.transcript.title = $('meeting-title').value.trim() || 'Untitled meeting';
    resetBindingConfirmation();
    renderControls();
    if (state.run || state.busy) invalidateResults('Meeting source changed. Extract again before reviewing or exporting.');
  });
  $('apply-import').addEventListener('click', () => {
    clearMessages();
    try {
      const input = $('source-editor').value;
      if (bytes(input) > state.limits.max_file_bytes) throw new Error('Transcript input exceeds the 100 KB limit.');
      let transcript;
      if ($('source-format').value === 'text') transcript = parseTimestamped(input);
      else { try { transcript = JSON.parse(input); } catch (_) { throw new Error('Invalid JSON. Check quotes, commas, and brackets, then try again.'); } }
      const validated = validateTranscript(transcript);
      if (JSON.stringify(validated) === JSON.stringify(state.transcript)) {
        $('import-panel').hidden = true; renderControls(); renderReview();
        notify('Transcript is unchanged. Your existing review is preserved.');
        return;
      }
      if (!confirmDiscard('Replacing the transcript')) return;
      setTranscript(validated, 'imported');
      notify('Transcript loaded. Custom cloud extraction is available only when enabled by the operator; the offline fixture accepts only the unmodified synthetic sample.');
    } catch (error) { notify(error.message, true); }
  });
  $('load-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const revision = state.revision;
    const readVersion = ++state.sourceReadVersion;
    clearMessages();
    try {
      if (file.size > state.limits.max_file_bytes) throw new Error('File exceeds the 100 KB limit.');
      const text = await file.text();
      if (revision !== state.revision || readVersion !== state.sourceReadVersion) return;
      let parsed; try { parsed = JSON.parse(text); } catch (_) { throw new Error('Invalid JSON file. Choose a transcript object with title and segments.'); }
      const validated = validateTranscript(parsed);
      if (JSON.stringify(validated) === JSON.stringify(state.transcript)) {
        notify('Imported transcript is unchanged. Your existing review is preserved.');
        return;
      }
      if (!confirmDiscard('Importing a new transcript')) return;
      setTranscript(validated, 'imported');
      notify('JSON transcript imported. Custom cloud extraction requires operator enablement; offline fixture results never substitute for custom content.');
    } catch (error) { notify(error.message, true); }
    finally { event.target.value = ''; }
  });
  $('clear').addEventListener('click', () => {
    if (!confirmDiscard('Clearing this workspace')) return;
    clearMessages(); resetBindingConfirmation(); invalidateResults(); state.transcript = { title: '', segments: [] }; state.origin = 'empty';
    $('meeting-title').value = ''; $('source-editor').value = ''; $('import-panel').hidden = true;
    renderSource(); renderControls(); notify('Transcript and all review candidates cleared from this tab.');
  });
  document.querySelectorAll('[data-filter]').forEach((node) => node.addEventListener('click', () => { if (state.editing !== null) return; state.filter = node.dataset.filter; renderReview(); }));
  $('export-json').addEventListener('click', () => exportMinutes('json'));
  $('export-text').addEventListener('click', () => exportMinutes('text'));
  window.addEventListener('beforeunload', (event) => {
    if (state.items.some((item) => item.review_status !== 'pending' || changed(item))) { event.preventDefault(); event.returnValue = ''; }
  });
  async function init() {
    renderSource(); renderReview();
    try {
      state.status = await (await api('/api/status')).json();
      if (state.status.limits) state.limits = { ...state.limits, ...state.status.limits };
    } catch (_) { state.status = null; }
    renderControls();
    await loadReviewContext();
    if (state.revision === 0) await loadSample(false);
  }
  init();
})();
