/**
 * llm.js — Phase 3: prompt → provider (with failover) → validated JSON → final difficulty.
 * Imported by background.js. No GitHub calls here; the caller supplies the issue context.
 * Keys live in chrome.storage.local and are never returned by any message.
 */
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, buildUserPrompt } from './prompt.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Model names change often: both are overridable via setLlmPrefs(). "-latest" tracks Google's current Flash.
const DEFAULT_PREFS = { order: ['gemini', 'groq'], geminiModel: 'gemini-flash-latest', groqModel: 'llama-3.3-70b-versatile' };
const ANALYSIS_TTL_MS = 7 * 864e5;
const MAX_CACHED = 150;

const LEVELS = ['Easy', 'Moderate', 'Hard'];
const ENUMS = {
  files: ['1-2', '3-8', '9-20', '20+'],
  lines: ['<50', '50-300', '300-1000', '1000+'],
  knowledge: ['low', 'medium', 'high'],
  design: ['none', 'minor', 'significant'],
  domain: ['low', 'medium', 'high'],
  rating: ['Low', 'Medium', 'High'],
};

export class LlmError extends Error {
  constructor(message, code = 'LLM_ERROR') {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

/* ───────────────────────── keys & prefs ───────────────────────── */

async function getKeys() {
  const { llmKeys = {} } = await chrome.storage.local.get('llmKeys');
  return llmKeys;
}

async function getPrefs() {
  const { llmPrefs = {} } = await chrome.storage.local.get('llmPrefs');
  return { ...DEFAULT_PREFS, ...llmPrefs };
}

export async function llmStatus() {
  const [keys, prefs] = await Promise.all([getKeys(), getPrefs()]);
  return { keys: { gemini: !!keys.gemini, groq: !!keys.groq }, prefs };
}

export async function setLlmKey(provider, key) {
  if (!PROVIDERS[provider]) throw new LlmError('Unknown provider.', 'BAD_INPUT');
  key = String(key || '').trim();
  if (key.length < 20 || /\s/.test(key)) throw new LlmError('That does not look like an API key.', 'BAD_KEY_FORMAT');
  await chrome.storage.local.set({ llmKeys: { ...(await getKeys()), [provider]: key } });
  return llmStatus();
}

export async function clearLlmKey(provider) {
  const keys = await getKeys();
  delete keys[provider];
  await chrome.storage.local.set({ llmKeys: keys });
  return llmStatus();
}

export async function setLlmPrefs(p = {}) {
  const next = await getPrefs();
  if (Array.isArray(p.order)) {
    const order = [...new Set(p.order.filter((x) => PROVIDERS[x]))];
    if (order.length) next.order = order;
  }
  for (const k of ['geminiModel', 'groqModel']) {
    if (typeof p[k] === 'string' && /^[\w./:-]{3,80}$/.test(p[k])) next[k] = p[k];
  }
  await chrome.storage.local.set({ llmPrefs: next });
  return llmStatus();
}

export async function assertLlmReady() {
  const { keys } = await llmStatus();
  if (!keys.gemini && !keys.groq) throw new LlmError('No LLM API key configured. Add a Gemini or Groq key first.', 'NO_KEY');
}

/* ───────────────────────── providers ───────────────────────── */

function httpError(provider, res, detail) {
  const code =
    res.status === 429 ? 'RATE_LIMITED' : res.status === 401 || res.status === 403 ? 'BAD_KEY' : res.status === 404 ? 'BAD_MODEL' : res.status >= 500 ? 'PROVIDER_DOWN' : 'API_ERROR';
  const hint = code === 'BAD_MODEL' ? ' (check the model name with setLlmPrefs)' : '';
  return new LlmError(`${provider} ${res.status}: ${String(detail || res.statusText).slice(0, 200)}${hint}`, code);
}

async function callGemini({ key, model, system, user }) {
  const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 6000, responseMimeType: 'application/json', responseJsonSchema: RESPONSE_SCHEMA },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError('gemini', res, data.error?.message);
  if (data.promptFeedback?.blockReason) throw new LlmError(`gemini blocked the prompt (${data.promptFeedback.blockReason}).`, 'BLOCKED');
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new LlmError(`gemini returned no text (finishReason: ${cand?.finishReason || 'unknown'}).`, 'EMPTY');
  return text;
}

// Groq: JSON mode works on every model (strict json_schema only on some), so we use json_object
// and rely on the format block in the prompt + validateAnalysis(). JSON mode requires the word "JSON" in the prompt.
async function callGroq({ key, model, system, user }) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError('groq', res, data.error?.message);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new LlmError(`groq returned no text (finish_reason: ${data.choices?.[0]?.finish_reason || 'unknown'}).`, 'EMPTY');
  return text;
}

const PROVIDERS = { gemini: callGemini, groq: callGroq };

/* ───────────────────────── parse, validate, reconcile ───────────────────────── */

export function parseJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new SyntaxError('No JSON object found in model output.');
  }
}

// Model output is untrusted: coerce to the schema, clamp lengths, drop anything unexpected.
const str = (v, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const strList = (v, maxItems, max = 120) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, maxItems);
const pick = (v, allowed, fallback) => allowed.find((a) => String(v).toLowerCase() === a.toLowerCase()) ?? fallback;

// Deterministic second opinion built only from the model's own factors (0-12 points).
export function deriveDifficulty(f) {
  const i = (list, v) => Math.max(0, list.indexOf(v));
  const score = i(ENUMS.files, f.files_touched) + i(ENUMS.lines, f.lines_changed) + i(ENUMS.knowledge, f.codebase_knowledge) + i(ENUMS.design, f.design_decisions) + i(ENUMS.domain, f.domain_complexity);
  return score <= 3 ? 'Easy' : score <= 7 ? 'Moderate' : 'Hard';
}

