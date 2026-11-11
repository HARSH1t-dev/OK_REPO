/**
 * background.js — Phase 2: GitHub auth + active-issue discovery & filtering
 * Manifest V3 service worker. The worker can be killed at any time, so all
 * durable state lives in chrome.storage (token: local, result cache: session).
 *
 * Message API (chrome.runtime.sendMessage from side panel / options page):
 *   { type: 'AUTH_SET_TOKEN', token }   -> { login }          (extension pages only)
 *   { type: 'AUTH_CLEAR' }              -> {}                 (extension pages only)
 *   { type: 'AUTH_STATUS' }             -> { authenticated, login, rate }
 *   { type: 'FETCH_ISSUES', filters }   -> { issues, meta }
 *   { type: 'ANALYZE_ISSUE', repo, number, force? } -> analysis (difficulty, languages, steps...)
 *   { type: 'LLM_STATUS' }              -> { keys: {gemini, groq}, prefs }
 *   { type: 'LLM_SET_KEY', provider, key } / { type: 'LLM_CLEAR_KEY', provider } / { type: 'LLM_SET_PREFS', prefs }
 *                                       (extension pages only)
 *   { type: 'ANALYSIS_PEEK', items: [{repo, number}], full? } -> { "repo#n": analysis|lite }   (cache only, free)
 *   { type: 'PICK_STATUS', repo, number } -> { picked, canTriage }
 *   { type: 'PICKS_LIST', repo }          -> { numbers: [...] }   (open items carrying the pick label)
 *   { type: 'PICK_SET', repo, number, picked } -> { picked }      (needs triage/write access)
 * Every reply is { ok: true, data } or { ok: false, error: { message, code, retryAt } }.
 */

import { analyzeIssue, getCachedAnalysis, peekAnalyses, assertLlmReady, setLlmKey, clearLlmKey, setLlmPrefs, llmStatus } from './llm.js';

const GH_REST = 'https://api.github.com';
const GH_GRAPHQL = 'https://api.github.com/graphql';
const API_VERSION = '2022-11-28';
const CACHE_TTL_MS = 10 * 60 * 1000;
const ENRICH_BATCH = 10; // issues per GraphQL request
const CLAIM_WINDOW_DAYS = 21;
const MAINTAINER_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const DEFAULT_FILTERS = {
  languages: [], // repo primary language(s), e.g. ['python', 'go']; [] = any
  labels: [], // optional include-labels (OR). [] = do NOT require any label
  excludeLabels: ['duplicate', 'invalid', 'wontfix', 'question', 'stale'],
  searchWindowDays: 90, // coarse GitHub-side "updated" window
  maxIdleDays: 45, // max days since last HUMAN activity (bots ignored)
  minComments: 1,
  minStars: 50,
  maxRepoIdleDays: 30, // repo must have been pushed to within this window
  excludeClaimed: true, // drop issues where someone recently said "I'll take this"
  requireMaintainerReply: false,
  minDepthScore: 35, // 0-100, see scoreDepth()
  perPage: 30, // search candidates per language per page (max 50)
  page: 1,
  maxResults: 20,
};

/* ───────────────────────── helpers ───────────────────────── */

