const $ = (id) => document.getElementById(id);
const LAST_VIEW_KEY = 'sidePanelLastView';
const SOURCES = window.MIGRATION_SOURCES || [];
const UTILITIES = window.SCALEPAD_UTILITIES || [];
const STATUS_LABELS = window.STATUS_LABELS || {};

const state = {
  view: 'home',
  sourceId: null,
  tab: null,
  data: { workspaceId: null, context: null, events: [], notes: [] },
  access: {},
  config: {},
  conn: { status: 'unknown', users: [], error: null }, // unknown | none | checking | ok | bad
  propel: { list: null, details: {}, selected: new Set(), open: new Set(['Production Questionnaires']), existing: new Map(), results: {}, loading: false, creating: false, error: null, tab: 'questionnaires' },
  propelProjects: { list: null, selected: new Set(), open: new Set(), existing: new Map(), results: {}, loading: false, creating: false, error: null },
};

let toastTimer = null;
let refreshInFlight = false;

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(response || { ok: false, error: 'No response from the extension.' });
    });
  });
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function shorten(value, length) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(0, length - 1).trim() + '…' : text;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3000);
}

function sourceById(id) {
  return SOURCES.find((source) => source.id === id) || null;
}

function detectedSource() {
  const url = state.tab?.url || '';
  return SOURCES.find((source) => source.match && source.match.test(url)) || null;
}

function statusChip(status) {
  const cls = status === 'ready' ? 'chip-success' : status === 'building' ? 'chip-warn' : 'chip-neutral';
  return h('span', { class: 'chip ' + cls, text: STATUS_LABELS[status] || status });
}

function makeLogo(source, size = '') {
  const logo = h('span', { class: 'logo' + (size ? ' ' + size : '') });
  if (source.logoBg) logo.style.background = source.logoBg;
  const img = h('img', { src: source.logo, alt: '' });
  img.addEventListener('error', () => {
    img.remove();
    logo.style.background = '';
    logo.textContent = source.fallback;
  });
  logo.appendChild(img);
  return logo;
}

function isConnected() {
  return state.conn.status === 'ok';
}

// ---------- navigation ----------

function setView(view, { sourceId } = {}) {
  state.view = view;
  if (view === 'source') state.sourceId = sourceId || state.sourceId;
  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('is-visible', section.id === view + 'View');
  }
  for (const button of document.querySelectorAll('.rail-btn[data-go]')) {
    const active = button.dataset.go === view;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const button of document.querySelectorAll('.rail-source')) {
    const active = view === 'source' && button.dataset.source === state.sourceId;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  clearActionBar();
  $('main').scrollTop = 0;
  if (view === 'home') renderHome();
  if (view === 'source') renderSource();
  if (view === 'utilities') renderUtilities();
  if (view === 'utility') renderUtility();
  if (view === 'issues') renderIssues();
  if (view === 'settings') renderSettings();
  try { chrome.storage.session?.set({ [LAST_VIEW_KEY]: { view, sourceId: state.sourceId } }); } catch (_e) { /* optional */ }
}

function clearActionBar() {
  document.querySelector('.action-bar')?.remove();
  $('main').classList.remove('has-actionbar');
  document.body.classList.remove('actionbar-open');
}

function mountActionBar(bar) {
  clearActionBar();
  $('main').appendChild(bar);
  $('main').classList.add('has-actionbar');
  document.body.classList.add('actionbar-open');
}

// ---------- rail + header ----------

function renderRail() {
  const rail = $('railSources');
  rail.replaceChildren();
  for (const source of SOURCES) {
    const button = h('button', {
      class: 'rail-source',
      type: 'button',
      role: 'listitem',
      'aria-label': source.name + ' — ' + (STATUS_LABELS[source.status] || ''),
      'data-tip': source.name,
      dataset: { source: source.id },
      onclick: () => openSource(source.id),
    }, makeLogo(source));
    if (source.status === 'ready' || source.status === 'building') {
      button.appendChild(h('span', { class: 'rail-status ' + source.status }));
    }
    rail.appendChild(button);
  }
  $('settingsDot').hidden = isConnected() || state.conn.status === 'unknown' || state.conn.status === 'checking';
}

function renderContextBar() {
  const context = state.data.context;
  const title = context?.title || state.tab?.title || 'No active page';
  let host = context?.host || '';
  if (!host) { try { host = new URL(state.tab?.url || '').hostname; } catch (_e) { host = ''; } }
  $('pageTitle').textContent = shorten(title, 80);
  $('pageHost').textContent = host || '—';
  const source = detectedSource();
  const logo = $('ctxLogo');
  const badge = $('ctxBadge');
  logo.replaceChildren();
  if (source) {
    const img = h('img', { src: source.logo, alt: '' });
    if (source.logoBg) logo.style.background = source.logoBg;
    img.addEventListener('error', () => { img.remove(); logo.style.background = ''; logo.textContent = source.fallback; });
    logo.appendChild(img);
    badge.className = 'chip chip-success';
    badge.textContent = source.name;
  } else {
    logo.style.background = '';
    logo.appendChild(icon('globe'));
    badge.className = 'chip chip-neutral';
    badge.textContent = 'Not a source';
  }
}

function renderFooter() {
  const conn = $('connStatus');
  conn.classList.toggle('ok', state.conn.status === 'ok');
  conn.classList.toggle('bad', state.conn.status === 'bad' || state.conn.status === 'none');
  const labels = {
    unknown: 'Checking connection…',
    checking: 'Checking connection…',
    none: 'ScalePad CS not connected',
    ok: 'Connected to ScalePad CS',
    bad: 'Connection failed',
  };
  $('connLabel').textContent = labels[state.conn.status];
  $('versionLabel').textContent = 'v' + chrome.runtime.getManifest().version;
}

// ---------- home ----------

function renderHome() {
  const detected = detectedSource();

  // Setup: only surface what's missing, as one compact banner.
  const missing = [];
  if (!isConnected() && state.conn.status !== 'checking' && state.conn.status !== 'unknown') missing.push('connect ScalePad CS');
  if (isConnected() && !state.config.evaluateUserId) missing.push('choose an evaluating user');
  $('setupSteps').replaceChildren(missing.length
    ? h('div', { class: 'callout callout-warn setup-banner' }, icon('alert'),
      h('div', {}, h('strong', { text: 'Finish setup: ' }), missing.join(' and ') + '.'),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => setView('settings') }, 'Settings'))
    : '');

  $('sourceCards').replaceChildren(...SOURCES.map((source) => h('button', {
    class: 'source-card' + (detected?.id === source.id ? ' is-detected' : ''),
    type: 'button',
    onclick: () => openSource(source.id),
  },
  makeLogo(source),
  h('span', {}, h('strong', { text: source.name }), h('small', { text: source.tagline })),
  detected?.id === source.id ? h('span', { class: 'chip chip-success', text: 'Detected' }) : statusChip(source.status),
  )));
}

function utilityIcon(utility) {
  const el = h('span', { class: 'util-icon' }, icon(utility.icon));
  el.style.background = utility.accent + '1A';
  el.style.color = utility.accent;
  return el;
}

// ---------- utilities ----------

function renderUtilities() {
  $('utilityList').replaceChildren(...UTILITIES.map((utility) => h('button', {
    class: 'utility-card', type: 'button', onclick: () => selectUtility(utility),
  },
  utilityIcon(utility),
  h('span', {},
    h('span', { class: 'top' }, h('strong', { text: utility.name }), statusChip(utility.status)),
    h('p', { text: utility.description })),
  )));
}

// ---------- Outcome classification ----------
// Three tiers so a good run reads as a good run:
//  auto   = handled automatically, nothing to do (not counted as an issue)
//  review = copied, but worth a look
//  failed = a record or field did not get into ScalePad CS
const OUTCOME_RULES = [
  ['auto', 'Restored after being deleted in ScalePad CS', /created again/i],
  ['auto', 'Dates moved to the earliest quarter ScalePad CS allows', /earlier than ScalePad CS allows/i],
  ['auto', 'Default owner used (no matching ScalePad CS user)', /no matching ScalePad user|default user from Settings/i],
  ['auto', 'Script lines left out (full text stays in Propel)', /script line|firewall/i],
  ['auto', 'Text shortened to fit (full text stays in Propel)', /shortened|2,?500/i],
  ['auto', 'Billing cycle converted to monthly or yearly', /converted (from|to)/i],
  ['auto', 'Templates created along the way', /^Created (assessment|initiative) template/i],
  ['auto', 'No completed audits in the selected date range', /No (completed )?audits in the selected/i],
  ['auto', 'Left open because the audit is still in progress in Propel', /left open/i],
  ['review', 'Created without their template', /without their template|template .*(not found|no longer exist)/i],
  ['review', 'Answers without a matching template question', /no matching template question/i],
  ['review', 'Old assessments you may want to delete', /template was deleted, so a new assessment/i],
  ['review', 'Audits skipped (no template could be created)', /Audits skipped/i],
  ['failed', 'Fields that could not be set', /^Could not set|HTTP \d{3}|-> [45]\d\d/i],
  ['failed', 'Could not read from Propel', /^Propel (roadmap|audits)|session needs refreshing/i],
  ['failed', 'Not migrated', /failed|could not|error/i],
];

function classifyNote(text) {
  const t = String(text || '');
  const [subject, ...rest] = t.includes(' — ') ? t.split(' — ') : ['', t];
  const detail = rest.length ? rest.join(' — ') : t;
  const rule = OUTCOME_RULES.find(([, , re]) => re.test(detail) || re.test(t));
  return { tier: rule ? rule[0] : 'review', group: rule ? rule[1] : 'Other notes', subject: subject.trim(), detail };
}

/** { failed: [{group, entries}], review: [...], auto: [...] } with repeats folded into one group. */
function groupNotes(messages) {
  const out = { failed: new Map(), review: new Map(), auto: new Map() };
  for (const m of messages) {
    const c = classifyNote(m);
    const bucket = out[c.tier];
    if (!bucket.has(c.group)) bucket.set(c.group, []);
    bucket.get(c.group).push(c);
  }
  const list = (map) => [...map].map(([group, entries]) => ({ group, entries }));
  return { failed: list(out.failed), review: list(out.review), auto: list(out.auto) };
}

const noteCount = (groups) => groups.reduce((n, g) => n + g.entries.length, 0);

/** One readable line per group for the issues centre. */
function groupLine(g) {
  const names = [...new Set(g.entries.map((e) => e.subject || e.detail))].filter(Boolean);
  const shown = names.slice(0, 6).join(', ');
  return g.group + ' (' + g.entries.length + ')' + (shown ? ': ' + shown + (names.length > 6 ? ', and ' + (names.length - 6) + ' more' : '') : '');
}

// ---------- Migration issues centre ----------
// One persistent list of everything that didn't copy across cleanly. Each run replaces the
// issues for the items it touched, so a successful retry clears them automatically.

const ISSUES_KEY = 'migrationIssues';
const ISSUE_AREAS = {
  'propel-questionnaires': { label: 'Propel · Questionnaires', where: { view: 'source', sourceId: 'propel', propelTab: 'questionnaires', step: 'templates' } },
  'propel-projects': { label: 'Propel · Project templates', where: { view: 'source', sourceId: 'propel', propelTab: 'projects', step: 'templates' } },
  'propel-clients': { label: 'Propel · Client data', where: { view: 'source', sourceId: 'propel', step: 'clients' } },
  'myitprocess-questionnaires': { label: 'MyITProcess · Review templates', where: { view: 'source', sourceId: 'myitprocess', step: 'templates' } },
  'myitprocess-clients': { label: 'MyITProcess · Client data', where: { view: 'source', sourceId: 'myitprocess', step: 'clients' } },
  'strategyoverview-questionnaires': { label: 'Strategy Overview · Templates', where: { view: 'source', sourceId: 'strategyoverview', step: 'templates' } },
  'strategyoverview-clients': { label: 'Strategy Overview · Client data', where: { view: 'source', sourceId: 'strategyoverview', step: 'clients' } },
  controlmap: { label: 'ControlMap workstream sync', where: { view: 'utility', utilityId: 'controlmap-sync' } },
  tenant: { label: 'Tenant migration', where: { view: 'utility', utilityId: 'tenant-migration' } },
  cleanup: { label: 'Client clean up', where: { view: 'utility', utilityId: 'client-cleanup' } },
};
const ISSUE_PLAIN = [
  [/^Not created:.*(firewall|403)/i, 'ScalePad CS refused some of this item’s text, so it was not created. Update the extension (newer versions leave the blocked line out) and create it again.'],
  [/^Not (created|deleted):/i, 'This item did not copy across. See the detail below, then try again.'],
  [/firewall|script line/i, 'The ScalePad CS API refused some text (usually a PowerShell snippet). That line was left out; the full text is still in Propel.'],
  [/not in a state that allows|template was deleted/i, 'This assessment can no longer be changed in ScalePad CS. The next run creates a fresh one.'],
  [/HTTP 40[34]|-> 40[34]/i, 'ScalePad CS would not let this record be changed. It may have been deleted or locked; the next run recreates it if it is gone.'],
  [/session needs refreshing/i, 'The Propel login expired during the run. Open Propel, click anywhere, then retry.'],
  [/2,?500|shortened|truncat/i, 'Text was longer than ScalePad CS allows, so it was shortened. The full text is still in Propel.'],
  [/template.*not (found|exist)|no longer exist/i, 'The item was created without its template, because the template could not be found.'],
  [/no matching (scalepad )?user|default user/i, 'No ScalePad CS user matched this person, so the default user from Settings was used.'],
  [/no matching template question|unmatched/i, 'Some answers had no matching question in the template. They are listed in the assessment\'s internal notes.'],
  [/in use|409/i, 'ScalePad CS refused because the item is still in use.'],
  [/-> 5\d\d|timed out|network/i, 'ScalePad CS had a temporary problem. Retrying usually fixes this.'],
];

function issueExplain(detail) {
  const hit = ISSUE_PLAIN.find(([re]) => re.test(detail || ''));
  return hit ? hit[1] : null;
}

async function loadIssues() {
  try {
    const { [ISSUES_KEY]: list } = await chrome.storage.local.get(ISSUES_KEY);
    state.issues = Array.isArray(list) ? list : [];
  } catch (_e) { state.issues = []; }
  renderIssuesBadge();
}

async function saveIssues() {
  state.issues = (state.issues || []).slice(-500);
  try { await chrome.storage.local.set({ [ISSUES_KEY]: state.issues }); } catch (_e) { /* best effort */ }
  renderIssuesBadge();
  if (state.view === 'issues') renderIssues();
}

/**
 * Replace the issues for one item in one area.
 * entries: [{ severity: 'error'|'warning', detail }]; an empty list marks the item clean.
 */
function setItemIssues(area, item, entries, where) {
  state.issues = (state.issues || []).filter((i) => !(i.area === area && i.item === item));
  const at = new Date().toISOString();
  for (const e of entries || []) {
    if (!e?.detail) continue;
    state.issues.push({ id: area + '|' + item + '|' + state.issues.length + '|' + at, area, item, severity: e.severity || 'warning', detail: String(e.detail), at, where: where || null });
  }
}

/** Small icon for a list row: amber = warnings, red = failed. Opens the issues centre. */
function issueIconFor(area, item) {
  const all = (state.issues || []).filter((i) => i.area === area && i.item === item);
  if (!all.length) return '';
  const list = all.filter((i) => i.severity !== 'info');
  if (!list.length) {
    return h('button', { class: 'row-issue is-info', type: 'button', 'aria-label': all.length + ' automatic adjustment(s) for ' + item, 'data-tip': all.length + ' handled automatically — view details',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); setView('issues'); } }, icon('check'), h('span', { text: String(all.length) }));
  }
  const errors = list.filter((i) => i.severity === 'error').length;
  const label = errors ? errors + ' failed' + (list.length > errors ? ', ' + (list.length - errors) + ' warning' + (list.length - errors === 1 ? '' : 's') : '')
    : list.length + ' warning' + (list.length === 1 ? '' : 's');
  return h('button', {
    class: 'row-issue' + (errors ? ' is-error' : ''), type: 'button',
    'aria-label': label + ' for ' + item + '. View in Migration issues.', 'data-tip': label + ' — view in Migration issues',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); state.issuesFilter = 'all'; setView('issues'); },
  }, icon('alert'), h('span', { text: String(list.length) }));
}

function renderIssuesBadge() {
  const badge = $('issuesBadge');
  if (!badge) return;
  const list = (state.issues || []).filter((i) => i.severity !== 'info');
  const errors = list.filter((i) => i.severity === 'error').length;
  badge.hidden = !list.length;
  badge.textContent = list.length > 99 ? '99+' : String(list.length);
  badge.classList.toggle('is-error', errors > 0);
  $('issuesBtn').setAttribute('aria-label', list.length ? 'Migration issues: ' + errors + ' errors, ' + (list.length - errors) + ' warnings' : 'Migration issues: none');
}

function goToIssue(area, where) {
  const w = { ...(ISSUE_AREAS[area]?.where || {}), ...(where || {}) };
  if (w.view === 'utility') { state.utilityId = w.utilityId; setView('utility'); return; }
  if (w.view === 'source') {
    useEngine(w.sourceId);
    if (w.propelTab) state.propel.tab = w.propelTab;
    if (w.step) {
      const open = propelStepsOpen();
      open[w.step] = true;
      if (w.step === 'templates') open.clients = open.clients ?? true;
      try { localStorage.setItem(PROPEL_STEPS_KEY, JSON.stringify(open)); } catch (_e) { /* optional */ }
    }
    setView('source', { sourceId: w.sourceId });
    return;
  }
  setView('home');
}

function formatWhen(iso) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  if (mins < 1440) return Math.round(mins / 60) + ' h ago';
  return formatDate(iso);
}

function renderIssues() {
  const body = $('issuesBody');
  const all = state.issues || [];
  const list = all.filter((i) => i.severity !== 'info');
  const autoItems = all.filter((i) => i.severity === 'info');
  const filter = state.issuesFilter || 'all';
  const errors = list.filter((i) => i.severity === 'error').length;
  const warnings = list.length - errors;
  clearActionBar();
  const autoSection = autoItems.length ? h('details', { class: 'note-group tier-auto issues-auto' },
    h('summary', {}, h('span', { text: 'Handled automatically' }), h('span', { class: 'note-count', text: String(autoItems.length) })),
    h('p', { class: 'muted small', text: 'Nothing to do here: the tool adjusted these so they could be copied. Kept for your records.' }),
    ...[...new Set(autoItems.map((i) => i.area))].map((area) => h('div', { class: 'auto-group' },
      h('strong', { text: ISSUE_AREAS[area]?.label || area }),
      ...autoItems.filter((i) => i.area === area).map((i) => h('p', { text: i.item + ' — ' + i.detail }))))) : '';
  if (!list.length) {
    body.replaceChildren(h('div', { class: 'card issues-empty' },
      h('span', { class: 'state-icon ok' }, icon('check')),
      h('h2', { class: 'card-title', text: 'Nothing needs attention' }),
      h('p', { class: 'muted', text: autoItems.length ? 'Everything copied across. A few items were adjusted automatically; details are below.' : 'Warnings and failures from migrations and utilities appear here.' })), autoSection);
    return;
  }
  const shown = list.filter((i) => filter === 'all' || i.severity === filter);
  const groups = new Map();
  for (const i of shown.slice().reverse()) {
    if (!groups.has(i.area)) groups.set(i.area, new Map());
    const items = groups.get(i.area);
    if (!items.has(i.item)) items.set(i.item, []);
    items.get(i.item).push(i);
  }
  body.replaceChildren(
    h('div', { class: 'issues-summary' },
      h('span', { class: 'chip chip-danger', text: errors + ' failed' }),
      h('span', { class: 'chip chip-warn', text: warnings + ' worth a look' }),
      h('button', { class: 'link-btn', type: 'button', onclick: async () => { if (confirm('Clear all issues? This only clears this list; nothing in ScalePad CS changes.')) { state.issues = []; await saveIssues(); } } }, 'Clear all')),
    h('div', { class: 'seg seg-3', role: 'tablist', 'aria-label': 'Filter issues' },
      ...[['all', 'All · ' + list.length], ['error', 'Failed · ' + errors], ['warning', 'Worth a look · ' + warnings]].map(([id, label]) => h('button', {
        class: 'seg-btn' + (filter === id ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(filter === id),
        onclick: () => { state.issuesFilter = id; renderIssues(); },
      }, label))),
    ...[...groups].map(([area, items]) => h('section', { class: 'issue-group' },
      h('div', { class: 'issue-group-head' },
        h('h2', { text: ISSUE_AREAS[area]?.label || area }),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => goToIssue(area) }, 'Go to', icon('chevron'))),
      ...[...items].map(([item, list]) => {
        const entries = list.slice().sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
        const sev = entries.some((e) => e.severity === 'error') ? 'error' : 'warning';
        return h('article', { class: 'issue-card is-' + sev },
          h('div', { class: 'issue-top' },
            h('span', { class: 'issue-sev', 'aria-label': sev === 'error' ? 'Failed' : 'Warning' }, icon('alert')),
            h('strong', { text: item }),
            h('time', { text: formatWhen(entries[0].at), datetime: entries[0].at })),
          h('ul', { class: 'issue-lines' }, ...entries.map((e) => {
            const plain = /^[A-Z][^:]+ \(\d+\)/.test(e.detail) ? null : issueExplain(e.detail);
            return h('li', {}, plain ? h('span', { class: 'issue-plain', text: plain }) : '', h('span', { class: 'issue-detail', text: e.detail }));
          })),
          h('div', { class: 'issue-actions' },
            h('button', { class: 'link-btn', type: 'button', onclick: () => goToIssue(area, entries[0].where) }, 'Open in migration'),
            h('button', { class: 'link-btn muted-link', type: 'button', onclick: async () => { setItemIssues(area, item, []); await saveIssues(); } }, 'Dismiss')));
      }))),
    autoSection);
}

