importScripts('propel.js', 'myitp.js', 'so.js');

const API_BASE = 'https://api.scalepad.com';
const LMX_REQUEST_TIMEOUT_MS = 30000;
const LMX_RETRY_DELAYS_MS = [500, 1200];

async function configurePrimarySidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('Could not make the ScalePad CS side panel the primary action:', error);
  }
}

configurePrimarySidePanel();
chrome.runtime.onInstalled.addListener(configurePrimarySidePanel);
chrome.runtime.onStartup.addListener(configurePrimarySidePanel);

function timeoutError(label, milliseconds) {
  return new Error(`${label} timed out after ${Math.round(milliseconds / 1000)} seconds.`);
}

function reportMigrationProgress(message) {
  // No live log listens any more (the old pop-up progress page is gone); keep retries visible in the worker console.
  console.debug(message);
}

// ---------- storage helpers ----------

async function getConfig() {
  const { apiKey, evaluateUserId } = await chrome.storage.local.get(['apiKey', 'evaluateUserId']);
  return {
    apiKey: apiKey || null,
    evaluateUserId: evaluateUserId || null,
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

async function setApiKey(apiKey) {
  await chrome.storage.local.set({ apiKey });
}

async function setEvaluateUser(evaluateUserId) {
  await chrome.storage.local.set({ evaluateUserId });
}

function shouldRetryLmx(method, error) {
  // GET/PUT/PATCH/DELETE are idempotent, so a retry can't duplicate anything. POST never retries.
  if (method === 'POST') return false;
  const message = error?.message || String(error);
  return error?.retryable === true || /-> (429|500|502|503|504):/.test(message) || /timed out|network|fetch failed/i.test(message);
}

async function lmxFetchOnce(path, { method, body, key }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LMX_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'x-api-key': key,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || res.statusText;
      const error = new Error(`LMX API ${method} ${path} -> ${res.status}: ${detail}`);
      error.retryable = [429, 500, 502, 503, 504].includes(res.status);
      throw error;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw timeoutError(`LMX API ${method} ${path}`, LMX_REQUEST_TIMEOUT_MS);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function lmxFetch(path, { method = 'GET', body, apiKey } = {}) {
  const key = apiKey || (await getConfig()).apiKey;
  if (!key) throw new Error('No LMX API key configured yet.');
  let attempt = 0;
  while (true) {
    try {
      return await lmxFetchOnce(path, { method, body, key });
    } catch (error) {
      if (!shouldRetryLmx(method, error) || attempt >= LMX_RETRY_DELAYS_MS.length) throw error;
      const delay = LMX_RETRY_DELAYS_MS[attempt++];
      reportMigrationProgress(`LMX ${method} ${path} failed; retrying in ${delay}ms (${attempt}/${LMX_RETRY_DELAYS_MS.length})…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const lmx = {
  lookupClients: (search) => lmxFetch(`/lifecycle-manager/v1/clients/lookup?search=${encodeURIComponent(search)}`),
  lookupClientsPage: ({ pageSize = 50, cursor } = {}) => lmxFetch(`/lifecycle-manager/v1/clients/lookup?page_size=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  listUsers: () => lmxFetch('/lifecycle-manager/v1/users'),
  listTemplates: () => lmxFetch('/lifecycle-manager/v1/assessment-templates'),
  getTemplate: (id) => lmxFetch(`/lifecycle-manager/v1/assessment-templates/${id}`),
  createTemplate: (body) => lmxFetch('/lifecycle-manager/v1/assessment-templates', { method: 'POST', body }),
  setQuestionPublicComment: (id, questionId, text) =>
    lmxFetch(`/lifecycle-manager/v1/assessments/${id}/questions/${questionId}/comment/public`, {
      method: 'PUT', body: { comment_plain_text: text },
    }),
  // Initiative endpoints are documented under /cs/v1 (verified for templates; initiatives verified in the live test).
  createInitiative: (body) => lmxFetch('/cs/v1/initiatives', { method: 'POST', body }),
  applyInitiativeTemplate: (id, templateId) => lmxFetch(`/cs/v1/initiatives/${id}/template/${templateId}/apply`, { method: 'POST' }),
  setInitiativeBudget: (id, items) => lmxFetch(`/cs/v1/initiatives/${id}/budget`, { method: 'PUT', body: { budget_line_items: items } }),
  setInitiativeRecurring: (id, items) => lmxFetch(`/cs/v1/initiatives/${id}/recurring`, { method: 'PUT', body: { recurring_line_items: items } }),
  setInitiativeSchedule: (id, body) => lmxFetch(`/cs/v1/initiatives/${id}/schedule`, { method: 'PUT', body: clampSchedule(body).body }),
  setInitiativeStatus: (id, status) => lmxFetch(`/cs/v1/initiatives/${id}/status`, { method: 'PUT', body: { status } }),
  setInitiativeAssignedUser: (id, userId) => lmxFetch(`/cs/v1/initiatives/${id}/assigned-user`, { method: 'PUT', body: { assigned_user_id: userId } }),
  setInitiativePriority: (id, priority) => lmxFetch(`/cs/v1/initiatives/${id}/priority`, { method: 'PUT', body: { priority } }),
  linkQuestionInitiative: (assessmentId, questionId, initiativeId) =>
    lmxFetch(`/cs/v1/assessments/${assessmentId}/questions/${questionId}/initiative`, { method: 'POST', body: { initiative_id: initiativeId } }),
  listInitiativeTemplatesPage: (cursor) => lmxFetch(`/lifecycle-manager/v1/initiative-templates?page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  createInitiativeTemplate: (body) => lmxFetch('/lifecycle-manager/v1/initiative-templates', { method: 'POST', body }),
  listInitiativeTags: () => lmxFetch('/app/v1/tags?filter%5Bdomain%5D=eq%3AInitiative'),
  createTag: (body) => lmxFetch('/app/v1/tags', { method: 'POST', body }),
  updateTemplate: (id, body) => lmxFetch(`/lifecycle-manager/v1/assessment-templates/${id}`, { method: 'PUT', body }),
  listAssessments: (pageSize = 50) => lmxFetch(`/lifecycle-manager/v1/assessments?page_size=${pageSize}`),
  createAssessment: (body) => lmxFetch('/lifecycle-manager/v1/assessments', { method: 'POST', body }),
  getAssessment: (id) => lmxFetch(`/lifecycle-manager/v1/assessments/${id}`),
  evaluate: (id, body) => lmxFetch(`/lifecycle-manager/v1/assessments/${id}/evaluate`, { method: 'PUT', body }),
  setQuestionInternalComment: (id, questionId, text) =>
    lmxFetch(`/lifecycle-manager/v1/assessments/${id}/questions/${questionId}/comment/internal`, {
      method: 'PUT', body: { comment_plain_text: text },
    }),
  setAssessmentInternalComment: (id, text) =>
    lmxFetch(`/lifecycle-manager/v1/assessments/${id}/internal-comment`, {
      method: 'PUT', body: { internal_comment: text },
    }),
  setCompletionStatus: (id, isCompleted) =>
    lmxFetch(`/lifecycle-manager/v1/assessments/${id}/completion-status`, {
      method: 'PUT', body: { is_completed: isCompleted },
    }),

  createInitiative: (body) => lmxFetch('/lifecycle-manager/v1/initiatives', { method: 'POST', body }),
  updateInitiativeSchedule: (id, body) => lmxFetch(`/lifecycle-manager/v1/initiatives/${id}/schedule`, { method: 'PUT', body }),
  updateInitiativeStatus: (id, body) => lmxFetch(`/lifecycle-manager/v1/initiatives/${id}/status`, { method: 'PUT', body }),
  updateInitiativeBudget: (id, body) => lmxFetch(`/lifecycle-manager/v1/initiatives/${id}/budget`, { method: 'PUT', body }),
};

async function allLmxClients() {
  const clients = new Map();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const result = await lmx.lookupClientsPage({ pageSize: 50, cursor });
    for (const client of result.data || []) clients.set(client.id || client.label, client);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return Array.from(clients.values());
}

async function recentEvaluators() {
  const list = await lmx.listUsers();
  return (list.data || []).filter((user) => user.status !== 'Disabled');
}

// ---------- side panel prototype state ----------

const SIDE_PANEL_STATE_KEY = 'sidePanelStateByTab';
const sidePanelStore = () => chrome.storage.session || chrome.storage.local;

function sidePanelTabId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function newSidePanelState(tabId) {
  return {
    workspaceId: 'tab-' + tabId,
    context: null,
    events: [],
    notes: [],
    followUp: false,
  };
}

async function readSidePanelStates() {
  const stored = await sidePanelStore().get(SIDE_PANEL_STATE_KEY);
  return stored[SIDE_PANEL_STATE_KEY] || {};
}

async function getSidePanelState(tabId) {
  const normalizedTabId = sidePanelTabId(tabId);
  if (normalizedTabId === null) return newSidePanelState('unavailable');
  const states = await readSidePanelStates();
  if (!states[normalizedTabId]) {
    states[normalizedTabId] = newSidePanelState(normalizedTabId);
    await sidePanelStore().set({ [SIDE_PANEL_STATE_KEY]: states });
  }
  return states[normalizedTabId];
}

async function saveSidePanelState(tabId, nextState) {
  const normalizedTabId = sidePanelTabId(tabId);
  if (normalizedTabId === null) return nextState;
  const states = await readSidePanelStates();
  states[normalizedTabId] = nextState;
  await sidePanelStore().set({ [SIDE_PANEL_STATE_KEY]: states });
  return nextState;
}

async function emitSidePanelState(tabId) {
  const data = await getSidePanelState(tabId);
  chrome.runtime.sendMessage({ type: 'SIDE_PANEL_CONTEXT_UPDATED', tabId: sidePanelTabId(tabId), data }).catch(() => {});
  return data;
}

function pageContextFromDocument() {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((heading) => clean(heading.textContent))
    .filter(Boolean)
    .slice(0, 6);
  return {
    reason: 'script-request',
    url: window.location.href,
    title: clean(document.title) || window.location.hostname,
    host: window.location.hostname,
    path: window.location.pathname + window.location.search + window.location.hash,
    selection: clean(window.getSelection?.()?.toString()).slice(0, 600),
    headings,
    preview: clean(document.body?.innerText).slice(0, 420),
    capturedAt: new Date().toISOString(),
  };
}

async function requestSidePanelPageContext(tabId) {
  const normalizedTabId = sidePanelTabId(tabId);
  if (normalizedTabId === null) return null;
  const contentResponse = await new Promise((resolve) => {
    chrome.tabs.sendMessage(normalizedTabId, { type: 'SIDE_PANEL_GET_CONTEXT' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
  if (contentResponse?.ok && contentResponse.context) {
    return contentResponse.context;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: normalizedTabId },
      files: ['src/sidepanel-context.js'],
    });
    const injectedResponse = await new Promise((resolve) => {
      chrome.tabs.sendMessage(normalizedTabId, { type: 'SIDE_PANEL_GET_CONTEXT' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
    if (injectedResponse?.ok && injectedResponse.context) return injectedResponse.context;
  } catch (_error) {
    // The current tab may be a restricted page or a domain without access.
  }
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: normalizedTabId },
      func: pageContextFromDocument,
    });
    return result?.[0]?.result || null;
  } catch (_error) {
    return null;
  }
}

async function updateSidePanelPageContext(tabId, context) {
  const normalizedTabId = sidePanelTabId(tabId);
  if (normalizedTabId === null || !context) return getSidePanelState(tabId);
  const current = await getSidePanelState(normalizedTabId);
  const previousUrl = current.context?.url;
  const next = {
    ...current,
    context,
  };
  if (previousUrl && previousUrl !== context.url) {
    next.events = [
      ...(current.events || []),
      {
        label: 'Page changed',
        detail: context.title || context.host || context.url,
        icon: '→',
        createdAt: new Date().toISOString(),
      },
    ].slice(-30);
  }
  const saved = await saveSidePanelState(normalizedTabId, next);
  chrome.runtime.sendMessage({ type: 'SIDE_PANEL_CONTEXT_UPDATED', tabId: normalizedTabId, data: saved }).catch(() => {});
  return saved;
}

async function resolveSidePanelTabId(candidate) {
  const normalized = sidePanelTabId(candidate);
  if (normalized !== null) return normalized;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return sidePanelTabId(tab?.id);
}

async function clearSidePanelPageContext(tabId) {
  const normalizedTabId = sidePanelTabId(tabId);
  if (normalizedTabId === null) return null;
  const current = await getSidePanelState(normalizedTabId);
  const next = { ...current, context: null };
  const saved = await saveSidePanelState(normalizedTabId, next);
  chrome.runtime.sendMessage({ type: 'SIDE_PANEL_NAVIGATION', tabId: normalizedTabId, data: saved }).catch(() => {});
  return saved;
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const data = await getSidePanelState(tabId);
  chrome.runtime.sendMessage({ type: 'SIDE_PANEL_ACTIVE_TAB_CHANGED', tabId, data }).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    await clearSidePanelPageContext(tabId);
    return;
  }
  if (changeInfo.status === 'complete') {
    chrome.runtime.sendMessage({ type: 'SIDE_PANEL_NAVIGATION', tabId }).catch(() => {});
  }
});

if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    chrome.runtime.sendMessage({ type: 'SIDE_PANEL_NAVIGATION', tabId: details.tabId }).catch(() => {});
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const states = await readSidePanelStates();
  if (!states[tabId]) return;
  delete states[tabId];
  await sidePanelStore().set({ [SIDE_PANEL_STATE_KEY]: states });
});

// ---------- initiative tags ----------

const INITIATIVE_TAG_COLORS = ['Info400', 'Primary400', 'Positive400', 'Caution200', 'Secondary200', 'Positive700', 'Primary800', 'Excellent300'];

/** Resolve tag names to Initiative-domain tag ids, creating any that are missing. */
async function ensureInitiativeTags(names) {
  const wanted = [...new Set((names || []).map((n) => String(n).trim().slice(0, 100)).filter(Boolean))];
  if (!wanted.length) return [];
  const existing = (await lmx.listInitiativeTags())?.data || [];
  const byName = new Map(existing.map((t) => [t.name.trim().toLowerCase(), t.tag_id]));
  const ids = [];
  for (const name of wanted) {
    let id = byName.get(name.toLowerCase());
    if (!id) {
      const color = name.startsWith('Priority: ') ? 'Caution200' : INITIATIVE_TAG_COLORS[byName.size % INITIATIVE_TAG_COLORS.length];
      // Same-name tags in other domains get the Initiative domain added rather than duplicated.
      const created = await lmx.createTag({ tag: { name, color, domain: 'Initiative' } });
      id = created.tag_id;
      byName.set(name.toLowerCase(), id);
    }
    ids.push(id);
  }
  return ids;
}

// ---------- Schedule window ----------
// ScalePad CS returns HTTP 500 for schedules more than ~12 months in the past (confirmed by probing:
// the quarter containing "today minus 12 months" is the earliest accepted). Clamp instead of failing.

function earliestQuarter(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
  return { year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 };
}
const quarterIndex = (q) => q.year * 4 + (q.quarter - 1);

/** Returns { body, clamped } with any too-early schedule moved to the earliest accepted quarter. */
function clampSchedule(body) {
  if (!body) return { body, clamped: false };
  const min = earliestQuarter();
  if (body.fiscal_quarter && quarterIndex(body.fiscal_quarter) < quarterIndex(min)) return { body: { fiscal_quarter: min }, clamped: true };
  if (body.target_start_date) {
    const minStart = new Date(Date.UTC(min.year, (min.quarter - 1) * 3, 1)).toISOString().slice(0, 10);
    const start = String(body.target_start_date).slice(0, 10);
    const end = String(body.target_end_date || '').slice(0, 10);
    if (end && end < minStart) return { body: { fiscal_quarter: min }, clamped: true };
    if (start < minStart) return { body: { ...body, target_start_date: minStart }, clamped: true };
  }
  return { body, clamped: false };
}

/** Collapse "Label: LMX API PUT ... -> 403: detail" warnings into one line per failure reason. */
function collapseWarnings(warnings) {
  const groups = new Map();
  const other = [];
  for (const w of warnings) {
    const m = String(w).match(/^(.+?): LMX API \S+ \S+ -> (\d{3}):?\s*(.*)$/);
    if (!m) { other.push(w); continue; }
    const key = m[2] + '|' + m[3].slice(0, 120);
    if (!groups.has(key)) groups.set(key, { code: m[2], detail: m[3], labels: [] });
    groups.get(key).labels.push(m[1].toLowerCase());
  }
  const lines = [...groups.values()].map((g) => 'Could not set ' + [...new Set(g.labels)].join(', ') + ' (HTTP ' + g.code + (g.detail ? ': ' + g.detail.slice(0, 140) : '') + ')');
  return [...lines, ...other];
}

// ---------- Propel client data migration (one audit / one project per call) ----------

const PROPEL_LEDGER_KEY = 'propelMigrationLedger';

async function propelLedger() {
  const { [PROPEL_LEDGER_KEY]: ledger } = await chrome.storage.local.get(PROPEL_LEDGER_KEY);
  return ledger || { audits: {}, projects: {} };
}
async function recordPropelLedger(kind, propelId, scalepadId, extra = {}) {
  const ledger = await propelLedger();
  ledger[kind][propelId] = { ...(ledger[kind][propelId] || {}), id: scalepadId, at: new Date().toISOString(), ...extra };
  await chrome.storage.local.set({ [PROPEL_LEDGER_KEY]: ledger });
}

/** Run a step; collect a warning instead of failing the whole item. */
async function attempt(warnings, label, fn) {
  try {
    const result = await fn();
    return result == null ? true : result; // many ScalePad writes return 204/empty bodies; null means failure
  } catch (error) {
    warnings.push(label + ': ' + error.message);
    return null;
  }
}

async function migratePropelAudit({ audit, answers, client, templateId, evaluatorId }) {
  const ledger = await propelLedger();
  const warnings = [];
  let assessmentId = ledger.audits[audit.id]?.id || null;
  let instance = null;
  let repaired = false;
  const notes = [];
  if (assessmentId) {
    const entry = ledger.audits[audit.id];
    try {
      instance = (await lmx.getAssessment(assessmentId))?.assessment || null;
    } catch (_error) {
      instance = null; // deleted in ScalePad since the last run
    }
    if (!instance || instance.assessment_template_is_deleted) {
      // Gone, or its template was deleted (ScalePad then refuses answers): start a fresh assessment.
      if (instance) notes.push('Its template was deleted, so a new assessment was created. Remove the old one (' + assessmentId + ') with Client Clean Up if it is no longer needed');
      delete ledger.audits[audit.id];
      await chrome.storage.local.set({ [PROPEL_LEDGER_KEY]: ledger });
      assessmentId = null;
      instance = null;
    } else if (!entry.needsRepair && !entry.incomplete) {
      return { skipped: true, assessmentId, links: [], warnings: [] };
    } else {
      repaired = true;
      // Completed assessments are locked: reopen, fix, then complete again.
      if (instance.status === 'Completed') await attempt(warnings, 'Reopen', () => lmx.setCompletionStatus(assessmentId, false));
    }
  }
  if (!assessmentId) {
    const created = await lmx.createAssessment(self.Propel.assessmentCreatePayload(audit, { clientId: client.id, clientName: client.name, templateId, evaluatorId }));
    assessmentId = created.id;
    await recordPropelLedger('audits', audit.id, assessmentId); // record first so a retry never duplicates
    instance = (await lmx.getAssessment(assessmentId))?.assessment || {};
  }
  const plan = self.Propel.planAssessment(audit, answers, instance);
  for (let i = 0; i < plan.evaluations.length; i += 25) {
    await attempt(warnings, 'Answers ' + (i + 1) + '–' + Math.min(i + 25, plan.evaluations.length), () =>
      lmx.evaluate(assessmentId, { question_evaluations: plan.evaluations.slice(i, i + 25) }));
  }
  for (const c of plan.comments) {
    await attempt(warnings, c.kind + ' comment', () => (c.kind === 'public'
      ? lmx.setQuestionPublicComment(assessmentId, c.questionId, c.text)
      : lmx.setQuestionInternalComment(assessmentId, c.questionId, c.text)));
  }
  await attempt(warnings, 'Assessment summary', () => lmx.setAssessmentInternalComment(assessmentId, plan.summary));
  // In-progress Propel audits stay open in ScalePad so they can be finished there (or re-synced later).
  if (!audit.incomplete) await attempt(warnings, 'Mark complete', () => lmx.setCompletionStatus(assessmentId, true));
  else notes.push('Still in progress in ' + (String(audit.id).startsWith('mitp-') ? 'MyITProcess' : 'Propel') + ', so the assessment was left open');
  await recordPropelLedger('audits', audit.id, assessmentId, { needsRepair: warnings.length > 0, incomplete: !!audit.incomplete });
  return { assessmentId, repaired, links: plan.links, stats: plan.stats, unmatched: plan.unmatched.length, warnings: [...collapseWarnings(warnings), ...notes] };
}

/** Set the schedule, falling back to the start quarter if ScalePad rejects the date range. */
async function setPropelSchedule(initiativeId, schedule, warnings, notes) {
  if (!schedule) return;
  if (clampSchedule(schedule.primary).clamped && notes) {
    const q = earliestQuarter();
    notes.push({ kind: 'schedule', detail: 'Planned date is earlier than ScalePad CS allows; scheduled for Q' + q.quarter + ' ' + q.year + ' instead' });
  }
  try {
    await lmx.setInitiativeSchedule(initiativeId, schedule.primary);
  } catch (error) {
    if (!schedule.fallback) { warnings.push('Schedule: ' + error.message); return; }
    await attempt(warnings, 'Schedule (quarter fallback)', () => lmx.setInitiativeSchedule(initiativeId, schedule.fallback));
  }
}

/** The idempotent setters: safe to re-run on an existing initiative (used for repair on retry). */
async function applyPropelProjectDetails(initiativeId, plan, warnings) {
  await attempt(warnings, 'One-time budget', () => lmx.setInitiativeBudget(initiativeId, plan.budgetLineItems));
  await attempt(warnings, 'Recurring costs', () => lmx.setInitiativeRecurring(initiativeId, plan.recurringLineItems));
  await setPropelSchedule(initiativeId, plan.schedule, warnings, plan.notes);
  if (plan.priority) await attempt(warnings, 'Priority', () => lmx.setInitiativePriority(initiativeId, plan.priority));
  if (plan.status) await attempt(warnings, 'Status', () => lmx.setInitiativeStatus(initiativeId, plan.status));
  if (plan.assignedUserId) await attempt(warnings, 'Owner', () => lmx.setInitiativeAssignedUser(initiativeId, plan.assignedUserId));
}

async function migratePropelProject({ project, client, templateIdByName, rich, assignedUserId }) {
  const ledger = await propelLedger();
  const warnings = [];
  const plan = self.Propel.planInitiative(project, {
    clientId: client.id, clientName: client.name, rich,
    templateIdByName: new Map(templateIdByName || []),
  });
  plan.assignedUserId = assignedUserId || null;
  let existing = ledger.projects[project.id];
  if (existing) {
    // Check it still exists before touching it: a deleted initiative answers every update with 403.
    const alive = await lmxFetch('/cs/v1/initiatives/' + existing.id).then(() => true).catch((e) => !/-> (404|403)/.test(e.message));
    if (!alive) {
      delete ledger.projects[project.id];
      await chrome.storage.local.set({ [PROPEL_LEDGER_KEY]: ledger });
      plan.notes.push({ kind: 'recreated', detail: 'The earlier copy was deleted in ScalePad CS, so it was created again' });
      existing = null;
    }
  }
  if (existing) {
    const templatePending = plan.templateId && !existing.templateApplied;
    if (!existing.needsRepair && !templatePending) return { skipped: true, initiativeId: existing.id, notes: [], warnings: [] };
    // Only items that had problems last time are touched again.
    if (templatePending) {
      const ok = await attempt(warnings, 'Apply template', () => lmx.applyInitiativeTemplate(existing.id, plan.templateId));
      if (ok !== null) await recordPropelLedger('projects', project.id, existing.id, { templateApplied: true });
    }
    await applyPropelProjectDetails(existing.id, plan, warnings);
    await recordPropelLedger('projects', project.id, existing.id, { needsRepair: warnings.length > 0 });
    return { skipped: true, repaired: true, initiativeId: existing.id, notes: plan.notes, warnings: collapseWarnings(warnings) };
  }
  const created = await lmx.createInitiative(plan.create);
  const initiativeId = created.id;
  await recordPropelLedger('projects', project.id, initiativeId);
  // Template first (it replaces budget/recurring/action items), then the project's own numbers win.
  if (plan.templateId) {
    const ok = await attempt(warnings, 'Apply template', () => lmx.applyInitiativeTemplate(initiativeId, plan.templateId));
    if (ok !== null) await recordPropelLedger('projects', project.id, initiativeId, { templateApplied: true });
  }
  await applyPropelProjectDetails(initiativeId, plan, warnings);
  await recordPropelLedger('projects', project.id, initiativeId, { needsRepair: warnings.length > 0 });
  return { initiativeId, notes: plan.notes, warnings: collapseWarnings(warnings) };
}

/** Link failed assessment items to the initiatives migrated from their Propel projects. */
async function linkPropelFindings({ assessmentId, links }) {
  const ledger = await propelLedger();
  const warnings = [];
  let linked = 0;
  for (const link of links || []) {
    const initiative = ledger.projects[link.projectId];
    if (!initiative) continue; // project not migrated (yet)
    const ok = await attempt(warnings, 'Link finding', () => lmx.linkQuestionInitiative(assessmentId, link.questionId, initiative.id));
    if (ok !== null) linked++;
  }
  return { linked, warnings };
}

// ---------- Client Clean Up (port of sp-marketplace src/lib/cleanup-api.ts) ----------
// Deletes Lifecycle Manager records for ONE client, children first. Every listed record is
// re-checked against the client id before deletion, so an ignored filter can't widen scope.

const CLEANUP_TYPES = ['action-items', 'notes', 'assessments', 'deliverables', 'meetings', 'contracts', 'goals', 'initiatives'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recordClientId(rec) {
  return rec?.client?.id || rec?.client?.client_id || rec?.client_id || rec?.clientId || null;
}
function recordId(rec, type) {
  const singular = type.replace(/s$/, '').replace(/-/g, '_');
  return rec?.id || rec?.[singular + '_id'] || rec?.[type.replace(/-/g, '_') + '_id'] || null;
}

async function listAllPages(path) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await lmxFetch(path + sep + 'page_size=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...(res?.data || []));
    cursor = res?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** List one record type for a client: raw filter → eq: filter → unfiltered scan; always client-guarded. */
async function listClientRecords(type, clientId) {
  const base = '/lifecycle-manager/v1/' + type;
  let records = null;
  for (const value of [clientId, 'eq:' + clientId]) {
    try { records = await listAllPages(base + '?filter%5Bclient.id%5D=' + encodeURIComponent(value)); break; } catch (_e) { /* try next form */ }
  }
  if (records === null) records = await listAllPages(base);
  let ids = records.filter((r) => recordClientId(r) === clientId).map((r) => recordId(r, type)).filter(Boolean);
  if (type === 'action-items' && !ids.length) {
    // Fallback: action items hang off the client's initiatives and meetings.
    for (const parent of ['initiatives', 'meetings']) {
      const parents = await listClientRecords(parent, clientId).catch(() => []);
      for (const pid of parents) {
        const res = await lmxFetch('/lifecycle-manager/v1/' + parent + '/' + pid + '/action-items').catch(() => null);
        ids.push(...(res?.action_item_ids || []));
      }
    }
    ids = [...new Set(ids)];
  }
  return ids;
}

/** DELETE with backoff on 429/5xx (honours the retry hints lmxFetch already applies). */
async function deleteRecord(type, id) {
  const delays = [1000, 3000, 8000];
  for (let attempt = 0; ; attempt++) {
    try {
      await lmxFetchOnce('/lifecycle-manager/v1/' + type + '/' + id, { method: 'DELETE', key: (await getConfig()).apiKey });
      return;
    } catch (error) {
      const retryable = /-> (429|500|502|503|504)/.test(error.message);
      if (!retryable || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}

async function cleanupPreview({ clientId, types }) {
  const counts = {};
  for (const type of (types || CLEANUP_TYPES).filter((t) => CLEANUP_TYPES.includes(t))) {
    try { counts[type] = (await listClientRecords(type, clientId)).length; } catch (error) { counts[type] = { error: error.message }; }
  }
  return counts;
}

async function cleanupDeleteType({ clientId, type }) {
  if (!CLEANUP_TYPES.includes(type)) throw new Error('Unknown record type: ' + type);
  const ids = await listClientRecords(type, clientId);
  const failures = [];
  let deleted = 0;
  for (const id of ids) {
    try { await deleteRecord(type, id); deleted++; } catch (error) { failures.push({ id, detail: error.message }); }
    await sleep(120);
  }
  return { type, total: ids.length, deleted, failures };
}

// ---------- Template & tag clean up (account level) ----------
// Only the account's own items are ever listed: ScalePad-provided templates
// (scope "Application", or deliverable templates with is_custom=false) are filtered out here.

const TEMPLATE_TYPES = {
  'assessment-templates': { label: 'Assessment template', list: '/cs/v1/assessment-templates', id: 'assessment_template_id', name: 'title', del: (id) => '/cs/v1/assessment-templates/' + id },
  'initiative-templates': { label: 'Initiative template', list: '/cs/v1/initiative-templates', id: 'initiative_template_id', name: 'name', del: (id) => '/cs/v1/initiative-templates/' + id },
  'roadmap-templates': { label: 'Roadmap template', list: '/cs/v1/roadmap-templates', id: 'roadmap_template_id', name: 'name', del: (id) => '/cs/v1/roadmap-templates/' + id },
  'goal-templates': { label: 'Goal template', list: '/cs/v1/goal-templates', id: 'goal_template_id', name: 'title', del: (id) => '/cs/v1/goal-templates/' + id },
  'task-templates': { label: 'Task template', list: '/app/v1/task-templates', id: 'task_template_id', name: 'title', del: (id) => '/app/v1/task-templates/' + id },
  'deliverable-templates': { label: 'Deliverable template', list: '/cs/v1/deliverables/templates', id: 'id', name: 'name', custom: (r) => r.is_custom !== false, del: (id) => '/cs/v1/deliverables/templates/' + id },
  'agreement-templates': { label: 'Agreement template', list: '/cs/v1/agreement-templates', id: 'agreement_template_id', name: 'title', del: (id) => '/cs/v1/agreement-templates/' + id },
  tags: { label: 'Tag', list: '/app/v1/tags', id: 'tag_id', name: 'name', detail: (r) => (r.domains || []).join(', '), del: (id) => '/app/v1/tags/' + id },
};

async function listAccountItems(types) {
  const out = [];
  for (const type of types) {
    const t = TEMPLATE_TYPES[type];
    if (!t) continue;
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const sep = t.list.includes('?') ? '&' : '?';
      const res = await lmxFetch(t.list + (type === 'tags' ? '' : sep + 'page_size=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')));
      rows.push(...(Array.isArray(res) ? res : res?.data || []));
      cursor = res?.next_cursor;
      if (!cursor || type === 'tags') break;
    }
    for (const r of rows) {
      const isOwn = t.custom ? t.custom(r) : (r.scope ? r.scope === 'Account' : true);
      if (!isOwn) continue;
      out.push({ type, label: t.label, id: r[t.id], name: r[t.name] || '(untitled)', detail: t.detail ? t.detail(r) : '' });
    }
  }
  return out;
}

async function deleteAccountItems(items) {
  const results = [];
  for (const item of items) {
    const t = TEMPLATE_TYPES[item.type];
    if (!t) { results.push({ ...item, ok: false, detail: 'Unknown type' }); continue; }
    try {
      const key = (await getConfig()).apiKey;
      const delays = [1000, 3000];
      for (let attemptNo = 0; ; attemptNo++) {
        try { await lmxFetchOnce(t.del(item.id), { method: 'DELETE', key }); break; } catch (error) {
          if (!/-> (429|503)/.test(error.message) || attemptNo >= delays.length) throw error;
          await sleep(delays[attemptNo]);
        }
      }
      results.push({ ...item, ok: true });
    } catch (error) {
      results.push({ ...item, ok: false, detail: error.message.replace(/^LMX API DELETE \S+ -> /, '') });
    }
    await sleep(120);
  }
  return results;
}

// ---------- ControlMap → ScalePad CS workstream sync ----------
// Same account and key: ControlMap lives at /controlmap/v1. Items become LM initiatives named
// "{code} · title"; the code prefix + a stored fingerprint keep re-syncs idempotent.

const CM_SYNC_KEY = 'controlmapSyncItems';
const CM_STATUS = { 'not started': 'Proposed', 'in progress': 'InProgress', review: 'InProgress', completed: 'Completed', closed: 'Completed', remediated: 'Completed' };
const CM_PRIORITY = { critical: 'High', severe: 'High', high: 'High', medium: 'Medium', moderate: 'Medium', low: 'Low' };

async function cmPages(path, pick) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await lmxFetch(path + (cursor ? sep + 'cursor=' + encodeURIComponent(cursor) : ''));
    const box = pick ? pick(res) : res;
    out.push(...(box?.data || []));
    cursor = box?.next_cursor;
    if (!cursor) break;
    await sleep(120);
  }
  return out;
}

async function cmPortfolio() {
  const [health, risks] = await Promise.all([
    cmPages('/controlmap/v1/clients/health?fields=compliance_score,risk_score,work_progress&page_size=200'),
    cmPages('/controlmap/v1/clients/risks-summary?page_size=200').catch(() => []),
  ]);
  const riskById = new Map(risks.map((r) => [r.client?.id, r.risk_summary]));
  return health.map((h) => {
    const rs = h.risk_score || riskById.get(h.client?.id) || {};
    const br = rs.risk_breakdown || {};
    return {
      id: h.client?.id, name: h.client?.name || 'Unnamed client', tenantId: h.client?.tenant_id || null,
      riskLevel: rs.risk_level || null, severe: br.severe || 0, high: br.high || 0, medium: br.medium || 0, low: br.low || 0,
      compliance: h.compliance_score?.overall_score ?? null, complianceTrend: h.compliance_score?.trend?.last_30_days ?? null,
      actionItemsPct: h.work_progress?.action_items?.completion_percentage ?? null,
    };
  });
}

async function cmClientItems(clientId) {
  // Plain GET lists (same fields as the search endpoint) so transient failures retry automatically.
  // Risks and action items load independently: one failing never blanks the other.
  const base = '/controlmap/v1/clients/' + clientId;
  const [risks, actions] = await Promise.allSettled([
    cmPages(base + '/risks?page_size=100&sort=-current_risk', (r) => r?.risks),
    cmPages(base + '/action-items?page_size=200', (r) => r?.action_items),
  ]);
  const explain = (label, r) => {
    const msg = r.reason?.message || String(r.reason);
    const code = (msg.match(/-> (\d{3})/) || [])[1];
    return 'Could not load ' + label + ' from ControlMap' + (code ? ' (HTTP ' + code + ')' : '') +
      (code === '403' ? '. The API turned the request away; this is usually temporary, so try again in a moment.' : ': ' + msg);
  };
  const errors = [];
  if (risks.status === 'rejected') errors.push(explain('risks', risks));
  if (actions.status === 'rejected') errors.push(explain('action items', actions));
  return {
    risks: risks.status === 'fulfilled' ? risks.value : [],
    actionItems: actions.status === 'fulfilled' ? actions.value : [],
    error: errors.join(' ') || null,
  };
}

function cmQuarter(dateStr, horizonMonths) {
  const d = dateStr ? new Date(dateStr) : new Date();
  if (!dateStr || Number.isNaN(d.getTime())) d.setUTCMonth(d.getUTCMonth() + (horizonMonths || 6));
  return { year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1 };
}

/** Desired initiative state for one ControlMap item. */
function cmSpec(item, sourceType, horizonMonths) {
  const code = item.code || (sourceType === 'risks' ? 'RSK-' : 'AI-') + item.id;
  const title = item.weakness_name || item.name || item.title || 'Untitled';
  const text = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const para = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const lines = [
    text(item.weakness_description || item.description) && 'Description: ' + text(item.weakness_description || item.description),
    text(item.corrective_action || item.treatment) && (item.corrective_action ? 'Corrective action: ' : 'Treatment: ') + text(item.corrective_action || item.treatment),
    item.current_risk_label && 'Current risk: ' + item.current_risk_label + (item.target_risk_label ? ' → target ' + item.target_risk_label : ''),
    'Synced from ControlMap ' + code + '.',
  ].filter(Boolean).map((t) => t.slice(0, 2000));
  const status = String(item.status || '').toLowerCase();
  const cost = Number(item.cost) || 0;
  return {
    code,
    name: (code + ' · ' + title).slice(0, 200),
    summary: JSON.stringify({ type: 'doc', content: lines.map(para) }),
    status: CM_STATUS[status] || 'Proposed',
    priority: CM_PRIORITY[String(item.priority || item.current_risk_label || '').toLowerCase()] || 'None',
    quarter: cmQuarter(item.planned_completion_date || item.planned_end_date || item.due_date || item.planned_start_date, horizonMonths),
    budgetLine: cost > 0 ? { label: 'ControlMap ' + code + ' remediation', cost_subunits: Math.round(cost * 100), cost_type: 'Fixed' } : null,
  };
}

async function lmClientInitiatives(lmClientId) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const res = await lmxFetch('/lifecycle-manager/v2/initiatives?filter%5Bclient.id%5D=eq%3A' + encodeURIComponent(lmClientId) + '&include_unscheduled=true&page_size=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...(res?.data || []));
    cursor = res?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * Sync selected ControlMap items into initiatives for one client.
 * payload: { cmClientId, lmClient:{id,name}, sourceType:'risks'|'action_items', items:[...], horizonMonths, dryRun }
 */
async function cmSync({ cmClientId, lmClient, sourceType, items, horizonMonths = 6, dryRun = true }) {
  const { [CM_SYNC_KEY]: store = {} } = await chrome.storage.local.get(CM_SYNC_KEY);
  const existing = await lmClientInitiatives(lmClient.id).catch(() => []);
  const byCode = new Map(existing.map((i) => [String(i.name || '').split(' · ')[0], i]));
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  for (const item of items) {
    if (String(item.status || '').toLowerCase() === 'not applicable') { summary.skipped++; continue; }
    const spec = cmSpec(item, sourceType, horizonMonths);
    const key = cmClientId + '|' + sourceType + '|' + item.id;
    const fingerprint = JSON.stringify(spec);
    const known = store[key];
    let initiativeId = known?.initiativeId || byCode.get(spec.code)?.id || byCode.get(spec.code)?.initiative_id || null;
    if (known && known.fingerprint === fingerprint && initiativeId) { summary.unchanged++; continue; }
    if (dryRun) { initiativeId ? summary.updated++ : summary.created++; continue; }
    const warnings = [];
    try {
      if (initiativeId) {
        await attempt(warnings, 'Rename/summary', () => lmxFetch('/cs/v1/initiatives/' + initiativeId, { method: 'PATCH', body: { name: spec.name, executive_summary_json: spec.summary } }));
        summary.updated++;
      } else {
        const created = await lmx.createInitiative({ client_key: { id: lmClient.id, name: lmClient.name }, name: spec.name, executive_summary_json: spec.summary });
        initiativeId = created.id;
        summary.created++;
      }
      store[key] = { initiativeId, fingerprint: null, code: spec.code }; // null until all steps land, so a retry re-applies
      await attempt(warnings, 'Status', () => lmx.setInitiativeStatus(initiativeId, spec.status));
      if (spec.priority !== 'None') await attempt(warnings, 'Priority', () => lmx.setInitiativePriority(initiativeId, spec.priority));
      await attempt(warnings, 'Schedule', () => lmx.setInitiativeSchedule(initiativeId, { fiscal_quarter: spec.quarter }));
      if (spec.budgetLine) {
        // Replace only our own labelled line; keep anything the user added.
        const current = (byCode.get(spec.code)?.budget?.line_items || []).filter((l) => l.label !== spec.budgetLine.label);
        await attempt(warnings, 'Budget', () => lmx.setInitiativeBudget(initiativeId, [...current, spec.budgetLine]));
      }
      if (!warnings.length) store[key].fingerprint = fingerprint;
      else summary.errors.push(spec.name + ': ' + warnings.join('; '));
    } catch (error) {
      summary.errors.push(spec.name + ': ' + error.message);
    }
    await chrome.storage.local.set({ [CM_SYNC_KEY]: store });
    await sleep(120);
  }
  return summary;
}

// ---------- Tenant migration (v1: initiatives, goals, notes, assessments + goal→initiative links) ----------
// Source key lives only in chrome.storage.session (memory; cleared when the browser closes).
// Destination = the key configured in Settings. A ledger prevents duplicates on re-runs.

const TENANT_SOURCE_KEY = 'tenantSourceApiKey';
const TENANT_LEDGER_KEY = 'tenantMigrationLedger';

async function tenantKey(side) {
  if (side === 'dest') return (await getConfig()).apiKey;
  const { [TENANT_SOURCE_KEY]: key } = await chrome.storage.session.get(TENANT_SOURCE_KEY);
  if (!key) throw new Error('Add the source tenant API key first.');
  return key;
}

/** Fetch with an explicit tenant key; retries 429/5xx with backoff. */
async function tenantFetch(side, path, { method = 'GET', body } = {}) {
  const key = await tenantKey(side);
  const delays = [800, 2000, 5000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await lmxFetchOnce(path, { method, body, key });
    } catch (error) {
      if (!/-> (429|500|502|503|504)/.test(error.message) || attempt >= delays.length || (method !== 'GET' && !/-> 429/.test(error.message))) throw error;
      await sleep(delays[attempt]);
    }
  }
}

async function tenantPages(side, path) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await tenantFetch(side, path + sep + 'page_size=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...(res?.data || []));
    cursor = res?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function tenantSetSourceKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) { await chrome.storage.session.remove(TENANT_SOURCE_KEY); return { cleared: true }; }
  await lmxFetchOnce('/lifecycle-manager/v1/users?page_size=1', { method: 'GET', key }); // validates the key
  await chrome.storage.session.set({ [TENANT_SOURCE_KEY]: key });
  const dest = (await getConfig()).apiKey;
  return { sameTenant: key === dest };
}

async function tenantClients(side) {
  const rows = await tenantPages(side, '/lifecycle-manager/v1/clients?sort=name');
  return rows.map((r) => ({ id: r.client?.client_id || r.client_id || r.id, name: r.client?.display_name || r.display_name || r.name || '' })).filter((c) => c.id);
}

async function tenantUsers(side) {
  const rows = await tenantPages(side, '/lifecycle-manager/v1/users');
  return rows.map((u) => ({
    id: u.user_id || u.id,
    email: (u.email || u.contact_info?.email || '').trim().toLowerCase() || null,
    name: ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.name || u.email || 'Unnamed user',
    disabled: u.status === 'Disabled',
  })).filter((u) => u.id);
}

/**
 * Pair every source user with a destination user: email first, then an unambiguous full name.
 * Owners and evaluators that find no pair fall back to the chosen destination user.
 */
async function tenantUserMatch() {
  const [source, dest] = await Promise.all([tenantUsers('source'), tenantUsers('dest')]);
  const active = dest.filter((u) => !u.disabled);
  const byEmail = new Map(active.filter((u) => u.email).map((u) => [u.email, u.id]));
  const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const byName = new Map();
  for (const u of active) byName.set(norm(u.name), [...(byName.get(norm(u.name)) || []), u.id]);
  const rows = source.map((u) => {
    const row = { key: u.id, sourceId: u.id, sourceName: u.name, sourceEmail: u.email, destId: null, matchedBy: 'none' };
    if (u.email && byEmail.has(u.email)) return { ...row, destId: byEmail.get(u.email), matchedBy: 'email' };
    const named = byName.get(norm(u.name)) || [];
    if (named.length === 1) return { ...row, destId: named[0], matchedBy: 'name' };
    return row;
  }).sort((a, b) => (!!a.destId - !!b.destId) || a.sourceName.localeCompare(b.sourceName));
  return { rows, destUsers: active.map(({ id, email, name }) => ({ id, email, name })).sort((a, b) => a.name.localeCompare(b.name)) };
}

async function tenantLedger() {
  const { [TENANT_LEDGER_KEY]: l } = await chrome.storage.local.get(TENANT_LEDGER_KEY);
  return l || {};
}
async function tenantRecord(key, dstId) {
  const l = await tenantLedger();
  l[key] = dstId;
  await chrome.storage.local.set({ [TENANT_LEDGER_KEY]: l });
}

const cleanLines = (lines) => (lines || []).map(({ item_id, product_id, assigned_asset_count, ...rest }) => rest);

async function tenantCopyTemplate(srcTemplateId, destTemplates) {
  const src = (await tenantFetch('source', '/lifecycle-manager/v1/assessment-templates/' + srcTemplateId))?.assessment_template;
  if (!src) throw new Error('Source assessment template not found.');
  const norm = (s) => String(s || '').trim().toLowerCase();
  const match = destTemplates.find((t) => norm(t.title) === norm(src.title));
  if (match) return match.assessment_template_id || match.id;
  const payload = { assessment_template: {
    title: src.title, description: String(src.description || '').trim() || src.title,
    is_category_weight_evenly_distributed: !!src.is_category_weight_evenly_distributed,
    categories: (src.categories || []).map((c) => ({
      title: c.title, description: c.description || null,
      is_question_weight_evenly_distributed: !!c.is_question_weight_evenly_distributed,
      weight_in_percentage: c.weight_in_percentage ?? null,
      questions: (c.questions || []).map((q) => ({
        title: q.title, description: String(q.description || '').trim() || q.title, remediation_tips: q.remediation_tips || null,
        scoring_instructions: q.scoring_instructions || null, criterion_label_type_enum: q.criterion_label_type_enum || 'MultiResponse',
        weight_in_percentage: q.weight_in_percentage ?? null, tag_ids: [],
        // The API rejects empty descriptions (422), so blank criteria get their rating label.
        criteria: (q.criteria || []).map((cr) => {
          const label = cr.label_enum || cr.label_key;
          const text = { Satisfactory: 'Satisfactory', NeedsAttention: 'Needs attention', AtRisk: 'At risk', NotApplicable: 'Not applicable' }[label] || label || 'No description';
          return { label_enum: label, description: String(cr.description || '').trim() || text };
        }),
      })),
    })),
  } };
  const created = await tenantFetch('dest', '/lifecycle-manager/v1/assessment-templates', { method: 'POST', body: payload });
  destTemplates.push({ title: src.title, assessment_template_id: created.assessment_template_id });
  return created.assessment_template_id;
}

// ---------- Tenant migration phase 2: account setup (copied once per run, matched by name) ----------

const TENANT_MAPS_KEY = 'tenantAccountMaps';

/** List endpoints are a mix of paged and plain {data[]}; this reads either. */
async function tenantList(side, path) {
  try { return await tenantPages(side, path); }
  catch (error) {
    if (!/-> 4\d\d/.test(error.message)) throw error;
    return (await tenantFetch(side, path))?.data || [];
  }
}

/** Raw fetch for binary bodies (attachments). */
async function tenantRaw(side, path, init = {}) {
  const key = await tenantKey(side);
  const res = await fetch(API_BASE + path, { ...init, headers: { 'x-api-key': key, ...(init.headers || {}) } });
  if (!res.ok) throw new Error('LMX API ' + (init.method || 'GET') + ' ' + path + ' -> ' + res.status);
  return res;
}

/**
 * Copy account-level setup from source to destination and build source→destination id maps
 * (tags, statuses, outcomes, meeting types, templates). Existing destination items with the same
 * name are reused, never duplicated. Types not selected are still matched so client records can map to them.
 */
async function tenantAccountSetup({ types = [], userMap } = {}) {
  const want = new Set(types);
  const out = { counts: {}, warnings: [], errors: [] };
  const maps = { tags: {}, statuses: {}, outcomes: {}, meetingTypes: {}, initiativeTemplates: {}, goalTemplates: {}, deliverableTemplates: {} };
  const norm = (s) => String(s || '').trim().toLowerCase();
  const bump = (type, key) => { out.counts[type] = out.counts[type] || { created: 0, skipped: 0, failed: 0 }; out.counts[type][key]++; };
  const own = (x) => (x.scope || 'Account') !== 'Application';
  const mapUser = (id) => (id && userMap?.byId?.[id]) || null;
  const LABELS = {
    tags: 'Tag', statuses: 'Initiative status', outcomes: 'Goal outcome', meetingTypes: 'Meeting type', meetingTemplates: 'Meeting template',
    taskTemplates: 'Task template', initiativeTemplates: 'Initiative template', goalTemplates: 'Goal template',
    agreementTemplates: 'Agreement template', deliverableTemplates: 'Deliverable template', roadmapTemplates: 'Roadmap template',
  };
  // Match every source row to a destination row by name; create the missing ones when the type is selected.
  async function sync(type, srcRows, dstRows, { keyOf, srcId, dstId, create, mapName, creatable = () => true }) {
    const byKey = new Map(dstRows.map((d) => [norm(keyOf(d)), dstId(d)]));
    for (const s of srcRows) {
      const k = norm(keyOf(s));
      if (!k) continue;
      let id = byKey.get(k);
      if (id) { if (want.has(type) && creatable(s)) bump(type, 'skipped'); }
      else if (want.has(type) && creatable(s)) {
        try { id = await create(s); if (id) byKey.set(k, id); bump(type, 'created'); }
        catch (error) { bump(type, 'failed'); out.errors.push(LABELS[type] + ' "' + keyOf(s) + '": ' + error.message); }
        await sleep(100);
      }
      if (id && mapName) maps[mapName][srcId(s)] = id;
    }
  }
  const step = async (type, fn) => { try { await fn(); } catch (error) { out.errors.push(LABELS[type] + 's: ' + error.message); } };

  await step('tags', async () => {
    const [s, d] = await Promise.all([tenantList('source', '/app/v1/tags'), tenantList('dest', '/app/v1/tags')]);
    await sync('tags', s, d, { keyOf: (t) => t.name, srcId: (t) => t.tag_id, dstId: (t) => t.tag_id, mapName: 'tags',
      create: async (t) => {
        let id = null;
        for (const domain of t.domains?.length ? t.domains : ['Initiative']) {
          const r = await tenantFetch('dest', '/app/v1/tags', { method: 'POST', body: { tag: { name: t.name, color: t.color || 'Primary500', domain } } });
          id = id || r?.tag_id;
        }
        return id;
      } });
  });

  await step('statuses', async () => {
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/initiatives/statuses/labels'), tenantList('dest', '/cs/v1/initiatives/statuses/labels')]);
    const labelOf = (x) => x.custom_label || x.default_label || x.status;
    for (const x of s.filter((x) => !x.is_custom)) maps.statuses[x.initiative_status_id] = x.initiative_status_id;
    await sync('statuses', s.filter((x) => x.is_custom), d, { keyOf: labelOf, srcId: (x) => x.initiative_status_id, dstId: (x) => x.initiative_status_id, mapName: 'statuses',
      create: async (x) => (await tenantFetch('dest', '/cs/v1/initiatives/statuses/custom', { method: 'POST', body: { label: labelOf(x), base_status: x.base_status } }))?.data?.initiative_status_id });
    if (want.has('statuses')) {
      for (const x of s.filter((x) => !x.is_custom && x.custom_label)) {
        const dx = d.find((y) => y.initiative_status_id === x.initiative_status_id);
        if (dx && dx.custom_label === x.custom_label) continue;
        await attempt(out.warnings, 'Status label "' + x.custom_label + '"', () => tenantFetch('dest', '/cs/v1/initiatives/statuses/' + encodeURIComponent(x.initiative_status_id) + '/label', { method: 'PUT', body: { custom_label: x.custom_label } }));
      }
    }
  });

  await step('outcomes', async () => {
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/goals/outcomes?visibility=all'), tenantList('dest', '/cs/v1/goals/outcomes?visibility=all')]);
    await sync('outcomes', s, d, { keyOf: (o) => o.label, srcId: (o) => o.outcome_id, dstId: (o) => o.outcome_id, mapName: 'outcomes', creatable: (o) => own(o) && !o.is_archived,
      create: async (o) => (await tenantFetch('dest', '/cs/v1/goals/outcomes', { method: 'POST', body: { label: o.label, description: o.description || null, group_key: o.group_key || null } }))?.outcome_id });
  });

  await step('meetingTypes', async () => {
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/meeting-types'), tenantList('dest', '/cs/v1/meeting-types')]);
    await sync('meetingTypes', s, d, { keyOf: (t) => t.label, srcId: (t) => t.meeting_type_id, dstId: (t) => t.meeting_type_id, mapName: 'meetingTypes',
      create: async (t) => (await tenantFetch('dest', '/cs/v1/meeting-types', { method: 'POST', body: { label: t.label } }))?.meeting_type_id });
  });

  await step('meetingTemplates', async () => {
    if (!want.has('meetingTemplates')) return;
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/meeting-templates'), tenantList('dest', '/cs/v1/meeting-templates')]);
    await sync('meetingTemplates', s, d, { keyOf: (t) => t.title, srcId: (t) => t.meeting_template_id, dstId: (t) => t.meeting_template_id,
      create: async (t) => {
        const typeId = maps.meetingTypes[t.meeting_type?.meeting_type_id];
        if (!typeId) throw new Error('its meeting type "' + (t.meeting_type?.label || '?') + '" is missing in the destination; include Meeting types.');
        return (await tenantFetch('dest', '/cs/v1/meeting-templates', { method: 'POST', body: {
          title: t.title, meeting_type_id: typeId, agenda_json: t.agenda_json || null,
          assigned_user_ids: (t.assigned_user_ids || []).map(mapUser).filter(Boolean),
        } }))?.meeting_template_id;
      } });
  });

  await step('taskTemplates', async () => {
    if (!want.has('taskTemplates')) return;
    const [s, d] = await Promise.all([tenantList('source', '/app/v1/task-templates'), tenantList('dest', '/app/v1/task-templates')]);
    await sync('taskTemplates', s, d, { keyOf: (t) => t.title, srcId: (t) => t.task_template_id, dstId: (t) => t.task_template_id, creatable: own,
      create: async (t) => (await tenantFetch('dest', '/app/v1/task-templates', { method: 'POST', body: { task_template: { title: t.title, description_json: t.description_json || null, category: t.category || null } } }))?.task_template_id });
  });

  await step('initiativeTemplates', async () => {
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/initiative-templates'), tenantList('dest', '/cs/v1/initiative-templates')]);
    await sync('initiativeTemplates', s, d, { keyOf: (t) => t.name, srcId: (t) => t.initiative_template_id, dstId: (t) => t.initiative_template_id, mapName: 'initiativeTemplates', creatable: own,
      create: async (t) => {
        const x = (await tenantFetch('source', '/cs/v1/initiative-templates/' + t.initiative_template_id))?.initiative_template || t;
        return (await tenantFetch('dest', '/cs/v1/initiative-templates', { method: 'POST', body: { initiative_template: {
          name: x.name, executive_summary_json: x.executive_summary_json || null, business_value_json: x.business_value_json || null,
          budget_line_items: cleanLines(x.budget_line_items), recurring_line_items: cleanLines(x.recurring_line_items),
          action_items: x.action_items || [], estimated_hours: x.estimated_hours || null,
          tag_ids: (x.tags || []).map((g) => maps.tags[g.tag_id]).filter(Boolean),
          budget_model: x.budget_model || null, cost_type: x.cost_type || null, recurrence: x.recurrence ?? null, duration: x.duration ?? null,
        } } }))?.initiative_template_id;
      } });
  });

  await step('goalTemplates', async () => {
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/goal-templates'), tenantList('dest', '/cs/v1/goal-templates')]);
    await sync('goalTemplates', s, d, { keyOf: (t) => t.title, srcId: (t) => t.goal_template_id, dstId: (t) => t.goal_template_id, mapName: 'goalTemplates', creatable: own,
      create: async (t) => {
        const x = (await tenantFetch('source', '/cs/v1/goal-templates/' + t.goal_template_id))?.goal_template || t;
        const initIds = (x.initiative_templates || []).map((i) => maps.initiativeTemplates[i.initiative_template_id]).filter(Boolean);
        if (!initIds.length) throw new Error('none of its initiative templates exist in the destination; include Initiative templates.');
        return (await tenantFetch('dest', '/cs/v1/goal-templates', { method: 'POST', body: { goal_template: {
          title: x.title, description: x.description || null, initiative_template_ids: initIds,
          outcome_ids: (x.outcomes || []).map((o) => maps.outcomes[o.outcome_id]).filter(Boolean),
        } } }))?.goal_template_id;
      } });
  });

  await step('agreementTemplates', async () => {
    if (!want.has('agreementTemplates')) return;
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/agreement-templates'), tenantList('dest', '/cs/v1/agreement-templates')]);
    await sync('agreementTemplates', s, d, { keyOf: (t) => t.name_display || t.title, srcId: (t) => t.agreement_template_id, dstId: (t) => t.agreement_template_id, creatable: own,
      create: async (t) => {
        const x = (await tenantFetch('source', '/cs/v1/agreement-templates/' + t.agreement_template_id))?.agreement_template || t;
        return (await tenantFetch('dest', '/cs/v1/agreement-templates', { method: 'POST', body: { agreement_template: {
          name_display: x.name_display || x.title, title: x.title || x.name_display, impact: x.impact || 'Unspecified', status: x.status || 'Active',
          billing_cycle: x.billing_cycle || 'Unknown', billing_cost_subunits: x.billing_cost_subunits || 0, billing_cost_type: x.billing_cost_type || 'Actual',
          notify_days_before_end_date: x.notify_days_before_end_date ?? 30, category: x.category || null, description: x.description || null,
          billing_number_of_seats: x.billing_number_of_seats == null ? null : Math.round(x.billing_number_of_seats),
          billing_is_auto_renew: x.billing_is_auto_renew ?? null, is_third_party: x.is_third_party ?? null,
        } } }))?.agreement_template_id;
      } });
  });

  await step('deliverableTemplates', async () => {
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/deliverables/templates'), tenantList('dest', '/cs/v1/deliverables/templates')]);
    await sync('deliverableTemplates', s, d, { keyOf: (t) => t.name, srcId: (t) => t.id, dstId: (t) => t.id, mapName: 'deliverableTemplates', creatable: (t) => t.is_custom !== false,
      create: async (t) => {
        const x = (await tenantFetch('source', '/cs/v1/deliverables/templates/' + t.id))?.deliverable_template || t;
        let dropped = 0;
        const sections = (x.sections || []).map((sec) => ({
          section_key: sec.section_key, display_order: sec.display_order ?? 0, name: sec.name || null, summary: sec.summary || null,
          include_cover_page: sec.include_cover_page ?? true, use_landscape_cover_page: !!sec.use_landscape_cover_page, include_exec_summary: sec.include_exec_summary ?? true,
          // Vendor components point at the source tenant's integrations, which don't exist in the destination.
          components: (sec.components || []).filter((c) => (c.component_type_configuration?.type === 'Vendor' ? (dropped++, false) : true)).map((c) => ({
            component_key: c.component_key, component_type_configuration: { type: c.component_type_configuration?.type || 'LifecycleManager' },
            configuration: c.configuration || null, display_order: c.display_order ?? null,
          })),
        }));
        if (dropped) out.warnings.push('Deliverable template "' + x.name + '": ' + dropped + ' integration component(s) left out; re-add them in the destination.');
        const r = await tenantFetch('dest', '/cs/v1/deliverables/templates', { method: 'POST', body: { name: x.name, description: x.description || null, sections } });
        return r?.deliverable_template?.id;
      } });
  });

  await step('roadmapTemplates', async () => {
    if (!want.has('roadmapTemplates')) return;
    const [s, d] = await Promise.all([tenantList('source', '/cs/v1/roadmap-templates'), tenantList('dest', '/cs/v1/roadmap-templates')]);
    const owner = (o) => (o?.kind === 'user' && mapUser(o.user_id) ? { kind: 'user', user_id: mapUser(o.user_id) } : null);
    await sync('roadmapTemplates', s, d, { keyOf: (t) => t.name, srcId: (t) => t.roadmap_template_id, dstId: (t) => t.roadmap_template_id, creatable: own,
      create: async (t) => {
        const x = (await tenantFetch('source', '/cs/v1/roadmap-templates/' + t.roadmap_template_id))?.roadmap_template || t;
        const its = (x.initiative_templates || []).filter((i) => maps.initiativeTemplates[i.initiative_template_id]).map((i) => ({
          initiative_template_id: maps.initiativeTemplates[i.initiative_template_id], target_quarter_offset: i.target_quarter_offset ?? null, default_owner: owner(i.default_owner),
        }));
        const manual = (x.manual_initiatives || []).map((m) => ({
          id: m.id, position: m.position ?? 0, target_quarter_offset: m.target_quarter_offset ?? null, default_owner: owner(m.default_owner),
          initiative_template: m.initiative_template ? { ...m.initiative_template, budget_line_items: cleanLines(m.initiative_template.budget_line_items), recurring_line_items: cleanLines(m.initiative_template.recurring_line_items), tag_ids: [], dependency_initiative_template_ids: [] } : null,
        }));
        if (!its.length && !manual.length) throw new Error('none of its initiatives exist in the destination; include Initiative templates.');
        const r = await tenantFetch('dest', '/cs/v1/roadmap-templates', { method: 'POST', body: { roadmap_template: {
          name: x.name, description_json: x.description_json || null, category: x.category || null, initiative_templates: its, manual_initiatives: manual,
          goal_template_ids: (x.goal_template_ids || []).map((g) => maps.goalTemplates[g]).filter(Boolean),
        } } });
        return r?.roadmap_template_id;
      } });
  });

  await chrome.storage.session.set({ [TENANT_MAPS_KEY]: maps });
  return out;
}

/**
 * Migrate one client. payload: { src:{id,name}, dst:{id,name}, objects:{initiatives,goals,notes,assessments,…}, primaryUserId }
 * Returns per-type counts, warnings, and errors. Never re-creates anything already in the ledger.
 */
async function tenantMigrateClient({ src, dst, objects, primaryUserId, userMap }) {
  const ledger = await tenantLedger();
  const out = { counts: {}, warnings: [], errors: [] };
  const { [TENANT_SOURCE_KEY]: sourceKey } = await chrome.storage.session.get(TENANT_SOURCE_KEY);
  const sameTenant = sourceKey === (await getConfig()).apiKey;
  // Source owner/evaluator -> destination user via the reviewed matching; fallback is the chosen user.
  const resolveUser = (sourceId, sourceEmail, label, recordName) => {
    if (!sourceId && !sourceEmail) return primaryUserId || null;
    if (sameTenant && sourceId) return sourceId;
    const mapped = (sourceId && userMap?.byId?.[sourceId]) || (sourceEmail && userMap?.byEmail?.[String(sourceEmail).toLowerCase()]);
    if (mapped) return mapped;
    out.warnings.push(recordName + " — " + label + " \"" + (sourceEmail || sourceId) + "\" has no matching destination user; " + (primaryUserId ? "assigned the default user." : "left unassigned."));
    return primaryUserId || null;
  };
  const filt = (type) => '/lifecycle-manager/v1/' + type + '?filter%5Bclient.id%5D=' + encodeURIComponent(src.id);
  const clientFilter = 'filter%5Bclient.id%5D=eq%3A' + encodeURIComponent(src.id);
  const bump = (type, key) => { out.counts[type] = out.counts[type] || { created: 0, skipped: 0, failed: 0 }; out.counts[type][key]++; };
  const initiativeMap = {};
  const goalMap = {};
  // Destination id of any record copied for this client pair, in this run or an earlier one.
  const dstOf = (type, srcId) => (srcId ? ledger[dst.id + '|' + type + '|' + srcId] || null : null);
  const record = async (lk, id) => { ledger[lk] = id; await tenantRecord(lk, id); };
  // Source user id -> destination user key, without warnings (attendees and assignees are optional).
  const mapUserQuiet = (id, email) => {
    if (sameTenant && id) return id;
    return (id && userMap?.byId?.[id]) || (email && userMap?.byEmail?.[String(email).toLowerCase()]) || null;
  };
  // Account-level ids (tags, statuses, meeting types, templates) from the run's account setup step.
  const { [TENANT_MAPS_KEY]: maps = {} } = sameTenant ? {} : await chrome.storage.session.get(TENANT_MAPS_KEY);
  const mapId = (kind, id) => (!id ? null : sameTenant ? id : maps[kind]?.[id] || null);

  if (objects.initiatives) {
    const rows = await tenantPages('source', '/lifecycle-manager/v2/initiatives?filter%5Bclient.id%5D=eq%3A' + encodeURIComponent(src.id) + '&include_internal=true&include_unscheduled=true');
    for (const it of rows) {
      const lk = dst.id + '|initiative|' + it.id;
      if (ledger[lk]) { initiativeMap[it.id] = ledger[lk]; bump('initiatives', 'skipped'); continue; }
      try {
        const detail = await tenantFetch('source', '/cs/v1/initiatives/' + it.id).catch(() => null);
        const d = detail?.initiative || detail || {};
        const created = await tenantFetch('dest', '/cs/v1/initiatives', { method: 'POST', body: {
          client_key: { id: dst.id, name: dst.name }, name: it.name,
          executive_summary_json: d.executive_summary_json || null,
        } });
        const id = created.id;
        await record(lk, id);
        initiativeMap[it.id] = id;
        const w = [];
        const put = (label, path, body) => attempt(w, label, () => tenantFetch('dest', '/cs/v1/initiatives/' + id + path, { method: 'PUT', body }));
        if (it.status) await put('Status', '/status', { status: mapId('statuses', it.status) || it.status });
        if (it.priority) await put('Priority', '/priority', { priority: it.priority });
        if (it.fiscal_quarter?.year) await put('Schedule', '/schedule', clampSchedule({ fiscal_quarter: { year: it.fiscal_quarter.year, quarter: it.fiscal_quarter.quarter } }).body);
        else if (it.target_start_date && it.target_end_date) await put('Schedule', '/schedule', clampSchedule({ target_start_date: it.target_start_date, target_end_date: it.target_end_date, target_precision: it.target_precision || 'Month' }).body);
        if (it.budget?.line_items?.length) await put('Budget', '/budget', { budget_line_items: cleanLines(it.budget.line_items) });
        if (it.budget?.recurring_line_items?.length) await put('Recurring', '/recurring', { recurring_line_items: cleanLines(it.budget.recurring_line_items) });
        const owner = resolveUser(it.assigned_user_id || it.assigned_user?.id || d.assigned_user_id || d.assigned_user?.id || null,
          it.assigned_user?.email || d.assigned_user?.email || null, "Owner", it.name);
        if (owner) await put('Owner', '/assigned-user', { assigned_user_id: owner });
        for (const x of w) out.warnings.push(it.name + ' — ' + x);
        bump('initiatives', 'created');
      } catch (error) { bump('initiatives', 'failed'); out.errors.push('Initiative "' + it.name + '": ' + error.message); }
      await sleep(120);
    }
  }

  if (objects.goals) {
    for (const g of await tenantPages('source', filt('goals'))) {
      const lk = dst.id + '|goal|' + g.id;
      if (ledger[lk]) { goalMap[g.id] = ledger[lk]; bump('goals', 'skipped'); continue; }
      try {
        const created = await tenantFetch('dest', '/lifecycle-manager/v1/goals', { method: 'POST', body: {
          client_key: { id: dst.id }, title: g.title, description: g.description || '', status: g.status || 'OnTrack', target_period: g.period || g.target_period || null,
        } });
        const id = created.id || created.goal_id;
        await record(lk, id);
        goalMap[g.id] = id;
        bump('goals', 'created');
      } catch (error) { bump('goals', 'failed'); out.errors.push('Goal "' + g.title + '": ' + error.message); }
      await sleep(120);
    }
  }

  if (objects.notes) {
    for (const n of await tenantPages('source', filt('notes'))) {
      const nid = n.note_id || n.id;
      const lk = dst.id + '|note|' + nid;
      if (ledger[lk]) { bump('notes', 'skipped'); continue; }
      try {
        const created = await tenantFetch('dest', '/lifecycle-manager/v1/notes', { method: 'POST', body: { client_key: { id: dst.id }, title: n.title || 'Note', description_json: n.description_json || null } });
        await record(lk, created.id || created.note_id);
        bump('notes', 'created');
      } catch (error) { bump('notes', 'failed'); out.errors.push('Note "' + (n.title || nid) + '": ' + error.message); }
      await sleep(120);
    }
  }

  if (objects.assessments) {
    const destTemplates = (await tenantFetch('dest', '/lifecycle-manager/v1/assessment-templates'))?.data || [];
    for (const a of await tenantPages('source', filt('assessments'))) {
      const lk = dst.id + '|assessment|' + a.id;
      if (ledger[lk]) { bump('assessments', 'skipped'); continue; }
      try {
        const detail = (await tenantFetch('source', '/lifecycle-manager/v1/assessments/' + a.id))?.assessment;
        const evaluatorId = resolveUser(detail.evaluate_user_id || detail.evaluate_user?.id || a.evaluate_user_id || null,
          detail.evaluate_user?.email || detail.evaluate_user?.contact_info?.email || null, "Evaluator", a.title);
        if (!evaluatorId) throw new Error('Choose a destination evaluating user.');
        const templateId = await tenantCopyTemplate(detail.assessment_template_id, destTemplates);
        const created = await tenantFetch('dest', '/lifecycle-manager/v1/assessments', { method: 'POST', body: {
          client_key: { id: dst.id }, title: a.title, assessment_template_id: templateId,
          evaluate_user_id: evaluatorId, evaluate_at: a.evaluated_at || a.completed_at || new Date().toISOString(),
        } });
        const newId = created.id;
        await record(lk, newId);
        // Map answers by category + question title and criterion label.
        const inst = (await tenantFetch('dest', '/lifecycle-manager/v1/assessments/' + newId))?.assessment || {};
        const norm = (s) => String(s || '').trim().toLowerCase();
        const target = new Map();
        for (const c of inst.category_list || []) for (const q of c.question_list || []) target.set(norm(c.title) + '|' + norm(q.title), q);
        const evaluations = [];
        const comments = [];
        let unmatched = 0;
        for (const c of detail.category_list || []) for (const q of c.question_list || []) {
          const sel = (q.criteria_list || []).find((x) => x.is_selected);
          const t = target.get(norm(c.title) + '|' + norm(q.title));
          if (!t) { if (sel) unmatched++; continue; }
          if (sel) {
            const tc = (t.criteria_list || []).find((x) => norm(x.label_key) === norm(sel.label_key) || norm(x.display_label) === norm(sel.display_label));
            if (tc) evaluations.push({ question_id: t.assessment_question_id, selected_criteria_id: tc.assessment_criterion_id });
          }
          const pub = typeof q.public_comment === 'string' ? q.public_comment : q.public_comment?.comment_plain_text;
          if (pub) comments.push({ id: t.assessment_question_id, kind: 'public', text: pub });
          const internal = (q.internal_comments || []).map((x) => (typeof x === 'string' ? x : x?.comment_plain_text || x?.comment)).filter(Boolean).join('\n');
          if (internal) comments.push({ id: t.assessment_question_id, kind: 'internal', text: internal });
        }
        const w = [];
        for (let i = 0; i < evaluations.length; i += 25) await attempt(w, 'Answers', () => tenantFetch('dest', '/lifecycle-manager/v1/assessments/' + newId + '/evaluate', { method: 'PUT', body: { question_evaluations: evaluations.slice(i, i + 25) } }));
        for (const cm of comments) await attempt(w, cm.kind + ' comment', () => tenantFetch('dest', '/lifecycle-manager/v1/assessments/' + newId + '/questions/' + cm.id + '/comment/' + cm.kind, { method: 'PUT', body: { comment_plain_text: cm.text.slice(0, 1000) } }));
        if (detail.internal_comment) await attempt(w, 'Summary', () => tenantFetch('dest', '/lifecycle-manager/v1/assessments/' + newId + '/internal-comment', { method: 'PUT', body: { internal_comment: String(detail.internal_comment).slice(0, 1000) } }));
        if (a.status === 'Completed' || a.completed_at) await attempt(w, 'Mark complete', () => tenantFetch('dest', '/lifecycle-manager/v1/assessments/' + newId + '/completion-status', { method: 'PUT', body: { is_completed: true } }));
        if (unmatched) w.push(unmatched + ' answer(s) had no matching question');
        for (const x of w) out.warnings.push(a.title + ' — ' + x);
        bump('assessments', 'created');
      } catch (error) { bump('assessments', 'failed'); out.errors.push('Assessment "' + a.title + '": ' + error.message); }
      await sleep(120);
    }
  }

  // ----- Phase 2 client records -----
  const createdMeetings = [];

  if (objects.meetings) {
    for (const m of await tenantPages('source', '/cs/v1/meetings?' + clientFilter)) {
      const lk = dst.id + '|meeting|' + m.id;
      if (ledger[lk]) { bump('meetings', 'skipped'); continue; }
      try {
        const x = (await tenantFetch('source', '/cs/v1/meetings/' + m.id))?.meeting || m;
        const owner = x.owned_by?.id || x.owned_by?.email ? (mapUserQuiet(x.owned_by.id, x.owned_by.email) || primaryUserId) : null;
        const body = {
          client_key: { id: dst.id }, title: x.title || 'Meeting', type: mapId('meetingTypes', x.meeting_type?.meeting_type_id),
          starts_at: x.starts_at || null, ends_at: x.ends_at || null, agenda_json: x.agenda_json || null,
          owned_by: owner ? { id: owner } : null,
          user_attendee_keys: (x.user_attendee_ids || []).map((u) => mapUserQuiet(u, null)).filter(Boolean).map((id) => ({ id })),
          contact_attendee_keys: (x.contact_attendees || []).filter((c) => !c.is_deleted).map((c) => (sameTenant ? { id: c.id } : c.email ? { email: c.email, client_key: { id: dst.id } } : null)).filter(Boolean),
          external_attendees: (x.external_attendees || []).filter(Boolean),
          outlook_linking_disabled: true, // copies must not create calendar events
        };
        let created;
        try { created = await tenantFetch('dest', '/cs/v2/meetings', { method: 'POST', body }); }
        catch (error) {
          if (!body.contact_attendee_keys.length || !/-> (400|404|422)/.test(error.message)) throw error;
          // Contacts come from each tenant's PSA; when one isn't in the destination, keep the meeting without them.
          created = await tenantFetch('dest', '/cs/v2/meetings', { method: 'POST', body: { ...body, contact_attendee_keys: [] } });
          out.warnings.push('Meeting "' + body.title + '" — client contacts not found in the destination; attendees left off.');
        }
        await record(lk, created.id);
        createdMeetings.push([m.id, created.id]);
        if (x.is_complete) await attempt(out.warnings, 'Meeting "' + body.title + '" complete', () => tenantFetch('dest', '/cs/v1/meetings/' + created.id + '/completion-status', { method: 'PUT', body: { is_completed: true } }));
        bump('meetings', 'created');
      } catch (error) { bump('meetings', 'failed'); out.errors.push('Meeting "' + (m.title || m.id) + '": ' + error.message); }
      await sleep(120);
    }
    // Links from each new meeting to initiatives, goals and notes copied for this client.
    for (const [srcM, dstM] of createdMeetings) {
      const [inits, goals, notes] = await Promise.all([
        tenantFetch('source', '/cs/v1/meetings/' + srcM + '/initiatives').catch(() => null),
        tenantFetch('source', '/cs/v1/meetings/' + srcM + '/goals').catch(() => null),
        tenantFetch('source', '/cs/v1/meetings/' + srcM + '/notes').catch(() => null),
      ]);
      for (const i of inits?.initiative_ids || []) { const d = dstOf('initiative', i); if (d) await attempt(out.warnings, 'Link meeting→initiative', () => tenantFetch('dest', '/cs/v1/meetings/' + dstM + '/initiatives/' + d, { method: 'POST' })); }
      for (const g of goals?.goal_ids || []) { const d = dstOf('goal', g); if (d) await attempt(out.warnings, 'Link meeting→goal', () => tenantFetch('dest', '/cs/v1/meetings/' + dstM + '/goals/' + d, { method: 'POST' })); }
      for (const n of notes?.data || []) { const d = dstOf('note', n.note_id); if (d) await attempt(out.warnings, 'Link meeting→note', () => tenantFetch('dest', '/cs/v1/meetings/' + dstM + '/notes/' + d, { method: 'POST' })); }
    }
  }

  if (objects.tasks) {
    for (const t of await tenantPages('source', '/app/v1/tasks?' + clientFilter)) {
      const tid = t.engagement_action_id || t.id;
      const lk = dst.id + '|task|' + tid;
      if (ledger[lk]) { bump('tasks', 'skipped'); continue; }
      try {
        // Assignees first, then the task's creator, then the default assigned user.
        let assignees = (t.assigned_user_ids || []).map((u) => mapUserQuiet(u, null)).filter(Boolean);
        if (!assignees.length && t.created_by_user_id) assignees = [mapUserQuiet(t.created_by_user_id, null)].filter(Boolean);
        if (!assignees.length && primaryUserId) assignees = [primaryUserId];
        const created = await tenantFetch('dest', '/app/v1/tasks', { method: 'POST', body: {
          client_key: { id: dst.id }, title: t.title || 'Task', description_json: t.description_json || null,
          assigned_user_ids: assignees.map((id) => ({ id })), due_at: t.due_at || null,
        } });
        const id = created.id;
        await record(lk, id);
        const w = [];
        if (t.is_completed) await attempt(w, 'Completed', () => tenantFetch('dest', '/app/v1/tasks/' + id + '/completion-status', { method: 'PUT', body: { is_completed: true } }));
        if (t.is_pinned) await attempt(w, 'Pinned', () => tenantFetch('dest', '/app/v1/tasks/' + id + '/pin', { method: 'PUT', body: { is_pinned: true } }));
        const li = dstOf('initiative', t.initiative_links?.initiative_id);
        if (li) await attempt(w, 'Link to initiative', () => tenantFetch('dest', '/cs/v1/initiatives/' + li + '/tasks/' + id, { method: 'POST' }));
        for (const g of t.goal_links || []) { const d = dstOf('goal', g.goal_id); if (d) await attempt(w, 'Link to goal', () => tenantFetch('dest', '/cs/v1/goals/' + d + '/tasks/' + id, { method: 'POST' })); }
        for (const ml of t.meeting_links || []) { const d = dstOf('meeting', ml.meeting_id); if (d) await attempt(w, 'Link to meeting', () => tenantFetch('dest', '/cs/v1/meetings/' + d + '/tasks/' + id, { method: 'POST' })); }
        for (const x of w) out.warnings.push('Task "' + t.title + '" — ' + x);
        bump('tasks', 'created');
      } catch (error) { bump('tasks', 'failed'); out.errors.push('Task "' + (t.title || tid) + '": ' + error.message); }
      await sleep(120);
    }
  }

  if (objects.agreements) {
    let synced = 0;
    for (const a of await tenantPages('source', '/cs/v1/agreements?' + clientFilter)) {
      // PSA-synced agreements arrive through the destination's own PSA sync; only manual ones are copied.
      if (a.source && a.source !== 'Manual') { synced++; continue; }
      const lk = dst.id + '|agreement|' + a.id;
      if (ledger[lk]) { bump('agreements', 'skipped'); continue; }
      try {
        const x = (await tenantFetch('source', '/cs/v1/agreements/' + a.id))?.agreement || a;
        const created = await tenantFetch('dest', '/cs/v1/agreements', { method: 'POST', body: { client_key: { id: dst.id }, create_payload: {
          title: x.name, category: x.category || null, impact: x.impact || 'Unspecified', status: x.status || 'Active', location: x.location || null,
          description: x.description || null, is_third_party: x.is_third_party ?? null, billing_cycle: x.billing_cycle || 'Unknown',
          billing_cost_subunits: x.billing_cost_subunits ?? 0, billing_cost_currency_code: x.billing_cost_currency_code || x.currency_code || null,
          billing_cost_type: x.billing_cost_type || 'Actual', billing_per_seat_cost_subunits: x.billing_per_seat_cost_subunits ?? null,
          billing_number_of_seats: x.billing_number_of_seats ?? null, billing_start_at: x.start_at || null, billing_is_auto_renew: x.is_auto_renew ?? null,
          end_at: x.end_at || null, should_budget_past_end_date: !!x.should_budget_past_end_date, notify_days_before_end_date: x.notify_days_before_end_date ?? 30,
          is_billable: !!x.is_billable,
        } } });
        const id = created.agreement_id || created.id;
        await record(lk, id);
        // Creating an agreement may add its own first line item; skip source items already present by name.
        const have = new Set(((await tenantFetch('dest', '/cs/v1/agreements/' + id).catch(() => null))?.agreement?.line_items || []).map((l) => String(l.name || '').trim().toLowerCase()));
        const cents = (v) => (v == null ? null : Math.round(Number(v) * 100));
        for (const li of x.line_items || []) {
          if (have.has(String(li.name || '').trim().toLowerCase())) continue;
          await attempt(out.warnings, 'Agreement "' + x.name + '" item "' + li.name + '"', () => tenantFetch('dest', '/cs/v1/agreements/' + id + '/items', { method: 'POST', body: { agreement_item: {
            name: li.name || x.name, description: li.description || null, start_at: li.start_at || null, end_at: li.end_at || null,
            total_price_subunits: cents(li.total_price) ?? 0, unit_price_subunits: cents(li.unit_price), quantity: li.quantity ?? null,
            price_type: li.price_type || 'Actual', is_billable: !!li.is_billable,
          } } }));
        }
        if (x.assets?.length) out.warnings.push('Agreement "' + x.name + '" — ' + x.assets.length + ' linked device(s) not carried over; attach them in the destination.');
        bump('agreements', 'created');
      } catch (error) { bump('agreements', 'failed'); out.errors.push('Agreement "' + (a.name || a.id) + '": ' + error.message); }
      await sleep(120);
    }
    if (synced) out.warnings.push(synced + ' PSA-synced agreement(s) skipped: they come from the destination\'s own PSA sync.');
  }

  if (objects.deliverables) {
    let custom = 0;
    for (const dv of await tenantPages('source', '/cs/v1/deliverables?' + clientFilter)) {
      const lk = dst.id + '|deliverable|' + dv.id;
      if (ledger[lk]) { bump('deliverables', 'skipped'); continue; }
      const tpl = mapId('deliverableTemplates', dv.template_id);
      if (!tpl) { custom++; continue; }
      try {
        const r = await tenantFetch('dest', '/cs/v1/clients/' + encodeURIComponent(dst.id) + '/deliverables/create-from/template/' + encodeURIComponent(tpl), { method: 'POST', body: { name: dv.name || null } });
        await record(lk, r?.deliverable?.id || 'created');
        if (r?.omitted_component_keys?.length) out.warnings.push('Deliverable "' + dv.name + '" — ' + r.omitted_component_keys.length + ' integration section(s) skipped (integration not set up for this client).');
        bump('deliverables', 'created');
      } catch (error) { bump('deliverables', 'failed'); out.errors.push('Deliverable "' + (dv.name || dv.id) + '": ' + error.message); }
      await sleep(150);
    }
    if (custom) out.warnings.push(custom + ' deliverable(s) without a matching template were not rebuilt (their content is generated from live data).');
  }

  if (objects.extras) {
    const srcInits = await tenantPages('source', '/lifecycle-manager/v2/initiatives?filter%5Bclient.id%5D=eq%3A' + encodeURIComponent(src.id) + '&include_internal=true&include_unscheduled=true');
    const destAssessments = {}; // dst assessment id -> Map(question title -> question id)
    for (const it of srcInits) {
      const dInit = dstOf('initiative', it.id);
      const lk = dst.id + '|initiative-extras|' + it.id;
      if (!dInit) continue;
      if (ledger[lk]) { bump('initiative extras', 'skipped'); continue; }
      const w = [];
      const d = (await tenantFetch('source', '/cs/v1/initiatives/' + it.id).catch(() => null))?.initiative || {};
      const tagIds = (d.tag_ids || d.tags || it.tag_ids || it.tags || []).map((g) => mapId('tags', g.tag_id || g.id || g)).filter(Boolean);
      if (tagIds.length) await attempt(w, 'Tags', () => tenantFetch('dest', '/cs/v1/initiatives/' + dInit + '/tags/assign', { method: 'PUT', body: { initiative_tag_ids: tagIds } }));
      for (const u of (await tenantFetch('source', '/cs/v1/initiatives/' + it.id + '/external-urls').catch(() => null))?.data || []) {
        await attempt(w, 'Link "' + u.label + '"', () => tenantFetch('dest', '/cs/v1/initiatives/' + dInit + '/external-urls', { method: 'POST', body: { url: u.url, label: u.label || u.url } }));
      }
      for (const f of (await tenantFetch('source', '/cs/v1/initiatives/' + it.id + '/attachments').catch(() => null))?.data || []) {
        await attempt(w, 'File "' + f.file_name + '"', async () => {
          const blob = await (await tenantRaw('source', '/cs/v1/initiatives/' + it.id + '/attachments/' + f.initiative_attachment_id + '/content')).blob();
          const form = new FormData();
          form.append('file', blob, f.file_name);
          await tenantRaw('dest', '/cs/v1/initiatives/' + dInit + '/attachments', { method: 'POST', body: form });
        });
      }
      // Assessment findings linked to this initiative, matched by question title in the copied assessment.
      const qs = (await tenantFetch('source', '/cs/v1/initiatives/' + it.id + '/assessment-questions').catch(() => null))?.data || [];
      const byAssessment = {};
      for (const q of qs) {
        const dA = dstOf('assessment', q.assessment_evaluation_id);
        if (!dA) continue;
        if (!destAssessments[dA]) {
          const inst = (await tenantFetch('dest', '/lifecycle-manager/v1/assessments/' + dA).catch(() => null))?.assessment || {};
          destAssessments[dA] = new Map();
          for (const c of inst.category_list || []) for (const qq of c.question_list || []) destAssessments[dA].set(String(qq.title || '').trim().toLowerCase(), qq.assessment_question_id);
        }
        const dq = destAssessments[dA].get(String(q.title || '').trim().toLowerCase());
        if (dq) (byAssessment[dA] = byAssessment[dA] || []).push(dq);
      }
      for (const [dA, ids] of Object.entries(byAssessment)) {
        await attempt(w, 'Assessment findings', () => tenantFetch('dest', '/cs/v1/assessments/' + dA + '/questions/initiative-link', { method: 'POST', body: { initiative_id: dInit, assessment_evaluation_question_ids: ids } }));
      }
      await record(lk, dInit);
      for (const x of w) out.warnings.push(it.name + ' — ' + x);
      bump('initiative extras', 'created');
      await sleep(120);
    }
  }

  if (objects.clientTags) {
    try {
      const [s, d] = await Promise.all([tenantFetch('source', '/app/v1/clients/' + src.id), tenantFetch('dest', '/app/v1/clients/' + dst.id)]);
      const tagsOf = (r) => ((r?.client || r)?.tags || []).map((g) => g.tag_id || g.id || g);
      const want = tagsOf(s).map((id) => mapId('tags', id)).filter(Boolean);
      const have = tagsOf(d);
      const merged = [...new Set([...have, ...want])];
      if (merged.length > have.length) {
        await tenantFetch('dest', '/app/v1/clients/' + dst.id + '/tags', { method: 'PUT', body: { tag_ids: merged } });
        bump('client tags', 'created');
      } else bump('client tags', 'skipped');
    } catch (error) { bump('client tags', 'failed'); out.errors.push('Client tags: ' + error.message); }
  }

  // Goal → initiative links (both sides must have migrated).
  if (objects.goals && objects.initiatives) {
    for (const [srcGoal, dstGoal] of Object.entries(goalMap)) {
      const links = await tenantFetch('source', '/lifecycle-manager/v1/goals/' + srcGoal + '/initiatives').catch(() => null);
      for (const srcInit of links?.initiative_ids || []) {
        const dstInit = initiativeMap[srcInit];
        if (!dstInit) continue;
        await attempt(out.warnings, 'Link goal→initiative', () => tenantFetch('dest', '/lifecycle-manager/v1/goals/' + dstGoal + '/initiatives/' + dstInit, { method: 'PUT' }));
      }
    }
  }
  return out;
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'GET_CONFIG':
          return sendResponse({ ok: true, data: await getConfig() });
        case 'SET_API_KEY':
          await setApiKey(message.apiKey);
          return sendResponse({ ok: true });
        case 'SET_EVALUATE_USER':
          await setEvaluateUser(message.evaluateUserId);
          return sendResponse({ ok: true });
        case 'LIST_LMX_CLIENTS':
          return sendResponse({ ok: true, data: await allLmxClients() });
        case 'RECENT_EVALUATORS':
          return sendResponse({ ok: true, data: await recentEvaluators() });
        case 'LIST_TEMPLATE_TITLES': {
          const list = await lmx.listTemplates();
          const titles = (list?.data || []).map((t) => ({ id: t.assessment_template_id, title: t.title || '' }));
          return sendResponse({ ok: true, data: titles });
        }
        case 'CREATE_PROPEL_TEMPLATE': {
          const builder = { myitprocess: self.MyItp, strategyoverview: self.SoAdapter }[message.source] || self.Propel;
          const { payload, omissions } = builder.prepareTemplate(message.questionnaire);
          try {
            const created = await lmx.createTemplate(payload);
            return sendResponse({ ok: true, data: { templateId: created.assessment_template_id, omissions } });
          } catch (error) {
            if (/-> 403/.test(error.message)) {
              return sendResponse({ ok: false, error: 'The ScalePad CS API firewall rejected some of this questionnaire\'s text (HTTP 403). Check the API key\'s permissions, or report the blocked content to ScalePad.' });
            }
            throw error;
          }
        }
        case 'TENANT_SET_SOURCE_KEY':
          return sendResponse({ ok: true, data: await tenantSetSourceKey(message.apiKey) });
        case 'TENANT_STATUS': {
          const { [TENANT_SOURCE_KEY]: key } = await chrome.storage.session.get(TENANT_SOURCE_KEY);
          return sendResponse({ ok: true, data: { hasSourceKey: !!key, sameTenant: !!key && key === (await getConfig()).apiKey } });
        }
        case 'TENANT_CLIENTS':
          return sendResponse({ ok: true, data: { source: await tenantClients('source'), dest: await tenantClients('dest') } });
        case 'TENANT_USER_MATCH':
          return sendResponse({ ok: true, data: await tenantUserMatch() });
        case 'TENANT_ACCOUNT_SETUP':
          return sendResponse({ ok: true, data: await tenantAccountSetup(message.payload || {}) });
        case 'TENANT_MIGRATE_CLIENT':
          return sendResponse({ ok: true, data: await tenantMigrateClient(message.payload) });
        case 'CLEANUP_LIST_ACCOUNT_ITEMS':
          return sendResponse({ ok: true, data: await listAccountItems(message.types || Object.keys(TEMPLATE_TYPES)) });
        case 'CLEANUP_DELETE_ACCOUNT_ITEMS':
          return sendResponse({ ok: true, data: await deleteAccountItems(message.items || []) });
        case 'CM_PORTFOLIO':
          return sendResponse({ ok: true, data: await cmPortfolio() });
        case 'CM_CLIENT_ITEMS':
          return sendResponse({ ok: true, data: await cmClientItems(message.clientId) });
        case 'CM_SYNC':
          return sendResponse({ ok: true, data: await cmSync(message.payload) });
        case 'CLEANUP_PREVIEW':
          return sendResponse({ ok: true, data: await cleanupPreview(message.payload) });
        case 'CLEANUP_DELETE_TYPE':
          return sendResponse({ ok: true, data: await cleanupDeleteType(message.payload) });
        case 'MIGRATE_PROPEL_AUDIT':
          return sendResponse({ ok: true, data: await migratePropelAudit(message.payload) });
        case 'MIGRATE_PROPEL_PROJECT':
          return sendResponse({ ok: true, data: await migratePropelProject(message.payload) });
        case 'LINK_PROPEL_FINDINGS':
          return sendResponse({ ok: true, data: await linkPropelFindings(message.payload) });
        case 'GET_PROPEL_LEDGER':
          return sendResponse({ ok: true, data: await propelLedger() });
        case 'LIST_SP_CLIENTS': {
          // All ScalePad clients with their PSA source ids, for Propel company matching.
          const clients = [];
          let cursor = null;
          for (let page = 0; page < 100; page++) {
            const res = await lmxFetch('/core/v1/clients?page_size=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
            for (const c of res?.data || []) {
              clients.push({
                id: c.id,
                name: c.name || '',
                psaIds: (c.record_lineage || [])
                  .filter((l) => l.source_record_id != null)
                  .map((l) => ({ vendor: l.integration_configuration?.vendor?.brand_name || '', id: String(l.source_record_id) })),
              });
            }
            cursor = res?.next_cursor;
            if (!cursor) break;
          }
          return sendResponse({ ok: true, data: clients });
        }
        case 'LIST_INITIATIVE_TEMPLATE_NAMES': {
          const names = [];
          let cursor = null;
          for (let page = 0; page < 50; page++) {
            const res = await lmx.listInitiativeTemplatesPage(cursor);
            for (const t of res?.data || []) names.push({ id: t.initiative_template_id, name: t.name || '' });
            cursor = res?.next_cursor;
            if (!cursor) break;
          }
          return sendResponse({ ok: true, data: names });
        }
        case 'CREATE_INITIATIVE_TEMPLATE': {
          const template = message.template;
          const tagIds = await ensureInitiativeTags(self.Propel.initiativeTagNames(template));
          const { payload, notes } = self.Propel.prepareInitiativeTemplate(template, { tagIds, rich: message.rich !== false });
          try {
            const created = await lmx.createInitiativeTemplate(payload);
            return sendResponse({ ok: true, data: { templateId: created.initiative_template_id, notes } });
          } catch (error) {
            if (/-> 403/.test(error.message)) {
              return sendResponse({ ok: false, error: 'The ScalePad CS API firewall rejected some of this template\'s text (HTTP 403). Check the API key\'s permissions, or report the blocked content to ScalePad.' });
            }
            throw error;
          }
        }
        case 'GET_VENDOR_ACCESS': {
          const origins = Array.isArray(message.origins) ? message.origins : [];
          const granted = origins.length ? await chrome.permissions.contains({ origins }) : false;
          return sendResponse({ ok: true, data: { granted, origins } });
        }
        case 'REQUEST_VENDOR_ACCESS': {
          const origins = Array.isArray(message.origins) ? message.origins : [];
          if (!origins.length) return sendResponse({ ok: false, error: 'No vendor page access scope was supplied.' });
          const granted = await chrome.permissions.request({ origins });
          return sendResponse({ ok: true, data: { granted, origins } });
        }
        case 'GET_SIDE_PANEL_STATE': {
          const tabId = await resolveSidePanelTabId(message.tabId);
          return sendResponse({ ok: true, data: await getSidePanelState(tabId) });
        }
        case 'GET_SIDE_PANEL_CONTEXT': {
          const tabId = await resolveSidePanelTabId(message.tabId);
          const context = await requestSidePanelPageContext(tabId);
          const data = context ? await updateSidePanelPageContext(tabId, context) : await getSidePanelState(tabId);
          return sendResponse({ ok: true, data });
        }
        case 'SIDE_PANEL_PAGE_CONTEXT': {
          const tabId = message.tabId ?? _sender?.tab?.id;
          const data = await updateSidePanelPageContext(tabId, message.context);
          return sendResponse({ ok: true, data });
        }
        case 'RECORD_SIDE_PANEL_EVENT': {
          const tabId = await resolveSidePanelTabId(message.tabId);
          const current = await getSidePanelState(tabId);
          const event = message.event || {};
          const next = {
            ...current,
            events: [
              ...(current.events || []),
              {
                label: String(event.label || 'Workspace action').slice(0, 120),
                detail: String(event.detail || '').slice(0, 240),
                icon: String(event.icon || '•').slice(0, 3),
                createdAt: new Date().toISOString(),
              },
            ].slice(-30),
          };
          return sendResponse({ ok: true, data: await saveSidePanelState(tabId, next) });
        }
        case 'TOGGLE_SIDE_PANEL_FOLLOW_UP': {
          const tabId = await resolveSidePanelTabId(message.tabId);
          const current = await getSidePanelState(tabId);
          return sendResponse({ ok: true, data: await saveSidePanelState(tabId, { ...current, followUp: !current.followUp }) });
        }
        case 'CLEAR_SIDE_PANEL_ACTIVITY': {
          const tabId = await resolveSidePanelTabId(message.tabId);
          const current = await getSidePanelState(tabId);
          return sendResponse({ ok: true, data: await saveSidePanelState(tabId, { ...current, events: [] }) });
        }
        case 'SAVE_SIDE_PANEL_NOTE': {
          const tabId = await resolveSidePanelTabId(message.tabId);
          const current = await getSidePanelState(tabId);
          const text = String(message.text || '').trim().slice(0, 2000);
          if (!text) return sendResponse({ ok: false, error: 'Note text is empty.' });
          const createdAt = new Date().toISOString();
          const next = {
            ...current,
            notes: [...(current.notes || []), { text, createdAt }].slice(-30),
            events: [
              ...(current.events || []),
              { label: 'Added a note', detail: text.slice(0, 180), icon: '+', createdAt },
            ].slice(-30),
          };
          return sendResponse({ ok: true, data: await saveSidePanelState(tabId, next) });
        }
        default:
          return sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      return sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