class GhError extends Error {
  constructor(message, { code = 'API_ERROR', status, retryAt } = {}) {
    super(message);
    this.name = 'GhError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daysSince = (iso) => (Date.now() - Date.parse(iso)) / 864e5;
const isoDaysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
const hashStr = (s) => {
  let h = 5381;
  for (const c of s) h = ((h << 5) + h + c.codePointAt(0)) | 0;
  return (h >>> 0).toString(36);
};

/* ───────────────────────── auth ───────────────────────── */

async function getToken() {
  const { ghToken } = await chrome.storage.local.get('ghToken');
  return ghToken || null;
}

async function setToken(raw) {
  const token = String(raw || '').trim();
  if (token.length < 20 || /\s/.test(token)) {
    throw new GhError('That does not look like a GitHub token.', { code: 'BAD_TOKEN_FORMAT' });
  }
  const user = await ghFetch(`${GH_REST}/user`, { token }); // throws BAD_CREDENTIALS on 401
  await chrome.storage.local.set({ ghToken: token, ghLogin: user.login });
  return { login: user.login };
}

async function clearToken() {
  await chrome.storage.local.remove(['ghToken', 'ghLogin']);
  await chrome.storage.session.remove('cache');
  return {};
}

async function authStatus() {
  const [token, { ghLogin }] = await Promise.all([getToken(), chrome.storage.local.get('ghLogin')]);
  return { authenticated: !!token, login: ghLogin || null, rate: lastRate };
}

/* ───────────────────────── GitHub fetch wrapper ───────────────────────── */

const lastRate = {}; // in-memory, per resource: { limit, remaining, resetAt }

async function ghFetch(url, { method = 'GET', body, token, retries = 2 } = {}) {
  token = token || (await getToken());
  if (!token) throw new GhError('Not authenticated. Add a GitHub token first.', { code: 'NO_TOKEN' });

  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const h = res.headers;
  const resource = h.get('x-ratelimit-resource');
  if (resource) {
    lastRate[resource] = {
      limit: +h.get('x-ratelimit-limit'),
      remaining: +h.get('x-ratelimit-remaining'),
      resetAt: +h.get('x-ratelimit-reset') * 1000,
    };
  }

  if (res.ok) return res.json();

  // Primary (remaining=0) and secondary (retry-after) rate limits
  const retryAfter = +h.get('retry-after') || 0;
  const limited = (res.status === 403 || res.status === 429) && (retryAfter || h.get('x-ratelimit-remaining') === '0');
  if (limited) {
    const waitMs = retryAfter ? retryAfter * 1000 : Math.max(0, +h.get('x-ratelimit-reset') * 1000 - Date.now()) + 1000;
    if (retries > 0 && waitMs <= 15000) {
      await sleep(waitMs);
      return ghFetch(url, { method, body, token, retries: retries - 1 });
    }
    throw new GhError(`GitHub rate limit reached. Retry in ~${Math.ceil(waitMs / 1000)}s.`, {
      code: 'RATE_LIMITED',
      status: res.status,
      retryAt: Date.now() + waitMs,
    });
  }
  if (res.status === 401) {
    throw new GhError('GitHub rejected the token (invalid, expired or revoked).', { code: 'BAD_CREDENTIALS', status: 401 });
  }
  const detail = await res.json().catch(() => ({}));
  throw new GhError(detail.message || `GitHub API error (${res.status})`, { status: res.status });
}

/* ───────────────────────── session cache ───────────────────────── */

async function cacheGet(key) {
  const { cache = {} } = await chrome.storage.session.get('cache');
  const hit = cache[key];
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : null;
}

async function cachePut(key, value) {
  const { cache = {} } = await chrome.storage.session.get('cache');
  const fresh = Object.fromEntries(Object.entries(cache).filter(([, v]) => Date.now() - v.at < CACHE_TTL_MS));
  fresh[key] = { at: Date.now(), value };
  await chrome.storage.session.set({ cache: fresh });
}

/* ───────────────────────── pass 1: search (cheap, coarse) ───────────────────────── */

function normalizeFilters(input = {}) {
  const f = { ...DEFAULT_FILTERS, ...input };
  const list = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).replace(/"/g, '').trim()).filter(Boolean);
  const clamp = (v, min, max, d) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : d);
  f.languages = list(f.languages);
  f.labels = list(f.labels);
  f.excludeLabels = list(f.excludeLabels).map((s) => s.toLowerCase());
  f.perPage = clamp(f.perPage, 1, 50, 30);
  f.page = clamp(f.page, 1, 20, 1);
  f.maxResults = clamp(f.maxResults, 1, 100, 20);
  return f;
}

// Search query is capped at 256 chars, so exclude-labels are filtered client-side instead.
function buildQuery(f, language) {
  const q = ['is:issue', 'is:open', 'is:public', 'archived:false', 'no:assignee', '-linked:pr', `updated:>=${isoDaysAgo(f.searchWindowDays)}`];
  if (f.minComments > 0) q.push(`comments:>=${f.minComments}`);
  if (language) q.push(`language:${quote(language)}`);
  if (f.labels.length) q.push(`label:${f.labels.map(quote).join(',')}`);
  return q.join(' ');
}

async function searchCandidates(f) {
  const byId = new Map();
  for (const language of f.languages.length ? f.languages : [null]) {
    const params = new URLSearchParams({
      q: buildQuery(f, language),
      sort: 'updated',
      order: 'desc',
      per_page: String(f.perPage),
      page: String(f.page),
    });
    const data = await ghFetch(`${GH_REST}/search/issues?${params}`);
    for (const it of data.items || []) byId.set(it.id, it); // dedupe across languages
  }
  return [...byId.values()];
}

/* ───────────────────────── pass 2: GraphQL enrichment (batched) ───────────────────────── */

const repoOf = (item) => item.repository_url.replace(`${GH_REST}/repos/`, ''); // "owner/name"

function buildEnrichQuery(items) {
  const blocks = items.map((it, i) => {
    const [owner, name] = repoOf(it).split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      ...RepoFields
      issue(number: ${it.number}) {
        comments(last: 12) { nodes { createdAt body authorAssociation author { __typename login } } }
        timelineItems(first: 30, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
          nodes {
            __typename
            ... on CrossReferencedEvent { source { __typename ... on PullRequest { state } } }
            ... on ConnectedEvent { subject { __typename ... on PullRequest { state } } }
          }
        }
      }
    }`;
  });
  return `fragment RepoFields on Repository {
    stargazerCount pushedAt isArchived
    languages(first: 5, orderBy: {field: SIZE, direction: DESC}) { nodes { name } }
  }
  query { ${blocks.join('\n')} }`;
}

async function enrich(items) {
  const out = [];
  for (let i = 0; i < items.length; i += ENRICH_BATCH) {
    const batch = items.slice(i, i + ENRICH_BATCH);
    const res = await ghFetch(GH_GRAPHQL, { method: 'POST', body: { query: buildEnrichQuery(batch) } });
    if (!res.data) throw new GhError(res.errors?.[0]?.message || 'GraphQL request failed.');
    batch.forEach((item, j) => {
      const repo = res.data[`r${j}`]; // null if repo was renamed/removed -> skipped
      if (repo?.issue) out.push({ item, repo, issue: repo.issue });
    });
  }
  return out;
}

/* ───────────────────────── pass 3: filters + depth score ───────────────────────── */

const CLAIM_RE = /\b(?:can i (?:work on|take|pick|try|have)|i['’]?m (?:working on|on it)|i['’]?(?:d| would) (?:like|love) to (?:work on|take|pick|tackle)|i['’]?ll (?:take|work on|pick|submit|open)|assign (?:it |this )?to me|(?:working on|taking) (?:this|it))\b/i;
const TRIVIAL_TITLE_RE = /\b(typos?|spelling|misspell\w*|grammar|punctuation|whitespace|broken link|dead link|capitali[sz]\w*|readme|rename (?:a |the )?variable|bump version|add (?:a )?comment)\b/i;
const TRIVIAL_BODY_RE = /\b(one[- ]?line|single line|1[- ]line|trivial|simple fix|quick fix)\b/i;
const PATH_RE = /(?<![\w:/.-])(?:[\w.-]+\/)+[\w.-]+\.(?:js|jsx|ts|tsx|mjs|py|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|scala|vue|svelte|ya?ml|toml|json|proto|sql)\b/gi;
const SUBSTANTIVE_LABEL_RE = /^(enhancement|feature|feature request|refactor|performance|design|proposal|rfc|security|help wanted|gsoc|lfx|mentorship|bug)$/i;

// Heuristic "is this worth a mentorship-grade proposal?" score, 0-100, with explanations.
function scoreDepth(item, { maintainerReplied, maintainerAuthored }) {
  const body = item.body || '';
  const notes = [];
  let score = 0;
  const add = (pts, why) => {
    if (!pts) return;
    score += pts;
    notes.push(`${pts > 0 ? '+' : ''}${pts} ${why}`);
  };

  const len = body.replace(/\s+/g, ' ').trim().length;
  add(len >= 1200 ? 20 : len >= 500 ? 14 : len >= 200 ? 8 : 0, `description length (${len} chars)`);

  const codeBlocks = Math.floor((body.match(/```/g) || []).length / 2);
  add(Math.min(10, codeBlocks * 5), `${codeBlocks} code block(s) / stack trace`);

  const files = [...new Set((body.match(PATH_RE) || []).map((p) => p.toLowerCase()))];
  add(Math.min(15, files.length * 5), `${files.length} source path(s) referenced`);

  add(Math.min(15, item.comments * 3), `${item.comments} comment(s)`);
  add(maintainerReplied ? 15 : 0, 'maintainer replied');
  add(maintainerAuthored ? 10 : 0, 'filed by a maintainer');
  if (item.labels.some((l) => SUBSTANTIVE_LABEL_RE.test(l.name))) add(5, 'substantive label');

  if (TRIVIAL_TITLE_RE.test(item.title)) add(-35, 'title looks like a trivial fix');
  if (TRIVIAL_BODY_RE.test(body.slice(0, 1500))) add(-15, 'described as trivial / one-line');
  if (item.labels.some((l) => /^(docs?|documentation)$/i.test(l.name))) add(-15, 'docs-only label');

  return { score: Math.max(0, Math.min(100, score)), notes, files, codeBlocks };
}