// ---------- utility detail views ----------

function utilityById(id) {
  return UTILITIES.find((u) => u.id === id) || null;
}

async function selectUtility(utility) {
  if (utility.status !== 'ready') {
    showToast(utility.name + ' is coming soon.');
    return;
  }
  state.utilityId = utility.id;
  setView('utility');
  await recordEvent('Opened utility', utility.name);
}

function renderUtility() {
  const utility = utilityById(state.utilityId);
  if (!utility) return setView('utilities');
  const head = [
    h('button', { class: 'back-btn', type: 'button', onclick: () => setView('utilities') }, icon('back'), 'Utilities'),
    h('div', { class: 'detail-head' },
      utilityIcon(utility),
      h('div', { class: 'title' }, h('h1', { id: 'utilityTitle', text: utility.name }), h('p', { text: utility.description }))),
  ];
  const body = isConnected() ? (UTILITY_RENDERERS[utility.id] || (() => ''))() : connectCallout();
  $('utilityDetail').replaceChildren(...head, body);
  if (!isConnected()) clearActionBar();
}

const UTILITY_RENDERERS = {
  'client-cleanup': renderCleanup,
  'controlmap-sync': renderControlMapSync,
  'tenant-migration': renderTenantMigration,
};

// ----- Tenant migration (v1) -----

const TENANT_OBJECTS = {
  initiatives: 'Initiatives', goals: 'Goals', notes: 'Notes', assessments: 'Assessments',
  meetings: 'Meetings', tasks: 'Tasks', agreements: 'Agreements', deliverables: 'Deliverables',
  extras: 'Initiative tags, links & files', clientTags: 'Client tags',
};
// Account-wide setup, copied once per run (cross-tenant only) and matched by name.
const TENANT_ACCOUNT = {
  tags: 'Tags', statuses: 'Initiative statuses', outcomes: 'Goal outcomes', meetingTypes: 'Meeting types',
  meetingTemplates: 'Meeting templates', taskTemplates: 'Task templates', initiativeTemplates: 'Initiative templates',
  goalTemplates: 'Goal templates', roadmapTemplates: 'Roadmap templates', agreementTemplates: 'Agreement templates',
  deliverableTemplates: 'Deliverable templates',
};

function tenantState() {
  if (!state.tenant) {
    state.tenant = {
      status: null, clients: null, loading: false, error: null, search: '', limit: 40,
      mapping: {}, selected: new Set(), objects: new Set(Object.keys(TENANT_OBJECTS)), account: new Set(Object.keys(TENANT_ACCOUNT)), ownerId: null,
      users: null, usersLoading: false, usersError: null, usersAll: false,
      run: { running: false, items: [], done: 0, phase: '' },
    };
  }
  return state.tenant;
}
function rerenderTenant() {
  if (state.view === 'utility' && state.utilityId === 'tenant-migration') renderUtility();
}

async function loadTenantStatus() {
  const t = tenantState();
  t.loading = true;
  rerenderTenant();
  const res = await send({ type: 'TENANT_STATUS' });
  t.status = res.ok ? res.data : { hasSourceKey: false };
  t.loading = false;
  if (t.status.hasSourceKey) await loadTenantClients();
  else rerenderTenant();
}

async function loadTenantClients() {
  const t = tenantState();
  t.loading = true;
  t.error = null;
  rerenderTenant();
  const res = await send({ type: 'TENANT_CLIENTS' });
  t.loading = false;
  if (res.ok) t.clients = res.data;
  else t.error = res.error;
  rerenderTenant();
  if (res.ok && !t.status?.sameTenant) await loadTenantUserMatch();
}

async function loadTenantUserMatch() {
  const t = tenantState();
  t.usersLoading = true;
  t.usersError = null;
  rerenderTenant();
  const res = await send({ type: 'TENANT_USER_MATCH' });
  t.usersLoading = false;
  if (res.ok) t.users = res.data;
  else t.usersError = res.error;
  rerenderTenant();
}

function tenantUserMap() {
  const t = tenantState();
  const map = { byId: {}, byEmail: {} };
  for (const r of t.users?.rows || []) {
    if (!r.destId) continue;
    map.byId[r.sourceId] = r.destId;
    if (r.sourceEmail) map.byEmail[r.sourceEmail] = r.destId;
  }
  return map;
}

function renderTenantUserMatch() {
  const t = tenantState();
  if (t.status?.sameTenant) return '';
  const card = h('section', { class: 'card' },
    h('h2', { class: 'card-title', text: 'Owner matching check' }),
    h('p', { class: 'field-help', text: 'Source users are paired with destination users by email, then by exact name. Owners and evaluators without a pair fall back to the destination user above. Fix a row by picking the right user.' }));
  if (t.usersLoading) { card.appendChild(h('p', { class: 'muted', text: 'Comparing users in both tenants…' })); return card; }
  if (t.usersError) {
    card.appendChild(h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', { text: t.usersError })));
    card.appendChild(h('button', { class: 'link-btn', type: 'button', onclick: loadTenantUserMatch }, 'Try again'));
    return card;
  }
  if (!t.users) return card;
  const rows = t.users.rows;
  const unmatched = rows.filter((r) => !r.destId).length;
  card.appendChild(h('div', { class: 'callout ' + (unmatched ? 'callout-warn' : 'callout-info'), style: 'margin:8px 0' }, icon('alert'),
    h('div', { text: (rows.length - unmatched) + ' of ' + rows.length + ' source users matched' + (unmatched ? ' · ' + unmatched + ' will fall back to the default user' : '') })));
  const label = { email: ['Email', 'chip-success'], name: ['Name – verify', 'chip-warn'], manual: ['Manual', 'chip-info'], none: ['Not found', 'chip-danger'] };
  const shown = t.usersAll ? rows : rows.filter((r) => r.matchedBy !== 'email');
  for (const r of shown) {
    const pick = h('select', { class: 'input range-select', 'aria-label': 'Destination user for ' + r.sourceName });
    pick.appendChild(h('option', { value: '', text: 'No match – use default user' }));
    for (const u of t.users.destUsers) pick.appendChild(h('option', { value: u.id, text: u.name + (u.email ? ' (' + u.email + ')' : '') }));
    pick.value = r.destId || '';
    pick.addEventListener('change', () => { r.destId = pick.value || null; r.matchedBy = pick.value ? 'manual' : 'none'; rerenderTenant(); });
    const [text, tone] = label[r.matchedBy];
    card.appendChild(h('div', { class: 'review-item' },
      h('div', { class: 'cleanup-row' }, h('strong', { text: r.sourceName }), h('span', { class: 'chip ' + tone, text })),
      r.sourceEmail ? h('span', { class: 'field-help', text: r.sourceEmail }) : '',
      h('div', { class: 'client-range' }, pick)));
  }
  card.appendChild(h('div', {},
    h('button', { class: 'link-btn', type: 'button', onclick: () => { t.usersAll = !t.usersAll; rerenderTenant(); } }, t.usersAll ? 'Hide email matches' : 'Show all users (' + rows.length + ')'),
    ' · ',
    h('button', { class: 'link-btn', type: 'button', onclick: loadTenantUserMatch }, 'Re-check')));
  return card;
}

async function connectTenantSource() {
  const t = tenantState();
  const input = document.getElementById('tenantSourceKey');
  const key = input?.value.trim();
  if (!key) return showToast('Paste the source tenant API key.');
  t.loading = true;
  t.error = null;
  rerenderTenant();
  const res = await send({ type: 'TENANT_SET_SOURCE_KEY', apiKey: key });
  t.loading = false;
  if (!res.ok) { t.error = 'Source key rejected: ' + res.error; rerenderTenant(); return; }
  t.status = { hasSourceKey: true, sameTenant: res.data.sameTenant };
  await loadTenantClients();
}

function tenantTarget(src) {
  const t = tenantState();
  if (src.id in t.mapping) return t.mapping[src.id] ? t.clients.dest.find((d) => d.id === t.mapping[src.id]) || null : null;
  if (t.status?.sameTenant) return null; // cloning inside one tenant: always pick the destination explicitly
  const n = window.Propel.normName(src.name);
  const hits = t.clients.dest.filter((d) => window.Propel.normName(d.name) === n);
  return hits.length === 1 ? hits[0] : null;
}

function renderTenantMigration() {
  const t = tenantState();
  if (!t.status) { if (!t.loading) queueMicrotask(loadTenantStatus); clearActionBar(); return h('p', { class: 'muted', text: 'Loading…' }); }
  if (!t.status.hasSourceKey) {
    clearActionBar();
    return h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Connect the source tenant' }),
      h('p', { class: 'muted', text: 'Data is copied FROM the tenant this key belongs to, INTO the tenant connected in Settings. The key is kept in memory only and cleared when the browser closes.' }),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'tenantSourceKey', text: 'Source tenant API key' }),
        h('input', { id: 'tenantSourceKey', class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Paste the source ScalePad API key' })),
      t.error ? h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', { text: t.error })) : '',
      h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: t.loading, onclick: connectTenantSource }, t.loading ? 'Checking…' : 'Connect Source'));
  }
  if (!t.clients) { clearActionBar(); return h('div', {}, h('p', { class: 'muted', text: t.loading ? 'Loading clients from both tenants…' : '' }), t.error ? h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', { text: t.error })) : ''); }
  return t.run.running || t.run.items.length ? renderTenantRun() : renderTenantSetup();
}

function renderTenantSetup() {
  const t = tenantState();
  const q = window.Propel.normName(t.search);
  const rows = t.clients.source.filter((c) => !q || window.Propel.normName(c.name).includes(q));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search source clients…', 'aria-label': 'Search source clients', value: t.search });
  search.addEventListener('input', () => { t.search = search.value; t.limit = 40; rerenderTenant(); const a = document.querySelector('.tenant-search input'); if (a) { a.focus(); a.setSelectionRange(a.value.length, a.value.length); } });
  const owner = h('select', { class: 'input', 'aria-label': 'Destination owner and evaluator' });
  owner.appendChild(h('option', { value: '', text: 'Choose a destination user…' }));
  for (const u of state.conn.users || []) owner.appendChild(h('option', { value: u.user_id, text: ((u.first_name || '') + ' ' + (u.last_name || '')).trim() + ' (' + u.email + ')' }));
  owner.value = t.ownerId || state.config.evaluateUserId || '';
  if (!t.ownerId && owner.value) t.ownerId = owner.value;
  owner.addEventListener('change', () => { t.ownerId = owner.value || null; mountTenantBar(); });

  mountTenantBar();
  return h('div', {},
    h('div', { class: 'callout ' + (t.status.sameTenant ? 'callout-warn' : 'callout-info'), style: 'margin:0 0 12px' }, icon('alert'),
      h('div', { text: t.status.sameTenant
        ? 'Source and destination are the same tenant: this clones client data. Pick each destination client explicitly.'
        : 'Copying from the source tenant into the tenant connected in Settings. Re-runs skip anything already copied.' })),
    t.status.sameTenant ? '' : h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Account setup' }),
      h('p', { class: 'field-help', text: 'Copied once per run. Items that already exist in the destination with the same name are reused, never duplicated. Built-in ScalePad templates are matched, not copied.' }),
      tenantChips(TENANT_ACCOUNT, t.account)),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Client data to copy' }),
      tenantChips(TENANT_OBJECTS, t.objects),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Default assigned user' }), owner,
        h('span', { class: 'field-help', text: t.status.sameTenant
          ? 'Owners, assignees and evaluators are kept as-is; this user is used only when a record has none.'
          : 'Each record keeps its source owner, assignee, creator or evaluator, matched to a destination user below. This user is used only when there is no match.' })),
      h('p', { class: 'field-help', style: 'margin-top:10px', text: 'PSA-synced agreements, contacts, hardware and tickets come from the destination’s own integrations, so they aren’t copied. Deliverables are rebuilt from their template.' })),
    renderTenantUserMatch(),
    h('div', { class: 'review-toolbar' }, h('h2', { text: 'Clients' }), h('span', { class: 'muted small', text: t.selected.size + ' selected of ' + t.clients.source.length })),
    h('div', { class: 'tenant-search client-search' }, search),
    h('div', { class: 'client-list' }, ...rows.slice(0, t.limit).map(renderTenantRow)),
    rows.length > t.limit ? h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => { t.limit += 40; rerenderTenant(); } }, 'Show more') : '',
    h('button', { class: 'link-btn', type: 'button', style: 'margin-top:8px', onclick: async () => { await send({ type: 'TENANT_SET_SOURCE_KEY', apiKey: '' }); state.tenant = null; rerenderTenant(); } }, 'Disconnect source tenant'));
}

function tenantChips(defs, set) {
  return h('div', { class: 'type-grid' }, ...Object.entries(defs).map(([k, label]) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = set.has(k);
    box.addEventListener('change', () => { box.checked ? set.add(k) : set.delete(k); mountTenantBar(); });
    return h('label', { class: 'toggle-chip' }, box, label);
  }));
}

function renderTenantRow(src) {
  const t = tenantState();
  const target = tenantTarget(src);
  const box = h('input', { type: 'checkbox', 'aria-label': 'Select ' + src.name, disabled: !target });
  box.checked = t.selected.has(src.id) && !!target;
  box.addEventListener('change', () => { box.checked ? t.selected.add(src.id) : t.selected.delete(src.id); rerenderTenant(); });
  const pick = h('select', { class: 'input range-select', 'aria-label': 'Destination client for ' + src.name });
  pick.appendChild(h('option', { value: '', text: target ? '→ ' + target.name : 'Choose destination client…' }));
  for (const d of t.clients.dest) pick.appendChild(h('option', { value: d.id, text: d.name }));
  pick.addEventListener('change', () => { if (pick.value) t.mapping[src.id] = pick.value; rerenderTenant(); });
  return h('div', { class: 'review-item' + (box.checked ? ' is-selected' : '') },
    h('label', { class: 'cleanup-row' }, box, h('strong', { text: src.name })),
    h('div', { class: 'client-range' }, h('span', { class: 'field-help', text: target ? 'Destination' : 'No match' }), pick));
}

function mountTenantBar() {
  const t = tenantState();
  const ready = t.selected.size && t.objects.size && (!['assessments', 'initiatives', 'tasks'].some((k) => t.objects.has(k)) || t.ownerId);
  mountActionBar(h('div', { class: 'action-bar' },
    h('span', { class: 'count' }, h('strong', { text: String(t.selected.size) }), ' clients'),
    h('button', { class: 'btn btn-primary', type: 'button', disabled: !ready, title: ready ? '' : 'Select clients, what to copy, and a destination user', onclick: runTenantMigration },
      'Migrate ' + (t.selected.size || '') + ' Client' + (t.selected.size === 1 ? '' : 's'))));
}

async function runTenantMigration() {
  const t = tenantState();
  const items = [...t.selected].map((id) => {
    const src = t.clients.source.find((c) => c.id === id);
    const dst = tenantTarget(src);
    return { src, dst, status: 'queued', counts: {}, warnings: [], errors: [] };
  }).filter((i) => i.dst);
  const objs = [...t.objects].map((o) => TENANT_OBJECTS[o].toLowerCase()).join(', ');
  const cross = !t.status?.sameTenant;
  const account = cross ? [...t.account] : [];
  const setupLine = account.length ? '\nAccount setup: ' + account.map((a) => TENANT_ACCOUNT[a].toLowerCase()).join(', ') + '.\n' : '';
  if (!confirm('Copy ' + objs + ' for ' + items.length + ' client(s) into the destination tenant?\n' + setupLine + '\nThis creates records in ScalePad CS. Already-copied records are skipped.')) return;
  // Account setup runs first (even with nothing selected) so client records can map tags, statuses, meeting types and templates.
  const setup = cross ? { src: { name: 'Account setup' }, dst: { name: 'destination tenant' }, status: 'queued', counts: {}, warnings: [], errors: [], account: true } : null;
  t.run = { running: true, items: setup ? [setup, ...items] : items, done: 0, phase: '' };
  rerenderTenant();
  if (setup) {
    setup.status = 'running';
    t.run.phase = account.length ? 'Copying account setup…' : 'Matching account setup…';
    rerenderTenant();
    const res = await send({ type: 'TENANT_ACCOUNT_SETUP', payload: { types: account, userMap: tenantUserMap() } });
    if (res.ok) Object.assign(setup, res.data); else setup.errors.push(res.error);
    setup.status = setup.errors.length ? (Object.values(setup.counts).some((c) => c.created) ? 'partial' : 'failed') : setup.warnings.length ? 'warning' : 'done';
    setItemIssues('tenant', 'Account setup', [...setup.errors.map((e) => ({ severity: 'error', detail: e })), ...setup.warnings.map((w) => ({ severity: 'warning', detail: w }))]);
    await saveIssues();
    t.run.done++;
    rerenderTenant();
  }
  for (const item of items) {
    item.status = 'running';
    t.run.phase = 'Copying ' + item.src.name + ' → ' + item.dst.name + '…';
    rerenderTenant();
    const res = await send({ type: 'TENANT_MIGRATE_CLIENT', payload: {
      src: item.src, dst: item.dst, objects: Object.fromEntries([...t.objects].map((o) => [o, true])), primaryUserId: t.ownerId, userMap: tenantUserMap(),
    } });
    if (res.ok) Object.assign(item, res.data);
    else item.errors.push(res.error);
    item.status = item.errors.length ? (Object.values(item.counts).some((c) => c.created) ? 'partial' : 'failed') : item.warnings.length ? 'warning' : 'done';
    setItemIssues('tenant', item.src.name + ' → ' + item.dst.name, [
      ...item.errors.map((e) => ({ severity: 'error', detail: e })),
      ...item.warnings.map((w) => ({ severity: 'warning', detail: w })),
    ]);
    await saveIssues();
    t.run.done++;
    rerenderTenant();
  }
  t.run.running = false;
  rerenderTenant();
  await recordEvent('Tenant migration', items.length + ' client(s) copied');
  showToast('Tenant migration finished.');
}