// Keep the model's tag unless it contradicts its own factors by two levels (Easy vs Hard).
function reconcile(modelLevel, derived) {
  if (!modelLevel) return { level: derived, source: 'derived' };
  const gap = Math.abs(LEVELS.indexOf(modelLevel) - LEVELS.indexOf(derived));
  return gap >= 2 ? { level: 'Moderate', source: 'adjusted' } : { level: modelLevel, source: 'model' };
}

export function validateAnalysis(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LlmError('Model output was not a JSON object.', 'BAD_OUTPUT');

  const steps = (Array.isArray(raw.implementation_steps) ? raw.implementation_steps : [])
    .slice(0, 10)
    .map((s) => ({ title: str(s?.title, 100), details: str(s?.details, 400), areas: strList(s?.areas, 3) }))
    .filter((s) => s.title && s.details);
  if (steps.length < 2) throw new LlmError('Model returned no usable implementation steps.', 'BAD_OUTPUT');

  const fx = raw.difficulty_factors || {};
  const factors = {
    files_touched: pick(fx.files_touched, ENUMS.files, '3-8'),
    lines_changed: pick(fx.lines_changed, ENUMS.lines, '50-300'),
    codebase_knowledge: pick(fx.codebase_knowledge, ENUMS.knowledge, 'medium'),
    design_decisions: pick(fx.design_decisions, ENUMS.design, 'minor'),
    domain_complexity: pick(fx.domain_complexity, ENUMS.domain, 'medium'),
    tests_required: fx.tests_required !== false,
  };
  const derived = deriveDifficulty(factors);
  const { level, source } = reconcile(pick(raw.difficulty, LEVELS, null), derived);

  const num = (v, d) => (Number.isFinite(+v) ? Math.min(90, Math.max(0, Math.round(+v * 10) / 10)) : d);
  let min = num(raw.estimated_effort_days?.min, 0);
  let max = num(raw.estimated_effort_days?.max, min);
  if (min > max) [min, max] = [max, min];

  return {
    difficulty: level,
    difficulty_source: source, // 'model' | 'derived' | 'adjusted'
    derived_difficulty: derived,
    difficulty_reasoning: str(raw.difficulty_reasoning),
    difficulty_factors: factors,
    label_mismatch: str(raw.label_mismatch),
    summary: str(raw.summary),
    languages: strList(raw.languages, 4, 40),
    frameworks_and_tools: strList(raw.frameworks_and_tools, 6, 60),
    prerequisites: strList(raw.prerequisites, 4),
    implementation_steps: steps,
    risks_and_unknowns: strList(raw.risks_and_unknowns, 4),
    estimated_effort_days: { min, max },
    proposal_fit: pick(raw.proposal_fit, ENUMS.rating, 'Medium'),
    confidence: pick(raw.confidence, ENUMS.rating, 'Low'),
  };
}

/* ───────────────────────── analysis cache (persistent) ───────────────────────── */

export async function getCachedAnalysis(key, issueUpdatedAt) {
  const { analysisCache = {} } = await chrome.storage.local.get('analysisCache');
  const hit = analysisCache[key];
  return hit && hit.issueUpdatedAt === issueUpdatedAt && Date.now() - hit.analyzedAt < ANALYSIS_TTL_MS ? hit : null;
}

// Cheap lookup for the UI: cached analyses only (may be slightly stale), no network, no LLM quota.
export async function peekAnalyses(keys, full = false) {
  const { analysisCache = {} } = await chrome.storage.local.get('analysisCache');
  const out = {};
  for (const k of keys.slice(0, 100)) {
    const a = analysisCache[k];
    if (!a || Date.now() - a.analyzedAt > ANALYSIS_TTL_MS) continue;
    out[k] = full ? a : { difficulty: a.difficulty, confidence: a.confidence, label_mismatch: !!a.label_mismatch };
  }
  return out;
}

async function putCachedAnalysis(key, value) {
  const { analysisCache = {} } = await chrome.storage.local.get('analysisCache');
  analysisCache[key] = value;
  const keep = Object.entries(analysisCache).sort((a, b) => b[1].analyzedAt - a[1].analyzedAt).slice(0, MAX_CACHED);
  await chrome.storage.local.set({ analysisCache: Object.fromEntries(keep) });
}

/* ───────────────────────── main entry ───────────────────────── */

// ctx: see buildUserPrompt() in prompt.js (+ updatedAt for cache invalidation).
export async function analyzeIssue(ctx) {
  const [keys, prefs] = await Promise.all([getKeys(), getPrefs()]);
  const providers = prefs.order.filter((p) => keys[p]);
  if (!providers.length) throw new LlmError('No LLM API key configured. Add a Gemini or Groq key first.', 'NO_KEY');

  const user = buildUserPrompt(ctx);
  const errors = [];
  for (const provider of providers) {
    const model = prefs[`${provider}Model`];
    try {
      const text = await PROVIDERS[provider]({ key: keys[provider], model, system: SYSTEM_PROMPT, user });
      const analysis = {
        ...validateAnalysis(parseJson(text)),
        provider,
        model,
        analyzedAt: Date.now(),
        issueUpdatedAt: ctx.updatedAt,
      };
      await putCachedAnalysis(`${ctx.repo}#${ctx.number}`, analysis);
      return { ...analysis, cached: false };
    } catch (e) {
      errors.push(`${provider}: ${e.message}`); // fall through to the next provider
    }
  }
  throw new LlmError(`All providers failed. ${errors.join(' | ')}`, 'ALL_FAILED');
}