// Returns { pass: false, why } or { pass: true, issue }
function evaluate({ item, repo, issue }, f) {
  const isBot = (a) => !a || a.__typename === 'Bot' || /\[bot\]$/i.test(a.login);
  const labelNames = item.labels.map((l) => l.name);

  if (labelNames.some((n) => f.excludeLabels.includes(n.toLowerCase()))) return { pass: false, why: 'excluded_label' };
  if (repo.isArchived) return { pass: false, why: 'archived' };
  if (repo.stargazerCount < f.minStars) return { pass: false, why: 'few_stars' };
  if (daysSince(repo.pushedAt) > f.maxRepoIdleDays) return { pass: false, why: 'repo_inactive' };

  const hasOpenPR = (issue.timelineItems.nodes || []).some(
    (n) => (n.source?.__typename === 'PullRequest' && n.source.state === 'OPEN') || (n.subject?.__typename === 'PullRequest' && n.subject.state === 'OPEN')
  );
  if (hasOpenPR) return { pass: false, why: 'has_open_pr' };

  const human = (issue.comments.nodes || []).filter((c) => !isBot(c.author)); // chronological
  const lastHumanAt = human.length ? human[human.length - 1].createdAt : item.created_at;
  const idleDays = daysSince(lastHumanAt);
  if (idleDays > f.maxIdleDays) return { pass: false, why: 'stale' };

  const claimed = human.some(
    (c) => !MAINTAINER_ROLES.has(c.authorAssociation) && daysSince(c.createdAt) <= CLAIM_WINDOW_DAYS && CLAIM_RE.test((c.body || '').slice(0, 400))
  );
  if (f.excludeClaimed && claimed) return { pass: false, why: 'claimed' };

  const maintainerReplied = human.some((c) => MAINTAINER_ROLES.has(c.authorAssociation));
  const maintainerAuthored = MAINTAINER_ROLES.has(item.author_association);
  if (f.requireMaintainerReply && !maintainerReplied) return { pass: false, why: 'no_maintainer_reply' };

  const depth = scoreDepth(item, { maintainerReplied, maintainerAuthored });
  if (depth.score < f.minDepthScore) return { pass: false, why: 'too_shallow' };

  return {
    pass: true,
    issue: {
      id: item.id,
      number: item.number,
      repo: repoOf(item),
      title: item.title,
      url: item.html_url,
      author: item.user?.login || null,
      labels: labelNames,
      comments: item.comments,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      body: (item.body || '').slice(0, 6000), // kept for Phase 3 (LLM analysis)
      repoInfo: {
        stars: repo.stargazerCount,
        pushedAt: repo.pushedAt,
        languages: (repo.languages?.nodes || []).map((n) => n.name),
      },
      signals: {
        idleDays: Math.round(idleDays),
        maintainerReplied,
        maintainerAuthored,
        possiblyClaimed: claimed,
        fileRefs: depth.files,
        codeBlocks: depth.codeBlocks,
        depthScore: depth.score,
        depthNotes: depth.notes,
      },
    },
  };
}

