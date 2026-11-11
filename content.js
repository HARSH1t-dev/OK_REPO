/**
 * content.js — Phase 4: renders the analysis, difficulty tags and maintainer picks inside github.com.
 *
 * - Issue page : sidebar card (summary, languages, effort, label-mismatch warning) + title badge
 *                + "Implementation guide" dialog. Analysis runs only when you click (saves LLM quota);
 *                cached results show instantly.
 * - PR page    : "Maintainer pick" badge for everyone; toggle for people with triage/write access.
 * - List pages : per-row difficulty chip (from cache) or a ⚡ button to analyze on demand, plus ★ on picks.
 *
 * GitHub is a single-page app and its markup changes, so every anchor has a fallback, every injection is
 * idempotent, and a MutationObserver re-applies it. LLM text is only ever inserted with textContent.
 */
(() => {
  'use strict';
  if (window.__ghxLoaded) return;
  window.__ghxLoaded = true;

  const SETUP_HINT = 'Setup: open chrome://extensions → this extension → "service worker", then run gh.setToken("…") and gh.setLlmKey("gemini", "…") in its console.';
  const LEVEL_CLASS = { Easy: 'ghx-easy', Moderate: 'ghx-moderate', Hard: 'ghx-hard' };
  const SIDEBAR_SELECTORS = ['#partial-discussion-sidebar', '[data-testid="issue-viewer-metadata-pane"]', '.Layout-sidebar'];
  const TITLE_SELECTORS = ['[data-testid="issue-title"]', 'bdi.js-issue-title', '.gh-header-title .js-issue-title', 'h1 bdi'];
  const TITLE_LINK = '[data-hovercard-type],[data-testid*="title"],.markdown-title,.Link--primary';
  const REF_RE = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/;

  /* ───────────────────────── helpers ───────────────────────── */

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: { code: 'NO_BACKGROUND', message: chrome.runtime.lastError.message } });
          else resolve(res || { ok: false, error: { code: 'NO_RESPONSE', message: 'No response from the extension.' } });
        });
      } catch {
        resolve({ ok: false, error: { code: 'CONTEXT_INVALIDATED', message: 'The extension was reloaded. Refresh this page.' } });
      }
    });

  // Tiny DOM builder. Strings become text nodes, never HTML.
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const badge = (level, { small = false, title = '' } = {}) =>
    h('span', { class: `ghx-badge ${LEVEL_CLASS[level] || ''}${small ? ' ghx-sm' : ''}`, title }, level);

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60;
    if (m < 90) return `${Math.round(m)} min ago`;
    const hr = m / 60;
    return hr < 36 ? `${Math.round(hr)} h ago` : `${Math.round(hr / 24)} days ago`;
  }

  function friendly(err = {}) {
    const wait = err.retryAt ? Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000)) : 0;
    const known = {
      NO_TOKEN: 'No GitHub token yet.',
      NO_KEY: 'No LLM API key yet.',
      BAD_CREDENTIALS: 'GitHub rejected your token.',
      RATE_LIMITED: `GitHub rate limit reached${wait ? `, retry in ~${wait}s` : ''}.`,
    }[err.code];
    return { text: known || err.message || 'Something went wrong.', setup: err.code === 'NO_TOKEN' || err.code === 'NO_KEY' };
  }

  const errorBox = (err) => {
    const f = friendly(err);
    return h('p', { class: 'ghx-error' }, f.text, f.setup ? h('span', { class: 'ghx-hint' }, SETUP_HINT) : null);
  };

  const levelTitle = (a) => `${a.difficulty} · confidence ${a.confidence}${a.label_mismatch ? ` · ${a.label_mismatch}` : ''}`;

  /* ───────────────────────── routing ───────────────────────── */

  function parseRoute() {
    const p = location.pathname;
    let m = p.match(REF_RE);
    if (m) return { kind: m[3] === 'pull' ? 'pr' : 'issue', repo: `${m[1]}/${m[2]}`, number: +m[4] };
    m = p.match(/^\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/?$/);
    if (m) return { kind: 'list', repo: `${m[1]}/${m[2]}` };
    if (/^\/(?:issues|pulls)(?:\/.*)?$/.test(p)) return { kind: 'list', repo: '' };
    if (p === '/search' && /^(issues|pullrequests)$/.test(new URLSearchParams(location.search).get('type') || '')) return { kind: 'list', repo: '' };
    return null;
  }

  let state = { key: '', route: null, page: null, list: null };

  function sync() {
    const route = parseRoute();
    const key = route ? [route.kind, route.repo, route.number || ''].join(':') : '';
    if (key !== state.key) {
      document.querySelectorAll('[data-ghx]').forEach((n) => n.remove()); // dialogs included
      state = { key, route, page: null, list: null };
    }
    if (!route) return;
    if (route.kind === 'list') mountList(route);
    else mountDetail(route);
  }

  /* ───────────────────────── issue / PR page ───────────────────────── */

  function mountDetail(route) {
    const page = (state.page ||= { route, status: 'idle', analysis: null, error: null, pick: null, pickError: null, busyPick: false, card: null, started: false });
    if (!page.started) {
      page.started = true;
      startDetail(page);
    }
    const wantCard = route.kind === 'issue' || !!(page.pick && (page.pick.canTriage || page.pick.picked));
    if (!wantCard) {
      page.card?.remove();
    } else {
      if (!page.card) {
        page.card = h('section', { class: 'ghx-card', dataset: { ghx: 'card' } });
        renderCard(page);
      }
      placeCard(page.card);
    }
    ensureTitleBadge(page);
  }

  async function startDetail(page) {
    const { repo, number, kind } = page.route;
    const [peek, pick] = await Promise.all([
      kind === 'issue' ? send({ type: 'ANALYSIS_PEEK', items: [{ repo, number }], full: true }) : null,
      send({ type: 'PICK_STATUS', repo, number }),
    ]);
    if (state.page !== page) return; // navigated away meanwhile
    const cached = peek?.ok ? peek.data[`${repo}#${number}`] : null;
    if (cached) {
      page.analysis = cached;
      page.status = 'done';
    }
    page.pick = pick.ok ? pick.data : { picked: false, canTriage: false, unavailable: true };
    update(page);
  }

  function update(page) {
    if (state.page !== page) return;
    if (page.card) renderCard(page);
    sync();
  }

  async function runAnalysis(page, force = false) {
    page.status = 'loading';
    page.error = null;
    update(page);
    const res = await send({ type: 'ANALYZE_ISSUE', repo: page.route.repo, number: page.route.number, force });
    if (state.page !== page) return;
    if (res.ok) {
      page.analysis = res.data;
      page.status = 'done';
    } else {
      page.status = page.analysis ? 'done' : 'error'; // keep an older analysis visible if a refresh fails
      page.error = res.error;
    }
    update(page);
  }

  async function togglePick(page) {
    if (page.busyPick) return;
    page.busyPick = true;
    page.pickError = null;
    update(page);
    const res = await send({ type: 'PICK_SET', repo: page.route.repo, number: page.route.number, picked: !page.pick.picked });
    if (state.page !== page) return;
    page.busyPick = false;
    if (res.ok) page.pick.picked = res.data.picked;
    else page.pickError = friendly(res.error).text;
    update(page);
  }

  // Sidebar if we can find it, otherwise a floating card that always works.
  function placeCard(card) {
    for (const sel of SIDEBAR_SELECTORS) {
      const side = document.querySelector(sel);
      if (!side) continue;
      if (side.firstElementChild !== card) side.prepend(card);
      if (card.classList.contains('ghx-float')) card.classList.remove('ghx-float');
      return;
    }
    if (!card.classList.contains('ghx-float')) card.classList.add('ghx-float');
    if (card.parentElement !== document.body) document.body.append(card);
  }

  function ensureTitleBadge(page) {
    const level = page.analysis?.difficulty;
    const picked = !!page.pick?.picked;
    const sig = `${level || ''}|${picked}`;
    const wrap = document.querySelector('[data-ghx="titlebadge"]');
    const title = TITLE_SELECTORS.map((s) => document.querySelector(s)).find(Boolean);
    if (!title || (!level && !picked)) {
      wrap?.remove();
      return;
    }
    if (wrap && wrap.dataset.sig === sig && wrap.previousElementSibling === title) return;
    wrap?.remove();
    title.insertAdjacentElement(
      'afterend',
      h('span', { class: 'ghx-titlebadges', dataset: { ghx: 'titlebadge', sig } }, level ? badge(level, { title: levelTitle(page.analysis) }) : null, picked ? h('span', { class: 'ghx-pick' }, '★ Maintainer pick') : null)
    );
  }

  function renderCard(page) {
    const { route, status, analysis: a, error, pick } = page;
    const isIssue = route.kind === 'issue';
    const body = [];

    if (pick?.picked) body.push(h('div', { class: 'ghx-pickbar' }, h('b', {}, '★ Maintainer pick'), ' · aligned with the project’s architectural goals'));

    if (isIssue) {
      if (status === 'loading') {
        body.push(h('div', { class: 'ghx-loading' }, h('span', { class: 'ghx-spinner' }), 'Analyzing… this can take 10–20 s'));
      } else {
        if (error) body.push(errorBox(error));
        if (a) body.push(...resultView(page));
        else
          body.push(
            h('p', { class: 'ghx-text' }, 'Get a true difficulty rating, the languages you need, and a step-by-step plan.'),
            h('button', { class: 'ghx-btn ghx-btn-primary ghx-btn-block', type: 'button', onclick: () => runAnalysis(page) }, error ? 'Try again' : 'Analyze this issue')
          );
      }
    }
    if (pick?.canTriage) body.push(pickToggle(page));

    page.card.replaceChildren(
      h(
        'div',
        { class: 'ghx-head' },
        h('span', { class: 'ghx-title' }, isIssue ? 'Issue Scout' : 'Maintainer pick'),
        isIssue && a ? badge(a.difficulty, { title: levelTitle(a) }) : null,
        h('button', { class: 'ghx-btn ghx-icon ghx-collapse', type: 'button', 'aria-label': 'Collapse', onclick: () => page.card.classList.toggle('ghx-collapsed') }, '–')
      ),
      h('div', { class: 'ghx-body' }, ...body)
    );
  }

  const fact = (label, value) => h('div', { class: 'ghx-fact' }, h('span', {}, label), h('b', {}, value || 'n/a'));

  function resultView(page) {
    const a = page.analysis;
    const eff = a.estimated_effort_days || { min: 0, max: 0 };
    return [
      h('div', { class: 'ghx-chips' }, ...a.languages.map((l, i) => h('span', { class: `ghx-chip${i ? '' : ' ghx-chip-primary'}` }, l)), ...a.frameworks_and_tools.slice(0, 4).map((t) => h('span', { class: 'ghx-chip' }, t))),
      h('p', { class: 'ghx-summary' }, a.summary),
      h('div', { class: 'ghx-facts' }, fact('Confidence', a.confidence), fact('Proposal fit', a.proposal_fit), fact('Effort', eff.max ? `${eff.min}–${eff.max} d` : 'n/a')),
      a.label_mismatch ? h('p', { class: 'ghx-warn' }, '⚠ ', a.label_mismatch) : null,
      a.difficulty_source === 'adjusted' ? h('p', { class: 'ghx-note' }, `Rating adjusted: the model’s own factors point to ${a.derived_difficulty}.`) : null,
      h(
        'div',
        { class: 'ghx-actions' },
        h('button', { class: 'ghx-btn ghx-btn-primary', type: 'button', onclick: () => openGuide(page) }, 'Implementation guide'),
        h('button', { class: 'ghx-btn', type: 'button', title: 'Run the analysis again (uses LLM quota)', onclick: () => runAnalysis(page, true) }, 'Re-analyze')
      ),
      h('p', { class: 'ghx-note' }, `AI-generated · ${a.provider} · ${ago(a.analyzedAt)}`),
    ];
  }

  function pickToggle(page) {
    const on = !!page.pick.picked;
    const label = page.pick.label || 'maintainer-pick';
    return h(
      'div',
      { class: 'ghx-divider' },
      h('button', { class: 'ghx-btn ghx-btn-block', type: 'button', disabled: page.busyPick, onclick: () => togglePick(page) }, page.busyPick ? 'Saving…' : on ? '★ Remove maintainer pick' : '☆ Mark as maintainer pick'),
      h('p', { class: 'ghx-note' }, on ? `Applies the “${label}” label.` : `Adds the “${label}” label so contributors can see this fits the project’s goals.`),
      page.pickError ? h('p', { class: 'ghx-error' }, page.pickError) : null
    );
  }

  function openGuide(page) {
    const a = page.analysis;
    if (!a) return;
    document.querySelector('dialog[data-ghx="dialog"]')?.remove();
    const f = a.difficulty_factors || {};
    const rows = [
      ['Files touched', f.files_touched],
      ['Lines changed', f.lines_changed],
      ['Codebase knowledge needed', f.codebase_knowledge],
      ['Design decisions', f.design_decisions],
      ['Domain complexity', f.domain_complexity],
      ['Tests required', f.tests_required ? 'yes' : 'no'],
    ];
    const list = (items) => h('ul', {}, ...items.map((x) => h('li', {}, x)));
    const dlg = h(
      'dialog',
      { class: 'ghx-dialog', dataset: { ghx: 'dialog' } },
      h('header', { class: 'ghx-dlg-head' }, h('div', {}, h('h2', {}, `#${page.route.number} implementation guide`), badge(a.difficulty, { title: levelTitle(a) })), h('button', { class: 'ghx-btn ghx-icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h(
        'div',
        { class: 'ghx-dlg-body' },
        h('section', {}, h('p', {}, a.summary)),
        h('section', {}, h('h3', {}, 'Why this rating'), h('p', {}, a.difficulty_reasoning), h('table', { class: 'ghx-table' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))), a.label_mismatch ? h('p', { class: 'ghx-warn' }, '⚠ ', a.label_mismatch) : null),
        h(
          'section',
          {},
          h('h3', {}, 'Step-by-step plan'),
          h('ol', { class: 'ghx-steps' }, ...a.implementation_steps.map((s) => h('li', {}, h('div', { class: 'ghx-step-title' }, s.title), h('p', {}, s.details), s.areas.length ? h('div', { class: 'ghx-areas' }, ...s.areas.map((x) => h('code', {}, x))) : null)))
        ),
        a.prerequisites.length ? h('section', {}, h('h3', {}, 'Learn or set up first'), list(a.prerequisites)) : null,
        a.risks_and_unknowns.length ? h('section', {}, h('h3', {}, 'Risks and unknowns'), list(a.risks_and_unknowns)) : null,
        h('p', { class: 'ghx-foot' }, `AI-generated by ${a.provider} (${a.model}), ${ago(a.analyzedAt)}. Verify against the code before committing to a proposal.`)
      )
    );
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close(); // click on the backdrop
    });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  /* ───────────────────────── list pages (rows) ───────────────────────── */

  // Finds issue/PR rows from their title links, so it survives GitHub's markup changes.
  function listRows() {
    const scope = document.querySelector('main, [role="main"], #repo-content-pjax-container') || document.body;
    const best = new Map(); // row element -> best candidate link
    for (const a of scope.querySelectorAll('a[href*="/issues/"], a[href*="/pull/"]')) {
      if (a.closest('[data-ghx]') || !a.textContent.trim()) continue;
      let u;
      try {
        u = new URL(a.href, location.origin);
      } catch {
        continue;
      }
      const m = u.origin === location.origin && !u.hash && u.pathname.match(REF_RE);
      if (!m) continue;
      const row = a.closest('li, .Box-row, [role="listitem"], [role="row"], tr');
      if (!row) continue;
      const score = a.matches(TITLE_LINK) ? 2 : 1;
      const cur = best.get(row);
      if (!cur || score > cur.score) best.set(row, { a, row, score, repo: `${m[1]}/${m[2]}`, number: +m[4], isPr: m[3] === 'pull', key: `${m[1]}/${m[2]}#${m[4]}` });
    }
    return [...best.values()];
  }

  function mountList(route) {
    const ls = (state.list ||= { peeked: new Map(), pending: new Set(), picks: null, picksRequested: false, busy: new Set(), errors: new Map() });
    const rows = listRows();

    if (route.repo && !ls.picksRequested) {
      ls.picksRequested = true;
      send({ type: 'PICKS_LIST', repo: route.repo }).then((r) => {
        if (state.list !== ls) return;
        ls.picks = new Set(r.ok ? r.data.numbers : []);
        sync();
      });
    }

    const unseen = rows.filter((r) => !r.isPr && !ls.peeked.has(r.key) && !ls.pending.has(r.key));
    if (unseen.length) {
      unseen.forEach((r) => ls.pending.add(r.key));
      send({ type: 'ANALYSIS_PEEK', items: unseen.map(({ repo, number }) => ({ repo, number })), full: false }).then((res) => {
        if (state.list !== ls) return;
        for (const r of unseen) {
          ls.pending.delete(r.key);
          ls.peeked.set(r.key, (res.ok && res.data[r.key]) || null);
        }
        sync();
      });
    }
    rows.forEach((r) => decorateRow(ls, r));
  }

  function decorateRow(ls, r) {
    const info = ls.peeked.get(r.key);
    const busy = ls.busy.has(r.key);
    const err = ls.errors.get(r.key);
    const picked = !!(ls.picks && r.repo === state.route.repo && ls.picks.has(r.number));
    const sig = [info?.difficulty || '', picked ? 1 : 0, busy ? 'b' : '', err ? 'e' : '', r.isPr ? 'p' : ''].join('|');

    const old = r.row.querySelector('[data-ghx="row"]');
    if (old && old.dataset.sig === sig) return;
    old?.remove();

    const kids = [];
    if (picked) kids.push(h('span', { class: 'ghx-pick ghx-sm', title: 'Maintainer pick: aligned with the project’s goals' }, '★'));
    if (info) kids.push(badge(info.difficulty, { small: true, title: `${info.difficulty} · confidence ${info.confidence || 'n/a'}${info.label_mismatch ? ' · differs from the repo label' : ''}` }));
    else if (!r.isPr)
      kids.push(
        h(
          'button',
          {
            type: 'button',
            class: `ghx-analyze${busy ? ' ghx-busy' : ''}${err ? ' ghx-failed' : ''}`,
            title: err || 'Analyze true difficulty (uses your LLM quota)',
            disabled: busy,
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              analyzeRow(ls, r);
            },
          },
          busy ? h('span', { class: 'ghx-spinner' }) : err ? '!' : '⚡'
        )
      );
    if (!kids.length) return;
    r.a.insertAdjacentElement('afterend', h('span', { class: 'ghx-rowchips', dataset: { ghx: 'row', sig } }, ...kids));
  }

  async function analyzeRow(ls, r) {
    ls.busy.add(r.key);
    ls.errors.delete(r.key);
    sync();
    const res = await send({ type: 'ANALYZE_ISSUE', repo: r.repo, number: r.number });
    if (state.list !== ls) return;
    ls.busy.delete(r.key);
    if (res.ok) ls.peeked.set(r.key, { difficulty: res.data.difficulty, confidence: res.data.confidence, label_mismatch: !!res.data.label_mismatch });
    else ls.errors.set(r.key, friendly(res.error).text);
    sync();
  }

  /* ───────────────────────── boot ───────────────────────── */

  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(sync, 250);
  };
  new MutationObserver((records) => {
    // ignore changes we made ourselves
    const external = records.some((r) => {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      return !el?.closest?.('[data-ghx]');
    });
    if (external) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });

  ['turbo:load', 'turbo:render', 'pjax:end'].forEach((e) => document.addEventListener(e, schedule));
  window.addEventListener('popstate', schedule);
  window.navigation?.addEventListener?.('navigatesuccess', schedule); // catches React-router pushState navigation
  sync();
})();
