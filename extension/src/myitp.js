/**
 * MyITProcess → ScalePad CS adapter.
 *
 * Reads MyITProcess through its own JSON API (api.live.myitprocess.com) from inside the signed-in
 * tab, the same way the Propel integration works: no pop-up tabs, no clicking through the page.
 * Records come back in the shapes the shared Propel pipeline already migrates (companies, audits,
 * answers, projects), so matching, ledgers, outcomes and the issues centre are shared.
 *
 * Shared between the side panel (window) and the background worker (importScripts).
 */
(function (root) {
  /**
   * Runs inside the MyITProcess tab (chrome.scripting.executeScript). Must be self-contained.
   * The sign-in token stays in the page; only the extracted records are returned.
   */
  async function myItpPageExtract(args) {
    const token = localStorage.getItem('access_token');
    if (!token) return { ok: false, error: 'Not signed in to MyITProcess in this tab.' };
    try {
      const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (claims.exp && claims.exp * 1000 <= Date.now()) {
        return { ok: false, error: 'Your MyITProcess session needs refreshing. Reload MyITProcess, then try again.' };
      }
    } catch (_e) { /* opaque token: let the API decide */ }

    const API = 'https://api.live.myitprocess.com/';
    const api = async (path) => {
      const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      if (res.status === 401) throw new Error('Your MyITProcess session needs refreshing. Reload MyITProcess, then try again.');
      if (!res.ok) throw new Error('MyITProcess ' + path.split('?')[0] + ' → ' + res.status);
      return res.json();
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
    const STATUS = { 1: 'Not started', 2: 'Engineer review in progress', 3: 'Awaiting vCIO review', 4: 'vCIO review in progress', 6: 'Complete' };
    const VCIO_ANSWER = { 2: 'Pass', 6: 'Marginal', 9: 'Fail', 11: 'NotApplicable' };
    const VCIO_LABEL = { 2: 'Aligned', 6: 'Marginal', 9: 'Vulnerable', 11: 'N/A' };
    const ENGINEER_ANSWER = { 1: 'Pass', 2: 'Fail', 3: 'NotApplicable' };
    const ENGINEER_LABEL = { 1: 'Yes', 2: 'No', 3: 'N/A' };
    const PREFIX = 'mitp-';
    const day = (s) => (s ? String(s).slice(0, 10) : '');

    const usersById = async () => {
      const res = await api('ItProvidersApi/api/v1/users').catch(() => []);
      const list = Array.isArray(res) ? res : (res.users || res.items || res.data || []);
      const map = new Map();
      for (const u of list) {
        const name = (u.fullName || u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '').trim();
        for (const id of [u.id, u.userId, u.userProfileId].filter(Boolean)) map.set(String(id).toLowerCase(), name);
      }
      return map;
    };
    const reviewsList = async () => {
      const res = await api('WebAPICore/api/v1/reviews');
      return Array.isArray(res) ? res : (res.reviews || res.items || []);
    };
    // A review's template is the set of standards sections it uses. Name it after them, e.g.
    // "MyITProcess: Core Infrastructure, Server Infrastructure +4 more v2020.5 (84 questions)".
    const templateName = (sections) => {
      const versions = {};
      let questions = 0;
      const names = [];
      for (const s of sections || []) {
        for (const c of s.Categories || []) questions += (c.Questions || []).length;
        const raw = String(s.SectionName || '').trim();
        const m = raw.match(/\s+v(\d{4}(?:\.\d+)?)\s*$/i);
        if (m) versions[m[1]] = (versions[m[1]] || 0) + 1;
        names.push(raw.replace(/\s+v\d{4}(?:\.\d+)?\s*$/i, '').replace(/^Enterprise\s*-\s*/i, '') || 'General');
      }
      const version = Object.entries(versions).sort((a, b) => b[1] - a[1])[0]?.[0];
      const head = names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) + ' more' : '');
      return ('MyITProcess: ' + (head || 'Alignment') + (version ? ' v' + version : '') + ' (' + questions + ' questions)').slice(0, 200);
    };
    const flatQuestions = (rv) => {
      const names = {};
      for (const s of rv.sections || []) for (const c of s.Categories || []) names[c.CategoryName] = (names[c.CategoryName] || 0) + 1;
      const out = [];
      for (const s of rv.sections || []) {
        for (const c of s.Categories || []) {
          const cat = String(c.CategoryName || 'General').trim();
          const section = names[c.CategoryName] > 1 ? String(s.SectionName || '').trim() + ' – ' + cat : cat;
          for (const q of c.Questions || []) out.push({ q, section, sectionOrder: (s.SectionListIndex || 0) * 1000 + (c.CategoryListIndex || 0) });
        }
      }
      return out;
    };
    const instructionsFor = (q) => [
      tidy(q.QuestionDetailText),
      q.HelpLink ? tidy(q.HelpLink) : '',
      q.QuestionInternalUseOnly || q.CategoryInternalUseOnly || q.SectionInternalUseOnly ? 'Marked internal use only in MyITProcess.' : '',
    ].filter(Boolean).join('\n\n');
    const questionnaireFromReview = (rv, id, reviewCount) => {
      const sections = new Map();
      for (const { q, section } of flatQuestions(rv)) {
        if (!sections.has(section)) sections.set(section, []);
        sections.get(section).push({
          id: q.ReviewTemplateQuestionId || q.ReviewQuestionId,
          title: String(q.QuestionLabel || '').trim() || tidy(q.QuestionText).slice(0, 120),
          question: tidy(q.QuestionText),
          points: 1, scope: 'Company', risks: [], isRequired: false, isClientStatus: false,
          failureAction: 'None', projectTemplate: null,
          instructions: instructionsFor(q), criteria: {}, customerExplanation: '',
        });
      }
      return {
        id, name: templateName(rv.sections), category: 'Review templates',
        description: 'Built from the MyITProcess review "' + String(rv.reviewName || '').trim() + '"' + (reviewCount ? ', one of ' + reviewCount + ' review(s) using this template' : '') + '.',
        passThreshold: null,
        sections: [...sections].map(([name, questions]) => ({ id: name, name, questions })),
      };
    };

    try {
      if (args.mode === 'list') {
        // Review templates in use, found by each review's category list (no template endpoint exists).
        const reviews = await reviewsList();
        const details = await pool(reviews, 8, (r) => api('WebAPICore/api/v1/reviews/' + r.reviewId + '/details'));
        const groups = new Map();
        reviews.forEach((r, i) => {
          const cats = details[i]?.categories;
          if (!cats || !cats.length) return;
          const sig = cats.map((c) => String(c).trim().toLowerCase()).sort().join('|');
          const g = groups.get(sig) || { reviews: [] };
          g.reviews.push(r);
          groups.set(sig, g);
        });
        const out = [];
        for (const g of groups.values()) {
          const newest = g.reviews.slice().sort((a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated)))[0];
          const rv = await api('WebAPICore/api/v1/reviews/' + newest.reviewId).catch(() => null);
          if (!rv) continue;
          out.push({
            id: 'r' + newest.reviewId + ':' + g.reviews.length,
            name: templateName(rv.sections),
            category: 'Review templates',
            description: g.reviews.length + ' review(s) use this template.',
          });
        }
        // Same name twice means two templates with identical structure: keep the most used.
        const seen = new Map();
        for (const q of out) { const prev = seen.get(q.name); if (!prev || Number(q.id.split(':')[1]) > Number(prev.id.split(':')[1])) seen.set(q.name, q); }
        return { ok: true, questionnaires: [...seen.values()] };
      }

      if (args.mode === 'detail') {
        const out = [];
        for (const id of args.ids || []) {
          const [reviewId, count] = String(id).replace(/^r/, '').split(':');
          const rv = await api('WebAPICore/api/v1/reviews/' + reviewId);
          out.push(questionnaireFromReview(rv, id, Number(count) || 0));
        }
        return { ok: true, questionnaires: out };
      }

      if (args.mode === 'companies') {
        const [clientsRes, reviews, users] = await Promise.all([api('ItProvidersApi/api/v1/clients'), reviewsList(), usersById()]);
        const clients = Array.isArray(clientsRes) ? clientsRes : (clientsRes.clients || []);
        const byClient = new Map();
        for (const r of reviews) {
          const e = byClient.get(r.clientId) || { completed: 0, incomplete: 0, latest: null, lastActivity: null };
          if (r.reviewStatus === 6) {
            e.completed++;
            const at = r.dateSubmittedByVCIO || r.lastUpdated;
            if (at && (!e.latest || at > e.latest)) e.latest = at;
          } else if (r.reviewStatus !== 1) e.incomplete++;
          if (r.reviewStatus !== 1 && r.lastUpdated && (!e.lastActivity || r.lastUpdated > e.lastActivity)) e.lastActivity = r.lastUpdated;
          byClient.set(r.clientId, e);
        }
        const nameOf = (id) => (id ? users.get(String(id).toLowerCase()) || null : null);
        return {
          ok: true,
          companies: clients.map((c) => {
            const id = c.oldId ?? c.id;
            const s = byClient.get(id);
            return {
              id: String(id),
              name: String(c.name || c.clientName || '').trim(),
              externalId: null, // MyITProcess holds the ConnectWise company identifier, not its numeric id
              psaIdentifier: c.psaCompanyId || null,
              active: c.isActive !== false,
              completedAudits: s ? s.completed : 0,
              incompleteAudits: s ? s.incomplete : 0,
              auditQuestionnaires: 0,
              latestAudit: s ? s.latest : null,
              lastAuditActivity: s ? s.lastActivity : null,
              roadmapSpend: null,
              owners: { strategicAdvisor: nameOf(c.vcioId), technicalAlignment: nameOf(c.engineerId) },
            };
          }),
        };
      }

      if (args.mode === 'companyAudits') {
        const [reviews, users] = await Promise.all([reviewsList(), usersById()]);
        const nameOf = (id) => (id ? users.get(String(id).toLowerCase()) || '' : '');
        return {
          ok: true,
          audits: reviews
            .filter((r) => String(r.clientId) === String(args.companyId))
            .filter((r) => r.reviewStatus === 6 || (args.includeIncomplete && r.reviewStatus !== 1))
            .map((r) => ({
              id: PREFIX + r.reviewId,
              name: String(r.reviewName || 'Alignment review').trim(),
              title: String(r.reviewName || 'Alignment review').trim(),
              status: STATUS[r.reviewStatus] || String(r.reviewStatus),
              questionnaireId: 'alignment',
              incomplete: r.reviewStatus !== 6,
              startedAt: r.created || null,
              completedAt: r.dateSubmittedByVCIO || r.lastUpdated || r.created || null,
              reviewedAt: r.dateSubmittedByVCIO || null,
              auditor: nameOf(r.engineerId),
              reviewer: nameOf(r.vcioId),
              score: null, effectiveTotal: null, threshold: null, isFail: null,
            })),
        };
      }

      if (args.mode === 'auditAnswers') {
        const reviewId = String(args.auditId).replace(PREFIX, '');
        const rv = await api('WebAPICore/api/v1/reviews/' + reviewId);
        // Recommendations point at the review questions they address: those become finding links.
        const recs = await api('StrategyAPI/api/v1/recommendations/' + rv.clientId + '?includeBacklog=true').catch(() => []);
        const recFor = new Map();
        for (const rec of Array.isArray(recs) ? recs : []) {
          if (rec.isArchived) continue;
          for (const f of rec.assignedMyItProcessFindings || []) if (String(f.reviewId) === reviewId && !recFor.has(f.reviewQuestionId)) recFor.set(f.reviewQuestionId, PREFIX + rec.id);
        }
        const answers = flatQuestions(rv).map(({ q, section, sectionOrder }) => {
          const comments = [];
          if (q.AnswerId && ENGINEER_LABEL[q.AnswerId]) comments.push({ text: 'Engineer answer: ' + ENGINEER_LABEL[q.AnswerId] + (tidy(q.EngineerComments) ? ' — ' + tidy(q.EngineerComments) : ''), isPublic: false, type: 'Engineer' });
          else if (tidy(q.EngineerComments)) comments.push({ text: 'Engineer: ' + tidy(q.EngineerComments), isPublic: false, type: 'Engineer' });
          // The vCIO rating is the answer itself; only their comment needs carrying across.
          if (tidy(q.VcioComments)) comments.push({ text: 'vCIO' + (VCIO_LABEL[q.VcioAnswerId] ? ' (' + VCIO_LABEL[q.VcioAnswerId] + ')' : '') + ': ' + tidy(q.VcioComments), isPublic: false, type: 'vCIO' });
          return {
            id: String(q.ReviewQuestionId),
            section, sectionOrder,
            order: q.QuestionListIndex || 0,
            title: String(q.QuestionLabel || '').trim() || tidy(q.QuestionText).slice(0, 120),
            question: tidy(q.QuestionText),
            points: 1,
            // The vCIO alignment rating is the answer; the engineer's Yes/No/N/A is the fallback.
            answer: VCIO_ANSWER[q.VcioAnswerId] || ENGINEER_ANSWER[q.AnswerId] || null,
            site: null, remediation: null, ticket: null,
            projectId: recFor.get(q.ReviewQuestionId) || null,
            risks: [], isRequired: false, failureAction: 'None',
            instructions: instructionsFor(q), criteria: {}, customerExplanation: '',
            templateQuestionId: q.ReviewTemplateQuestionId || null,
            comments,
          };
        });
        const engineer = [rv.engineerFirstName, rv.engineerLastName].filter(Boolean).join(' ');
        const vcio = [rv.vcioFirstName, rv.vcioLastName].filter(Boolean).join(' ');
        return {
          ok: true,
          answers,
          meta: {
            templateName: templateName(rv.sections),
            auditor: engineer || null,
            reviewer: vcio || null,
            summaryLines: [
              'Migrated from MyITProcess review "' + String(rv.reviewName || '').trim() + '".',
              'Engineer: ' + (engineer || 'unknown') + ' · vCIO: ' + (vcio || 'unknown'),
              'Status: ' + (STATUS[rv.reviewStatus] || rv.reviewStatus) + ' · Last updated: ' + day(rv.lastUpdated),
            ],
          },
        };
      }

      if (args.mode === 'companyProjects') {
        const [recs, initiatives] = await Promise.all([
          api('StrategyAPI/api/v1/recommendations/' + args.companyId + '?includeBacklog=true'),
          api('StrategyAPI/api/v1/initiatives/' + args.companyId).catch(() => []),
        ]);
        const groupName = new Map((Array.isArray(initiatives) ? initiatives : []).map((i) => [i.id, String(i.name || '').trim()]));
        return {
          ok: true,
          projects: (Array.isArray(recs) ? recs : []).filter((r) => !r.isArchived).map((r) => ({
            id: PREFIX + r.id,
            name: String(r.name || 'Untitled recommendation').trim(),
            raw: {
              status: r.status, priority: r.priority, type: r.type, responsibleParty: r.responsibleParty,
              budget: r.budget, hours: r.hours, budgetMonth: r.newBudgetMonth || null,
              repeatInterval: r.repeatInterval, repeatEnd: r.repeatEnd || null,
              initiative: groupName.get(r.initiativeId) || null,
              descriptionHtml: r.description || '',
            },
          })),
        };
      }

      if (args.mode === 'roadmapCounts') {
        const ids = args.companyIds || [];
        const results = await pool(ids, 6, (id) => api('StrategyAPI/api/v1/recommendations/' + id + '?includeBacklog=true'));
        const counts = {};
        ids.forEach((id, i) => { counts[id] = Array.isArray(results[i]) ? results[i].filter((r) => !r.isArchived).length : null; });
        return { ok: true, counts };
      }

      if (args.mode === 'projectTemplates') return { ok: true, templates: [] };
      return { ok: false, error: 'Unknown mode: ' + args.mode };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  // ---------- Review templates → ScalePad CS assessment templates ----------

  const CRITERIA = [
    { label_enum: 'Satisfactory', description: 'Aligned: meets the best practice.' },
    { label_enum: 'NeedsAttention', description: 'Marginal: partly meets the best practice.' },
    { label_enum: 'AtRisk', description: 'Vulnerable: does not meet the best practice.' },
    { label_enum: 'NotApplicable', description: 'Not applicable. Excluded from scoring.' },
  ];

  function buildTemplatePayload(q) {
    const sections = q.sections.filter((s) => s.questions.length);
    return {
      assessment_template: {
        title: q.name,
        description: [q.description, 'Answers use the MyITProcess vCIO alignment rating: Aligned, Marginal, Vulnerable or N/A. All questions are weighted equally.'].filter(Boolean).join('\n\n'),
        is_category_weight_evenly_distributed: true,
        categories: sections.map((section) => ({
          title: section.name,
          description: section.questions.length + ' question(s) in MyITProcess.',
          is_question_weight_evenly_distributed: true,
          weight_in_percentage: null,
          questions: section.questions.map((item) => ({
            title: item.title || item.question.slice(0, 120) || 'Untitled question',
            description: item.question || item.title || 'Untitled question',
            remediation_tips: null,
            criterion_label_type_enum: 'MultiResponse',
            scoring_instructions: item.instructions || null,
            weight_in_percentage: null,
            tag_ids: [],
            scope: 'client',
            criteria: CRITERIA.map((c) => ({ ...c })),
          })),
        })),
      },
    };
  }

  function prepareTemplate(q) {
    return root.Propel.sanitizeTemplatePayload(buildTemplatePayload(q), 'MyITProcess');
  }

  // ---------- Recommendations → the Propel project shape the shared pipeline migrates ----------

  const REC_STATUS = { 0: 'NotDiscussed', 1: 'Accepted', 2: 'Rejected', 3: 'Deferred', 4: 'InProgress', 5: 'Completed' };
  const REC_PRIORITY = { 1: 'Low', 2: 'Medium', 3: 'High' };
  const REC_TYPE = { 1: 'Project', 2: 'Time & materials', 3: 'Maintenance', 4: 'Strategic', 5: 'Business goal' };
  const REC_PARTY = { 1: 'Us (MSP)', 2: 'You (client)', 3: 'Third party' };
  const REC_REPEAT = { 2: 'Monthly', 3: 'Quarterly', 4: 'Semi-Annual', 5: 'Yearly' };

  /** Runs in the side panel (needs DOMParser for the rich-text description). */
  async function adaptProjects(projects) {
    const out = [];
    for (const p of projects) {
      const r = p.raw || {};
      const doc = await root.Propel.htmlToDoc(r.descriptionHtml || '');
      const facts = [
        r.initiative && 'Initiative: ' + r.initiative,
        REC_TYPE[r.type] && 'Type: ' + REC_TYPE[r.type],
        REC_PARTY[r.responsibleParty] && 'Responsible: ' + REC_PARTY[r.responsibleParty],
        r.hours ? 'Estimated hours: ' + r.hours : null,
        r.repeatInterval && REC_REPEAT[r.repeatInterval] ? 'Repeats ' + REC_REPEAT[r.repeatInterval].toLowerCase() + (r.repeatEnd ? ' until ' + String(r.repeatEnd).slice(0, 10) : '') : null,
      ].filter(Boolean);
      if (facts.length) {
        doc.content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'From MyITProcess' }] });
        doc.content.push({ type: 'paragraph', content: [{ type: 'text', text: facts.join(' · ') }] });
      }
      const repeat = REC_REPEAT[r.repeatInterval];
      const budget = Number(r.budget) || 0;
      const start = r.budgetMonth && /^\d{4}-\d{2}/.test(r.budgetMonth) ? r.budgetMonth.slice(0, 7) + '-01' : null;
      let end = null;
      if (start) {
        const d = new Date(start + 'T00:00:00Z');
        end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      }
      out.push({
        id: p.id,
        name: p.name,
        status: REC_STATUS[r.status] || null,
        priority: REC_PRIORITY[r.priority] || null,
        templateName: null,
        descriptionDoc: doc,
        oneTimeLines: repeat || !budget ? [] : [{ label: 'Budget' + (r.hours ? ' (' + r.hours + ' hrs)' : ''), amount: budget }],
        agreements: repeat && budget ? [{ name: 'Recurring budget', billingCycle: repeat, amount: budget }] : [],
        expectedStartDate: start,
        targetCompletionDate: end,
      });
    }
    return out;
  }

  root.MyItp = { myItpPageExtract, buildTemplatePayload, prepareTemplate, adaptProjects };
})(typeof self !== 'undefined' ? self : window);