/* ───────────────────────── orchestrator ───────────────────────── */

async function fetchActiveIssues(userFilters = {}) {
  const { forceRefresh, ...rest } = userFilters;
  const f = normalizeFilters(rest);
  const key = `issues:${hashStr(JSON.stringify(f))}`;

  if (!forceRefresh) {
    const hit = await cacheGet(key);
    if (hit) return { ...hit, meta: { ...hit.meta, cached: true } };
  }

  const candidates = (await searchCandidates(f)).filter((it) => !it.pull_request && !it.locked);
  const enriched = await enrich(candidates);

  const rejected = {};
  const passed = [];
  for (const e of enriched) {
    const r = evaluate(e, f);
    if (r.pass) passed.push(r.issue);
    else rejected[r.why] = (rejected[r.why] || 0) + 1;
  }

  passed.sort((a, b) => b.signals.depthScore - a.signals.depthScore || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const result = {
    issues: passed.slice(0, f.maxResults),
    meta: { candidates: candidates.length, enriched: enriched.length, passed: passed.length, rejected, cached: false, fetchedAt: Date.now(), rate: lastRate },
  };
  await cachePut(key, result);
  return result;
}

/* ───────────────────────── Phase 3: LLM analysis ───────────────────────── */

// Human comments only, oldest → newest. prompt.js decides which ones reach the model.
async function getIssueComments(repo, number) {
  const raw = await ghFetch(`${GH_REST}/repos/${repo}/issues/${number}/comments?per_page=100`);
  return raw
    .filter((c) => c.user && c.user.type !== 'Bot' && !/\[bot\]$/i.test(c.user.login))
    .map((c) => ({ role: c.author_association, createdAt: c.created_at, body: c.body || '' }));
}

// Works for any issue (from a search result or the page the user is browsing): only repo + number are trusted input.
async function analyze({ repo, number, force = false }) {
  number = assertRef(repo, number);
  await assertLlmReady(); // fail fast before spending GitHub requests

  const raw = await ghFetch(`${GH_REST}/repos/${repo}/issues/${number}`);
  if (raw.pull_request) throw new GhError('Pull requests are not supported yet. Open an issue.', { code: 'UNSUPPORTED' });

  const cacheKey = `${repo}#${number}`;
  if (!force) {
    const hit = await getCachedAnalysis(cacheKey, raw.updated_at);
    if (hit) return { ...hit, cached: true };
  }

  const [comments, langs] = await Promise.all([getIssueComments(repo, number), ghFetch(`${GH_REST}/repos/${repo}/languages`).catch(() => ({}))]);
  return analyzeIssue({
    repo,
    number,
    title: raw.title,
    url: raw.html_url,
    labels: (raw.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    body: raw.body || '',
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentsCount: raw.comments,
    repoLanguages: Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name),
    comments,
  });
}

/* ───────────────────────── Phase 4: maintainer picks + UI lookups ───────────────────────── */

// A "pick" is just a GitHub label, so it is visible to everyone on github.com, with or without this extension.
const PICK_LABEL = { name: 'maintainer-pick', color: 'FBCA04', description: "Maintainer-endorsed: aligns with the project's architectural goals" };
const permCache = new Map(); // repo -> { at, value }

// owner: alphanumeric/hyphen/underscore; repo: word chars, dots, hyphens but never "." or ".." (no path traversal)
const REPO_RE = /^[A-Za-z0-9][\w-]{0,38}\/(?!\.{1,2}$)[\w.-]{1,100}$/;
function assertRepo(repo) {
  if (!REPO_RE.test(String(repo))) throw new GhError('Invalid repository.', { code: 'BAD_INPUT' });
}
function assertRef(repo, number) {
  assertRepo(repo);
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) throw new GhError('Invalid issue reference.', { code: 'BAD_INPUT' });
  return n;
}