function renderTenantRun() {
  const t = tenantState();
  const run = t.run;
  const pct = run.items.length ? Math.round((run.done / run.items.length) * 100) : 0;
  const tone = { queued: 'chip-neutral', running: 'chip-info', done: 'chip-success', warning: 'chip-warn', partial: 'chip-warn', failed: 'chip-danger' };
  if (!run.running) {
    mountActionBar(h('div', { class: 'action-bar' }, h('span', { class: 'count' }, 'Finished'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { run.items = []; t.selected.clear(); rerenderTenant(); } }, 'New Migration')));
  } else clearActionBar();
  return h('section', { class: 'run-panel' },
    h('div', { class: 'review-toolbar', style: 'margin-top:0' }, h('h2', { text: run.running ? 'Migrating…' : 'Migration finished' }), h('span', { class: 'muted small', text: run.done + ' of ' + run.items.length })),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('span', { style: 'width:' + pct + '%' })),
    run.running ? h('p', { class: 'muted small', 'aria-live': 'polite', text: run.phase }) : '',
    h('div', { class: 'run-list' }, ...run.items.map((i) => h('div', { class: 'run-item' },
      h('span', { class: 'review-main' }, h('strong', { text: i.src.name + ' → ' + i.dst.name }),
        h('small', { text: Object.entries(i.counts).map(([k, c]) => c.created + ' ' + k + (c.skipped ? ' (+' + c.skipped + ' already)' : '') + (c.failed ? ', ' + c.failed + ' failed' : '')).join(' · ') || (i.status === 'queued' ? 'Queued' : '') })),
      h('span', { class: 'chip ' + tone[i.status], text: i.status[0].toUpperCase() + i.status.slice(1) }),
      (i.errors.length || i.warnings.length) ? h('details', { class: 'q-weights' }, h('summary', {}, (i.errors.length + i.warnings.length) + ' note(s)'),
        h('ul', { class: 'run-warnings' }, ...i.errors.map((e) => h('li', { text: e })), ...i.warnings.slice(0, 40).map((w) => h('li', { class: 'is-info', text: w })))) : ''))));
}

// ----- ControlMap workstream sync -----

function cmState() {
  if (!state.cm) {
    state.cm = {
      portfolio: null, spClients: null, loading: false, error: null, search: '',
      clientId: null, items: null, itemsLoading: false, tab: 'risks', selected: new Set(),
      horizon: 6, mapping: {}, preview: null, running: false, result: null,
    };
  }
  return state.cm;
}
function rerenderCm() {
  if (state.view === 'utility' && state.utilityId === 'controlmap-sync') renderUtility();
}

async function loadCmPortfolio() {
  const s = cmState();
  s.loading = true;
  s.error = null;
  rerenderCm();
  const [p, sp] = await Promise.all([send({ type: 'CM_PORTFOLIO' }), send({ type: 'LIST_SP_CLIENTS' })]);
  s.loading = false;
  if (!p.ok) s.error = p.error || 'Could not load ControlMap clients.';
  else {
    s.portfolio = p.data.sort((a, b) => b.severe - a.severe || b.high - a.high || a.name.localeCompare(b.name));
    s.spClients = sp.ok ? sp.data : [];
  }
  rerenderCm();
}

/** ControlMap client → ScalePad CS client: same id, then name, then a manual pick. */
function cmTarget(client) {
  const s = cmState();
  if (s.mapping[client.id]) return { ...s.mapping[client.id], method: 'manual' };
  const byId = s.spClients.find((c) => c.id === client.id);
  if (byId) return { id: byId.id, name: byId.name, method: 'id' };
  const n = window.Propel.normName(client.name);
  const byName = s.spClients.filter((c) => window.Propel.normName(c.name) === n);
  return byName.length === 1 ? { id: byName[0].id, name: byName[0].name, method: 'name' } : null;
}

function renderControlMapSync() {
  const s = cmState();
  if (!s.portfolio) {
    if (!s.loading && !s.error) queueMicrotask(loadCmPortfolio);
    clearActionBar();
    return h('div', {},
      s.loading ? h('p', { class: 'muted', text: 'Loading ControlMap clients…' }) : '',
      s.error ? h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', { text: s.error })) : '');
  }
  return s.clientId ? renderCmClient() : renderCmPortfolio();
}

function renderCmPortfolio() {
  const s = cmState();
  clearActionBar();
  const q = window.Propel.normName(s.search);
  const rows = s.portfolio.filter((c) => !q || window.Propel.normName(c.name).includes(q));
  const totals = s.portfolio.reduce((t, c) => ({ severe: t.severe + c.severe, high: t.high + c.high, withSevere: t.withSevere + (c.severe ? 1 : 0) }), { severe: 0, high: 0, withSevere: 0 });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search ControlMap clients…', 'aria-label': 'Search ControlMap clients', value: s.search });
  search.addEventListener('input', () => { s.search = search.value; rerenderCm(); const a = document.querySelector('.cm-search input'); if (a) { a.focus(); a.setSelectionRange(a.value.length, a.value.length); } });
  return h('div', {},
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat' }, h('strong', { text: String(s.portfolio.length) }), h('small', { text: 'clients' })),
      h('div', { class: 'stat' }, h('strong', { text: String(totals.withSevere) }), h('small', { text: 'with severe risk' })),
      h('div', { class: 'stat' }, h('strong', { text: String(totals.severe + totals.high) }), h('small', { text: 'severe + high' }))),
    h('div', { class: 'cm-search client-search' }, search),
    h('div', { class: 'client-list' }, ...rows.map((c) => h('button', { class: 'review-item cm-client', type: 'button', onclick: () => openCmClient(c.id) },
      h('span', { class: 'review-main' }, h('strong', { text: c.name }),
        h('small', { text: [c.compliance != null ? 'Compliance ' + c.compliance + '%' : null, c.actionItemsPct != null ? 'Action items ' + Math.round(c.actionItemsPct) + '% done' : null].filter(Boolean).join(' · ') || ' ' })),
      h('span', { class: 'cm-risk' },
        c.severe ? h('span', { class: 'chip chip-danger', text: c.severe + ' severe' }) : '',
        c.high ? h('span', { class: 'chip chip-warn', text: c.high + ' high' }) : '',
        !c.severe && !c.high ? h('span', { class: 'chip chip-neutral', text: c.riskLevel || 'No risks' }) : '')))));
}

async function openCmClient(id) {
  const s = cmState();
  s.clientId = id;
  s.items = null;
  s.selected = new Set();
  s.preview = null;
  s.result = null;
  s.itemsLoading = true;
  rerenderCm();
  const res = await send({ type: 'CM_CLIENT_ITEMS', clientId: id });
  s.itemsLoading = false;
  s.items = res.ok ? res.data : { risks: [], actionItems: [], error: res.error };
  rerenderCm();
}

function cmItemRow(item, type) {
  const s = cmState();
  const box = h('input', { type: 'checkbox', 'aria-label': 'Select ' + (item.code || item.id) });
  box.checked = s.selected.has(item.id);
  box.addEventListener('change', () => { box.checked ? s.selected.add(item.id) : s.selected.delete(item.id); s.preview = null; s.result = null; rerenderCm(); });
  const label = type === 'risks' ? item.current_risk_label : item.priority;
  const tone = /severe|critical/i.test(label) ? 'chip-danger' : /high/i.test(label) ? 'chip-warn' : 'chip-neutral';
  return h('label', { class: 'review-item cm-item' + (box.checked ? ' is-selected' : '') },
    box,
    h('span', { class: 'review-main' },
      h('strong', { text: (item.code ? item.code + ' · ' : '') + (item.weakness_name || item.name || 'Untitled') }),
      h('small', { text: [item.status, type === 'risks' ? item.risk_category : item.responsible_department, item.planned_completion_date ? 'Due ' + String(item.planned_completion_date).slice(0, 10) : null].filter(Boolean).join(' · ') })),
    label ? h('span', { class: 'chip ' + tone, text: label }) : '');
}

function renderCmClient() {
  const s = cmState();
  const client = s.portfolio.find((c) => c.id === s.clientId);
  const target = cmTarget(client);
  const back = h('button', { class: 'link-btn', type: 'button', onclick: () => { s.clientId = null; rerenderCm(); } }, '← All ControlMap clients');
  if (!s.items) { clearActionBar(); return h('div', {}, back, h('p', { class: 'muted', text: 'Loading risks and action items…' })); }

  const list = s.tab === 'risks' ? s.items.risks : s.items.actionItems;
  const picker = h('select', { class: 'input', 'aria-label': 'ScalePad CS client for ' + client.name });
  picker.appendChild(h('option', { value: '', text: target ? 'Matched: ' + target.name : 'Choose a ScalePad CS client…' }));
  for (const c of s.spClients) picker.appendChild(h('option', { value: c.id, text: c.name }));
  picker.addEventListener('change', () => {
    const c = s.spClients.find((x) => x.id === picker.value);
    if (c) s.mapping[client.id] = { id: c.id, name: c.name };
    s.preview = null;
    rerenderCm();
  });
  const horizon = h('select', { class: 'input range-select', 'aria-label': 'Default horizon' });
  for (const m of [3, 6, 12]) horizon.appendChild(h('option', { value: String(m), text: m + ' months' }));
  horizon.value = String(s.horizon);
  horizon.addEventListener('change', () => { s.horizon = Number(horizon.value); s.preview = null; rerenderCm(); });

  const allOn = list.length && list.every((i) => s.selected.has(i.id));
  mountCmBar(target);
  return h('div', {},
    back,
    h('h2', { class: 'card-title', style: 'margin:10px 0 8px', text: client.name }),
    h('section', { class: 'card' },
      h('div', { class: 'field', style: 'margin-top:0' }, h('span', { class: 'field-label', text: 'Sync into ScalePad CS client' }), picker,
        h('span', { class: 'field-help', text: target ? 'Matched by ' + ({ id: 'client ID', name: 'name', manual: 'you' }[target.method]) + '.' : 'No automatic match — choose the client.' })),
      h('div', { class: 'client-range' }, h('span', { class: 'field-help', text: 'Schedule items without dates' }), horizon)),
    h('div', { class: 'seg', role: 'tablist', style: 'margin-top:14px' },
      ...[['risks', 'Risks', s.items.risks.length], ['action_items', 'Action items', s.items.actionItems.length]].map(([id, label, n]) => h('button', {
        class: 'seg-btn' + (s.tab === id ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(s.tab === id),
        onclick: () => { s.tab = id; s.selected = new Set(); s.preview = null; s.result = null; rerenderCm(); },
      }, label + ' · ' + n))),
    s.items.error ? h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', {},
      h('div', { text: s.items.error }),
      h('button', { class: 'link-btn', type: 'button', style: 'margin-top:4px', onclick: () => openCmClient(s.clientId) }, 'Try again'))) : '',
    list.length ? h('div', { class: 'review-toolbar', style: 'margin-top:0' },
      h('span', { class: 'muted small', text: s.selected.size + ' of ' + list.length + ' selected' }),
      h('button', { class: 'link-btn', type: 'button', onclick: () => { s.selected = allOn ? new Set() : new Set(list.map((i) => i.id)); s.preview = null; rerenderCm(); } }, allOn ? 'Clear' : 'Select all')) : '',
    s.preview ? cmSummaryCard('Preview (no changes made)', s.preview) : '',
    s.result ? cmSummaryCard('Sync finished', s.result) : '',
    list.length ? h('div', { class: 'client-list' }, ...list.map((i) => cmItemRow(i, s.tab))) : h('p', { class: 'empty', text: 'Nothing here.' }));
}

function cmSummaryCard(title, r) {
  return h('section', { class: 'card', style: 'margin-bottom:12px' },
    h('h2', { class: 'card-title', text: title }),
    h('p', { class: 'muted', text: r.created + ' to create · ' + r.updated + ' to update · ' + r.unchanged + ' unchanged' + (r.skipped ? ' · ' + r.skipped + ' skipped (Not Applicable)' : '') }),
    r.errors?.length ? h('ul', { class: 'run-warnings' }, ...r.errors.slice(0, 20).map((e) => h('li', { text: e }))) : '');
}

function mountCmBar(target) {
  const s = cmState();
  const count = s.selected.size;
  const ready = count && target && !s.running;
  let button;
  if (!s.preview) {
    button = h('button', { class: 'btn btn-secondary', type: 'button', disabled: !ready, onclick: () => runCmSync(true) }, s.running ? 'Checking…' : 'Preview Sync');
  } else {
    button = h('button', { class: 'btn btn-primary', type: 'button', disabled: !ready, onclick: () => runCmSync(false) }, s.running ? 'Syncing…' : 'Sync ' + count + ' to ScalePad CS');
  }
  mountActionBar(h('div', { class: 'action-bar' }, h('span', { class: 'count' }, h('strong', { text: String(count) }), ' selected'), button));
}

async function runCmSync(dryRun) {
  const s = cmState();
  const client = s.portfolio.find((c) => c.id === s.clientId);
  const target = cmTarget(client);
  const list = s.tab === 'risks' ? s.items.risks : s.items.actionItems;
  s.running = true;
  rerenderCm();
  const res = await send({ type: 'CM_SYNC', payload: {
    cmClientId: client.id, lmClient: { id: target.id, name: target.name }, sourceType: s.tab,
    items: list.filter((i) => s.selected.has(i.id)), horizonMonths: s.horizon, dryRun,
  } });
  s.running = false;
  const summary = res.ok ? res.data : { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [res.error] };
  if (dryRun) s.preview = summary;
  else {
    s.result = summary;
    s.preview = null;
    setItemIssues('controlmap', client.name + ' · ' + (s.tab === 'risks' ? 'Risks' : 'Action items'), (summary.errors || []).map((e) => ({ severity: 'error', detail: e })));
    await saveIssues();
    await recordEvent('ControlMap sync', client.name + ': ' + summary.created + ' created, ' + summary.updated + ' updated');
    showToast('ControlMap sync finished.');
  }
  rerenderCm();
}

// ----- Client Clean Up -----
// ----- Client Clean Up: Templates & tags mode -----

const ACCOUNT_TYPES = {
  'assessment-templates': 'Assessment', 'initiative-templates': 'Initiative', 'roadmap-templates': 'Roadmap',
  'goal-templates': 'Goal', 'task-templates': 'Task', 'deliverable-templates': 'Deliverable',
  'agreement-templates': 'Agreement', tags: 'Tags',
};

function tplState() {
  const c = cleanupState();
  if (!c.tpl) c.tpl = { types: new Set(['assessment-templates', 'initiative-templates']), items: null, loading: false, error: null, search: '', selected: new Set(), confirm: { ack: false, typed: '' }, stage: 'select', results: null, running: false };
  return c.tpl;
}

async function loadAccountItems() {
  const t = tplState();
  t.loading = true;
  t.error = null;
  t.items = null;
  t.selected = new Set();
  rerenderCleanup();
  const res = await send({ type: 'CLEANUP_LIST_ACCOUNT_ITEMS', types: [...t.types] });
  t.loading = false;
  if (res.ok) t.items = res.data.sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
  else t.error = res.error;
  rerenderCleanup();
}

const tplKey = (i) => i.type + ':' + i.id;

function renderTemplateCleanup() {
  const t = tplState();
  if (t.stage === 'done') return renderTemplateResults();
  const typeChips = h('div', { class: 'type-grid' }, ...Object.entries(ACCOUNT_TYPES).map(([type, label]) => {
    const box = h('input', { type: 'checkbox', disabled: t.stage === 'confirm' });
    box.checked = t.types.has(type);
    box.addEventListener('change', () => { box.checked ? t.types.add(type) : t.types.delete(type); t.items = null; rerenderCleanup(); });
    return h('label', { class: 'toggle-chip' }, box, label);
  }));
  const parts = [
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Types' }),
      h('p', { class: 'muted small', text: 'Only your account\'s own templates are listed. ScalePad-provided templates are never shown or deleted.' }),
      typeChips,
      !t.items ? h('button', { class: 'btn btn-secondary btn-block', type: 'button', disabled: !t.types.size || t.loading, onclick: loadAccountItems }, icon('scan'), t.loading ? 'Loading…' : 'Load Items') : ''),
    t.error ? h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', { text: t.error })) : '',
  ];
  if (t.items) {
    const q = window.Propel.normName(t.search);
    const shown = t.items.filter((i) => !q || window.Propel.normName(i.name).includes(q));
    const allOn = shown.length && shown.every((i) => t.selected.has(tplKey(i)));
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name…', 'aria-label': 'Search templates and tags', value: t.search });
    search.addEventListener('input', () => { t.search = search.value; rerenderCleanup(); const a = document.querySelector('.tpl-search input'); if (a) { a.focus(); a.setSelectionRange(a.value.length, a.value.length); } });
    parts.push(
      h('div', { class: 'review-toolbar' },
        h('h2', { text: t.items.length + ' items' }),
        h('button', { class: 'link-btn', type: 'button', disabled: t.stage === 'confirm', onclick: () => { for (const i of shown) allOn ? t.selected.delete(tplKey(i)) : t.selected.add(tplKey(i)); rerenderCleanup(); } }, allOn ? 'Clear shown' : 'Select all shown')),
      h('div', { class: 'tpl-search client-search' }, search),
      h('div', { class: 'client-list' }, ...shown.map((i) => {
        const box = h('input', { type: 'checkbox', 'aria-label': 'Select ' + i.name, disabled: t.stage === 'confirm' });
        box.checked = t.selected.has(tplKey(i));
        box.addEventListener('change', () => { box.checked ? t.selected.add(tplKey(i)) : t.selected.delete(tplKey(i)); rerenderCleanup(); });
        return h('label', { class: 'review-item cm-item' + (box.checked ? ' is-selected' : '') }, box,
          h('span', { class: 'review-main' }, h('strong', { text: i.name }), i.detail ? h('small', { text: i.detail }) : ''),
          h('span', { class: 'chip chip-neutral', text: i.label }));
      })));
  }
  if (t.stage === 'confirm') {
    const ack = h('input', { type: 'checkbox' });
    ack.checked = t.confirm.ack;
    ack.addEventListener('change', () => { t.confirm.ack = ack.checked; mountTemplateBar(); });
    const typed = h('input', { class: 'input', type: 'text', placeholder: 'Type DELETE', 'aria-label': 'Type DELETE to confirm', value: t.confirm.typed, autocomplete: 'off' });
    typed.addEventListener('input', () => { t.confirm.typed = typed.value; mountTemplateBar(); });
    parts.unshift(h('section', { class: 'card', style: 'margin-bottom:12px' },
      h('h2', { class: 'card-title', text: 'Confirm deletion of ' + t.selected.size + ' item(s)' }),
      h('p', { class: 'muted small', text: 'Templates already used by assessments or initiatives may be refused by ScalePad; those are reported, not forced.' }),
      h('label', { class: 'confirm-row' }, ack, 'I understand these templates and tags will be permanently deleted from this account.'),
      h('div', { class: 'field' }, h('label', { class: 'field-label', text: 'Type DELETE to confirm' }), typed),
      h('button', { class: 'link-btn', type: 'button', style: 'margin-top:8px', onclick: () => { t.stage = 'select'; rerenderCleanup(); } }, 'Back to selection')));
  }
  mountTemplateBar();
  return h('div', {}, ...parts);
}

function mountTemplateBar() {
  const t = tplState();
  let button;
  if (t.stage === 'confirm') {
    const ready = t.confirm.ack && t.confirm.typed.trim() === 'DELETE' && !t.running;
    button = h('button', { class: 'btn btn-danger', type: 'button', disabled: !ready, onclick: runTemplateCleanup }, t.running ? 'Deleting…' : 'Delete Permanently');
  } else {
    button = h('button', { class: 'btn btn-primary', type: 'button', disabled: !t.selected.size, onclick: () => { t.stage = 'confirm'; t.confirm = { ack: false, typed: '' }; rerenderCleanup(); } }, 'Review ' + (t.selected.size || '') + ' Selected');
  }
  mountActionBar(h('div', { class: 'action-bar' }, h('span', { class: 'count' }, h('strong', { text: String(t.selected.size) }), ' selected'), button));
}

