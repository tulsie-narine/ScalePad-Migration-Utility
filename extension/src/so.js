/**
 * Strategy Overview → ScalePad CS adapter.
 *
 * Strategy Overview signs in with MSAL and keeps its token cache encrypted, so the token can't be
 * read from storage. Instead so-auth-hook.js (a MAIN-world content script, document_start)
 * remembers the bearer token Strategy Overview's own app sends on its API calls. The extractor
 * below runs in the same MAIN world, calls Strategy Overview's API with that token, and returns
 * records in the shapes the shared migration engine already handles. The token never leaves the page.
 *
 * Shared between the side panel (window) and the background worker (importScripts).
 */
(function (root) {
  /** Runs inside the Strategy Overview tab (executeScript, world: 'MAIN'). Must be self-contained. */
  async function soPageExtract(args) {
    const auth = window.__spcsSoAuth;
    if (!auth || !auth.value) {
      return { ok: false, error: 'Your Strategy Overview session needs refreshing. Reload Strategy Overview, then try again.' };
    }
    const API = 'https://so-prod-use2-apim-01.azure-api.net/api/';
    const api = async (path, init) => {
      const res = await fetch(API + path, { ...(init || {}), headers: { Authorization: window.__spcsSoAuth.value, Accept: 'application/json', 'Content-Type': 'application/json' } });
      if (res.status === 401) throw new Error('Your Strategy Overview session needs refreshing. Reload Strategy Overview, then try again.');
      if (!res.ok) throw new Error('Strategy Overview ' + path.split('?')[0] + ' → ' + res.status);
      const j = await res.json();
      return j && j.result !== undefined ? j.result : j;
    };
    const pool = async (items, size, fn) => {
      const out = new Array(items.length);
      let next = 0;
      const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]).catch(() => null); } };
      await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
      return out;
    };
    const tidy = (html) => {
      if (!html) return '';
      const doc = new DOMParser().parseFromString(String(html), 'text/html');
      for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
      for (const p of doc.querySelectorAll('p, li, div')) p.append('\n');
      return doc.body.textContent.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    const PREFIX = 'so-';
    const day = (s) => (s ? String(s).slice(0, 10) : '');
    const templateName = (name) => {
      const n = String(name || 'Assessment').trim();
      return /strategy overview/i.test(n) ? n : 'Strategy Overview: ' + n;
    };
    // Grades are named in Strategy Overview; "In Progress" is healthy when green, a remediation otherwise.
    const answerFor = (grade) => {
      const n = String(grade?.name || '').toLowerCase();
      if (n === 'healthy') return 'Pass';
      if (n === 'warning') return 'Marginal';
      if (n === 'danger') return 'Fail';
      if (n === 'not applicable') return 'NotApplicable';
      if (n === 'in progress') return /^#0[0-9a-f]8[0-9a-f]0[0-9a-f]$/i.test(grade.color || '') ? 'Pass' : 'Marginal';
      return null; // Question (needs discovery), Hidden, or a custom grade: left unanswered
    };
    const mappedReports = async () => {
      const res = await api('Company/MappedReports/');
      return (res.companyReports || []).map((c) => ({
        id: c.id, name: String(c.name || '').trim(), health: c.health ?? null,
        reports: (c.templates || []).flatMap((t) => (t.reports || []).map((r) => ({ ...r, templateId: t.id, templateName: t.name }))),
      }));
    };
    const latestReport = (co) => co.reports.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;

    // IT Plan items of one report: Year → Quarter → item tree, values keyed by column type.
    const planItems = async (reportId) => {
      const parts = await api('reports/' + reportId + '/parts');
      const planPart = (Array.isArray(parts) ? parts : []).find((p) => p.typeEnum === 18 && p.isActive !== false);
      if (!planPart) return [];
      const base = 'reports/' + reportId + '/parts/' + planPart.id + '/plan';
      const subparts = await api(base + '/parts');
      const users = await api('reports/' + reportId + '/users').catch(() => []);
      const userName = new Map((users || []).map((u) => [String(u.id), [u.firstName, u.lastName].filter(Boolean).join(' ')]));
      const out = [];
      for (const sp of subparts || []) {
        if (sp.isActive === false) continue;
        const [cols, data] = await Promise.all([api(base + '/parts/' + sp.id + '/columns'), api(base + '/parts/' + sp.id + '/data')]);
        const colById = new Map((cols || []).map((c) => [c.id, c]));
        const statusLabel = new Map();
        for (const c of cols || []) for (const v of c.columnSettings?.typeSettings?.values || []) statusLabel.set(String(v.id), v.label);
        const read = (node) => {
          const row = {};
          for (const cv of node.columnsValues || []) {
            const col = colById.get(cv.id);
            if (!col || col.isActive === false) continue;
            const v = (cv.values || [])[0]?.value;
            if (v == null || v === '') continue;
            const key = { 10: 'name', 11: 'status', 12: 'assignedTo', 13: 'startDate', 14: 'dueDate', 15: 'confirmedBudget', 16: 'budgetYear', 17: 'budgetMonth', 18: 'quantity', 19: 'recurring', 24: 'site' }[col.typeEnum]
              || (/estimated budget/i.test(col.label) ? 'estimatedBudget' : /next steps/i.test(col.label) ? 'nextSteps' : /explanation|risk/i.test(col.label) ? 'explanation' : null);
            if (key === 'status') row.status = statusLabel.get(String(v)) || String(v);
            else if (key === 'assignedTo') row.assignedTo = userName.get(String(v)) || null;
            else if (key) row[key] = v;
            else row.extra = (row.extra || []).concat(col.label + ': ' + v);
          }
          return row;
        };
        const walk = (nodes, path) => {
          for (const n of nodes || []) {
            const row = read(n);
            if ((n.items || []).length) walk(n.items, path.concat(row.name || ''));
            else if (row.name && (row.status || path.length >= 2)) out.push({ id: PREFIX + 'plan-' + n.id, path, ...row });
          }
        };
        walk(data, []);
      }
      return out;
    };
    const initiativesModule = async () => {
      const [items, cols] = await Promise.all([api('initiatives-module/items').catch(() => []), api('initiatives-module/columns').catch(() => [])]);
      const labels = new Map();
      for (const c of Array.isArray(cols) ? cols : cols?.columns || []) for (const v of c.columnSettings?.typeSettings?.values || []) labels.set(String(v.id), v.label);
      return (Array.isArray(items) ? items : []).map((i) => ({ ...i, statusLabel: labels.get(String(i.statusId)) || null, priorityLabel: labels.get(String(i.priorityId)) || null }));
    };
    const questionnaireFromAssessment = (A, id, reportCount) => {
      const sections = (A.groups || []).filter((g) => g.isActive !== false).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map((g) => ({
        id: String(g.templateGroupId || g.id),
        name: String(g.name || 'General').trim(),
        questions: (g.items || []).filter((i) => i.isActive !== false).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map((i) => ({
          id: i.templateItemId || i.id,
          title: String(i.name || '').trim() || 'Untitled item',
          question: tidy(i.description) || String(i.name || '').trim(),
          points: Number(i.weight) > 0 ? Number(i.weight) : 1,
          scope: 'Company', risks: [], isRequired: false, isClientStatus: false, failureAction: 'None', projectTemplate: null,
          instructions: tidy(i.healthStandard) ? 'Health standard: ' + tidy(i.healthStandard) : '',
          criteria: {}, customerExplanation: '',
        })),
      })).filter((s) => s.questions.length);
      return {
        id, name: templateName(A.template?.name), category: 'Strategy templates',
        description: 'Built from the Strategy Overview report "' + String(A.name || '').trim() + '" (' + day(A.date) + ')' + (reportCount ? ', one of ' + reportCount + ' report(s) using this template' : '') + '.',
        passThreshold: null, sections,
      };
    };

    try {
      if (args.mode === 'list') {
        const [templates, companies] = await Promise.all([api('template/getTemplates'), mappedReports()]);
        const reports = companies.flatMap((c) => c.reports);
        const out = [];
        for (const t of templates.templates || []) {
          const mine = reports.filter((r) => r.templateId === t.id).sort((a, b) => String(b.date).localeCompare(String(a.date)));
          if (!mine.length) continue; // nothing to build it from yet
          out.push({ id: 'r' + mine[0].id + ':' + mine.length, name: templateName(t.name), category: 'Strategy templates', description: mine.length + ' report(s) use this template.' });
        }
        return { ok: true, questionnaires: out };
      }

      if (args.mode === 'detail') {
        const out = [];
        for (const id of args.ids || []) {
          const [reportId, count] = String(id).replace(/^r/, '').split(':');
          out.push(questionnaireFromAssessment(await api('reports/' + reportId + '/assessment'), id, Number(count) || 0));
        }
        return { ok: true, questionnaires: out };
      }

      if (args.mode === 'companies') {
        const [companies, initiatives] = await Promise.all([mappedReports(), initiativesModule()]);
        const spend = new Map();
        for (const i of initiatives) spend.set(i.companyId, (spend.get(i.companyId) || 0) + (Number(i.budgetEstimate) || 0) + 1);
        // Strategic Advisor = who prepared each company's latest report.
        const latest = companies.map(latestReport);
        const infos = await pool(latest, 6, (r) => (r ? api('reports/' + r.id + '/info') : Promise.resolve(null)));
        return {
          ok: true,
          companies: companies.map((c, i) => {
            const r = latest[i];
            const dates = c.reports.map((x) => x.date).filter(Boolean).sort();
            return {
              id: String(c.id), name: c.name, externalId: null, active: true,
              completedAudits: c.reports.length, incompleteAudits: 0, auditQuestionnaires: new Set(c.reports.map((x) => x.templateId)).size,
              latestAudit: dates[dates.length - 1] || null, lastAuditActivity: dates[dates.length - 1] || null,
              roadmapSpend: spend.has(c.id) ? spend.get(c.id) : null,
              owners: { strategicAdvisor: infos[i]?.preparedByUser?.name || null, technicalAlignment: null },
              latestReportId: r ? r.id : null,
            };
          }),
        };
      }

      if (args.mode === 'companyAudits') {
        const co = (await mappedReports()).find((c) => String(c.id) === String(args.companyId));
        return {
          ok: true,
          audits: (co?.reports || []).map((r) => ({
            id: PREFIX + r.id,
            name: templateName(r.templateName),
            title: String(r.name || r.templateName || 'Strategy Overview report').trim(),
            status: r.statusEnum, questionnaireId: String(r.templateId), incomplete: false,
            startedAt: r.date || null, completedAt: r.date || null, reviewedAt: null,
            auditor: '', reviewer: '', score: null, effectiveTotal: null, threshold: null, isFail: null,
          })),
        };
      }

      if (args.mode === 'auditAnswers') {
        const reportId = String(args.auditId).replace(PREFIX, '');
        const A = await api('reports/' + reportId + '/assessment');
        const colLabel = new Map((A.columns || []).map((c) => [String(c.id), c.label || c.columnName]));
        const answers = [];
        for (const g of (A.groups || []).filter((x) => x.isActive !== false)) {
          for (const i of (g.items || []).filter((x) => x.isActive !== false)) {
            const notes = [];
            if (i.grade?.name) notes.push('Grade: ' + i.grade.name);
            if (tidy(i.status)) notes.push('Status: ' + tidy(i.status));
            for (const [k, v] of Object.entries(i.customValues || {})) if (v != null && String(v).trim()) notes.push((colLabel.get(String(k)) || k) + ': ' + tidy(typeof v === 'object' ? JSON.stringify(v) : v));
            answers.push({
              id: String(i.id), section: String(g.name || 'General').trim(), sectionOrder: g.sortOrder || 0, order: i.sortOrder || 0,
              title: String(i.name || '').trim(), question: tidy(i.description) || String(i.name || '').trim(),
              points: Number(i.weight) > 0 ? Number(i.weight) : 1,
              answer: answerFor(i.grade),
              site: null, remediation: null, ticket: null, projectId: null,
              risks: [], isRequired: false, failureAction: 'None',
              instructions: tidy(i.healthStandard) ? 'Health standard: ' + tidy(i.healthStandard) : '', criteria: {}, customerExplanation: '',
              templateQuestionId: i.templateItemId || null,
              comments: notes.length ? [{ text: notes.join('\n'), isPublic: false, type: 'Strategy Overview' }] : [],
            });
          }
        }
        return {
          ok: true,
          answers,
          meta: {
            templateName: templateName(A.template?.name),
            auditor: A.preparedByUser?.name || null,
            summaryLines: [
              'Migrated from Strategy Overview report "' + String(A.name || '').trim() + '" (' + day(A.date) + ').',
              'Prepared by: ' + (A.preparedByUser?.name || 'unknown') + (A.healthScore != null ? ' · Health score: ' + A.healthScore + '%' : ''),
            ],
          },
        };
      }

      if (args.mode === 'companyProjects') {
        const [companies, initiatives] = await Promise.all([mappedReports(), initiativesModule()]);
        const co = companies.find((c) => String(c.id) === String(args.companyId));
        const latest = co ? latestReport(co) : null;
        const plan = latest ? await planItems(latest.id) : [];
        const mine = initiatives.filter((i) => String(i.companyId) === String(args.companyId));
        return {
          ok: true,
          projects: [
            ...mine.map((i) => ({
              id: PREFIX + 'ini-' + i.id, name: String(i.name || 'Untitled initiative').trim(),
              raw: { kind: 'initiative', status: i.statusLabel, priority: i.priorityLabel, summary: i.summary || '', nextSteps: i.nextSteps || '', budget: Number(i.budgetEstimate) || 0, tags: (i.tags || []).map((t) => t.name), site: i.site?.name || null },
            })),
            ...plan.map((p) => ({
              id: p.id, name: String(p.name).trim(),
              raw: { kind: 'plan', status: p.status || null, explanation: p.explanation || '', nextSteps: p.nextSteps || '', confirmedBudget: Number(p.confirmedBudget) || 0, estimatedBudget: Number(p.estimatedBudget) || 0, startDate: p.startDate || null, dueDate: p.dueDate || null, budgetYear: p.budgetYear || null, budgetMonth: p.budgetMonth || null, path: p.path, assignedTo: p.assignedTo || null, extra: p.extra || [], report: latest ? String(latest.name || '') + ' (' + day(latest.date) + ')' : '' },
            })),
          ],
        };
      }

      if (args.mode === 'roadmapCounts') {
        const [companies, initiatives] = await Promise.all([mappedReports(), initiativesModule()]);
        const ids = args.companyIds || [];
        const results = await pool(ids, 4, async (id) => {
          const co = companies.find((c) => String(c.id) === String(id));
          const latest = co ? latestReport(co) : null;
          const plan = latest ? await planItems(latest.id) : [];
          return plan.length + initiatives.filter((i) => String(i.companyId) === String(id)).length;
        });
        const counts = {};
        ids.forEach((id, i) => { counts[id] = results[i] == null ? null : results[i]; });
        return { ok: true, counts };
      }

      if (args.mode === 'projectTemplates') return { ok: true, templates: [] };
      return { ok: false, error: 'Unknown mode: ' + args.mode };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  // ---------- Strategy templates → ScalePad CS assessment templates ----------

  const CRITERIA = [
    { label_enum: 'Satisfactory', description: 'Healthy: meets the health standard.' },
    { label_enum: 'NeedsAttention', description: 'Warning: partly meets the health standard, or a remediation is in progress.' },
    { label_enum: 'AtRisk', description: 'Danger: does not meet the health standard.' },
    { label_enum: 'NotApplicable', description: 'Not applicable. Excluded from scoring.' },
  ];

  function buildTemplatePayload(q) {
    const P = root.Propel;
    const sections = q.sections.filter((s) => s.questions.length);
    const categoryWeights = P.distributeWeights(sections.map(P.sectionPoints));
    const categoriesEven = categoryWeights.every((w) => w == null);
    return {
      assessment_template: {
        title: q.name,
        description: [q.description, 'Answers use the Strategy Overview grade: Healthy, Warning, Danger or Not applicable. Weights are proportional to Strategy Overview health weights.'].filter(Boolean).join('\n\n'),
        is_category_weight_evenly_distributed: categoriesEven,
        categories: sections.map((section, si) => {
          const questionWeights = P.distributeWeights(section.questions.map((x) => x.points));
          const questionsEven = questionWeights.every((w) => w == null);
          return {
            title: section.name,
            description: section.questions.length + ' item(s) in Strategy Overview.',
            is_question_weight_evenly_distributed: questionsEven,
            weight_in_percentage: categoriesEven ? null : categoryWeights[si],
            questions: section.questions.map((item, qi) => ({
              title: item.title || item.question.slice(0, 120) || 'Untitled item',
              description: item.question || item.title || 'Untitled item',
              remediation_tips: null,
              criterion_label_type_enum: 'MultiResponse',
              scoring_instructions: item.instructions || null,
              weight_in_percentage: questionsEven ? null : questionWeights[qi],
              tag_ids: [],
              scope: 'client',
              criteria: CRITERIA.map((c) => ({ ...c })),
            })),
          };
        }),
      },
    };
  }

  function prepareTemplate(q) {
    return root.Propel.sanitizeTemplatePayload(buildTemplatePayload(q), 'Strategy Overview');
  }

  // ---------- Roadmap items → the project shape the shared pipeline migrates ----------

  /** Status labels are customisable in Strategy Overview, so map them by meaning. */
  function statusKey(label) {
    const s = String(label || '').toLowerCase();
    if (!s) return null;
    if (/complet|done/.test(s)) return 'Completed';
    if (/cancel|declin|reject/.test(s)) return 'Rejected';
    if (/in progress|underway|active/.test(s)) return 'InProgress';
    if (/hold|pause|off track|block/.test(s)) return 'Deferred';
    if (/approv|schedul|next|to schedule/.test(s)) return 'Accepted';
    if (/propos|quot|scop|future|backlog/.test(s)) return 'Discussed';
    return 'NotDiscussed'; // Open, Identified, Discussion/Decision/Review needed …
  }

  const quarterRange = (year, q) => {
    const start = new Date(Date.UTC(year, (q - 1) * 3, 1));
    const end = new Date(Date.UTC(year, q * 3, 0));
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
  };

  function scheduleOf(r) {
    const d = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : null);
    if (d(r.startDate) || d(r.dueDate)) return [d(r.startDate) || d(r.dueDate), d(r.dueDate) || d(r.startDate)];
    const year = Number(String(r.budgetYear || '').match(/^\d{4}$/)?.[0]);
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const m = String(r.budgetMonth || '').toLowerCase();
    const mi = /^\d{1,2}$/.test(m) ? Number(m) - 1 : months.findIndex((x) => m.startsWith(x));
    if (year && mi >= 0) {
      const s = new Date(Date.UTC(year, mi, 1));
      return [s.toISOString().slice(0, 10), new Date(Date.UTC(year, mi + 1, 0)).toISOString().slice(0, 10)];
    }
    // Plan tree position: "2026" → "Q2". Placeholder years like "202X" stay unscheduled.
    const py = Number((r.path || []).map((p) => String(p).match(/^(\d{4})\b/)?.[1]).find(Boolean));
    const pq = Number((r.path || []).map((p) => String(p).match(/\bQ([1-4])\b/i)?.[1]).find(Boolean));
    if (py && pq) return quarterRange(py, pq);
    if (year) return quarterRange(year, 1).map((v, i) => (i ? year + '-12-31' : v));
    return [null, null];
  }

  /** Runs in the side panel (rich text conversion needs DOMParser). */
  async function adaptProjects(projects) {
    const P = root.Propel;
    const out = [];
    for (const p of projects) {
      const r = p.raw || {};
      const content = [];
      const section = async (title, html) => {
        if (!html || !String(html).trim()) return;
        const doc = await P.htmlToDoc(String(html));
        if (!doc.content.length) return;
        content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: title }] }, ...doc.content);
      };
      if (r.kind === 'initiative') {
        await section('Summary', r.summary);
        await section('Next steps', r.nextSteps);
      } else {
        await section('Explanation / risk', r.explanation);
        await section('Next steps', r.nextSteps);
      }
      const facts = r.kind === 'initiative'
        ? ['From the Strategy Overview Initiatives module', r.tags?.length ? 'Tags: ' + r.tags.join(', ') : null, r.site ? 'Site: ' + r.site : null]
        : ['From the Strategy Overview IT Plan' + (r.report ? ' in ' + r.report : ''), (r.path || []).filter(Boolean).length ? 'Plan position: ' + r.path.filter(Boolean).join(' › ') : null,
          r.status ? 'Status: ' + r.status : null, r.assignedTo ? 'Assigned to: ' + r.assignedTo : null,
          r.confirmedBudget && r.estimatedBudget ? 'Estimated budget: $' + r.estimatedBudget : null, ...(r.extra || [])];
      const factLine = facts.filter(Boolean).join(' · ');
      if (factLine) content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'From Strategy Overview' }] }, { type: 'paragraph', content: [{ type: 'text', text: factLine }] });

      const budget = r.kind === 'initiative' ? r.budget : r.confirmedBudget || r.estimatedBudget;
      const label = r.kind === 'initiative' ? 'Budget estimate' : r.confirmedBudget ? 'Confirmed budget' : 'Estimated budget';
      const [start, end] = r.kind === 'plan' ? scheduleOf(r) : [null, null];
      out.push({
        id: p.id, name: p.name,
        status: statusKey(r.status),
        priority: /^(high|medium|low)$/i.test(r.priority || '') ? r.priority.charAt(0).toUpperCase() + r.priority.slice(1).toLowerCase() : null,
        templateName: null,
        descriptionDoc: { type: 'doc', content },
        oneTimeLines: budget ? [{ label, amount: budget }] : [],
        agreements: [],
        expectedStartDate: start,
        targetCompletionDate: end,
      });
    }
    return out;
  }

  root.SoAdapter = { soPageExtract, buildTemplatePayload, prepareTemplate, adaptProjects, statusKey, scheduleOf };
})(typeof self !== 'undefined' ? self : window);