async function canTriage(repo) {
  const hit = permCache.get(repo);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const r = await ghFetch(`${GH_REST}/repos/${repo}`);
  const p = r.permissions || {}; // the signed-in user's role on this repo
  const value = !!(p.admin || p.maintain || p.push || p.triage);
  permCache.set(repo, { at: Date.now(), value });
  return value;
}

const hasPickLabel = (labels = []) => labels.some((l) => (typeof l === 'string' ? l : l.name || '').toLowerCase() === PICK_LABEL.name);

async function pickStatus({ repo, number }) {
  number = assertRef(repo, number);
  const [issue, maintainer] = await Promise.all([ghFetch(`${GH_REST}/repos/${repo}/issues/${number}`), canTriage(repo)]);
  return { picked: hasPickLabel(issue.labels), canTriage: maintainer, label: PICK_LABEL.name };
}

// One request returns every open pick in the repo, so list pages can badge rows without N lookups.
async function picksList({ repo }) {
  assertRepo(repo);
  const items = await ghFetch(`${GH_REST}/repos/${repo}/issues?labels=${encodeURIComponent(PICK_LABEL.name)}&state=open&per_page=100`);
  return { numbers: items.map((i) => i.number), label: PICK_LABEL.name };
}

async function setPick({ repo, number, picked }) {
  number = assertRef(repo, number);
  if (!(await canTriage(repo))) {
    throw new GhError('Marking picks needs triage or write access on this repository.', { code: 'FORBIDDEN' });
  }
  const base = `${GH_REST}/repos/${repo}`;
  try {
    if (picked) {
      await ghFetch(`${base}/labels`, { method: 'POST', body: PICK_LABEL }).catch(() => {}); // already exists / not allowed: fine
      await ghFetch(`${base}/issues/${number}/labels`, { method: 'POST', body: { labels: [PICK_LABEL.name] } });
    } else {
      await ghFetch(`${base}/issues/${number}/labels/${encodeURIComponent(PICK_LABEL.name)}`, { method: 'DELETE' }).catch((e) => {
        if (e.status !== 404) throw e; // label was not on the item: already the desired state
      });
    }
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      throw new GhError('GitHub refused the change. Your token needs write access to issues on this repository (fine-grained tokens must include it).', { code: 'FORBIDDEN', status: e.status });
    }
    throw e;
  }
  return { picked: !!picked };
}