async function runTemplateCleanup() {
  const t = tplState();
  const items = t.items.filter((i) => t.selected.has(tplKey(i)));
  t.running = true;
  mountTemplateBar();
  const res = await send({ type: 'CLEANUP_DELETE_ACCOUNT_ITEMS', items });
  t.running = false;
  t.results = res.ok ? res.data : items.map((i) => ({ ...i, ok: false, detail: res.error }));
  t.stage = 'done';
  for (const r of t.results) setItemIssues('cleanup', r.label + ': ' + r.name, r.ok ? [] : [{ severity: 'error', detail: 'Not deleted: ' + r.detail }]);
  await saveIssues();
  const ok = t.results.filter((r) => r.ok).length;
  await recordEvent('Template clean up', ok + ' of ' + items.length + ' deleted');
  showToast(ok + ' of ' + items.length + ' deleted.');
  rerenderCleanup();
}

function renderTemplateResults() {
  const t = tplState();
  const ok = t.results.filter((r) => r.ok).length;
  mountActionBar(h('div', { class: 'action-bar' }, h('span', { class: 'count' }, 'Finished'),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { t.stage = 'select'; t.results = null; loadAccountItems(); } }, 'Done')));
  return h('section', { class: 'run-panel' },
    h('div', { class: 'review-toolbar', style: 'margin-top:0' }, h('h2', { text: 'Clean up finished' }), h('span', { class: 'muted small', text: ok + ' deleted · ' + (t.results.length - ok) + ' refused' })),
    h('div', { class: 'run-list' }, ...t.results.map((r) => h('div', { class: 'run-item' },
      h('span', { class: 'review-main' }, h('strong', { text: r.name }), h('small', { text: r.label + (r.ok ? '' : ' — ' + r.detail) })),
      h('span', { class: 'chip ' + (r.ok ? 'chip-success' : 'chip-danger'), text: r.ok ? 'Deleted' : 'Refused' })))));
}


const CLEANUP_TYPE_LABELS = {
  'action-items': 'Action items', notes: 'Notes', assessments: 'Assessments', deliverables: 'Deliverables',
  meetings: 'Meetings', contracts: 'Contracts', goals: 'Goals', initiatives: 'Initiatives',
};
const CLEANUP_PAGE = 40;

function cleanupState() {
  if (!state.cleanup) {
    state.cleanup = {
      clients: null, loading: false, error: null, search: '', limit: CLEANUP_PAGE,
      selected: new Set(), types: new Set(Object.keys(CLEANUP_TYPE_LABELS)),
      preview: null, previewing: false, confirm: { ack: false, typed: '' },
      run: { running: false, paused: false, items: [], done: 0, phase: '' },
    };
  }
  return state.cleanup;
}

function rerenderCleanup() {
  if (state.view === 'utility' && state.utilityId === 'client-cleanup') renderUtility();
}

async function loadCleanupClients() {
  const c = cleanupState();
  c.loading = true;
  c.error = null;
  rerenderCleanup();
  const res = await send({ type: 'LIST_LMX_CLIENTS' });
  c.loading = false;
  if (res.ok) c.clients = (res.data || []).map((x) => ({ id: x.id, name: x.label || x.name || x.id })).sort((a, b) => a.name.localeCompare(b.name));
  else c.error = res.error || 'Could not load clients.';
  rerenderCleanup();
}

function renderCleanup() {
  const c = cleanupState();
  if (!c.clients) {
    if (!c.loading && !c.error) queueMicrotask(loadCleanupClients);
    clearActionBar();
    return h('div', {},
      c.loading ? h('p', { class: 'muted', text: 'Loading ScalePad CS clients…' }) : '',
      c.error ? h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', { text: c.error })) : '');
  }
  const run = c.run;
  const busy = run.running || c.tpl?.running;
  const mode = c.mode || 'clients';
  const modes = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Clean up mode' },
    ...[['clients', 'Client data'], ['templates', 'Templates & tags']].map(([id, label]) => h('button', {
      class: 'seg-btn' + (mode === id ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(mode === id), disabled: busy,
      onclick: () => { c.mode = id; rerenderCleanup(); },
    }, label)));
  const banner = h('div', { class: 'callout callout-danger', style: 'margin:0 0 14px' }, icon('alert'),
    h('div', {}, h('strong', { text: 'Permanent deletion. ' }), 'Items removed here cannot be restored.'));
  if (mode === 'templates') return h('div', {}, modes, banner, renderTemplateCleanup());
  const stage = run.running || run.items.length ? 'run' : c.preview ? 'confirm' : 'select';
  const out = h('div', {}, modes, banner,
    stage === 'run' ? renderCleanupRun() : stage === 'confirm' ? renderCleanupConfirm() : renderCleanupSelect());
  mountCleanupBar(stage);
  return out;
}

function renderCleanupSelect() {
  const c = cleanupState();
  const q = window.Propel.normName(c.search);
  const rows = c.clients.filter((x) => !q || window.Propel.normName(x.name).includes(q));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search clients…', 'aria-label': 'Search clients', value: c.search });
  search.addEventListener('input', () => {
    c.search = search.value;
    c.limit = CLEANUP_PAGE;
    rerenderCleanup();
    const again = document.querySelector('.cleanup-search input');
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });
  return h('div', {},
    h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Record types' }),
      h('div', { class: 'type-grid' }, ...Object.entries(CLEANUP_TYPE_LABELS).map(([type, label]) => {
        const box = h('input', { type: 'checkbox' });
        box.checked = c.types.has(type);
        box.addEventListener('change', () => { box.checked ? c.types.add(type) : c.types.delete(type); rerenderCleanup(); });
        return h('label', { class: 'toggle-chip' }, box, label);
      }))),
    h('div', { class: 'review-toolbar' },
      h('h2', { text: 'Clients' }),
      h('span', { class: 'muted small', text: c.selected.size + ' selected of ' + c.clients.length })),
    h('div', { class: 'cleanup-search client-search' }, search),
    h('div', { class: 'client-list' }, ...rows.slice(0, c.limit).map((client) => {
      const box = h('input', { type: 'checkbox', 'aria-label': 'Select ' + client.name });
      box.checked = c.selected.has(client.id);
      box.addEventListener('change', () => { box.checked ? c.selected.add(client.id) : c.selected.delete(client.id); rerenderCleanup(); });
      return h('label', { class: 'review-item cleanup-row' + (box.checked ? ' is-selected' : '') }, box, h('strong', { text: client.name }));
    })),
    rows.length > c.limit ? h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => { c.limit += CLEANUP_PAGE; rerenderCleanup(); } },
      'Show ' + Math.min(CLEANUP_PAGE, rows.length - c.limit) + ' more of ' + (rows.length - c.limit)) : '');
}

async function previewCleanup() {
  const c = cleanupState();
  c.previewing = true;
  c.preview = null;
  rerenderCleanup();
  const preview = [];
  for (const id of c.selected) {
    const client = c.clients.find((x) => x.id === id);
    const res = await send({ type: 'CLEANUP_PREVIEW', payload: { clientId: id, types: [...c.types] } });
    preview.push({ id, name: client?.name || id, counts: res.ok ? res.data : {}, error: res.ok ? null : res.error });
  }
  c.previewing = false;
  c.preview = preview;
  c.confirm = { ack: false, typed: '' };
  rerenderCleanup();
}

function previewTotal(entry) {
  return Object.values(entry.counts).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0);
}

function renderCleanupConfirm() {
  const c = cleanupState();
  const grand = c.preview.reduce((n, e) => n + previewTotal(e), 0);
  const ack = h('input', { type: 'checkbox' });
  ack.checked = c.confirm.ack;
  ack.addEventListener('change', () => { c.confirm.ack = ack.checked; mountCleanupBar('confirm'); });
  const typed = h('input', { class: 'input', type: 'text', placeholder: 'Type DELETE', 'aria-label': 'Type DELETE to confirm', value: c.confirm.typed, autocomplete: 'off' });
  typed.addEventListener('input', () => { c.confirm.typed = typed.value; mountCleanupBar('confirm'); });
  return h('div', {},
    h('div', { class: 'review-toolbar', style: 'margin-top:0' },
      h('h2', { text: 'Preview' }),
      h('button', { class: 'link-btn', type: 'button', onclick: () => { c.preview = null; rerenderCleanup(); } }, 'Back to selection')),
    h('div', { class: 'client-list' }, ...c.preview.map((e) => h('div', { class: 'review-item' },
      h('div', { class: 'client-top' }, h('strong', { text: e.name }), h('span', { class: 'chip ' + (previewTotal(e) ? 'chip-danger' : 'chip-neutral'), text: previewTotal(e) + ' records' })),
      e.error ? h('p', { class: 'q-error', text: e.error }) : h('p', { class: 'muted small', text: Object.entries(e.counts)
        .map(([t, v]) => CLEANUP_TYPE_LABELS[t] + ' ' + (typeof v === 'number' ? v : 'error')).join(' · ') })))),
    h('section', { class: 'card', style: 'margin-top:14px' },
      h('h2', { class: 'card-title', text: 'Confirm deletion of ' + grand + ' records' }),
      h('label', { class: 'confirm-row' }, ack, 'I understand these records will be permanently deleted from ScalePad CS.'),
      h('div', { class: 'field' }, h('label', { class: 'field-label', text: 'Type DELETE to confirm' }), typed)));
}

function renderCleanupRun() {
  const run = cleanupState().run;
  const pct = run.items.length ? Math.round((run.done / run.items.length) * 100) : 0;
  const totals = run.items.reduce((t, i) => { for (const r of Object.values(i.results)) { t.deleted += r.deleted || 0; t.failed += (r.failures || []).length; } return t; }, { deleted: 0, failed: 0 });
  return h('section', { class: 'run-panel' },
    h('div', { class: 'review-toolbar', style: 'margin-top:0' },
      h('h2', { text: run.running ? (run.paused ? 'Paused' : 'Deleting…') : 'Clean up finished' }),
      h('span', { class: 'muted small', text: totals.deleted + ' deleted · ' + totals.failed + ' failed' })),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('span', { style: 'width:' + pct + '%' })),
    run.running ? h('p', { class: 'muted small', 'aria-live': 'polite', text: run.paused ? 'Paused after the current record type.' : run.phase }) : '',
    h('div', { class: 'run-list' }, ...run.items.map((i) => h('div', { class: 'run-item' },
      h('span', { class: 'review-main' }, h('strong', { text: i.name }),
        h('small', { text: Object.entries(i.results).map(([t, r]) => CLEANUP_TYPE_LABELS[t] + ' ' + (r.error ? 'failed' : r.deleted + '/' + r.total)).join(' · ') || 'Queued' })),
      h('span', { class: 'chip ' + ({ queued: 'chip-neutral', running: 'chip-info', done: 'chip-success', partial: 'chip-warn', failed: 'chip-danger' }[i.status]), text: i.status[0].toUpperCase() + i.status.slice(1) })))));
}

function mountCleanupBar(stage) {
  const c = cleanupState();
  const run = c.run;
  let left;
  let button;
  if (stage === 'select') {
    left = h('span', { class: 'count' }, h('strong', { text: String(c.selected.size) }), ' clients · ', h('strong', { text: String(c.types.size) }), ' types');
    button = h('button', { class: 'btn btn-primary', type: 'button', disabled: !c.selected.size || !c.types.size || c.previewing, onclick: previewCleanup }, c.previewing ? 'Counting…' : 'Preview Counts');
  } else if (stage === 'confirm') {
    const ready = c.confirm.ack && c.confirm.typed.trim() === 'DELETE' && c.preview.some((e) => previewTotal(e) > 0);
    left = h('span', { class: 'count' }, h('strong', { text: String(c.preview.reduce((n, e) => n + previewTotal(e), 0)) }), ' records');
    button = h('button', { class: 'btn btn-danger', type: 'button', disabled: !ready, onclick: runCleanup }, 'Delete Permanently');
  } else if (run.running) {
    left = h('span', { class: 'count' }, h('strong', { text: run.done + ' / ' + run.items.length }), ' clients done');
    button = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { run.paused = !run.paused; rerenderCleanup(); } }, run.paused ? 'Resume' : 'Pause');
  } else {
    left = h('span', { class: 'count' }, 'Finished');
    button = h('div', { class: 'btn-row', style: 'margin:0' },
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: exportCleanupCsv }, 'Export CSV'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { run.items = []; c.preview = null; c.selected.clear(); rerenderCleanup(); } }, 'New Clean Up'));
  }
  mountActionBar(h('div', { class: 'action-bar' }, left, button));
}

async function runCleanup() {
  const c = cleanupState();
  const run = c.run;
  const types = Object.keys(CLEANUP_TYPE_LABELS).filter((t) => c.types.has(t)); // children-first order
  run.items = c.preview.filter((e) => previewTotal(e) > 0).map((e) => ({ id: e.id, name: e.name, status: 'queued', results: {} }));
  run.done = 0;
  run.running = true;
  run.paused = false;
  rerenderCleanup();
  for (const item of run.items) {
    item.status = 'running';
    for (const type of types) {
      while (run.paused) await new Promise((r) => setTimeout(r, 400));
      run.phase = item.name + ': deleting ' + CLEANUP_TYPE_LABELS[type].toLowerCase() + '…';
      rerenderCleanup();
      const res = await send({ type: 'CLEANUP_DELETE_TYPE', payload: { clientId: item.id, type } });
      item.results[type] = res.ok ? res.data : { total: 0, deleted: 0, failures: [], error: res.error };
    }
    const results = Object.values(item.results);
    const failed = results.some((r) => r.error || r.failures?.length);
    const deletedAny = results.some((r) => r.deleted);
    item.status = !failed ? 'done' : deletedAny ? 'partial' : 'failed';
    setItemIssues('cleanup', item.name, Object.entries(item.results).flatMap(([type, r]) => (r.error
      ? [{ severity: 'error', detail: CLEANUP_TYPE_LABELS[type] + ': ' + r.error }]
      : (r.failures || []).map((f) => ({ severity: 'error', detail: CLEANUP_TYPE_LABELS[type] + ' record ' + f.id + ' not deleted: ' + f.detail })))));
    await saveIssues();
    run.done++;
    rerenderCleanup();
  }
  run.running = false;
  run.phase = '';
  rerenderCleanup();
  const deleted = run.items.reduce((n, i) => n + Object.values(i.results).reduce((m, r) => m + (r.deleted || 0), 0), 0);
  await recordEvent('Client clean up', deleted + ' records deleted across ' + run.items.length + ' client(s)');
  showToast('Clean up finished: ' + deleted + ' records deleted.');
}

function exportCleanupCsv() {
  const rows = [['client', 'record_type', 'total', 'deleted', 'failed_record_id', 'detail']];
  for (const i of cleanupState().run.items) {
    for (const [type, r] of Object.entries(i.results)) {
      if (r.failures?.length) for (const f of r.failures) rows.push([i.name, type, r.total, r.deleted, f.id, f.detail]);
      else rows.push([i.name, type, r.total, r.deleted, '', r.error || '']);
    }
  }
  const csv = rows.map((row) => row.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'client-cleanup-' + new Date().toISOString().slice(0, 10) + '.csv' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- settings ----------

function renderSettings() {
  const body = $('settingsBody');
  const hasKey = !!state.config.apiKey;
  const status = state.conn.status;
  const ok = status === 'ok';

  // API connection card
  const keyInput = h('input', {
    id: 'apiKeyInput', class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: hasKey ? '•••••••••••••••• (saved)' : 'Paste your ScalePad API key',
  });
  const toggle = h('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Show or hide API key', 'data-tip': 'Show / hide',
    onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; },
  }, icon('eye'));
  const stateText = {
    ok: ['Connected', 'API key verified · ' + state.conn.users.length + ' active user(s) found'],
    bad: ['Connection failed', state.conn.error || 'The saved key was rejected.'],
    none: ['Not connected', 'Add an API key to enable migrations.'],
    checking: ['Checking…', 'Verifying the saved API key.'],
    unknown: ['Checking…', 'Verifying the saved API key.'],
  }[status];

  const apiCard = h('section', { class: 'card', 'aria-labelledby': 'apiCardTitle' },
    h('div', { class: 'status-row' },
      h('span', { class: 'state-icon ' + (ok ? 'ok' : (status === 'bad' || status === 'none') ? 'bad' : '') }, icon(ok ? 'check' : 'key')),
      h('div', {}, h('strong', { id: 'apiCardTitle', text: 'ScalePad CS API · ' + stateText[0] }), h('small', { text: stateText[1] })),
    ),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'apiKeyInput', text: hasKey ? 'Replace API key' : 'API key' }),
      h('div', { class: 'input-group' }, keyInput, toggle),
      h('span', { class: 'field-help', text: 'Stored locally in this browser profile. Requests go to api.scalepad.com only.' }),
    ),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: saveApiKey }, ok && !hasKey ? 'Save' : 'Save & Test'),
      hasKey ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => verifyConnection(true) }, 'Test') : '',
    ),
    hasKey ? h('button', { class: 'btn btn-danger-ghost btn-block', type: 'button', onclick: removeApiKey }, 'Remove API Key') : '',
  );

  // defaults
  const evaluator = h('select', { id: 'evaluatorSelect', class: 'input', disabled: !ok });
  fillEvaluatorSelect(evaluator);
  evaluator.addEventListener('change', async () => {
    state.config.evaluateUserId = evaluator.value;
    await send({ type: 'SET_EVALUATE_USER', evaluateUserId: evaluator.value });
    showToast('Default assigned user saved.');
    renderRail();
  });
  const defaultsCard = h('section', { class: 'card', 'aria-labelledby': 'defaultsTitle' },
    h('h2', { id: 'defaultsTitle', class: 'card-title', text: 'Migration defaults' }),
    h('p', { class: 'muted', text: 'Each migrated item keeps its owner: the person who owns, created or evaluated it in the source is matched to a ScalePad user by email, then by name.' }),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'evaluatorSelect', text: 'Default assigned user' }),
      evaluator,
      h('span', { class: 'field-help', text: ok ? 'Used only when the source person can’t be matched to a ScalePad user, for owners, assignees and assessment evaluators.' : 'Connect the API to load users.' }),
    ),
  );

  // source access
  const accessCard = h('section', { class: 'card', 'aria-labelledby': 'accessTitle' },
    h('h2', { id: 'accessTitle', class: 'card-title', text: 'Source page access' }),
    h('p', { class: 'muted', text: 'The utility reads pages on these sites only after you allow it.' }),
    h('div', { style: 'margin-top:8px' }, ...SOURCES.map((source) => {
      const granted = !!state.access[source.id];
      return h('div', { class: 'access-row' },
        makeLogo(source),
        h('span', {}, h('strong', { text: source.name }), h('small', { text: source.origins[0].replace('https://', '').replace('/*', '') })),
        granted
          ? h('span', { class: 'chip chip-success', text: 'Allowed' })
          : h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => requestAccess(source) }, 'Allow'),
      );
    })),
  );

  body.replaceChildren(apiCard, defaultsCard, accessCard);
}

function fillEvaluatorSelect(select) {
  select.replaceChildren();
  if (!state.conn.users.length) {
    select.appendChild(h('option', { value: '', text: isConnected() ? 'No active users found' : 'Not connected' }));
    return;
  }
  select.appendChild(h('option', { value: '', text: 'Select a user…' }));
  for (const user of state.conn.users) {
    const name = ((user.first_name || '') + ' ' + (user.last_name || '')).trim();
    select.appendChild(h('option', { value: user.user_id, text: name + ' (' + user.email + ')' }));
  }
  select.value = state.config.evaluateUserId || '';
}

async function saveApiKey() {
  const input = $('apiKeyInput');
  const apiKey = input?.value.trim();
  if (!apiKey) {
    showToast('Paste an API key first.');
    input?.focus();
    return;
  }
  await send({ type: 'SET_API_KEY', apiKey });
  state.config.apiKey = apiKey;
  await verifyConnection(true);
  if (isConnected()) await recordEvent('Connected ScalePad CS', 'API key verified');
}

