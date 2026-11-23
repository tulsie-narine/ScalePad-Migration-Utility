// Propel Your MSP → ScalePad CS: audit questionnaire migration.
// Loaded by the side panel (window) and the background worker (importScripts).
//
// Data path: Propel's web app talks to its own JSON:API backend with a Bearer
// token kept in localStorage. We run `propelPageExtract` inside the signed-in
// Propel tab, so the token is used in place and never leaves the page; only the
// normalized questionnaire data is returned. This is the same internal API the
// Propel UI uses — not Propel's paid public API product.

(function (root) {
  const SEVERITY_BY_POINTS = { 5: 'Low', 10: 'Medium', 20: 'High', 40: 'Critical' };
  const FAILURE_ACTIONS = {
    CreateServiceTicket: 'Create a service ticket in the PSA',
    CreateProjectOpportunity: 'Create a project opportunity',
    None: null,
  };

  /**
   * Injected into the Propel tab via chrome.scripting.executeScript({ func }).
   * Must be fully self-contained (it is serialized).
   * args: { mode: 'list' } | { mode: 'detail', ids: string[] }
   */
  async function propelPageExtract(args) {
    // Propel stores { token, expiration, refreshToken } as JSON under access_token.
    // We only read it; refreshing is left to the Propel app (it rotates the refresh token).
    let session = null;
    try { session = JSON.parse(localStorage.getItem('access_token') || 'null'); } catch (_e) { session = null; }
    const token = session && session.token;
    const local = args.mode === 'convertHtml';
    if (!token && !local) return { ok: false, error: 'Not signed in to Propel in this tab.' };
    if (!local && session.expiration && Date.parse(session.expiration) <= Date.now()) {
      return { ok: false, error: 'Your Propel session needs refreshing. Click anywhere in Propel, then try again.' };
    }
    const api = async (path) => {
      const res = await fetch(location.origin + '/api' + path, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.api+json, application/json' },
      });
      if (!res.ok) throw new Error('Propel ' + path + ' → ' + res.status);
      return res.json();
    };
    // Audits someone started but has not finished (status names vary by Propel version).
    const isOpenAudit = (st) => /progress|started|draft|pending/i.test(st || '') && !/notstarted/i.test(st || '');
    const tidy = (s) => String(s || '')
      .replace(/ /g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    // HTML → readable plain text. Table rows become "Label: value" lines; rows whose
    // label is "Pass/Fail/N/A Criteria" are also returned separately.
    const parseRich = (html) => {
      const criteria = {};
      if (!html) return { text: '', criteria };
      const doc = new DOMParser().parseFromString(String(html), 'text/html');
      for (const a of doc.querySelectorAll('a[href]')) {
        const label = a.textContent.trim();
        const href = a.getAttribute('href');
        a.textContent = label && label !== href ? label + ' (' + href + ')' : href;
      }
      for (const el of doc.querySelectorAll('br')) el.replaceWith('\n');
      for (const li of doc.querySelectorAll('li')) li.prepend('• ');
      for (const el of doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')) el.append('\n');
      for (const tr of doc.querySelectorAll('tr')) {
        const cells = [...tr.children].map((c) => tidy(c.textContent)).filter(Boolean);
        if (!cells.length) { tr.remove(); continue; }
        const label = cells[0].replace(/:$/, '');
        const value = cells.slice(1).join(' — ');
        const key = /^pass criteria/i.test(label) ? 'pass' : /^fail criteria/i.test(label) ? 'fail' : /^n\/?a criteria/i.test(label) ? 'na' : null;
        if (key && value) criteria[key] = value;
        tr.replaceWith(doc.createTextNode((value ? label + ': ' + value : label) + '\n\n'));
      }
      return { text: tidy(doc.body.textContent), criteria };
    };
    const toText = (html) => parseRich(html).text;

    // HTML → rich-text document (ProseMirror/Tiptap node names). The builder can
    // flatten it to plain paragraphs if ScalePad CS doesn't render richer nodes.
    const htmlToDoc = (html) => {
      const content = [];
      if (!html) return { type: 'doc', content };
      const doc = new DOMParser().parseFromString(String(html), 'text/html');
      const MARKS = { STRONG: 'bold', B: 'bold', EM: 'italic', I: 'italic', U: 'underline' };
      const inline = (node, marks, out) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            const text = child.nodeValue.replace(/\s+/g, ' ');
            if (text.trim() || (text === ' ' && out.length)) out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
          } else if (child.nodeType === 1) {
            if (child.tagName === 'BR') { out.push({ type: 'hardBreak' }); continue; }
            let next = marks;
            if (MARKS[child.tagName] && !marks.some((m) => m.type === MARKS[child.tagName])) next = marks.concat({ type: MARKS[child.tagName] });
            if (child.tagName === 'A' && child.getAttribute('href')) next = marks.concat({ type: 'link', attrs: { href: child.getAttribute('href') } });
            inline(child, next, out);
          }
        }
        return out;
      };
      const trimInline = (nodes) => {
        while (nodes.length && nodes[0].type === 'text' && !nodes[0].text.trim()) nodes.shift();
        while (nodes.length && nodes[nodes.length - 1].type === 'text' && !nodes[nodes.length - 1].text.trim()) nodes.pop();
        while (nodes.length && nodes[nodes.length - 1].type === 'hardBreak') nodes.pop();
        if (nodes[0]?.type === 'text') nodes[0] = { ...nodes[0], text: nodes[0].text.replace(/^\s+/, '') };
        const last = nodes[nodes.length - 1];
        if (last?.type === 'text') nodes[nodes.length - 1] = { ...last, text: last.text.replace(/\s+$/, '') };
        return nodes;
      };
      const para = (el) => { const c = trimInline(inline(el, [], [])); return c.length ? { type: 'paragraph', content: c } : null; };
      const block = (el, out) => {
        for (const child of el.childNodes) {
          if (child.nodeType === 3) {
            if (child.nodeValue.trim()) out.push({ type: 'paragraph', content: [{ type: 'text', text: child.nodeValue.trim() }] });
            continue;
          }
          if (child.nodeType !== 1) continue;
          const tag = child.tagName;
          if (/^H[1-6]$/.test(tag)) {
            const c = trimInline(inline(child, [], []));
            // All headings at level 3 so Propel's H1s match the template's own section headings.
            if (c.length) out.push({ type: 'heading', attrs: { level: 3 }, content: c });
          } else if (tag === 'UL' || tag === 'OL') {
            const items = [...child.children].filter((li) => li.tagName === 'LI').map((li) => {
              const inner = [];
              const hasBlocks = [...li.children].some((c) => /^(P|DIV|UL|OL)$/.test(c.tagName));
              if (hasBlocks) block(li, inner); else { const p = para(li); if (p) inner.push(p); }
              return inner.length ? { type: 'listItem', content: inner } : null;
            }).filter(Boolean);
            if (items.length) out.push({ type: tag === 'UL' ? 'bulletList' : 'orderedList', content: items });
          } else if (tag === 'TABLE') {
            for (const tr of child.querySelectorAll('tr')) {
              const cells = [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
              if (cells.length) out.push({ type: 'paragraph', content: [{ type: 'text', text: cells.join(' — ') }] });
            }
          } else if (/^(DIV|SECTION|ARTICLE|BLOCKQUOTE)$/.test(tag) && [...child.children].some((c) => /^(P|DIV|UL|OL|H[1-6]|TABLE)$/.test(c.tagName))) {
            block(child, out);
          } else {
            const p = para(child);
            if (p) out.push(p);
          }
        }
        return out;
      };
      block(doc.body, content);
      return { type: 'doc', content };
    };
    if (local) return { ok: true, doc: htmlToDoc(args.html) };
    const decode = (s) => (s ? new DOMParser().parseFromString(String(s), 'text/html').body.textContent.trim() : '');
    const accountId = async () => {
      try {
        const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const fromClaim = claims[location.origin + '/account_id'] || claims['https://app.propelyourmsp.com/account_id'];
        if (fromClaim) return fromClaim;
      } catch (_e) { /* fall through */ }
      const link = document.querySelector('a[href*="/account/"]');
      const fromLink = link && (link.getAttribute('href').match(/\/account\/([0-9a-f-]{36})/i) || [])[1];
      if (fromLink) return fromLink;
      const me = await api('/users/current');
      const rel = me?.data?.relationships?.account?.data?.id;
      return rel || me?.data?.attributes?.accountId || null;
    };

    try {
      const acct = await accountId();
      if (!acct) return { ok: false, error: 'Could not determine the Propel account.' };

      if (args.mode === 'list') {
        const list = await api('/accounts/' + acct + '/auditquestionnaires');
        return {
          ok: true,
          questionnaires: (list.data || []).map((q) => ({
            id: q.id,
            name: q.attributes?.name || 'Untitled questionnaire',
            category: q.attributes?.category || 'Uncategorized',
            passThreshold: q.attributes?.thresholds?.success ?? null,
            lastModified: q.attributes?.lastModified || null,
          })),
        };
      }

      if (args.mode === 'detail') {
        const templates = await api('/accounts/' + acct + '/projecttemplates').catch(() => ({ data: [] }));
        const templateById = new Map((templates.data || []).map((t) => [t.id, {
          name: t.attributes?.name || '',
          category: t.attributes?.category || '',
          priority: t.attributes?.priority || '',
        }]));
        const out = [];
        for (const id of args.ids) {
          const head = await api('/auditquestionnaires/' + id);
          const body = await api('/auditquestionnaires/' + id + '/sections?include=questions');
          const questionsById = new Map((body.included || []).filter((r) => r.type === 'AuditQuestion').map((r) => [r.id, r]));
          const sectionOrder = (head.data?.relationships?.sections?.data || []).map((s) => s.id);
          const sections = (body.data || []).slice().sort((a, b) => {
            const ia = sectionOrder.indexOf(a.id); const ib = sectionOrder.indexOf(b.id);
            return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
          });
          out.push({
            id,
            name: head.data?.attributes?.name || 'Untitled questionnaire',
            category: head.data?.attributes?.category || '',
            description: toText(head.data?.attributes?.description),
            passThreshold: head.data?.attributes?.thresholds?.success ?? null,
            sections: sections.map((s) => ({
              id: s.id,
              name: s.attributes?.name || 'Untitled section',
              questions: (s.relationships?.questions?.data || [])
                .map((ref) => questionsById.get(ref.id))
                .filter(Boolean)
                .map((q) => {
                  const a = q.attributes || {};
                  const tplId = q.relationships?.projectTemplate?.data?.id;
                  const rich = parseRich(a.instructions);
                  return {
                    id: q.id,
                    title: (a.title || '').trim(),
                    question: (a.question || '').trim(),
                    points: Number(a.points) || 0,
                    scope: a.scope || 'Company',
                    risks: (a.risks || []).map((r) => r.name).filter(Boolean),
                    isRequired: !!a.isRequired,
                    isClientStatus: !!a.isClientStatus,
                    failureAction: a.defaultFailureAction || 'None',
                    projectTemplate: tplId ? (templateById.get(tplId) || { name: '', category: '', priority: '' }) : null,
                    instructions: rich.text,
                    criteria: rich.criteria, // { pass?, fail?, na? } parsed from the instructions table
                    customerExplanation: toText(a.customerExplanation),
                  };
                }),
            })),
          });
        }
        return { ok: true, questionnaires: out };
      }
      if (args.mode === 'companies') {
        // Companies + per-company completed-audit summary (one account-wide audits call).
        const [companies, audits, account] = await Promise.all([
          api('/companies?include=teamMembers'),
          api('/accounts/' + acct + '/companyaudits').catch(() => ({ data: [] })),
          api('/accounts/' + acct).catch(() => null),
        ]);
        // PSA user names (Strategic Advisor / Technical Alignment) come from the PSA integration.
        const psaNames = new Map();
        const integrationIds = new Set();
        for (const r of Object.values(account?.data?.relationships || {})) {
          for (const d of [].concat(r?.data || [])) if (/integration/i.test(d?.type || '')) integrationIds.add(d.id);
        }
        for (const id of integrationIds) {
          const users = await api('/integrations/' + id + '/remotepsausers').catch(() => ({ data: [] }));
          for (const u of users.data || []) psaNames.set(u.id, ((u.attributes?.firstName || '') + ' ' + (u.attributes?.lastName || '')).trim());
        }
        const members = new Map((companies.included || []).filter((r) => /teammember/i.test(r.type)).map((r) => [r.id, r]));
        const ownersOf = (c) => {
          const out = {};
          for (const ref of c.relationships?.teamMembers?.data || []) {
            const m = members.get(ref.id);
            const name = psaNames.get(m?.relationships?.remotePsaUser?.data?.id);
            if (!name) continue;
            if (m.attributes?.role === 'VCio' && !out.strategicAdvisor) out.strategicAdvisor = name;
            if (m.attributes?.role === 'AccountManager' && !out.technicalAlignment) out.technicalAlignment = name;
          }
          return out;
        };
        const byCompany = new Map();
        const statuses = {};
        for (const a of audits.data || []) {
          const status = a.attributes?.status;
          statuses[status] = (statuses[status] || 0) + 1;
          const done = status === 'Finished' || status === 'UnderReview';
          const open = isOpenAudit(status);
          if (!done && !open) continue;
          const cid = a.relationships?.company?.data?.id;
          if (!cid) continue;
          const entry = byCompany.get(cid) || { completed: 0, incomplete: 0, questionnaires: new Set(), latest: null, lastActivity: null };
          const x = a.attributes || {};
          if (done) {
            entry.completed++;
            entry.questionnaires.add(x.name || '');
            const at = x.auditCompletion || x.reviewCompletion;
            if (at && (!entry.latest || at > entry.latest)) entry.latest = at;
          } else entry.incomplete++;
          const touched = x.lastModified || x.auditCompletion || x.reviewCompletion || x.creation;
          if (touched && (!entry.lastActivity || touched > entry.lastActivity)) entry.lastActivity = touched;
          byCompany.set(cid, entry);
        }
        const roadmapHint = (c) => {
          const f = c.attributes?.financialSummary || {};
          for (const k of ['projectsNext12Months', 'projectCostNext12Months', 'upcomingProjects']) {
            const v = f[k];
            if (typeof v === 'number') return v;
            if (v && typeof v === 'object') {
              const n = Object.values(v).reduce((t, x) => t + (typeof x === 'number' ? x : 0), 0);
              return n;
            }
          }
          return null;
        };
        return {
          ok: true,
          companies: (companies.data || []).map((c) => {
            const s = byCompany.get(c.id);
            return {
              id: c.id,
              name: (c.attributes?.name || '').trim(),
              externalId: c.attributes?.externalId ? String(c.attributes.externalId) : null,
              active: !!c.attributes?.isUnlocked,
              completedAudits: s ? s.completed : 0,
              incompleteAudits: s ? s.incomplete : 0,
              auditQuestionnaires: s ? s.questionnaires.size : 0,
              latestAudit: s ? s.latest : null,
              lastAuditActivity: s ? s.lastActivity : null,
              roadmapSpend: roadmapHint(c),
              owners: ownersOf(c),
            };
          }),
          auditStatuses: statuses,
        };
      }
      if (args.mode === 'companyAudits') {
        // Completed audits (UnderReview / Finished) for one company, plus in-progress ones when asked.
        const res = await api('/companies/' + args.companyId + '/audits');
        const keep = (st) => ['Finished', 'UnderReview'].includes(st) || (args.includeIncomplete && isOpenAudit(st));
        return {
          ok: true,
          audits: (res.data || []).filter((a) => keep(a.attributes?.status)).map((a) => {
            const x = a.attributes || {};
            return {
              id: a.id,
              name: (x.name || 'Audit').trim(),
              status: x.status,
              questionnaireId: a.relationships?.auditQuestionnaire?.data?.id || null,
              incomplete: !['Finished', 'UnderReview'].includes(x.status),
              startedAt: x.creation || null,
              completedAt: x.auditCompletion || x.reviewCompletion || x.lastModified || x.creation || null,
              reviewedAt: x.reviewCompletion || null,
              auditor: x.auditor || '',
              reviewer: x.reviewer || '',
              score: x.score ?? null,
              effectiveTotal: x.effectiveTotal ?? null,
              threshold: x.thresholds?.success ?? null,
              isFail: x.isFail ?? null,
            };
          }),
        };
      }
      if (args.mode === 'auditAnswers') {
        const res = await api('/companyaudits/' + args.auditId + '/questions?include=section,site,comments,ticket');
        const inc = new Map((res.included || []).map((r) => [r.type + ':' + r.id, r]));
        const rel = (r, key) => { const d = r.relationships?.[key]?.data; return d && !Array.isArray(d) ? inc.get(d.type + ':' + d.id) : null; };
        return {
          ok: true,
          answers: (res.data || []).map((q) => {
            const a = q.attributes || {};
            const section = rel(q, 'section');
            const ticket = rel(q, 'ticket');
            return {
              id: q.id,
              section: (section?.attributes?.name || '').trim(),
              sectionOrder: section?.attributes?.orderingIndex ?? 0,
              order: a.orderingIndex ?? 0,
              title: (a.title || '').trim(),
              question: (a.question || '').trim(),
              points: Number(a.points) || 0,
              answer: a.answer || null, // Pass | Fail | NotApplicable | null
              site: rel(q, 'site')?.attributes?.name || null,
              remediation: a.remediation || null,
              ticket: ticket ? (ticket.attributes?.externalId || null) : null,
              projectId: q.relationships?.project?.data?.id || null,
              risks: (a.risks || []).map((r) => r.name).filter(Boolean),
              isRequired: !!a.isRequired,
              failureAction: a.defaultFailureAction || 'None',
              instructions: parseRich(a.instructions).text,
              criteria: parseRich(a.instructions).criteria,
              customerExplanation: toText(a.customerExplanation),
              templateQuestionId: q.relationships?.template?.data?.id || null,
              comments: (q.relationships?.comments?.data || []).map((d) => inc.get(d.type + ':' + d.id)).filter(Boolean).map((cm) => ({
                text: toText(cm.attributes?.comment),
                isPublic: !!cm.attributes?.isPublic,
                type: cm.attributes?.commentType || 'Auditor',
              })).filter((cm) => cm.text),
            };
          }),
        };
      }
      if (args.mode === 'roadmapCounts') {
        const ids = args.companyIds || [];
        const counts = {};
        let next = 0;
        const worker = async () => {
          while (next < ids.length) {
            const id = ids[next++];
            try {
              const res = await api('/companies/' + id + '/projects');
              counts[id] = (res.data || []).length;
            } catch (e) { counts[id] = null; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
        return { ok: true, counts };
      }
      if (args.mode === 'companyProjects') {
        const [res, templates, types] = await Promise.all([
          api('/companies/' + args.companyId + '/projects?include=agreements'),
          api('/accounts/' + acct + '/projecttemplates').catch(() => ({ data: [] })),
          api('/accounts/' + acct + '/projecttypes').catch(() => ({ data: [] })),
        ]);
        const tplName = new Map((templates.data || []).map((t) => [t.id, (t.attributes?.name || '').trim()]));
        const typeName = new Map((types.data || []).map((t) => [t.id, t.attributes?.name || '']));
        const agreements = new Map((res.included || []).filter((r) => r.type === 'Agreement').map((r) => [r.id, r]));
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const level = (o) => (o && o.level && o.level !== 'Undefined' ? { level: o.level, reason: decode(o.reason) } : null);
        return {
          ok: true,
          projects: (res.data || []).map((p) => {
            const a = p.attributes || {};
            return {
              id: p.id,
              name: (a.name || 'Untitled project').trim(),
              status: a.status || null,
              priority: a.priority || null,
              projectType: typeName.get(p.relationships?.projectType?.data?.id) || null,
              templateName: tplName.get(p.relationships?.parentProjectTemplate?.data?.id) || null,
              costs: { material: num(a.materialCost), labor: num(a.laborCost), thirdParty: num(a.thirdPartyCost) },
              expectedStartDate: a.expectedStartDate || null,
              targetCompletionDate: a.targetCompletionDate || null,
              completionDate: a.completionDate || null,
              durationInDays: num(a.durationInDays),
              executiveSummary: decode(a.executiveSummary),
              justificationDoc: htmlToDoc(a.businessJustification),
              descriptionDoc: htmlToDoc(a.description),
              businessValue: a.businessValue ? { description: decode(a.businessValue.description), bullets: (a.businessValue.bullets || []).map(decode).filter(Boolean) } : null,
              beneficiaries: decode(a.beneficiaries),
              disruptedParties: decode(a.disruptedParties),
              disruption: level(a.disruption),
              executionRisk: level(a.executionRisk),
              psaOpportunity: a.externalId && /^\d+$/.test(String(a.externalId)) ? String(a.externalId) : null,
              agreements: (p.relationships?.agreements?.data || []).map((r) => agreements.get(r.id)).filter(Boolean).map((ag) => ({
                name: (ag.attributes?.name || 'Agreement').trim(),
                amount: num(ag.attributes?.amount),
                billingCycle: ag.attributes?.billingCycle || 'Monthly',
                isThirdParty: !!ag.attributes?.isThirdParty,
                annualIncrease: ag.attributes?.annualIncrease || null,
              })),
            };
          }),
        };
      }
      if (args.mode === 'projectTemplates') {
        const [list, types] = await Promise.all([
          api('/accounts/' + acct + '/projecttemplates?include=agreementTemplates'),
          api('/accounts/' + acct + '/projecttypes').catch(() => ({ data: [] })),
        ]);
        const typeName = new Map((types.data || []).map((t) => [t.id, t.attributes?.name || '']));
        const agreements = new Map((list.included || []).filter((r) => r.type === 'AgreementTemplate').map((r) => [r.id, r]));
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null); // absent = TBD
        const level = (o) => (o && o.level ? { level: o.level, reason: decode(o.reason) } : null);
        return {
          ok: true,
          templates: (list.data || []).map((t) => {
            const a = t.attributes || {};
            return {
              id: t.id,
              name: (a.name || 'Untitled project').trim(),
              category: (a.category || 'Uncategorized').trim(),
              priority: a.priority || null,
              projectType: typeName.get(t.relationships?.projectType?.data?.id) || null,
              costs: { material: num(a.materialCost), labor: num(a.laborCost), thirdParty: num(a.thirdPartyCost) },
              durationInDays: num(a.durationInDays),
              executiveSummary: decode(a.executiveSummary),
              justificationDoc: htmlToDoc(a.businessJustification),
              descriptionDoc: htmlToDoc(a.description),
              businessValue: a.businessValue ? {
                description: decode(a.businessValue.description),
                bullets: (a.businessValue.bullets || []).map(decode).filter(Boolean),
              } : null,
              beneficiaries: decode(a.beneficiaries),
              disruptedParties: decode(a.disruptedParties),
              disruption: level(a.disruption),
              executionRisk: level(a.executionRisk),
              hasInstructions: !!toText(a.instructions),
              agreements: (t.relationships?.agreementTemplates?.data || []).map((ref) => agreements.get(ref.id)).filter(Boolean).map((ag) => ({
                name: (ag.attributes?.name || 'Agreement').trim(),
                amount: num(ag.attributes?.amount),
                billingCycle: ag.attributes?.billingCycle || 'Monthly',
                isThirdParty: !!ag.attributes?.isThirdParty,
                annualIncrease: ag.attributes?.annualIncrease || null,
              })),
              lastModified: a.lastModified || null,
            };
          }),
        };
      }
      return { ok: false, error: 'Unknown extract mode.' };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) };
    }
  }

  /**
   * Split 100% across items in proportion to `values`, rounded to 2 decimals,
   * using largest-remainder so the result always sums to exactly 100.
   */
  function distributeWeights(values) {
    const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
    if (!total) return values.map(() => null);
    const raw = values.map((v) => (Math.max(0, v) / total) * 10000); // hundredths of a percent
    const floors = raw.map(Math.floor);
    let remainder = 10000 - floors.reduce((a, b) => a + b, 0);
    const order = raw.map((v, i) => [v - floors[i], i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < remainder; k++) floors[order[k % order.length][1]] += 1;
    return floors.map((v) => v / 100);
  }

  function sectionPoints(section) {
    return section.questions.reduce((sum, q) => sum + q.points, 0);
  }

  function questionnaireStats(q) {
    const questions = q.sections.reduce((n, s) => n + s.questions.length, 0);
    const points = q.sections.reduce((n, s) => n + sectionPoints(s), 0);
    return { sections: q.sections.length, questions, points };
  }

  function severityLabel(points) {
    return SEVERITY_BY_POINTS[points] || 'Custom';
  }

  function remediationText(q) {
    const lines = [];
    const action = FAILURE_ACTIONS[q.failureAction];
    if (action) lines.push('On Fail: ' + action + '.');
    if (q.projectTemplate?.name) {
      const meta = [q.projectTemplate.category, q.projectTemplate.priority && q.projectTemplate.priority + ' priority'].filter(Boolean).join(', ');
      lines.push('Project template: ' + q.projectTemplate.name + (meta ? ' (' + meta + ')' : '') + '.');
    }
    return lines.length ? lines.join('\n') : null;
  }

  function scoringText(q) {
    const head = ['Pass/Fail question. Severity: ' + severityLabel(q.points) + ' (' + q.points + ' pts in Propel).'];
    if (q.isRequired) head.push('Required: in Propel, a Fail on this question fails the whole audit.');
    if (q.risks.length) head.push('Risks: ' + q.risks.join(', ') + '.');
    return [head.join(' '), q.instructions].filter(Boolean).join('\n\n');
  }

  /** Build the ScalePad CS POST /assessment-templates body for one questionnaire. */
  function buildPropelTemplatePayload(q) {
    const sections = q.sections.filter((s) => s.questions.length);
    const categoryWeights = distributeWeights(sections.map(sectionPoints));
    const categoriesEven = categoryWeights.every((w) => w == null);
    const descriptionParts = [
      q.description,
      'Migrated from the Propel Your MSP questionnaire "' + q.name + '".',
      q.passThreshold != null ? 'Propel pass threshold: ' + q.passThreshold + '%.' : '',
      'Category and question weights are proportional to Propel points.',
    ].filter(Boolean);

    return {
      assessment_template: {
        title: q.name,
        description: descriptionParts.join('\n\n'),
        is_category_weight_evenly_distributed: categoriesEven,
        categories: sections.map((section, sectionIndex) => {
          const questionWeights = distributeWeights(section.questions.map((x) => x.points));
          const questionsEven = questionWeights.every((w) => w == null);
          return {
            title: section.name,
            description: sectionPoints(section) + ' points in Propel across ' + section.questions.length + ' question(s).',
            is_question_weight_evenly_distributed: questionsEven,
            weight_in_percentage: categoriesEven ? null : categoryWeights[sectionIndex],
            questions: section.questions.map((item, questionIndex) => ({
              title: item.title || item.question.slice(0, 120) || 'Untitled question',
              description: item.question || item.title || 'Untitled question',
              remediation_tips: remediationText(item),
              criterion_label_type_enum: 'MultiResponse',
              scoring_instructions: scoringText(item),
              weight_in_percentage: questionsEven ? null : questionWeights[questionIndex],
              tag_ids: [],
              scope: item.scope === 'Site' ? 'site' : 'client',
              criteria: [
                { label_enum: 'Satisfactory', description: item.criteria?.pass ? 'Pass: ' + item.criteria.pass : 'Pass.' },
                {
                  label_enum: 'AtRisk',
                  description: item.criteria?.fail ? 'Fail: ' + item.criteria.fail : 'Fail.',
                  default_public_comment: item.customerExplanation || null,
                },
                { label_enum: 'NotApplicable', description: item.criteria?.na ? 'N/A: ' + item.criteria.na : 'Not applicable. Excluded from scoring.' },
              ],
            })),
          };
        }),
      },
    };
  }

  // ScalePad's API firewall rejects (HTTP 403) template text that looks like injection:
  //  - a quoted string containing {…} (e.g. PowerShell's "{0:N2}") or ${…}
  //  - a "$last…" variable, any case (e.g. $lastLogonDate, $LASTEXITCODE); other $vars pass
  // Such lines are left out (never encoded or disguised), replaced by a pointer back to
  // Propel, and reported so the user knows. Patterns confirmed by probing the API.
  const FIREWALL_FLAGGED = /"[^"\n]*\{[^{}\n]*\}[^"\n]*"|\$\{[^}\n]*\}|\$last/i;
  let sourceLabel = 'Propel';
  const omittedNote = () => '[Line omitted: it contains a script snippet the ScalePad CS API does not accept. See ' + sourceLabel + ' for the full text.]';

  function omitFlaggedLines(text) {
    if (typeof text !== 'string' || !FIREWALL_FLAGGED.test(text)) return { text, omitted: 0 };
    let omitted = 0;
    const lines = text.split('\n').map((line) => {
      if (!FIREWALL_FLAGGED.test(line)) return line;
      omitted++;
      return omittedNote();
    });
    return { text: lines.join('\n'), omitted };
  }

  // Field length limits enforced by the ScalePad CS API (HTTP 422 when exceeded).
  const FIELD_LIMITS = { scoring_instructions: 2500 };

  function truncateToLimit(text, limit) {
    if (typeof text !== 'string' || text.length <= limit) return { text, truncated: false };
    const note = '\n\n[Truncated: the full text is ' + text.length + ' characters and ScalePad CS allows ' + limit + '. See this question in ' + sourceLabel + ' for the rest.]';
    const room = limit - note.length;
    const cut = text.lastIndexOf('\n', room);
    const head = text.slice(0, cut > room * 0.6 ? cut : room).trimEnd();
    return { text: head + note, truncated: true };
  }

  /**
   * Build the payload, strip firewall-flagged lines, and fit fields to API limits.
   * Returns { payload, omissions: [{ kind: 'firewall'|'truncated', category, question, field, lines? }] }.
   */
  function prepareTemplate(q) {
    return sanitizeTemplatePayload(buildPropelTemplatePayload(q), 'Propel');
  }

  /** Strip firewall-flagged lines and fit fields to API limits for any assessment-template payload. */
  function sanitizeTemplatePayload(payload, label = 'Propel') {
    sourceLabel = label;
    const omissions = [];
    const t = payload.assessment_template;
    const clean = (obj, key, where) => {
      const result = omitFlaggedLines(obj[key]);
      if (result.omitted) {
        obj[key] = result.text;
        omissions.push({ kind: 'firewall', ...where, field: key, lines: result.omitted });
      }
      if (FIELD_LIMITS[key]) {
        const fitted = truncateToLimit(obj[key], FIELD_LIMITS[key]);
        if (fitted.truncated) {
          obj[key] = fitted.text;
          omissions.push({ kind: 'truncated', ...where, field: key });
        }
      }
    };
    clean(t, 'description', { category: null, question: null });
    for (const category of t.categories) {
      clean(category, 'description', { category: category.title, question: null });
      for (const question of category.questions) {
        const where = { category: category.title, question: question.title };
        for (const key of ['title', 'description', 'remediation_tips', 'scoring_instructions']) clean(question, key, where);
        for (const criterion of question.criteria) {
          clean(criterion, 'description', where);
          clean(criterion, 'default_public_comment', where);
        }
      }
    }
    return { payload, omissions };
  }

  // ---------- Project templates → ScalePad CS initiative templates ----------

  const PRIORITY_TAG = (p) => (p ? 'Priority: ' + p : null);
  // Billing cycles ScalePad can't represent are converted to Monthly or Yearly.
  const CYCLE_CONVERSION = {
    Monthly: ['Monthly', 1],
    Yearly: ['Yearly', 1],
    Weekly: ['Monthly', 52 / 12],
    'Bi-Weekly': ['Monthly', 26 / 12],
    'Bi-Monthly': ['Monthly', 1 / 2],
    Quarterly: ['Monthly', 1 / 3],
    'Semi-Annual': ['Monthly', 1 / 6],
    'Every 2 years': ['Yearly', 1 / 2],
    'Every 3 years': ['Yearly', 1 / 3],
    'Every 4 years': ['Yearly', 1 / 4],
    'Every 5 years': ['Yearly', 1 / 5],
  };

  const textNode = (text, marks) => (marks && marks.length ? { type: 'text', text, marks } : { type: 'text', text });
  const paragraph = (...parts) => {
    const content = parts.flat().filter((p) => p && (p.type !== 'text' || p.text));
    return content.length ? { type: 'paragraph', content } : null;
  };
  const heading = (text) => ({ type: 'heading', attrs: { level: 3 }, content: [textNode(text)] });
  const bulletList = (items) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [paragraph(textNode(t))] })) });

  /** Flatten rich nodes to paragraphs + plain text (headings bold-free, bullets as "• "). */
  function flattenDoc(doc) {
    const out = [];
    const inlineText = (nodes) => (nodes || []).map((n) => (n.type === 'hardBreak' ? '\n' : n.text || '')).join('');
    const walk = (nodes, prefix) => {
      for (const n of nodes || []) {
        if (n.type === 'paragraph' || n.type === 'heading') {
          const text = inlineText(n.content).trim();
          if (text) out.push(paragraph(textNode(prefix + text)));
        } else if (n.type === 'bulletList' || n.type === 'orderedList') {
          (n.content || []).forEach((li, i) => walk(li.content, n.type === 'orderedList' ? (i + 1) + '. ' : '• '));
        } else if (n.content) walk(n.content, prefix);
      }
    };
    walk(doc.content, '');
    return { type: 'doc', content: out.filter(Boolean) };
  }

  /** Apply firewall line-omission to every text node; returns count of nodes changed. */
  function scrubDoc(doc) {
    let changed = 0;
    const walk = (n) => {
      if (n.type === 'text' && typeof n.text === 'string') {
        const r = omitFlaggedLines(n.text);
        if (r.omitted) { n.text = r.text; changed++; }
      }
      (n.content || []).forEach(walk);
    };
    walk(doc);
    return changed;
  }

  const hasContent = (doc) => !!(doc && doc.content && doc.content.length);
  const money = (dollars) => Math.round(dollars * 100);

  function executiveSummaryDoc(t) {
    const content = [];
    if (t.executiveSummary) content.push(paragraph(textNode(t.executiveSummary, [{ type: 'bold' }])));
    if (hasContent(t.justificationDoc)) content.push(heading('Why this matters'), ...t.justificationDoc.content);
    if (hasContent(t.descriptionDoc)) {
      if (content.length && t.descriptionDoc.content[0]?.type !== 'heading') content.push(heading('Project scope'));
      content.push(...t.descriptionDoc.content);
    }
    return { type: 'doc', content: content.filter(Boolean) };
  }

  function businessValueDoc(t) {
    const content = [];
    const bv = t.businessValue;
    if (bv?.description) content.push(paragraph(textNode(bv.description)));
    if (bv?.bullets?.length) content.push(bulletList(bv.bullets));
    const facts = [
      ['Who benefits', t.beneficiaries],
      ["Who's disrupted", t.disruptedParties],
      ['Disruption', t.disruption && t.disruption.level + (t.disruption.reason ? ' — ' + t.disruption.reason : '')],
      ['Execution risk', t.executionRisk && t.executionRisk.level + (t.executionRisk.reason ? ' — ' + t.executionRisk.reason : '')],
    ].filter(([, v]) => v);
    for (const [label, value] of facts) content.push(paragraph(textNode(label + ': ', [{ type: 'bold' }]), textNode(value)));
    return { type: 'doc', content: content.filter(Boolean) };
  }

  /**
   * One-time and recurring budget lines for a project template or a project
   * (same Propel cost shape). Pushes conversion notes into `notes`.
   */
  function costLines(t, notes = []) {
    const oneTime = [];
    if (Array.isArray(t.oneTimeLines)) oneTime.push(...t.oneTimeLines.map((l) => ({ label: l.label, cost_subunits: money(l.amount || 0), cost_type: 'Fixed' })));
    else for (const [key, label] of [['material', 'Material'], ['labor', 'Labor'], ['thirdParty', 'Third-party']]) {
      const v = t.costs?.[key];
      if (v == null) oneTime.push({ label: label + ' (TBD)', cost_subunits: 0, cost_type: 'Fixed' });
      else if (v > 0) oneTime.push({ label, cost_subunits: money(v), cost_type: 'Fixed' });
    }
    if (oneTime.some((l) => /\(TBD\)$/.test(l.label))) notes.push({ kind: 'tbd', detail: 'TBD costs added as $0 lines' });

    const recurring = (t.agreements || []).map((ag) => {
      const [frequency, factor] = CYCLE_CONVERSION[ag.billingCycle] || ['Monthly', 1];
      const suffix = [];
      if (ag.annualIncrease?.amount) suffix.push(ag.annualIncrease.type === 'Percentage' ? '+' + ag.annualIncrease.amount + '%/yr' : '+$' + ag.annualIncrease.amount + '/yr');
      if (ag.isThirdParty) suffix.push('3rd party');
      if (factor !== 1) suffix.push('converted from ' + ag.billingCycle);
      if (ag.amount == null) suffix.push('TBD');
      if (factor !== 1) notes.push({ kind: 'cycle', detail: ag.name + ': ' + ag.billingCycle + ' converted to ' + frequency });
      return {
        label: (ag.name + (suffix.length ? ' (' + suffix.join(', ') + ')' : '')).slice(0, 400),
        cost_subunits: ag.amount == null ? 0 : money(ag.amount * factor),
        cost_type: 'Fixed',
        frequency,
      };
    });

    let order = 0;
    for (const line of oneTime) line.display_order = order++;
    for (const line of recurring) line.display_order = order++;
    return { oneTime, recurring };
  }

  /** Tag names this template needs (category + priority). */
  function initiativeTagNames(t) {
    return [t.category, PRIORITY_TAG(t.priority)].filter(Boolean);
  }

  /**
   * Build the POST /initiative-templates body for one Propel project template.
   * opts: { tagIds: string[], rich: boolean }
   * Returns { payload, notes: [{ kind, detail }] }.
   */
  function prepareInitiativeTemplate(t, opts = {}) {
    const rich = opts.rich !== false;
    const notes = [];

    let summary = executiveSummaryDoc(t);
    let value = businessValueDoc(t);
    if (!rich) { summary = flattenDoc(summary); value = flattenDoc(value); }
    const scrubbed = scrubDoc(summary) + scrubDoc(value);
    if (scrubbed) notes.push({ kind: 'firewall', detail: scrubbed + ' line(s) with script snippets left out' });

    const { oneTime, recurring } = costLines(t, notes);

    const hasOneTime = oneTime.length > 0;
    const hasRecurring = recurring.length > 0;
    if (t.hasInstructions) notes.push({ kind: 'instructions', detail: 'Internal vCIO instructions not migrated (no internal field on initiative templates)' });

    const payload = {
      initiative_template: {
        name: t.name,
        executive_summary_json: hasContent(summary) ? JSON.stringify(summary) : null,
        business_value_json: hasContent(value) ? JSON.stringify(value) : null,
        budget_line_items: oneTime,
        recurring_line_items: recurring,
        action_items: [],
        tag_ids: opts.tagIds || [],
        budget_model: 'flat',
        cost_type: hasOneTime && hasRecurring ? 'one_time_plus_recurring' : hasRecurring ? 'recurring' : hasOneTime ? 'one_time' : null,
        duration: t.durationInDays ? Math.max(1, Math.ceil(t.durationInDays / 7)) : null,
      },
    };
    return { payload, notes };
  }

  function initiativeTotals(t) {
    const oneTime = ['material', 'labor', 'thirdParty'].reduce((sum, k) => sum + (t.costs?.[k] || 0), 0);
    const tbd = ['material', 'labor', 'thirdParty'].some((k) => t.costs?.[k] == null);
    const monthly = (t.agreements || []).reduce((sum, ag) => {
      const [freq, factor] = CYCLE_CONVERSION[ag.billingCycle] || ['Monthly', 1];
      const amount = (ag.amount || 0) * factor;
      return sum + (freq === 'Yearly' ? amount / 12 : amount);
    }, 0);
    return { oneTime, tbd, monthly };
  }

  // ---------- Completed audits → ScalePad CS assessments ----------

  const COMMENT_MAX = 1000; // ScalePad per-question comment limit
  // Server-enforced limit (not in the OpenAPI spec; confirmed by a 422 response).
  const SUMMARY_MAX = 1000; // assessment internal comment
  const ANSWER_TO_LABEL = { Pass: 'Satisfactory', Marginal: 'NeedsAttention', Fail: 'AtRisk', NotApplicable: 'NotApplicable' };
  const clip = (s, max) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);
  const qKey = (title, question) => normName(title || String(question || '').slice(0, 120));

  /**
   * Which audits to migrate for a client.
   * range: 'latest' (default: newest per questionnaire) | 'all' | number of months (every audit
   * completed within that window, oldest first so history reads in order).
   */
  function pickAuditsToMigrate(audits, range = 'latest', now = new Date()) {
    const byDate = (list) => list.slice().sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
    if (range === 'all') return byDate(audits);
    if (typeof range === 'number' || /^\d+$/.test(String(range))) {
      const cutoff = new Date(now);
      cutoff.setUTCMonth(cutoff.getUTCMonth() - Number(range));
      return byDate(audits.filter((a) => a.completedAt && new Date(a.completedAt) >= cutoff));
    }
    const latest = new Map();
    for (const a of audits) {
      const key = a.questionnaireId || 'name:' + normName(a.name);
      const cur = latest.get(key);
      if (!cur || String(a.completedAt) > String(cur.completedAt)) latest.set(key, a);
    }
    // An in-progress audit newer than the last finished one comes along too, so nothing is lost.
    const out = [...latest.values()];
    if (audits.some((a) => a.incomplete)) {
      const finished = new Map();
      for (const a of audits) {
        if (a.incomplete) continue;
        const key = a.questionnaireId || 'name:' + normName(a.name);
        const cur = finished.get(key);
        if (!cur || String(a.completedAt) > String(cur.completedAt)) finished.set(key, a);
      }
      for (const [key, a] of finished) if (latest.get(key)?.incomplete) out.push(a);
    }
    return byDate(out);
  }

  /** Match an auditor display name to a ScalePad user id (first + last name). */
  function matchUser(displayName, users) {
    const want = normName(displayName);
    if (!want) return null;
    const hit = (users || []).find((u) => normName((u.first_name || '') + ' ' + (u.last_name || '')) === want);
    return hit ? hit.user_id : null;
  }

  /** ScalePad requires evaluate_at in UTC; MyITProcess and Strategy Overview send dates without a zone. */
  function utcTimestamp(value) {
    if (!value) return new Date().toISOString();
    const s = String(value);
    const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) || !/T/.test(s) ? s : s + 'Z');
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  function assessmentCreatePayload(audit, { clientId, clientName, templateId, evaluatorId }) {
    const day = audit.completedAt ? String(audit.completedAt).slice(0, 10) : '';
    return {
      client_key: { id: clientId, name: clientName },
      title: clip((audit.title || audit.name) + (day ? ' (' + day + ')' : ''), 200),
      assessment_template_id: templateId,
      evaluate_user_id: evaluatorId,
      evaluate_at: utcTimestamp(audit.completedAt),
    };
  }

  /**
   * Plan answers + comments for one audit against a created assessment instance.
   * instance: GET assessment body (category_list[].question_list[].criteria_list[]).
   * Returns { evaluations, comments, links, unmatched, summary, stats }.
   */
  function planAssessment(audit, answers, instance) {
    // Index the ScalePad instance by section+title, and by title alone when unique.
    const bySectionTitle = new Map();
    const byTitle = new Map();
    for (const cat of instance.category_list || []) {
      const catKey = normName(cat.title || cat.category_title || cat.name);
      for (const q of cat.question_list || []) {
        const criteria = {};
        for (const c of q.criteria_list || []) {
          const label = String(c.label_enum || c.label_key || c.display_label || '').replace(/\s+/g, '').toLowerCase();
          criteria[label] = c.assessment_criterion_id;
        }
        const entry = { id: q.assessment_question_id, criteria };
        const tKey = normName(q.title);
        bySectionTitle.set(catKey + '|' + tKey, entry);
        byTitle.set(tKey, byTitle.has(tKey) ? null : entry);
      }
    }

    // Collapse per-site rows of the same question into one client-wide answer.
    const groups = new Map();
    for (const a of answers) {
      const key = normName(a.section) + '|' + qKey(a.title, a.question);
      if (!groups.has(key)) groups.set(key, { rows: [], section: a.section, title: a.title || a.question.slice(0, 120) });
      groups.get(key).rows.push(a);
    }

    const evaluations = [];
    const comments = [];
    const links = [];
    const unmatched = [];
    const stats = { pass: 0, marginal: 0, fail: 0, na: 0, unanswered: 0 };
    for (const [key, g] of groups) {
      const target = bySectionTitle.get(key) || byTitle.get(key.split('|')[1]);
      const answersSet = g.rows.map((r) => r.answer);
      const combined = ['Fail', 'Marginal', 'Pass', 'NotApplicable'].find((v) => answersSet.includes(v)) || null;
      stats[{ Fail: 'fail', Marginal: 'marginal', Pass: 'pass', NotApplicable: 'na' }[combined] || 'unanswered']++;
      if (!target) { if (combined) unmatched.push('[' + g.section + '] ' + g.title + ': ' + combined); continue; }

      if (combined) {
        const crit = target.criteria[ANSWER_TO_LABEL[combined].toLowerCase()];
        if (crit) evaluations.push({ question_id: target.id, selected_criteria_id: crit });
      }
      const pub = [];
      const internal = [];
      for (const r of g.rows) {
        const where = g.rows.length > 1 && r.site ? r.site + ': ' : '';
        if (g.rows.length > 1 && r.site) internal.push('Site ' + r.site + ': ' + (r.answer || 'unanswered'));
        for (const cm of r.comments) (cm.isPublic ? pub : internal).push(where + cm.text);
        if (r.remediation) internal.push(where + 'Review action: ' + r.remediation);
        if (r.ticket) internal.push(where + 'ConnectWise ticket #' + r.ticket);
        if (r.projectId) links.push({ questionId: target.id, projectId: r.projectId });
      }
      if (pub.length) comments.push({ questionId: target.id, kind: 'public', text: clip(pub.join('\n'), COMMENT_MAX) });
      if (internal.length) comments.push({ questionId: target.id, kind: 'internal', text: clip(internal.join('\n'), COMMENT_MAX) });
    }

    const pct = audit.effectiveTotal ? Math.round((audit.score / audit.effectiveTotal) * 100) : null;
    const lines = audit.summaryLines || [
      'Migrated from Propel audit "' + audit.name + '".',
      'Auditor: ' + (audit.auditor || 'unknown') + (audit.reviewer ? ' · Reviewer: ' + audit.reviewer : ''),
      'Completed: ' + String(audit.completedAt || '').slice(0, 10) + (audit.reviewedAt ? ' · Reviewed: ' + String(audit.reviewedAt).slice(0, 10) : ''),
      pct != null ? 'Propel score: ' + audit.score + '/' + audit.effectiveTotal + ' (' + pct + '%)' + (audit.threshold != null ? ', pass at ' + audit.threshold + '% → ' + (audit.isFail ? 'Fail' : 'Pass') : '') : '',
    ].filter(Boolean);
    // List as many unmatched answers as fit under the limit, then "…and N more".
    let summary = lines.join('\n');
    if (unmatched.length) {
      summary += '\n\nAnswers with no matching template question (' + unmatched.length + '):';
      for (let i = 0; i < unmatched.length; i++) {
        const more = '\n…and ' + (unmatched.length - i) + ' more';
        if (summary.length + 1 + unmatched[i].length + more.length > SUMMARY_MAX) { summary += more; break; }
        summary += '\n' + unmatched[i];
      }
    }
    return { evaluations, comments, links, unmatched, summary: clip(summary, SUMMARY_MAX), stats };
  }

  /** Rebuild a questionnaire (same shape as 'detail' extraction) from an audit's own question copies. */
  function questionnaireFromAudit(audit, answers) {
    const sections = new Map();
    for (const a of answers.slice().sort((x, y) => (x.sectionOrder - y.sectionOrder) || (x.order - y.order))) {
      if (!sections.has(a.section)) sections.set(a.section, new Map());
      const qs = sections.get(a.section);
      const key = qKey(a.title, a.question);
      if (qs.has(key)) continue; // per-site duplicates
      qs.set(key, {
        id: a.templateQuestionId || a.id, title: a.title, question: a.question, points: a.points,
        scope: a.site ? 'Site' : 'Company', risks: a.risks || [], isRequired: !!a.isRequired, isClientStatus: false,
        failureAction: a.failureAction || 'None', projectTemplate: null,
        instructions: a.instructions || '', criteria: a.criteria || {}, customerExplanation: a.customerExplanation || '',
      });
    }
    return {
      id: 'audit:' + audit.id, name: audit.name, category: 'Rebuilt from audit',
      description: 'Rebuilt from a completed Propel audit because its questionnaire no longer exists in Propel.',
      passThreshold: audit.threshold ?? null,
      sections: [...sections].map(([name, qs]) => ({ id: name, name: name || 'General', questions: [...qs.values()] })),
    };
  }

  // ---------- Roadmap projects → ScalePad CS initiatives ----------

  const STATUS_MAP = {
    NotDiscussed: 'New', Discussed: 'Proposed', AwaitingResponse: 'Proposed', ToQuote: 'Proposed',
    VerbalApproval: 'Approved', Accepted: 'Approved', InProgress: 'InProgress', Deferred: 'OnHold',
    Rejected: 'Declined', Completed: 'Completed',
  };
  const PRIORITY_MAP = { Low: 'Low', Medium: 'Medium', High: 'High', Critical: 'High' };

  /**
   * Schedule for a project. ScalePad's "Day" precision only accepts a single day
   * (start must equal end), so ranges are sent at Month precision (first day of the
   * start month → last day of the end month). `fallback` is the start date's quarter,
   * used if ScalePad rejects the range.
   * Returns { primary, fallback } or null when Propel has no start date.
   */
  function scheduleFor(p) {
    const day = (s) => (s ? String(s).slice(0, 10) : null);
    const start = day(p.expectedStartDate);
    if (!start) return null;
    let end = day(p.targetCompletionDate) || day(p.completionDate);
    if (!end && p.durationInDays) {
      const d = new Date(start + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + Math.max(0, p.durationInDays - 1));
      end = d.toISOString().slice(0, 10);
    }
    const s = new Date(start + 'T00:00:00Z');
    const quarter = { fiscal_quarter: { year: s.getUTCFullYear(), quarter: Math.floor(s.getUTCMonth() / 3) + 1 } };
    if (!end || end < start) return { primary: quarter, fallback: null };
    const e = new Date(end + 'T00:00:00Z');
    const monthStart = start.slice(0, 8) + '01';
    const monthEnd = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { primary: { target_start_date: monthStart, target_end_date: monthEnd, target_precision: 'Month' }, fallback: quarter };
  }

  /**
   * Plan every write for one Propel project.
   * opts: { clientId, clientName, templateIdByName: Map(lowercased name → id), rich }
   */
  function planInitiative(p, opts) {
    const notes = [];
    let summary = executiveSummaryDoc(p);
    let value = businessValueDoc(p);
    if (opts.rich === false) { summary = flattenDoc(summary); value = flattenDoc(value); }
    const scrubbed = scrubDoc(summary) + scrubDoc(value);
    if (scrubbed) notes.push({ kind: 'firewall', detail: scrubbed + ' line(s) with script snippets left out' });
    const { oneTime, recurring } = costLines(p, notes);
    const templateId = p.templateName ? (opts.templateIdByName?.get(p.templateName.toLowerCase()) || null) : null;
    if (p.templateName && !templateId) notes.push({ kind: 'template', detail: 'Project template "' + p.templateName + '" not found in ScalePad CS' });
    if (p.priority === 'Critical') notes.push({ kind: 'priority', detail: 'Critical priority set as High' });
    return {
      create: {
        client_key: { id: opts.clientId, name: opts.clientName },
        name: clip(p.name, 200),
        executive_summary_json: hasContent(summary) ? JSON.stringify(summary) : null,
      },
      businessValueJson: hasContent(value) ? JSON.stringify(value) : null,
      templateId,
      budgetLineItems: oneTime,
      recurringLineItems: recurring,
      schedule: scheduleFor(p),
      status: p.status ? STATUS_MAP[p.status] || null : null,
      priority: PRIORITY_MAP[p.priority] || null,
      notes,
    };
  }

  // ---------- Client matching (Propel company → ScalePad CS client) ----------

  const normName = (s) => String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|pllc|lp|llp)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '');

  /**
   * Match Propel companies to ScalePad clients.
   * spClients: [{ id, name, psaIds: [{ vendor, id }] }]
   * saved: { [propelCompanyId]: { clientId, clientName, method } } (manual choices win)
   * Returns Map propelCompanyId → { clientId, clientName, method: 'manual'|'psa'|'name' } | null
   */
  function matchCompanies(companies, spClients, saved = {}) {
    const byPsa = new Map();
    const byName = new Map();
    for (const c of spClients) {
      for (const p of c.psaIds || []) if (/connectwise/i.test(p.vendor)) byPsa.set(String(p.id), c);
      const key = normName(c.name);
      byName.set(key, byName.has(key) ? null : c); // ambiguous names don't auto-match
    }
    const clientIds = new Set(spClients.map((c) => c.id));
    const out = new Map();
    for (const co of companies) {
      const manual = saved[co.id];
      if (manual && manual.clientId === null) { out.set(co.id, { clientId: null, method: 'skip' }); continue; }
      if (manual && clientIds.has(manual.clientId)) { out.set(co.id, { ...manual, method: 'manual' }); continue; }
      const psa = co.externalId && byPsa.get(co.externalId);
      if (psa) { out.set(co.id, { clientId: psa.id, clientName: psa.name, method: 'psa' }); continue; }
      const named = byName.get(normName(co.name));
      out.set(co.id, named ? { clientId: named.id, clientName: named.name, method: 'name' } : null);
    }
    return out;
  }

  root.Propel = {
    questionnaireFromAudit,
    pickAuditsToMigrate,
    matchUser,
    assessmentCreatePayload,
    planAssessment,
    planInitiative,
    scheduleFor,
    matchCompanies,
    normName,
    prepareInitiativeTemplate,
    initiativeTagNames,
    initiativeTotals,
    flattenDoc,
    propelPageExtract,
    distributeWeights,
    sectionPoints,
    questionnaireStats,
    severityLabel,
    buildPropelTemplatePayload,
    prepareTemplate,
    sanitizeTemplatePayload,
    omitFlaggedLines,
    distributeWeightsEven: (n) => distributeWeights(Array(n).fill(1)),
    htmlToDoc: async (html) => (await propelPageExtract({ mode: 'convertHtml', html })).doc,
  };
})(typeof self !== 'undefined' ? self : window);