async function peek({ items = [], full = false }) {
  const keys = (Array.isArray(items) ? items : [])
    .filter((i) => REPO_RE.test(String(i?.repo)) && Number.isInteger(+i?.number) && +i.number > 0)
    .map((i) => `${i.repo}#${+i.number}`);
  return peekAnalyses(keys, !!full);
}

/* ───────────────────────── messaging ───────────────────────── */

const HANDLERS = {
  AUTH_SET_TOKEN: (m) => setToken(m.token),
  AUTH_CLEAR: () => clearToken(),
  AUTH_STATUS: () => authStatus(),
  FETCH_ISSUES: (m) => fetchActiveIssues(m.filters),
  ANALYZE_ISSUE: (m) => analyze(m),
  LLM_STATUS: () => llmStatus(),
  LLM_SET_KEY: (m) => setLlmKey(m.provider, m.key),
  LLM_CLEAR_KEY: (m) => clearLlmKey(m.provider),
  LLM_SET_PREFS: (m) => setLlmPrefs(m.prefs),
  ANALYSIS_PEEK: (m) => peek(m),
  PICK_STATUS: (m) => pickStatus(m),
  PICKS_LIST: (m) => picksList(m),
  PICK_SET: (m) => setPick(m),
};
// never callable from content scripts
const PRIVILEGED = new Set(['AUTH_SET_TOKEN', 'AUTH_CLEAR', 'LLM_SET_KEY', 'LLM_CLEAR_KEY', 'LLM_SET_PREFS']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;

  const fromExtensionPage = !!sender.url?.startsWith(chrome.runtime.getURL(''));
  if (PRIVILEGED.has(msg.type) && !fromExtensionPage) {
    sendResponse({ ok: false, error: { message: 'Not allowed from this context.', code: 'FORBIDDEN' } });
    return false;
  }

  (async () => handler(msg))()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: { message: err.message, code: err.code || 'UNKNOWN', retryAt: err.retryAt } }));
  return true; // keep the channel open for the async reply
});

// Dev helper for testing from the service worker DevTools console (remove before publishing).
self.gh = { setToken, clearToken, authStatus, fetchActiveIssues, analyze, setLlmKey, setLlmPrefs, llmStatus };