async function removeApiKey() {
  if (!confirm('Remove the saved ScalePad CS API key from this browser?')) return;
  await send({ type: 'SET_API_KEY', apiKey: null });
  state.config.apiKey = null;
  state.conn = { status: 'none', users: [], error: null };
  showToast('API key removed.');
  refreshChrome();
}

async function verifyConnection(announce = false) {
  if (!state.config.apiKey) {
    state.conn = { status: 'none', users: [], error: null };
    refreshChrome();
    return;
  }
  state.conn.status = 'checking';
  refreshChrome();
  const response = await send({ type: 'RECENT_EVALUATORS' });
  if (response.ok) {
    state.conn = { status: 'ok', users: response.data || [], error: null };
    if (announce) showToast('Connected to ScalePad CS.');
  } else {
    state.conn = { status: 'bad', users: [], error: response.error };
    if (announce) showToast('Connection failed: ' + (response.error || 'unknown error'));
  }
  refreshChrome();
}

function refreshChrome() {
  renderRail();
  renderFooter();
  if (state.view === 'settings') renderSettings();
  if (state.view === 'home') renderHome();
  if (state.view === 'source') renderSource();
  setRailActive();
}

function setRailActive() {
  for (const button of document.querySelectorAll('.rail-source')) {
    button.classList.toggle('is-active', state.view === 'source' && button.dataset.source === state.sourceId);
  }
}

// ---------- state + context ----------

async function loadState() {
  state.tab = await activeTab();
  const response = await send({ type: 'GET_SIDE_PANEL_STATE', tabId: state.tab?.id });
  if (response.ok && response.data) state.data = response.data;
  renderContextBar();
}

async function refreshContext({ silent = false } = {}) {
  if (refreshInFlight) return;
  state.tab = await activeTab();
  if (!state.tab?.id) {
    renderContextBar();
    if (!silent) showToast('No active tab is available.');
    return;
  }
  refreshInFlight = true;
  $('refreshContextBtn').disabled = true;
  const response = await send({ type: 'GET_SIDE_PANEL_CONTEXT', tabId: state.tab.id });
  refreshInFlight = false;
  $('refreshContextBtn').disabled = false;
  if (response.ok) state.data = response.data;
  renderContextBar();
  if (state.view === 'home') renderHome();
  if (!silent) showToast(response.ok ? 'Page refreshed.' : (response.error || 'This page cannot be read.'));
}

async function recordEvent(label, detail) {
  const response = await send({ type: 'RECORD_SIDE_PANEL_EVENT', tabId: state.tab?.id, event: { label, detail } });
  if (response.ok) {
    state.data = response.data;
  }
}

async function loadAccess() {
  for (const source of SOURCES) {
    if (source.alwaysGranted) { state.access[source.id] = true; continue; }
    const response = await send({ type: 'GET_VENDOR_ACCESS', origins: source.origins });
    state.access[source.id] = !!response.data?.granted;
  }
}

async function requestAccess(source) {
  const granted = await new Promise((resolve) => {
    if (!chrome.permissions?.request) return resolve(false);
    chrome.permissions.request({ origins: source.origins }, (result) => resolve(!chrome.runtime.lastError && !!result));
  });
  if (!granted) {
    showToast('Page access was not granted for ' + source.name + '.');
    return false;
  }
  state.access[source.id] = true;
  showToast(source.name + ' page access allowed.');
  if (state.view === 'settings') renderSettings();
  if (state.view === 'source') renderSource();
  return true;
}

async function openSourceInActiveTab(source) {
  state.tab = await activeTab();
  if (!state.tab?.id) {
    showToast('No active tab is available.');
    return;
  }
  await chrome.tabs.update(state.tab.id, { url: source.startUrl });
  await recordEvent('Opened ' + source.name, source.startUrl);
}

// ---------- source detail ----------

async function openSource(sourceId) {
  const source = sourceById(sourceId);
  if (!source) return;
  setView('source', { sourceId });
  await recordEvent('Opened source', source.name);
  if (ENGINES[source.id]) { useEngine(source.id); await loadPropelList(); }
}

function renderSource() {
  const source = sourceById(state.sourceId);
  if (!source) return setView('home');
  if (ENGINES[source.id]) { useEngine(source.id); renderPropel(source); }
  else renderGenericSource(source);
}

function detailHeader(source) {
  return [
    h('button', { class: 'back-btn', type: 'button', onclick: () => setView('home') }, icon('back'), 'Home'),
    h('div', { class: 'detail-head' },
      makeLogo(source, 'lg'),
      h('div', { class: 'title' }, h('h1', { id: 'sourceTitle', text: source.name }), h('p', { text: source.tagline })),
      statusChip(source.status),
    ),
  ];
}

function stepper(steps, current) {
  return h('div', { class: 'stepper', role: 'group', 'aria-label': 'Migration progress' },
    h('div', { class: 'stepper-label' },
      h('span', {}, 'Step ' + (current + 1) + ' of ' + steps.length + ': ', h('strong', { text: steps[current] })),
    ),
    h('div', { class: 'stepper-bar', 'aria-hidden': 'true' },
      ...steps.map((_s, i) => h('span', { class: i < current ? 'done' : i === current ? 'current' : '' }))),
  );
}

function connectCallout() {
  return h('div', { class: 'callout callout-warn' }, icon('alert'),
    h('div', {},
      h('strong', { text: 'Connect ScalePad CS first. ' }),
      'Migrations need a verified API key.',
      h('div', {}, h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => setView('settings') }, 'Open Settings')),
    ));
}

function renderGenericSource(source) {
  const granted = !!state.access[source.id];
  const onSource = detectedSource()?.id === source.id;
  const steps = ['Allow page access', 'Open ' + source.name, 'Scan the page', 'Review and push'];
  const current = !granted ? 0 : !onSource ? 1 : 2;

  const card = h('section', { class: 'card' },
    h('h2', { class: 'card-title', text: 'How this migration works' }),
    h('p', { class: 'muted', text: source.description }),
    h('ol', { class: 'steps-preview' },
      h('li', {}, h('span', {}, h('strong', { text: 'Allow page access' }), 'Lets the utility read ' + source.name + ' pages you open.')),
      h('li', {}, h('span', {}, h('strong', { text: 'Open the source page' }), 'Navigate to the client or roadmap you want to bring over.')),
      h('li', {}, h('span', {}, h('strong', { text: 'Scan and review' }), 'We read the page and show the records we found.')),
      h('li', {}, h('span', {}, h('strong', { text: 'Push to ' + (source.destination || 'ScalePad CS') }), 'Matched records are written through the ' + (source.destination || 'ScalePad CS') + ' API.')),
    ),
  );

  const actions = h('section', { class: 'card' },
    !granted
      ? h('div', {},
        h('h2', { class: 'card-title', text: 'Allow page access' }),
        h('p', { class: 'muted', text: 'Chrome will ask before the utility can read ' + source.origins[0].replace('https://', '').replace('/*', '') + '.' }),
        h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => requestAccess(source) }, icon('lock'), 'Allow Page Access'))
      : h('div', {},
        h('h2', { class: 'card-title', text: onSource ? source.name + ' is open' : 'Open ' + source.name }),
        h('p', { class: 'muted', text: onSource ? 'Capture the page to keep its context with this workspace.' : 'Open the platform in this tab, then come back here.' }),
        onSource
          ? h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => captureSourcePage(source) }, icon('scan'), 'Scan This Page')
          : h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => openSourceInActiveTab(source) }, icon('external'), 'Open ' + source.name)),
  );

  const notice = source.status !== 'ready'
    ? h('div', { class: 'callout callout-info' }, icon('alert'), h('div', {},
      h('strong', { text: source.status === 'building' ? 'In progress. ' : 'Coming soon. ' }),
      source.status === 'building'
        ? 'Record extraction for ' + source.name + ' is being built. Page access and scanning work today.'
        : 'Full migration for ' + source.name + ' is planned. You can allow access and capture pages now.'))
    : '';

  $('sourceDetail').replaceChildren(
    ...detailHeader(source),
    stepper(steps, current),
    isConnected() ? '' : connectCallout(),
    actions,
    card,
    notice,
  );
}

async function captureSourcePage(source) {
  if (!state.access[source.id] && !(await requestAccess(source))) return;
  await refreshContext({ silent: true });
  if (!state.data.context) {
    showToast('No readable page context was returned.');
    return;
  }
  await recordEvent('Scanned ' + source.name + ' page', state.data.context.title || state.data.context.host);
  showToast(source.name + ' page captured.');
}

// ---------- Propel Your MSP ----------

// One migration engine, two sources. Each source supplies an in-page extractor that returns
// records in the same shapes, so Step 1 / Step 2, ledgers, outcomes and issues are shared.
const ENGINES = {
  propel: {
    id: 'propel', name: 'Propel', fullName: 'Propel Your MSP', host: 'app.propelyourmsp.com',
    extract: () => window.Propel.propelPageExtract,
    primaryCategory: 'Production Questionnaires', primaryLabel: 'production questionnaires',
    projectTemplates: true, keySuffix: '',
    company: 'company', companies: 'companies', audit: 'audit', audits: 'audits',
    questionnaires: 'questionnaires', questionnairesTitle: 'Audit questionnaires',
    weightsHint: 'Weights in ScalePad CS are set in proportion to Propel points.',
    matchHint: 'by ConnectWise ID and name', latestLabel: 'Latest per questionnaire',
  },
  myitprocess: {
    id: 'myitprocess', name: 'MyITProcess', fullName: 'MyITProcess', host: 'new.live.myitprocess.com',
    extract: () => window.MyItp.myItpPageExtract,
    primaryCategory: 'Review templates', primaryLabel: 'review templates',
    projectTemplates: false, keySuffix: ':myitprocess',
    company: 'client', companies: 'clients', audit: 'review', audits: 'reviews',
    questionnaires: 'review templates', questionnairesTitle: 'Review templates',
    weightsHint: 'Questions are weighted equally. Answers use the vCIO alignment rating (Aligned, Marginal, Vulnerable, N/A).',
    matchHint: 'by name', latestLabel: 'Latest review',
    adaptProjects: (projects) => window.MyItp.adaptProjects(projects),
  },
  strategyoverview: {
    id: 'strategyoverview', name: 'Strategy Overview', fullName: 'Strategy Overview', host: 'app.us.strategyoverview.com',
    extract: () => window.SoAdapter.soPageExtract, world: 'MAIN',
    primaryCategory: 'Strategy templates', primaryLabel: 'strategy templates',
    projectTemplates: false, keySuffix: ':strategyoverview',
    company: 'company', companies: 'companies', audit: 'report', audits: 'reports',
    questionnaires: 'strategy templates', questionnairesTitle: 'Strategy templates',
    weightsHint: 'Weights follow Strategy Overview health weights. Answers use the grade (Healthy, Warning, Danger, Not applicable).',
    matchHint: 'by name', latestLabel: 'Latest report',
    adaptProjects: (projects) => window.SoAdapter.adaptProjects(projects),
  },
};
const ENGINE_BAG_KEYS = ['propel', 'propelProjects', 'propelClients'];
const PROPEL_PRIMARY_CATEGORY = 'Production Questionnaires';

function eng() { return ENGINES[state.engineId || 'propel']; }
function engKey(base) { return base + eng().keySuffix; }
function engArea(kind) { return eng().id + '-' + kind; }
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/** Swap the per-source state bags so each source keeps its own lists, picks and matches. */
function useEngine(id) {
  if (!ENGINES[id] || (state.engineId || 'propel') === id) return;
  state.engineBags = state.engineBags || {};
  state.engineBags[state.engineId || 'propel'] = Object.fromEntries(ENGINE_BAG_KEYS.map((k) => [k, state[k]]));
  const saved = state.engineBags[id];
  if (saved) for (const k of ENGINE_BAG_KEYS) state[k] = saved[k];
  else {
    state.propel = { list: null, details: {}, selected: new Set(), open: new Set([ENGINES[id].primaryCategory]), existing: new Map(), results: {}, loading: false, creating: false, error: null, tab: 'questionnaires' };
    state.propelProjects = { list: null, selected: new Set(), open: new Set(), existing: new Map(), results: {}, loading: false, creating: false, error: null };
    state.propelClients = null;
  }
  state.engineId = id;
}

function propelOnSource() {
  return detectedSource()?.id === eng().id;
}

async function runInPropel(args) {
  const first = await runInPropelOnce(args);
  if (first.ok || !/session needs refreshing/i.test(first.error || '')) return first;
  const tabId = state.propelRun?.running ? state.propelRun.tabId : state.tab?.id;
  if (!tabId) return first;
  try {
    await chrome.tabs.reload(tabId);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') break;
    }
    await new Promise((r) => setTimeout(r, 2500)); // let the app renew its session
  } catch (_e) { return first; }
  return runInPropelOnce(args);
}

async function runInPropelOnce(args) {
  // During a migration run, stay pinned to the Propel tab it started on, even if the user switches tabs.
  let tabId = state.propelRun?.running ? state.propelRun.tabId : null;
  if (!tabId) {
    state.tab = await activeTab();
    if (!state.tab?.id || !propelOnSource()) return { ok: false, error: 'Open ' + eng().fullName + ' in this tab first.' };
    tabId = state.tab.id;
  }
  const engine = state.propelRun?.running ? ENGINES[state.propelRun.engineId] || eng() : eng();
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: engine.extract(),
      args: [args],
      // Strategy Overview's session token is only reachable from the page's own (MAIN) world.
      ...(engine.world ? { world: engine.world } : {}),
    });
    return result?.result || { ok: false, error: engine.name + ' did not return any data.' };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function propelCategoryOrder(a, b) {
  const rank = (c) => (c === eng().primaryCategory ? 0 : /^zz|archiv/i.test(c) ? 2 : 1);
  return rank(a) - rank(b) || a.localeCompare(b);
}

async function loadPropelExisting() {
  if (!isConnected()) return;
  const response = await send({ type: 'LIST_TEMPLATE_TITLES' });
  if (response.ok) {
    state.propel.existing = new Map(response.data.map((t) => [t.title.trim().toLowerCase(), t.id]));
  }
}

function propelExistingId(name) {
  return state.propel.existing.get(String(name || '').trim().toLowerCase()) || null;
}

async function loadPropelList() {
  const source = sourceById(eng().id);
  if (!state.access[eng().id] || !propelOnSource()) return;
  state.propel.loading = true;
  state.propel.error = null;
  if (state.view === 'source') renderPropel(source);
  const [list] = await Promise.all([runInPropel({ mode: 'list' }), loadPropelExisting()]);
  if (!list.ok) {
    state.propel.loading = false;
    state.propel.error = list.error;
    if (state.view === 'source' && state.sourceId === eng().id) renderPropel(source);
    return;
  }
  state.propel.list = list.questionnaires;
  // Pre-load details for the primary group so counts and weights show straight away.
  const primary = list.questionnaires.filter((q) => q.category === eng().primaryCategory).map((q) => q.id);
  await loadPropelDetails(primary);
  state.propel.loading = false;
  if (state.view === 'source' && state.sourceId === eng().id) renderPropel(source);
}

async function loadPropelDetails(ids) {
  const missing = ids.filter((id) => !state.propel.details[id]);
  if (!missing.length) return true;
  const response = await runInPropel({ mode: 'detail', ids: missing });
  if (!response.ok) {
    state.propel.error = response.error;
    return false;
  }
  for (const q of response.questionnaires) state.propel.details[q.id] = q;
  return true;
}

// Collapsible step sections on the Propel screen. Open/closed state is a per-viewer
// convenience, so it lives in localStorage (wrapped: storage can be unavailable).
const PROPEL_STEPS_KEY = 'propelStepsOpen';
function propelStepsOpen() {
  if (!state.propelSteps) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PROPEL_STEPS_KEY) || 'null'); } catch (_e) { saved = null; }
    state.propelSteps = saved && typeof saved === 'object' ? saved : { templates: true, clients: true };
  }
  return state.propelSteps;
}
function togglePropelStep(id) {
  const open = propelStepsOpen();
  open[id] = !open[id];
  try { localStorage.setItem(PROPEL_STEPS_KEY, JSON.stringify(open)); } catch (_e) { /* optional */ }
  renderPropel(sourceById(eng().id));
}

function stepSection({ id, number, title, summary, done, badge, body }) {
  const open = propelStepsOpen()[id] !== false;
  return h('section', { class: 'step-section' + (open ? ' is-open' : '') + (done ? ' is-done' : '') },
    h('button', { class: 'step-head', type: 'button', 'aria-expanded': String(open), onclick: () => togglePropelStep(id) },
      h('span', { class: 'step-num' }, done ? icon('check') : String(number)),
      h('span', { class: 'step-title' }, h('strong', { text: title }), h('small', { text: summary })),
      badge || '',
      icon('chevron')),
    open ? h('div', { class: 'step-body' }, body) : '');
}

function templatesSummary() {
  const p = state.propel;
  const pt = state.propelProjects;
  const parts = [];
  if (p.list) {
    const prod = p.list.filter((q) => q.category === eng().primaryCategory);
    const base = prod.length ? prod : p.list;
    parts.push(base.filter((q) => propelExistingId(q.name)).length + ' of ' + base.length + ' ' + (prod.length ? eng().primaryLabel : eng().questionnaires));
  }
  if (eng().projectTemplates && pt.list) parts.push(pt.list.filter((t) => propelProjectExistingId(t)).length + ' of ' + pt.list.length + ' project templates');
  return parts.length ? parts.join(' · ') + ' in ScalePad CS' : 'Assessment and initiative templates';
}

function templatesDone() {
  const p = state.propel;
  const pt = state.propelProjects;
  const qDone = p.list && p.list.some((q) => propelExistingId(q.name));
  const tDone = !eng().projectTemplates || (pt.list && pt.list.some((t) => propelProjectExistingId(t)));
  return !!(qDone && tDone);
}

function renderPropel(source) {
  const p = state.propel;
  const pt = state.propelProjects;
  const tab = eng().projectTemplates ? (p.tab || 'questionnaires') : 'questionnaires';
  const granted = !!state.access[eng().id];
  const onSource = propelOnSource();
  const active = tab === 'projects' ? pt : p;
  const ready = granted && onSource;

  let body;
  if (!granted) {
    body = [stepper(['Allow page access', 'Open ' + eng().name], 0), h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Allow page access' }),
      h('p', { class: 'muted', text: 'Chrome will ask before the utility can read ' + eng().host + '. Nothing is changed in ' + eng().name + '.' }),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async () => { if (await requestAccess(source)) loadPropelList(); } }, icon('lock'), 'Allow Page Access'))];
  } else if (!onSource) {
    body = [stepper(['Allow page access', 'Open ' + eng().name], 1), h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Open ' + eng().fullName }),
      h('p', { class: 'muted', text: 'Sign in to ' + eng().name + ' in this tab. Any ' + eng().name + ' page works; data is read in the background, with no pop-ups.' }),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => openSourceInActiveTab(source) }, icon('external'), 'Open ' + eng().name))];
  } else {
    // Load both lists up front so the Step 1 summary is accurate even when collapsed.
    if (!p.list && !p.loading && !p.error) queueMicrotask(loadPropelList);
    if (eng().projectTemplates && !pt.list && !pt.loading && !pt.error) queueMicrotask(loadProjectTemplates);

    const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Template type' },
      ...[['questionnaires', 'Questionnaires'], ['projects', 'Project templates']].map(([id, label]) => h('button', {
        class: 'seg-btn' + (tab === id ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(tab === id),
        onclick: () => { p.tab = id; renderPropel(source); },
      }, label)));

    const done = templatesDone();
    body = [
      stepSection({
        id: 'templates', number: 1, title: 'Create templates',
        summary: templatesSummary(), done,
        body: h('div', {},
          eng().projectTemplates ? tabs : '',
          tab === 'projects' && eng().projectTemplates ? renderProjectPicker() : renderPropelPicker(),
          active.error ? h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', { text: active.error })) : ''),
      }),
      stepSection({
        id: 'clients', number: 2, title: 'Migrate client data',
        summary: clientStepSummary(),
        badge: clientState().companies ? '' : h('span', { class: 'chip chip-neutral', text: 'Next up' }),
        body: renderClientDataStep(done),
      }),
    ];
  }

  $('sourceDetail').replaceChildren(
    ...detailHeader(source),
    isConnected() ? '' : connectCallout(),
    ...body,
  );

  const steps = propelStepsOpen();
  // Only one action bar fits, so pick the step the user is actually working in.
  // Step 2 wins whenever a migration is running or clients are picked; otherwise Step 1
  // keeps the bar while it has a selection to act on. An expanded Step 1 can no longer
  // hide the Migrate button while the client list is on screen.
  const clientsBar = ready && steps.clients !== false && !!clientState().companies;
  const templatesBar = ready && steps.templates !== false && !!active.list;
  if (clientsBar && (runState().running || clientState().selected.size || !templatesBar || !active.selected.size)) {
    mountActionBar(clientActionBar());
  } else if (templatesBar) {
    const count = active.selected.size;
    const noun = tab === 'projects' ? 'Initiative Template' : 'Template';
    mountActionBar(h('div', { class: 'action-bar' },
      h('span', { class: 'count' }, h('strong', { text: String(count) }), ' selected'),
      h('button', {
        class: 'btn btn-primary', type: 'button',
        disabled: !count || !isConnected() || active.creating || active.loading,
        onclick: tab === 'projects' ? createInitiativeTemplates : createPropelTemplates,
      }, active.creating ? 'Creating…' : count ? 'Create ' + count + ' ' + noun + (count === 1 ? '' : 's') : 'Create ' + noun + 's'),
    ));
  } else {
    clearActionBar();
  }
}

// ----- Step 2: Propel companies → ScalePad CS clients -----

const CLIENT_MAP_KEY = 'propelClientMap';
const CLIENT_PAGE = 40;

function clientState() {
  if (!state.propelClients) {
    state.propelClients = {
      companies: null, spClients: null, matches: new Map(), saved: {},
      loading: false, error: null, filter: 'needs', search: '', limit: CLIENT_PAGE,
      selected: new Map(), picking: null,
    };
  }
  return state.propelClients;
}

async function loadPropelClients() {
  const c = clientState();
  if (c.loading || !state.access[eng().id] || !propelOnSource()) return;
  if (!isConnected()) { c.error = 'Connect ScalePad CS in Settings to match clients.'; renderPropel(sourceById(eng().id)); return; }
  c.loading = true;
  c.error = null;
  renderPropel(sourceById(eng().id));
  const [companies, sp, stored] = await Promise.all([
    runInPropel({ mode: 'companies' }),
    send({ type: 'LIST_SP_CLIENTS' }),
    chrome.storage.local.get(engKey(CLIENT_MAP_KEY)),
  ]);
  c.loading = false;
  if (!companies.ok) c.error = companies.error;
  else if (!sp.ok) c.error = sp.error || 'Could not load ScalePad CS clients.';
  else {
    c.companies = companies.companies;
    c.spClients = sp.data;
    c.saved = stored[engKey(CLIENT_MAP_KEY)] || {};
    rematchClients();
    // Start on the most useful filter.
    c.filter = clientCounts().needs ? 'needs' : 'matched';
  }
  renderPropel(sourceById(eng().id));
}

function rematchClients() {
  const c = clientState();
  c.matches = window.Propel.matchCompanies(c.companies, c.spClients, c.saved);
}

/** Companies worth showing: active in Propel or holding completed audits. */
const ROADMAP_COUNT_KEY = 'propelRoadmapCounts';
const DEFAULT_CLIENT_FILTERS = { activeOnly: true, lastAudit: 'any', roadmap: 'any', advisor: '', sort: 'recent', includeIncomplete: false };
const LAST_AUDIT_OPTIONS = [['any', 'Any time'], ['3', 'Last 3 months'], ['6', 'Last 6 months'], ['12', 'Last 12 months'], ['24', 'Last 2 years'], ['stale12', 'Not in 12+ months'], ['never', 'Never audited']];
const ROADMAP_OPTIONS = [['any', 'Any roadmap'], ['has', 'Has roadmap items'], ['empty', 'Roadmap empty']];
const SORT_OPTIONS = [['recent', 'Newest audit'], ['roadmap', 'Most roadmap items'], ['audits', 'Most audits'], ['name', 'Name']];

function clientFilters() {
  const c = clientState();
  if (!c.filters) c.filters = { ...DEFAULT_CLIENT_FILTERS };
  return c.filters;
}

function auditCount(co, f = clientFilters()) {
  return co.completedAudits + (f.includeIncomplete ? co.incompleteAudits || 0 : 0);
}

function lastAuditDate(co, f = clientFilters()) {
  return (f.includeIncomplete ? co.lastAuditActivity : null) || co.latestAudit || null;
}

/** Roadmap item count: scanned count when known, otherwise Propel's upcoming-spend hint (null = unknown). */
function roadmapCount(co) {
  const c = clientState();
  if (c.roadmapCounts && typeof c.roadmapCounts[co.id] === 'number') return c.roadmapCounts[co.id];
  return null;
}

function roadmapKnown(co) {
  const n = roadmapCount(co);
  if (n !== null) return n > 0;
  if (typeof co.roadmapSpend === 'number' && co.roadmapSpend > 0) return true;
  return null; // unknown until scanned
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString();
}

function passesClientFilters(co) {
  const f = clientFilters();
  if (f.activeOnly && !co.active) return false;
  const last = lastAuditDate(co, f);
  if (f.lastAudit === 'never' && last) return false;
  if (f.lastAudit === 'stale12' && (!last || last >= monthsAgo(12))) return false;
  if (/^\d+$/.test(f.lastAudit) && (!last || last < monthsAgo(Number(f.lastAudit)))) return false;
  if (f.roadmap !== 'any') {
    const has = roadmapKnown(co);
    if (f.roadmap === 'has' && has !== true) return false;
    if (f.roadmap === 'empty' && has !== false) return false;
  }
  if (f.advisor && (co.owners?.strategicAdvisor || '') !== f.advisor) return false;
  return true;
}

function relevantCompanies() {
  const c = clientState();
  return (c.companies || []).filter((co) => (co.active || co.completedAudits > 0 || co.incompleteAudits > 0) && passesClientFilters(co));
}

function sortCompanies(list) {
  const f = clientFilters();
  const by = {
    recent: (a, b) => String(lastAuditDate(b, f) || '').localeCompare(String(lastAuditDate(a, f) || '')),
    roadmap: (a, b) => (roadmapCount(b) ?? -1) - (roadmapCount(a) ?? -1),
    audits: (a, b) => auditCount(b, f) - auditCount(a, f),
    name: () => 0,
  }[f.sort] || (() => 0);
  return list.sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
}

async function loadRoadmapCounts() {
  const c = clientState();
  if (c.roadmapCounts) return;
  const stored = (await chrome.storage.local.get(engKey(ROADMAP_COUNT_KEY)))[engKey(ROADMAP_COUNT_KEY)];
  c.roadmapCounts = stored?.counts || {};
  c.roadmapScannedAt = stored?.at || null;
}

async function scanRoadmaps() {
  const c = clientState();
  if (c.scanning) return;
  const f = clientFilters();
  // Scan everything that passes the other filters (the roadmap filter itself is ignored here).
  const saved = f.roadmap;
  f.roadmap = 'any';
  const ids = relevantCompanies().map((co) => co.id);
  f.roadmap = saved;
  c.scanning = { done: 0, total: ids.length };
  renderPropel(sourceById(eng().id));
  try {
    for (let i = 0; i < ids.length; i += 30) {
      const batch = ids.slice(i, i + 30);
      const res = await runInPropel({ mode: 'roadmapCounts', companyIds: batch });
      if (!res.ok) throw new Error(res.error);
      Object.assign(c.roadmapCounts, res.counts);
      c.scanning.done = Math.min(ids.length, i + batch.length);
      renderPropel(sourceById(eng().id));
    }
    c.roadmapScannedAt = new Date().toISOString();
    await chrome.storage.local.set({ [engKey(ROADMAP_COUNT_KEY)]: { counts: c.roadmapCounts, at: c.roadmapScannedAt } });
  } catch (e) {
    showToast('Roadmap scan stopped: ' + e.message);
  } finally {
    c.scanning = null;
    renderPropel(sourceById(eng().id));
  }
}

function filterSelect(options, value, onChange, label) {
  const select = h('select', { class: 'input filter-select', 'aria-label': label });
  for (const [v, text] of options) select.appendChild(h('option', { value: v, text }));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function renderClientFilters() {
  const c = clientState();
  const f = clientFilters();
  const rerender = () => { c.limit = CLIENT_PAGE; renderPropel(sourceById(eng().id)); };
  const set = (key) => (v) => { f[key] = v; rerender(); };
  const advisors = [...new Set((c.companies || []).map((co) => co.owners?.strategicAdvisor).filter(Boolean))].sort();
  const active = Object.keys(DEFAULT_CLIENT_FILTERS).filter((k) => k !== 'sort' && k !== 'includeIncomplete' && f[k] !== DEFAULT_CLIENT_FILTERS[k]).length;
  const ready = f.activeOnly && f.lastAudit === '12' && f.roadmap === 'has';

  const activeBox = h('input', { type: 'checkbox' });
  activeBox.checked = f.activeOnly;
  activeBox.addEventListener('change', () => set('activeOnly')(activeBox.checked));
  const incBox = h('input', { type: 'checkbox' });
  incBox.checked = f.includeIncomplete;
  incBox.addEventListener('change', () => {
    f.includeIncomplete = incBox.checked;
    for (const [id, sel] of c.selected) c.selected.set(id, { ...sel, includeIncomplete: incBox.checked });
    rerender();
  });

  const scanned = c.roadmapScannedAt;
  const scanBtn = c.scanning
    ? h('span', { class: 'muted small', text: 'Counting roadmap items… ' + c.scanning.done + ' of ' + c.scanning.total })
    : h('button', { class: 'link-btn', type: 'button', onclick: scanRoadmaps, title: 'Reads each ' + eng().company + '\u2019s ' + eng().name + ' roadmap (about a minute for 900). Results are remembered.' },
      scanned ? 'Recount roadmap items' : 'Count roadmap items');

  return h('details', { class: 'client-filters', open: c.filtersOpen ? '' : null, ontoggle: (e) => { c.filtersOpen = e.target.open; } },
    h('summary', {},
      icon('filter'),
      h('span', { text: 'Filters' }),
      active ? h('span', { class: 'chip chip-neutral', text: active + ' on' }) : '',
      ready ? h('span', { class: 'chip chip-success', text: 'Ready to migrate' }) : ''),
    h('div', { class: 'filter-body' },
      h('div', { class: 'filter-presets' },
        h('button', { class: 'btn btn-secondary btn-sm' + (ready ? ' is-active' : ''), type: 'button',
          title: 'Active clients audited in the last 12 months with something on the roadmap',
          onclick: () => { Object.assign(f, { activeOnly: true, lastAudit: '12', roadmap: 'has' }); rerender(); } }, 'Ready to migrate'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { Object.assign(f, { ...DEFAULT_CLIENT_FILTERS, includeIncomplete: f.includeIncomplete }); rerender(); } }, 'Reset')),
      h('label', { class: 'check-row' }, activeBox, h('span', { text: 'Active in ' + eng().name + ' only' })),
      h('label', { class: 'check-row' }, incBox, h('span', { text: 'Include incomplete ' + eng().audits }),
        h('span', { class: 'field-help', text: 'In-progress ' + eng().audits + ' come across with the answers so far; their assessments stay open.' })),
      h('div', { class: 'filter-grid' },
        h('label', { class: 'filter-field' }, h('span', { class: 'field-help', text: 'Last ' + eng().audit }), filterSelect(LAST_AUDIT_OPTIONS, f.lastAudit, set('lastAudit'), 'Last audit')),
        h('label', { class: 'filter-field' }, h('span', { class: 'field-help', text: 'Roadmap' }), filterSelect(ROADMAP_OPTIONS, f.roadmap, set('roadmap'), 'Roadmap')),
        advisors.length ? h('label', { class: 'filter-field' }, h('span', { class: 'field-help', text: 'Strategic Advisor' }),
          filterSelect([['', 'Anyone'], ...advisors.map((a) => [a, a])], f.advisor, set('advisor'), 'Strategic Advisor')) : '',
        h('label', { class: 'filter-field' }, h('span', { class: 'field-help', text: 'Sort by' }), filterSelect(SORT_OPTIONS, f.sort, set('sort'), 'Sort by'))),
      h('div', { class: 'filter-scan' }, scanBtn,
        !c.scanning ? h('span', { class: 'muted small', text: scanned
          ? 'Counted ' + new Date(scanned).toLocaleDateString()
          : f.roadmap !== 'any' ? 'Until counted, only clients with upcoming roadmap spend show as having items.' : '' }) : '')));
}

function clientCounts() {
  const c = clientState();
  const counts = { matched: 0, needs: 0, skipped: 0 };
  for (const co of relevantCompanies()) {
    const m = c.matches.get(co.id);
    if (!m) counts.needs++;
    else if (m.method === 'skip') counts.skipped++;
    else counts.matched++;
  }
  return counts;
}

async function saveClientChoice(companyId, choice) {
  const c = clientState();
  if (choice === undefined) delete c.saved[companyId];
  else c.saved[companyId] = choice;
  await chrome.storage.local.set({ [engKey(CLIENT_MAP_KEY)]: c.saved });
  c.picking = null;
  rematchClients();
  if (!choice?.clientId) c.selected.delete(companyId);
  renderPropel(sourceById(eng().id));
}

function renderClientDataStep(templatesReady) {
  const c = clientState();
  if (!c.companies) {
    if (!c.loading && !c.error) queueMicrotask(loadPropelClients);
    return h('div', {},
      h('p', { class: 'muted small', text: 'Reads your ' + eng().name + ' ' + eng().companies + ' and ScalePad CS clients, then matches them ' + eng().matchHint + '. Nothing is written yet.' }),
      c.loading ? h('p', { class: 'muted', text: 'Loading companies and clients…' }) : '',
      c.error ? h('div', { class: 'callout callout-warn' }, icon('alert'), h('div', { text: c.error })) : '',
      !c.loading ? h('button', { class: 'btn btn-secondary btn-block', type: 'button', onclick: () => { c.error = null; loadPropelClients(); } }, icon('scan'), 'Load ' + cap(eng().companies)) : '');
  }

  if (!c.roadmapCounts) { queueMicrotask(async () => { await loadRoadmapCounts(); renderPropel(sourceById(eng().id)); }); }
  const counts = clientCounts();
  const filters = [['needs', 'Needs match', counts.needs], ['matched', 'Matched', counts.matched], ['skipped', 'Skipped', counts.skipped]];
  const q = window.Propel.normName(c.search);
  const rows = relevantCompanies().filter((co) => {
    const m = c.matches.get(co.id);
    const bucket = !m ? 'needs' : m.method === 'skip' ? 'skipped' : 'matched';
    return bucket === c.filter && (!q || window.Propel.normName(co.name).includes(q));
  });
  sortCompanies(rows);
  const totalCompanies = (c.companies || []).length;

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search ' + eng().name + ' ' + eng().companies + '…', 'aria-label': 'Search ' + eng().name + ' ' + eng().companies, value: c.search });
  search.addEventListener('input', () => {
    c.search = search.value;
    c.limit = CLIENT_PAGE;
    renderPropel(sourceById(eng().id));
    const again = document.querySelector('.client-search input');
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });

  const matchedSelectable = relevantCompanies().filter((co) => c.matches.get(co.id)?.clientId);
  const allSelected = matchedSelectable.length && matchedSelectable.every((co) => c.selected.has(co.id));

  return h('div', {},
    renderRunPanel(),
    !templatesReady ? h('div', { class: 'callout callout-info', style: 'margin:0 0 12px' }, icon('alert'),
      h('div', { text: 'Create the ' + (eng().projectTemplates ? 'questionnaire and project templates' : eng().questionnaires) + ' in Step 1 before migrating client data.' })) : '',
    h('div', { class: 'seg seg-3', role: 'tablist', 'aria-label': 'Match status' },
      ...filters.map(([id, label, n]) => h('button', {
        class: 'seg-btn' + (c.filter === id ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': String(c.filter === id),
        onclick: () => { c.filter = id; c.limit = CLIENT_PAGE; renderPropel(sourceById(eng().id)); },
      }, label + ' · ' + n))),
    renderClientFilters(),
    h('div', { class: 'client-search' }, search),
    h('p', { class: 'muted small filter-count', text: 'Showing ' + (counts.needs + counts.matched + counts.skipped) + ' of ' + totalCompanies + ' ' + eng().name + ' ' + eng().companies }),
    c.filter === 'matched' && matchedSelectable.length ? h('div', { class: 'review-toolbar', style: 'margin-top:4px' },
      h('span', { class: 'muted small', text: c.selected.size + ' of ' + matchedSelectable.length + ' matched clients selected' }),
      h('button', { class: 'link-btn', type: 'button', onclick: () => {
        if (allSelected) c.selected.clear();
        else for (const co of matchedSelectable) if (!c.selected.has(co.id)) c.selected.set(co.id, newSelection(co));
        renderPropel(sourceById(eng().id));
      } }, allSelected ? 'Clear' : 'Select all')) : '',
    c.filter === 'matched' && matchedSelectable.length ? h('div', { class: 'client-range default-range' },
      h('span', { class: 'field-help', text: 'Default ' + eng().audit + ' range' }),
      auditRangeSelect(c.defaultRange, (v) => {
        c.defaultRange = v;
        for (const [id, sel] of c.selected) if (sel.assessments) c.selected.set(id, { ...sel, auditRange: v });
        renderPropel(sourceById(eng().id));
      }, 'Default audit range for selected clients')) : '',
    rows.length ? h('div', { class: 'client-list' }, ...rows.slice(0, c.limit).map(renderClientRow))
      : h('p', { class: 'empty', text: c.search ? 'No companies match that search.' : 'Nothing here.' }),
    rows.length > c.limit ? h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => { c.limit += CLIENT_PAGE; renderPropel(sourceById(eng().id)); } },
      'Show ' + Math.min(CLIENT_PAGE, rows.length - c.limit) + ' more of ' + (rows.length - c.limit)) : '',
    h('button', { class: 'link-btn', type: 'button', style: 'margin-top:8px', onclick: () => { c.companies = null; loadPropelClients(); } }, 'Reload ' + eng().name + ' ' + eng().companies + ' and ScalePad CS clients'));
}

function newSelection(co) {
  const c = clientState();
  const f = clientFilters();
  return { assessments: auditCount(co, f) > 0, roadmap: roadmapCount(co) !== 0, auditRange: c.defaultRange || 'latest', includeIncomplete: !!f.includeIncomplete };
}

const AUDIT_RANGES = [['latest', 'Latest per questionnaire'], ['1', 'Last 1 month'], ['3', 'Last 3 months'], ['6', 'Last 6 months'], ['9', 'Last 9 months'], ['12', 'Last 12 months'], ['all', 'All completed audits']];

function auditRangeSelect(value, onChange, label) {
  const select = h('select', { class: 'input range-select', 'aria-label': label });
  for (const [v, text] of AUDIT_RANGES) select.appendChild(h('option', { value: v, text: v === 'latest' ? eng().latestLabel : v === 'all' ? 'All completed ' + eng().audits : text }));
  select.value = value || 'latest';
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function renderClientRow(co) {
  const c = clientState();
  const m = c.matches.get(co.id);
  const f = clientFilters();
  const last = lastAuditDate(co, f);
  const rc = roadmapCount(co);
  const meta = [
    co.completedAudits ? co.completedAudits + ' completed ' + eng().audit + (co.completedAudits === 1 ? '' : 's') : 'No completed ' + eng().audits,
    co.incompleteAudits ? co.incompleteAudits + ' in progress' : null,
    last ? 'last ' + new Date(last).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : null,
    rc !== null ? (rc ? rc + ' roadmap item' + (rc === 1 ? '' : 's') : 'Empty roadmap') : null,
    co.externalId ? 'CW #' + co.externalId : null,
    co.active ? null : 'Not propelled',
  ].filter(Boolean).join(' · ');

  let chip;
  if (!m) chip = h('span', { class: 'chip chip-warn', text: 'Needs match' });
  else if (m.method === 'skip') chip = h('span', { class: 'chip chip-neutral', text: 'Skipped' });
  else chip = h('span', { class: 'chip chip-success', title: 'Matched by ' + ({ psa: 'ConnectWise ID', name: 'name', manual: 'you' }[m.method]), text: { psa: 'CW ID', name: 'Name', manual: 'Manual' }[m.method] });

  const sel = c.selected.get(co.id);
  const toggles = m?.clientId ? h('div', { class: 'client-toggles' },
    ...[['assessments', 'Assessments', auditCount(co) > 0], ['roadmap', 'Roadmap', rc !== 0]].map(([key, label, enabled]) => {
      const box = h('input', { type: 'checkbox', disabled: !enabled });
      box.checked = !!sel?.[key] && enabled;
      box.addEventListener('change', () => {
        const next = { ...(c.selected.get(co.id) || { ...newSelection(co), assessments: false, roadmap: false }), [key]: box.checked };
        if (next.assessments || next.roadmap) c.selected.set(co.id, next); else c.selected.delete(co.id);
        renderPropel(sourceById(eng().id));
      });
      return h('label', { class: 'toggle-chip' + (enabled ? '' : ' is-disabled') }, box, label);
    })) : '';

  const picking = c.picking === co.id || !m;
  return h('div', { class: 'review-item client-row' + (sel ? ' is-selected' : '') },
    h('div', { class: 'client-top' },
      h('span', { class: 'review-main' }, h('strong', { text: co.name }), h('small', { text: meta })),
      chip),
    m?.clientId ? h('div', { class: 'client-target' },
      icon('chevron'), h('span', { text: m.clientName }),
      h('button', { class: 'link-btn', type: 'button', onclick: () => { c.picking = c.picking === co.id ? null : co.id; renderPropel(sourceById(eng().id)); } }, c.picking === co.id ? 'Cancel' : 'Change')) : '',
    toggles,
    sel?.assessments ? h('div', { class: 'client-range' }, h('span', { class: 'field-help', text: 'Audits to migrate' }),
      auditRangeSelect(sel.auditRange, (v) => { c.selected.set(co.id, { ...c.selected.get(co.id), auditRange: v }); }, cap(eng().audits) + ' to migrate for ' + co.name)) : '',
    picking ? renderClientPicker(co, m) : '');
}

function renderClientPicker(co, m) {
  const c = clientState();
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search ScalePad CS clients…', 'aria-label': 'Search ScalePad CS clients for ' + co.name });
  const results = h('div', { class: 'match-results' });
  const show = (term) => {
    const q = window.Propel.normName(term || co.name);
    const scored = c.spClients
      .map((s) => ({ s, n: window.Propel.normName(s.name) }))
      .filter(({ n }) => q && (n.includes(q) || q.includes(n) || n.startsWith(q.slice(0, 4))))
      .slice(0, 6);
    results.replaceChildren(...(scored.length ? scored.map(({ s }) => h('button', {
      class: 'match-result', type: 'button', text: s.name,
      onclick: () => saveClientChoice(co.id, { clientId: s.id, clientName: s.name }),
    })) : [h('span', { class: 'field-help', text: 'No similar clients. Try another search.' })]));
  };
  input.addEventListener('input', () => show(input.value));
  show('');
  return h('div', { class: 'match-tools client-picker' }, input, results,
    h('div', { class: 'picker-actions' },
      m?.method === 'manual' ? h('button', { class: 'link-btn', type: 'button', onclick: () => saveClientChoice(co.id, undefined) }, 'Use automatic match') : '',
      m?.method !== 'skip' ? h('button', { class: 'link-btn', type: 'button', onclick: () => saveClientChoice(co.id, { clientId: null }) }, "Skip — don't migrate") :
        h('button', { class: 'link-btn', type: 'button', onclick: () => saveClientChoice(co.id, undefined) }, 'Un-skip')));
}

function clientStepSummary() {
  const c = clientState();
  if (!c.companies) return 'Map clients, then move assessments and roadmaps';
  const n = clientCounts();
  return n.matched + ' matched · ' + n.needs + ' need a match' + (c.selected.size ? ' · ' + c.selected.size + ' selected' : '');
}

// ----- Step 2 migration queue: one client at a time, roadmap first so findings can link -----

function runState() {
  if (!state.propelRun) state.propelRun = { running: false, paused: false, tabId: null, items: [], phase: '', done: 0 };
  return state.propelRun;
}

function clientActionBar() {
  const c = clientState();
  const run = runState();
  const picks = [...c.selected.values()];
  const assess = picks.filter((p) => p.assessments).length;
  const road = picks.filter((p) => p.roadmap).length;
  const failed = run.items.filter((i) => i.status === 'failed').length;
  let button;
  if (run.running) {
    button = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { run.paused = !run.paused; renderPropel(sourceById(eng().id)); } },
      run.paused ? 'Resume' : 'Pause');
  } else if (!c.selected.size && failed) {
    button = h('button', { class: 'btn btn-primary', type: 'button', disabled: !isConnected(), onclick: retryFailedClients }, 'Retry ' + failed + ' Client' + (failed === 1 ? '' : 's'));
  } else {
    button = h('button', { class: 'btn btn-primary', type: 'button', disabled: !c.selected.size || !isConnected(), onclick: startClientMigration },
      c.selected.size ? 'Migrate ' + c.selected.size + ' Client' + (c.selected.size === 1 ? '' : 's') : 'Migrate Clients');
  }
  return h('div', { class: 'action-bar' },
    h('span', { class: 'count' },
      run.running ? h('strong', { text: run.done + ' / ' + run.items.length }) : h('strong', { text: String(c.selected.size) }),
      run.running ? ' clients done' : ' clients',
      run.running ? h('small', { class: 'bar-sub', text: run.paused ? 'Paused' : run.phase })
        : c.selected.size ? h('small', { class: 'bar-sub', text: assess + ' assessments · ' + road + ' roadmaps' }) : ''),
    button);
}

function renderRunPanel() {
  const run = runState();
  if (!run.items.length) return '';
  if (run.engineId && run.engineId !== eng().id) {
    return h('div', { class: 'callout callout-info', style: 'margin:0 0 12px' }, icon('alert'),
      h('div', { text: 'The last client migration ran from ' + ENGINES[run.engineId].name + (run.running ? ' and is still running' : '') + '. Its results are on the ' + ENGINES[run.engineId].name + ' page.' }));
  }
  const pct = run.items.length ? Math.round((run.done / run.items.length) * 100) : 0;
  const finished = run.items.filter((i) => i.outcome);
  const sum = finished.reduce((t, i) => ({
    ini: t.ini + i.outcome.ini.done, iniTotal: t.iniTotal + i.outcome.ini.total,
    asm: t.asm + i.outcome.asm.done, asmTotal: t.asmTotal + i.outcome.asm.total,
    failed: t.failed + noteCount(i.groups.failed) + (i.outcome.ini.total - i.outcome.ini.done),
    review: t.review + i.groups.review.length, auto: t.auto + noteCount(i.groups.auto),
  }), { ini: 0, iniTotal: 0, asm: 0, asmTotal: 0, failed: 0, review: 0, auto: 0 });

  const summary = !run.running && finished.length ? h('div', { class: 'run-summary' + (sum.failed ? ' has-failed' : '') },
    h('span', { class: 'run-summary-icon' }, icon(sum.failed ? 'alert' : 'check')),
    h('div', {},
      h('strong', { text: sum.failed ? 'Run complete — some items need attention' : 'Run complete' }),
      h('p', { text: finished.length + ' client' + (finished.length === 1 ? '' : 's') + ' · ' + sum.ini + ' of ' + sum.iniTotal + ' initiatives · ' + sum.asm + ' of ' + sum.asmTotal + ' assessments migrated' }),
      h('p', { class: 'run-summary-tiers' },
        h('span', { class: 'tier tier-failed', text: sum.failed + ' failed' }),
        h('span', { class: 'tier tier-review', text: sum.review + ' worth a look' }),
        h('span', { class: 'tier tier-auto', text: sum.auto + ' handled automatically' })))) : '';

  return h('section', { class: 'run-panel' },
    summary,
    run.running ? h('div', {},
      h('div', { class: 'review-toolbar', style: 'margin-top:0' }, h('h2', { text: run.paused ? 'Paused' : 'Migrating…' }), h('span', { class: 'muted small', text: run.done + ' of ' + run.items.length + ' clients' })),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('span', { style: 'width:' + pct + '%' })),
      h('p', { class: 'muted small', 'aria-live': 'polite', text: run.paused ? 'Paused after the current item.' : run.phase })) : '',
    h('div', { class: 'run-list' }, ...run.items.map(renderOutcomeCard)));
}

const OUTCOME_CHIP = {
  queued: ['chip-neutral', 'Queued'], running: ['chip-info', 'Running'],
  done: ['chip-success', 'Done'], review: ['chip-warn', 'Worth a look'], failed: ['chip-danger', 'Needs attention'],
};

function renderOutcomeCard(i) {
  const [chipClass, chipText] = OUTCOME_CHIP[i.status] || OUTCOME_CHIP.queued;
  const o = i.outcome;
  const line = o ? [
    o.ini.total ? o.ini.done + ' of ' + o.ini.total + ' initiatives' : null,
    o.asm.total ? o.asm.done + ' of ' + o.asm.total + ' assessment' + (o.asm.total === 1 ? '' : 's') : null,
    o.linked ? o.linked + ' findings linked' : null,
  ].filter(Boolean).join(' · ') || 'Nothing to migrate' : (i.status === 'running' ? 'Working…' : 'Waiting');
  const g = i.groups || { failed: [], review: [], auto: [] };
  const groupBlock = (tier, groups, open) => groups.map((grp) => h('details', { class: 'note-group tier-' + tier, open: open || undefined },
    h('summary', {}, h('span', { text: grp.group }), h('span', { class: 'note-count', text: String(grp.entries.length) })),
    h('ul', {}, ...grp.entries.slice(0, 60).map((e) => h('li', { text: e.subject ? e.subject + (tier === 'auto' && /created again|earlier than/i.test(e.detail) ? '' : ' — ' + e.detail) : e.detail })),
      grp.entries.length > 60 ? h('li', { class: 'muted', text: '…and ' + (grp.entries.length - 60) + ' more' }) : '')));
  const autoCount = noteCount(g.auto);
  return h('div', { class: 'outcome-card is-' + i.status },
    h('div', { class: 'outcome-head' },
      h('span', { class: 'outcome-icon' }, icon(i.status === 'failed' ? 'alert' : i.status === 'done' || i.status === 'review' ? 'check' : 'dot')),
      h('span', { class: 'review-main' }, h('strong', { text: i.name }), h('small', { text: line })),
      h('span', { class: 'chip ' + chipClass, text: chipText })),
    ...groupBlock('failed', g.failed, true),
    ...groupBlock('review', g.review, false),
    autoCount ? h('details', { class: 'note-group tier-auto' },
      h('summary', {}, h('span', { text: 'Handled automatically' }), h('span', { class: 'note-count', text: String(autoCount) })),
      ...g.auto.map((grp) => h('div', { class: 'auto-group' }, h('strong', { text: grp.group + ' · ' + grp.entries.length }),
        h('p', { text: [...new Set(grp.entries.map((e) => e.subject || e.detail))].slice(0, 12).join(', ') + (grp.entries.length > 12 ? ', …' : '') })))) : '');
}

async function startClientMigration() {
  const c = clientState();
  const picks = [...c.selected.entries()];
  if (!picks.length) return;
  const assess = picks.filter(([, p]) => p.assessments).length;
  const road = picks.filter(([, p]) => p.roadmap).length;
  if (!confirm('Migrate ' + picks.length + ' client(s) from ' + eng().name + ' into ScalePad CS?\n\n' + road + ' roadmap(s) → initiatives\n' + assess
    + ' client(s) → ' + eng().audits + ' as assessments\n\nThis creates records in ScalePad CS. Already-migrated items are skipped.')) return;
  const run = runState();
  run.engineId = eng().id;
  const tab = await activeTab();
  run.tabId = tab?.id;
  run.items = picks.map(([companyId, sel]) => {
    const co = c.companies.find((x) => x.id === companyId);
    const m = c.matches.get(companyId);
    return { companyId, name: co?.name || companyId, client: { id: m.clientId, name: m.clientName }, sel, status: 'queued', summary: '', warnings: [], info: [] };
  });
  c.selected.clear();
  await executeRun();
}

async function retryFailedClients() {
  const run = runState();
  if (run.engineId) useEngine(run.engineId);
  for (const i of run.items) if (i.status === 'failed' || i.status === 'warning' || i.status === 'review') { i.status = 'queued'; i.warnings = []; i.info = []; i.summary = ''; i.groups = null; i.outcome = null; }
  const tab = await activeTab();
  run.tabId = tab?.id;
  await executeRun();
}

async function waitWhilePaused(run) {
  while (run.paused && run.running) await new Promise((r) => setTimeout(r, 400));
}

async function executeRun() {
  const run = runState();
  const engine = ENGINES[run.engineId] || eng();
  const source = sourceById(engine.id);
  const clients = clientState();
  run.running = true;
  run.paused = false;
  run.done = run.items.filter((i) => !['queued', 'running'].includes(i.status)).length;
  const rerender = () => { if (state.view === 'source' && state.sourceId === engine.id && eng().id === engine.id) renderPropel(source); };

  // Lookups shared by every client.
  run.phase = 'Loading templates and users…';
  rerender();
  const [assessTpls, initTpls] = await Promise.all([send({ type: 'LIST_TEMPLATE_TITLES' }), send({ type: 'LIST_INITIATIVE_TEMPLATE_NAMES' })]);
  const assessTemplateId = new Map((assessTpls.data || []).map((t) => [t.title.trim().toLowerCase(), t.id]));
  const initTemplateMap = new Map((initTpls.data || []).map((t) => [t.name.trim().toLowerCase(), t.id]));
  let propelProjectTemplates = null;
  const createdTemplates = [];
  // Missing templates are created on the fly (from Propel's template, or rebuilt from the audit itself).
  const ensureInitiativeTemplate = async (name) => {
    const key = name.trim().toLowerCase();
    if (initTemplateMap.has(key)) return initTemplateMap.get(key);
    if (!propelProjectTemplates) {
      const res = await runInPropel({ mode: 'projectTemplates' });
      propelProjectTemplates = res.ok ? res.templates : [];
    }
    const tpl = propelProjectTemplates.find((t) => t.name.trim().toLowerCase() === key);
    if (!tpl) { initTemplateMap.set(key, null); return null; }
    const r = await send({ type: 'CREATE_INITIATIVE_TEMPLATE', template: tpl });
    const id = r.ok ? r.data.templateId : null;
    initTemplateMap.set(key, id);
    if (id) createdTemplates.push('initiative template "' + tpl.name + '"');
    return id;
  };
  const ensureAssessmentTemplate = async (audit, answers) => {
    const tplName = audit.templateName || audit.name;
    const key = tplName.trim().toLowerCase();
    if (assessTemplateId.get(key)) return assessTemplateId.get(key);
    // Rebuilt from the audit's own question copies: the source's current questionnaire may have changed
    // since the audit was taken, which would leave answers unmatched.
    const questionnaire = window.Propel.questionnaireFromAudit({ ...audit, name: tplName }, answers);
    if (engine.id !== 'propel') questionnaire.description = 'Built from the ' + engine.name + ' ' + engine.audit + ' "' + (audit.title || audit.name) + '".';
    const rebuilt = true;
    const r = await send({ type: 'CREATE_PROPEL_TEMPLATE', questionnaire, source: engine.id });
    if (!r.ok) throw new Error('Could not create assessment template "' + tplName + '": ' + r.error);
    assessTemplateId.set(key, r.data.templateId);
    assessTemplateId.set(questionnaire.name.trim().toLowerCase(), r.data.templateId);
    createdTemplates.push('assessment template "' + questionnaire.name + '"' + (rebuilt ? ' (built from ' + engine.audit + ')' : ''));
    return r.data.templateId;
  };
  const users = state.conn.users || [];
  const defaultEvaluator = state.config.evaluateUserId || users[0]?.user_id || null;

  for (const item of run.items) {
    if (item.status !== 'queued') continue;
    await waitWhilePaused(run);
    item.status = 'running';
    const counts = { initiatives: 0, assessments: 0, linked: 0, skipped: 0, repaired: 0, failed: 0 };
    const ini = { total: 0, done: 0 };
    const asm = { total: 0, done: 0 };
    const missingProjectTemplates = new Set();
    const missingAuditTemplates = new Set();
    const owners = clients.companies?.find((x) => x.id === item.companyId)?.owners || {};
    const advisorId = window.Propel.matchUser(owners.strategicAdvisor, users);
    const initiativeOwner = advisorId || defaultEvaluator;
    if (owners.strategicAdvisor && !advisorId) item.info.push('Strategic Advisor "' + owners.strategicAdvisor + '" has no matching ScalePad user — used the default user from Settings.');
    const createdBefore = createdTemplates.length;
    const setPhase = (t) => { run.phase = item.name + ': ' + t; rerender(); };
    try {
      if (item.sel.roadmap) {
        setPhase('reading roadmap…');
        const res = await runInPropel({ mode: 'companyProjects', companyId: item.companyId });
        if (!res.ok) throw new Error(engine.name + ' roadmap: ' + res.error);
        if (engine.adaptProjects) res.projects = await engine.adaptProjects(res.projects);
        for (const name of new Set(res.projects.map((p) => p.templateName).filter(Boolean))) {
          if (!initTemplateMap.has(name.trim().toLowerCase())) { setPhase('creating initiative template "' + name + '"…'); await ensureInitiativeTemplate(name); }
        }
        ini.total = res.projects.length;
        for (const [n, project] of res.projects.entries()) {
          await waitWhilePaused(run);
          setPhase('initiative ' + (n + 1) + ' of ' + res.projects.length);
          const r = await send({ type: 'MIGRATE_PROPEL_PROJECT', payload: { project, client: item.client, templateIdByName: [...initTemplateMap].filter(([, v]) => v), assignedUserId: initiativeOwner } });
          if (!r.ok) { counts.failed++; item.warnings.push(project.name + ': ' + r.error); continue; }
          ini.done++;
          if (r.data.repaired) counts.repaired++; else if (r.data.skipped) counts.skipped++; else counts.initiatives++;
          for (const w of r.data.warnings || []) item.warnings.push(project.name + ' — ' + w);
          for (const nt of r.data.notes || []) {
            if (nt.kind === 'template' && project.templateName) missingProjectTemplates.add(project.templateName);
            else if (nt.kind === 'firewall') item.warnings.push(project.name + ' — ' + nt.detail);
            else if (nt.kind === 'schedule' || nt.kind === 'recreated') item.info.push(project.name + ' — ' + nt.detail);
          }
        }
      }
      if (item.sel.assessments) {
        setPhase('reading audits…');
        const res = await runInPropel({ mode: 'companyAudits', companyId: item.companyId, includeIncomplete: !!item.sel.includeIncomplete });
        if (!res.ok) throw new Error(engine.name + ' ' + engine.audits + ': ' + res.error);
        const picked = window.Propel.pickAuditsToMigrate(res.audits, item.sel.auditRange || 'latest');
        if (!picked.length) item.info.push(item.sel.includeIncomplete ? 'No ' + engine.audits + ' in the selected date range.' : 'No completed ' + engine.audits + ' in the selected date range.');
        asm.total = picked.length;
        for (const audit of picked) {
          await waitWhilePaused(run);
          setPhase('audit "' + audit.name + '"');
          const ans = await runInPropel({ mode: 'auditAnswers', auditId: audit.id });
          if (!ans.ok) { counts.failed++; item.warnings.push(audit.name + ': ' + ans.error); continue; }
          if (ans.meta) Object.assign(audit, { templateName: ans.meta.templateName, summaryLines: ans.meta.summaryLines, auditor: ans.meta.auditor || audit.auditor, reviewer: ans.meta.reviewer || audit.reviewer });
          let templateId = null;
          try { templateId = await ensureAssessmentTemplate(audit, ans.answers); } catch (e) { item.warnings.push(e.message); }
          if (!templateId) { missingAuditTemplates.add(audit.name); continue; }
          const evaluatorId = window.Propel.matchUser(audit.auditor, users) || advisorId || defaultEvaluator;
          const r = await send({ type: 'MIGRATE_PROPEL_AUDIT', payload: { audit, answers: ans.answers, client: item.client, templateId, evaluatorId } });
          if (!r.ok) { counts.failed++; item.warnings.push(audit.name + ': ' + r.error); continue; }
          asm.done++;
          if (r.data.skipped) { counts.skipped++; continue; }
          if (r.data.repaired) counts.repaired++; else counts.assessments++;
          for (const w of r.data.warnings || []) item.warnings.push(audit.name + ' — ' + w);
          if (r.data.unmatched) item.warnings.push(audit.name + ' — ' + r.data.unmatched + ' answer(s) had no matching template question (listed in the assessment notes).');
          if (r.data.links?.length) {
            const l = await send({ type: 'LINK_PROPEL_FINDINGS', payload: { assessmentId: r.data.assessmentId, links: r.data.links } });
            if (l.ok) { counts.linked += l.data.linked; for (const w of l.data.warnings) item.warnings.push(audit.name + ' — ' + w); }
          }
        }
      }
      if (createdTemplates.length > createdBefore) item.info.push('Created ' + createdTemplates.slice(createdBefore).join(', ') + '.');
      for (const name of missingProjectTemplates) item.warnings.push(name + ' — Initiatives created without their template (it no longer exists in ' + engine.name + ')');
      if (missingAuditTemplates.size) item.warnings.push('Audits skipped — could not create an assessment template for: ' + [...missingAuditTemplates].join(', ') + '.');
    } catch (error) {
      item.warnings.unshift(error.message);
    }
    item.outcome = { ini, asm, linked: counts.linked, restored: (item.info || []).filter((m) => /created again/i.test(m)).length };
    item.groups = groupNotes([...item.warnings, ...(item.info || [])]);
    item.status = noteCount(item.groups.failed) || ini.total - ini.done ? 'failed' : noteCount(item.groups.review) || asm.total - asm.done ? 'review' : 'done';
    item.summary = [
      counts.initiatives && counts.initiatives + ' initiatives',
      counts.assessments && counts.assessments + ' assessments',
      counts.linked && counts.linked + ' findings linked',
      counts.repaired && counts.repaired + ' updated',
      counts.skipped && counts.skipped + ' already migrated',
      counts.failed && counts.failed + ' failed',
    ].filter(Boolean).join(' · ') || 'Nothing to migrate';
    setItemIssues(engine.id + '-clients', item.name, [
      ...item.groups.failed.map((g) => ({ severity: 'error', detail: groupLine(g) })),
      ...item.groups.review.map((g) => ({ severity: 'warning', detail: groupLine(g) })),
      ...item.groups.auto.map((g) => ({ severity: 'info', detail: groupLine(g) })),
    ]);
    await saveIssues();
    run.done++;
    rerender();
  }
  run.running = false;
  run.phase = '';
  rerender();
  const failedClients = run.items.filter((i) => i.status === 'failed').length;
  await recordEvent('Migrated ' + engine.name + ' clients', (run.items.length - failedClients) + ' of ' + run.items.length + ' clients migrated');
  showToast(failedClients ? failedClients + ' client(s) need attention — see the summary.' : 'All ' + run.items.length + ' client(s) migrated.');
}

// ----- Propel project templates → ScalePad CS initiative templates -----

async function loadProjectTemplates() {
  const pt = state.propelProjects;
  const source = sourceById(eng().id);
  if (!state.access[eng().id] || !propelOnSource()) return;
  pt.loading = true;
  pt.error = null;
  renderPropel(source);
  const [res, names] = await Promise.all([
    runInPropel({ mode: 'projectTemplates' }),
    isConnected() ? send({ type: 'LIST_INITIATIVE_TEMPLATE_NAMES' }) : Promise.resolve({ ok: true, data: [] }),
  ]);
  pt.loading = false;
  if (!res.ok) pt.error = res.error;
  else pt.list = res.templates;
  if (names.ok) pt.existing = new Map(names.data.map((t) => [t.name.trim().toLowerCase(), t.id]));
  if (state.view === 'source' && state.sourceId === eng().id) renderPropel(source);
}

function formatMoney(n) {
  return '$' + Math.round(n).toLocaleString();
}

function projectCostLine(t) {
  const totals = window.Propel.initiativeTotals(t);
  const parts = [];
  if (totals.oneTime > 0) parts.push(formatMoney(totals.oneTime) + ' one-time' + (totals.tbd ? ' + TBD' : ''));
  else if (totals.tbd) parts.push('One-time TBD');
  if (totals.monthly > 0) parts.push(formatMoney(totals.monthly) + '/mo');
  if (!parts.length) parts.push('No costs');
  return parts.join(' · ');
}

function renderProjectPicker() {
  const pt = state.propelProjects;
  if (!pt.list) {
    return h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: 'Project templates' }),
      h('p', { class: 'muted', text: 'Each project template you pick becomes an initiative template in ScalePad CS, with its costs, business case, and category tag.' }),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: pt.loading, onclick: loadProjectTemplates },
        icon('scan'), pt.loading ? 'Reading Project Templates…' : 'Load Project Templates'));
  }
  const groups = new Map();
  for (const t of pt.list) {
    if (!groups.has(t.category)) groups.set(t.category, []);
    groups.get(t.category).push(t);
  }
  const categories = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const selectable = (t) => !propelProjectExistingId(t) && pt.results[t.id]?.status !== 'created';

  return h('div', {},
    h('div', { class: 'review-toolbar' },
      h('h2', { text: pt.list.length + ' project templates' }),
      h('button', { class: 'link-btn', type: 'button', disabled: pt.loading, onclick: () => { pt.list = null; loadProjectTemplates(); } }, pt.loading ? 'Loading…' : 'Reload')),
    h('p', { class: 'muted small pick-hint', text: 'Internal vCIO instructions are not migrated. Category and priority become initiative tags.' }),
    ...categories.map((category) => {
      const items = groups.get(category);
      const open = pt.open.has(category);
      const allSel = items.filter(selectable);
      const allOn = allSel.length && allSel.every((t) => pt.selected.has(t.id));
      return h('section', { class: 'q-group' + (open ? ' is-open' : '') },
        h('div', { class: 'q-group-row' },
          h('button', {
            class: 'q-group-head', type: 'button', 'aria-expanded': String(open),
            onclick: () => { open ? pt.open.delete(category) : pt.open.add(category); renderPropel(sourceById(eng().id)); },
          }, icon('chevron'), h('span', { text: category }), h('span', { class: 'q-count', text: String(items.length) })),
          open && allSel.length ? h('button', {
            class: 'link-btn q-select-all', type: 'button', disabled: pt.creating,
            onclick: () => { for (const t of allSel) allOn ? pt.selected.delete(t.id) : pt.selected.add(t.id); renderPropel(sourceById(eng().id)); },
          }, allOn ? 'Clear' : 'Select all') : ''),
        open ? h('div', { class: 'q-list' }, ...items.map(renderProjectTemplateRow)) : '');
    }),
  );
}

function propelProjectExistingId(t) {
  return state.propelProjects.existing.get(t.name.trim().toLowerCase()) || null;
}

function renderProjectTemplateRow(t) {
  const pt = state.propelProjects;
  const existingId = propelProjectExistingId(t);
  const result = pt.results[t.id];
  const locked = !!existingId || result?.status === 'created';
  const checkbox = h('input', { type: 'checkbox', 'aria-label': 'Select ' + t.name, disabled: locked || pt.creating });
  checkbox.checked = pt.selected.has(t.id) && !locked;
  checkbox.addEventListener('change', () => {
    checkbox.checked ? pt.selected.add(t.id) : pt.selected.delete(t.id);
    renderPropel(sourceById(eng().id));
  });

  let chip = '';
  if (result?.status === 'creating') chip = h('span', { class: 'chip chip-info', text: 'Creating…' });
  else if (result?.status === 'created') chip = h('span', { class: 'chip chip-success', text: 'Created' });
  else if (result?.status === 'failed') chip = h('span', { class: 'chip chip-danger', title: result.error, text: 'Failed' });
  else if (existingId) chip = h('span', { class: 'chip chip-neutral', title: 'An initiative template with this name already exists in ScalePad CS.', text: 'In ScalePad CS' });
  else if (t.priority) chip = h('span', { class: 'chip ' + (t.priority === 'High' || t.priority === 'Critical' ? 'chip-warn' : 'chip-neutral'), text: t.priority });

  const extras = [];
  if (t.businessValue || t.executiveSummary) extras.push('business case');
  if (t.agreements.length) extras.push(t.agreements.length + ' agreement' + (t.agreements.length === 1 ? '' : 's'));
  if (t.durationInDays) extras.push(t.durationInDays + ' days');

  return h('div', { class: 'review-item q-item' + (pt.selected.has(t.id) && !locked ? ' is-selected' : '') },
    h('div', { class: 'review-top' },
      checkbox,
      h('span', { class: 'review-main' },
        h('strong', { text: t.name }),
        h('small', { text: projectCostLine(t) + (extras.length ? ' · ' + extras.join(', ') : '') })),
      h('span', { class: 'row-end' }, issueIconFor('propel-projects', t.name), chip)));
}

async function createInitiativeTemplates() {
  const pt = state.propelProjects;
  const source = sourceById(eng().id);
  const items = pt.list.filter((t) => pt.selected.has(t.id) && !propelProjectExistingId(t));
  if (!items.length) return;
  pt.creating = true;
  pt.error = null;
  let created = 0;
  for (const t of items) {
    pt.results[t.id] = { status: 'creating' };
    renderPropel(source);
    const response = await send({ type: 'CREATE_INITIATIVE_TEMPLATE', template: t });
    if (response.ok) {
      pt.results[t.id] = { status: 'created', templateId: response.data.templateId, notes: response.data.notes || [] };
      setItemIssues('propel-projects', t.name, (response.data.notes || []).filter((n) => n.kind === 'firewall' || n.kind === 'cycle')
        .map((n) => ({ severity: 'info', detail: n.kind === 'firewall' ? 'Script line left out (API firewall): ' + n.detail : n.detail })));
      pt.existing.set(t.name.trim().toLowerCase(), response.data.templateId);
      pt.selected.delete(t.id);
      created++;
    } else {
      pt.results[t.id] = { status: 'failed', error: response.error || 'Unknown error' };
      setItemIssues('propel-projects', t.name, [{ severity: 'error', detail: 'Not created: ' + (response.error || 'Unknown error') }]);
    }
    await saveIssues();
  }
  pt.creating = false;
  renderPropel(source);
  if (created) await recordEvent('Created initiative templates', created + ' from Propel project templates');
  showToast(created + ' of ' + items.length + ' initiative template' + (items.length === 1 ? '' : 's') + ' created in ScalePad CS.');
}

function renderPropelPicker() {
  const p = state.propel;
  if (!p.list) {
    return h('section', { class: 'card' },
      h('h2', { class: 'card-title', text: eng().questionnairesTitle }),
      h('p', { class: 'muted', text: 'Read the ' + eng().questionnaires + ' from your ' + eng().name + ' account. Each one you pick becomes an assessment template in ScalePad CS.' }),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: p.loading, onclick: loadPropelList },
        icon('scan'), p.loading ? 'Reading ' + cap(eng().questionnaires) + '…' : 'Load ' + cap(eng().questionnaires)));
  }

  const groups = new Map();
  for (const q of p.list) {
    if (!groups.has(q.category)) groups.set(q.category, []);
    groups.get(q.category).push(q);
  }
  const categories = [...groups.keys()].sort(propelCategoryOrder);

  return h('div', {},
    h('div', { class: 'review-toolbar' },
      h('h2', { text: eng().questionnairesTitle }),
      h('button', { class: 'link-btn', type: 'button', disabled: p.loading, onclick: () => { p.list = null; p.details = {}; loadPropelList(); } }, p.loading ? 'Loading…' : 'Reload')),
    h('p', { class: 'muted small pick-hint', text: eng().weightsHint }),
    ...categories.map((category) => {
      const items = groups.get(category);
      const open = p.open.has(category);
      return h('section', { class: 'q-group' + (open ? ' is-open' : '') },
        h('button', {
          class: 'q-group-head', type: 'button', 'aria-expanded': String(open),
          onclick: () => { open ? p.open.delete(category) : p.open.add(category); renderPropel(sourceById(eng().id)); },
        }, icon('chevron'), h('span', { text: category }), h('span', { class: 'q-count', text: String(items.length) })),
        open ? h('div', { class: 'q-list' }, ...items.map(renderPropelQuestionnaire)) : '');
    }),
  );
}

function renderPropelQuestionnaire(q) {
  const p = state.propel;
  const detail = p.details[q.id];
  const stats = detail ? window.Propel.questionnaireStats(detail) : null;
  const existingId = propelExistingId(q.name);
  const result = p.results[q.id];
  const locked = !!existingId || result?.status === 'created';

  const checkbox = h('input', { type: 'checkbox', 'aria-label': 'Select ' + q.name, disabled: locked || p.creating });
  checkbox.checked = p.selected.has(q.id) && !locked;
  checkbox.addEventListener('change', async () => {
    if (checkbox.checked) {
      p.selected.add(q.id);
      if (!p.details[q.id]) {
        renderPropel(sourceById(eng().id));
        await loadPropelDetails([q.id]);
      }
    } else {
      p.selected.delete(q.id);
    }
    renderPropel(sourceById(eng().id));
  });

  let chip = '';
  if (result?.status === 'creating') chip = h('span', { class: 'chip chip-info', text: 'Creating…' });
  else if (result?.status === 'created') chip = h('span', { class: 'chip chip-success', text: 'Created' });
  else if (result?.status === 'failed') chip = h('span', { class: 'chip chip-danger', title: result.error, text: 'Failed' });
  else if (existingId) chip = h('span', { class: 'chip chip-neutral', title: 'A template with this name already exists in ScalePad CS.', text: 'In ScalePad CS' });

  const meta = stats
    ? stats.sections + ' categories · ' + stats.questions + ' questions' + (eng().id === 'propel' ? ' · ' + stats.points + ' pts' : '')
    : (q.passThreshold != null ? 'Pass at ' + q.passThreshold + '%' : q.description || 'Details load when selected');

  const row = h('div', { class: 'review-item q-item' + (p.selected.has(q.id) && !locked ? ' is-selected' : '') },
    h('div', { class: 'review-top' },
      checkbox,
      h('span', { class: 'review-main' }, h('strong', { text: q.name }), h('small', { text: meta })),
      h('span', { class: 'row-end' }, issueIconFor(engArea('questionnaires'), q.name), chip)),
    detail ? renderPropelWeights(detail) : '');
  return row;
}

function renderPropelWeights(detail) {
  const P = window.Propel;
  const sections = detail.sections.filter((s) => s.questions.length);
  const weights = P.distributeWeights(sections.map(P.sectionPoints));
  return h('details', { class: 'q-weights' },
    h('summary', {}, 'Preview categories and weights'),
    h('ol', {}, ...sections.map((s, i) => h('li', {},
      h('span', { class: 'w-name', text: s.name }),
      h('span', { class: 'w-meta', text: s.questions.length + ' q' + (eng().id === 'propel' ? ' · ' + P.sectionPoints(s) + ' pts' : '') }),
      h('span', { class: 'w-pct', text: weights[i] == null ? '—' : weights[i].toFixed(2) + '%' })))));
}

async function createPropelTemplates() {
  const p = state.propel;
  const source = sourceById(eng().id);
  const ids = [...p.selected].filter((id) => !propelExistingId(p.list.find((q) => q.id === id)?.name));
  if (!ids.length) return;
  p.creating = true;
  p.error = null;
  renderPropel(source);
  if (!(await loadPropelDetails(ids))) {
    p.creating = false;
    renderPropel(source);
    return;
  }
  let created = 0;
  for (const id of ids) {
    const detail = p.details[id];
    p.results[id] = { status: 'creating' };
    renderPropel(source);
    const response = await send({ type: 'CREATE_PROPEL_TEMPLATE', questionnaire: detail, source: eng().id });
    if (response.ok) {
      p.results[id] = { status: 'created', templateId: response.data.templateId, omissions: response.data.omissions || [] };
      const om = response.data.omissions || [];
      const fw = om.filter((o) => o.kind === 'firewall');
      const tr = om.filter((o) => o.kind === 'truncated');
      setItemIssues(engArea('questionnaires'), detail.name, [
        ...fw.map((o) => ({ severity: 'info', detail: 'Script line left out (API firewall) in "' + (o.question || o.category) + '"' })),
        ...tr.map((o) => ({ severity: 'info', detail: 'Instructions shortened to 2,500 characters in "' + o.question + '"' })),
      ]);
      p.existing.set(detail.name.trim().toLowerCase(), response.data.templateId);
      p.selected.delete(id);
      created++;
      await recordEvent('Created assessment template', detail.name + ' (from ' + eng().name + ')');
    } else {
      p.results[id] = { status: 'failed', error: response.error || 'Unknown error' };
      setItemIssues(engArea('questionnaires'), detail.name, [{ severity: 'error', detail: 'Not created: ' + (response.error || 'Unknown error') }]);
    }
    await saveIssues();
    renderPropel(source);
  }
  p.creating = false;
  renderPropel(source);
  showToast(created + ' of ' + ids.length + ' template' + (ids.length === 1 ? '' : 's') + ' created in ScalePad CS.');
}

// ---------- tooltips ----------

const tooltip = $('tooltip');
let tipTimer = null;
function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    tooltip.textContent = text;
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const inRail = !!target.closest('.rail');
    let left = inRail ? rect.left - tipRect.width - 10 : rect.left + rect.width / 2 - tipRect.width / 2;
    let top = inRail ? rect.top + rect.height / 2 - tipRect.height / 2 : rect.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }, 250);
}
function hideTip() {
  clearTimeout(tipTimer);
  tooltip.hidden = true;
}
document.addEventListener('mouseover', (e) => { const t = e.target.closest('[data-tip]'); if (t) showTip(t); });
document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) hideTip(); });
document.addEventListener('focusin', (e) => { const t = e.target.closest('[data-tip]'); if (t && t.matches(':focus-visible')) showTip(t); });
document.addEventListener('focusout', hideTip);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

// ---------- wiring ----------

for (const button of document.querySelectorAll('[data-go]')) {
  button.addEventListener('click', () => setView(button.dataset.go));
}
$('homeLogoBtn').addEventListener('click', () => setView('home'));
$('issuesBtn').addEventListener('click', () => setView('issues'));
$('refreshContextBtn').addEventListener('click', () => refreshContext());

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'SIDE_PANEL_CONTEXT_UPDATED' && message.tabId === state.tab?.id) {
    state.data = message.data;
    renderContextBar();
    if (state.view === 'home') renderHome();
  }
  if (message.type === 'SIDE_PANEL_ACTIVE_TAB_CHANGED') {
    loadState().then(() => refreshContext({ silent: true })).then(() => { if (state.view === 'source') renderSource(); });
  }
  if (message.type === 'SIDE_PANEL_NAVIGATION' && message.tabId === state.tab?.id) {
    refreshContext({ silent: true }).then(() => { if (state.view === 'source') renderSource(); });
  }
});

(async function init() {
  await loadIssues();
  renderFooter();
  renderRail();
  setView('home');
  await loadState();
  const configResponse = await send({ type: 'GET_CONFIG' });
  state.config = configResponse.data || {};
  await loadAccess();
  renderHome();
  verifyConnection(false);
  await refreshContext({ silent: true });
})();
