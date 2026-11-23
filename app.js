/* Contest Atlas — prototype (pure front end, data straight from codeforces.com/api)
 *
 * Scatter follows the current plots/plot_problem.py: one marker per submission,
 * r = 5.2, green = accepted / red = not accepted, shape = verdict, overlap counts
 * in the tooltip, marginal histograms and TL/ML lines.
 *
 * Statistics follows plots/charts.py: the same eight charts, computed in the browser.
 *
 * Everything is fetched by the visitor's own browser and cached as a compact point
 * list plus a compact submission list in IndexedDB, so a second visit needs no network.
 */
'use strict';

const API = 'https://codeforces.com/api/';
const RATE_GAP = 2060;
const SEEK_STEP = 10000;      // gallop stride, and how precisely we pin the block
const FETCH_CAP = 300000;     // one request grabs everything from there to the end
const SEEK_LIMIT = 4000000;   // give up galloping past any conceivable contest

/* --- geometry of the scatter, copied from plot_problem.draw_html ------------- */
const UW = 1180, UH = 700;
const PAD_L = 78, STRIP = 54, GAP = 10, LEG = 196;
const MR = STRIP + GAP + LEG + 10;
const MT = 20 + STRIP + GAP;
const MBOT = 64;
const X1 = UW - MR;
const PLOT_H = UH - MT - MBOT;
const R = 5.2;
const MARGIN_BINS = 34;

const OK_C = '#1f9d55', BAD_C = '#d94a4a';
const VERDICT = {
  WRONG_ANSWER: ['WA', 'circle'],
  TIME_LIMIT_EXCEEDED: ['TL', 'triangle'],
  MEMORY_LIMIT_EXCEEDED: ['ML', 'square'],
  RUNTIME_ERROR: ['RE', 'diamond'],
  COMPILATION_ERROR: ['CE', 'cross'],
  IDLENESS_LIMIT_EXCEEDED: ['IL', 'circle'],
  SKIPPED: ['SK', 'circle'],
  FAILED: ['??', 'circle']
};
const MARK_ORDER = [['WA', 'circle'], ['TL', 'triangle'], ['ML', 'square'],
                    ['RE', 'diamond'], ['CE', 'cross']];

/* --- palette, copied from charts.py ---------------------------------------- */
const PALETTE = ['#2563eb', '#e0533d', '#1f9d55', '#8e5cd9', '#d99a00',
                 '#0aa2a2', '#9b2c8f', '#6b7280', '#b45309'];
const VCOL = { AC: '#1f9d55', WA: '#d94a4a', TL: '#f0a020', ML: '#8e5cd9',
               RE: '#8b6b3f', CE: '#9aa0a6', other: '#c9ced6' };
const VORDER = ['AC', 'WA', 'TL', 'ML', 'RE', 'CE', 'other'];
const ATTEMPT_COLORS = ['#1f9d55', '#4c9f70', '#77a24a', '#a3a03c', '#cd9a34',
                        '#e08a3c', '#e06a4a', '#d94a4a', '#b03a5b'];

const FONT11 = '11px -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif';
const FONT12 = '12px -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtInt = v => Math.round(v).toLocaleString('en-US');

/* --------------------------------------------------------------- progress UI */
const WEIGHT = { standings: .06, subs: .70, rating: .10, draw: .14 };
const ORDER = ['standings', 'subs', 'rating', 'draw'];
const BOUND = {};
{ let acc = 0; for (const k of ORDER) { BOUND[k] = [acc, acc + WEIGHT[k]]; acc += WEIGHT[k]; } }

const P = {
  box: $('prog'), fill: $('fill'), pct: $('pct'), msg: $('msg'), bytes: $('bytes'), items: {},
  reset() {
    this.box.hidden = false; this.items = {};
    for (const li of document.querySelectorAll('#phases li')) {
      li.className = ''; this.items[li.dataset.k] = li;
    }
    this.bytes.textContent = ''; this.setFrac(0, 'Preparing…');
  },
  phase(k) {
    let seen = false;
    for (const key of ORDER) {
      const li = this.items[key];
      if (key === k) { li.className = 'on'; seen = true; } else if (!seen) li.className = 'done';
    }
  },
  allDone() { for (const li of Object.values(this.items)) li.className = 'done'; },
  setFrac(f, msg) {
    f = clamp(f, 0, 1);
    this.fill.style.width = (f * 100).toFixed(2) + '%';
    this.pct.textContent = Math.round(f * 100) + '%';
    if (msg != null) this.msg.textContent = msg;
  },
  within(k, t, msg) {
    const [a, b] = BOUND[k];
    this.setFrac(a + (b - a) * clamp(t, 0, 1), msg);
  },
  byteCounter(n) { this.bytes.textContent = n > 0 ? (n / 1048576).toFixed(1) + ' MB downloaded' : ''; }
};

let errBox = $('err');
function fail(msg) { errBox.hidden = false; errBox.textContent = msg; }

/* ------------------------------------------------------------------- API layer */
let bytesTotal = 0;

async function apiText(method, onBytes) {
  const r = await fetch(API + method, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + method);
  const head = +(r.headers.get('content-length') || 0);
  if (!r.body) { const t = await r.text(); bytesTotal += t.length; P.byteCounter(bytesTotal); return t; }
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length; parts.push(value);
    onBytes && onBytes(got, head);
  }
  bytesTotal += got;
  P.byteCounter(bytesTotal);
  const buf = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  return new TextDecoder().decode(buf);
}

async function apiJSON(method, onBytes) {
  const txt = await apiText(method, onBytes);
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('response is not JSON: ' + method); }
  if (j.status !== 'OK') throw new Error(j.comment || ('API FAILED: ' + method));
  return j.result;
}

/* contest.status is ordered by submission id descending, so the post-contest
 * practice/virtual traffic fills the head of the list and the in-contest
 * submissions form one contiguous block at the tail. Probing a single row at a
 * given offset is enough to tell which side of that boundary we are on. */
async function probeAt(cid, from) {
  const r = await apiJSON(`contest.status?contestId=${cid}&from=${from}&count=1`);
  return r && r.length ? r[0] : null;
}

function pastPractice(sub) {
  return !sub || (sub.relativeTimeSeconds ?? 2e9) < 1e8;
}

/* ---------------------------------------------------------------- data shaping */
function handleOf(sub) {
  const a = sub.author;
  return a && a.members && a.members.length ? a.members.map(m => m.handle).join(';') : null;
}

function isValidSub(sub, official) {
  const a = sub.author;
  if (!a || a.participantType !== 'CONTESTANT') return false;
  if (!(sub.relativeTimeSeconds >= 0 && sub.relativeTimeSeconds < 1e8)) return false;
  if (!a.members || !a.members.length) return false;
  return a.members.some(m => official.has(m.handle));
}

function shape(subs, official, problems) {
  const all = new Map();
  for (const p of problems) all.set(p.index, []);
  for (const s of subs) {
    if (!isValidSub(s, official)) continue;
    const arr = all.get(s.problem.index);
    if (arr) arr.push(s);
  }

  const out = [];
  for (const p of problems) {
    const arr = all.get(p.index);
    if (!arr.length) continue;
    arr.sort((a, b) => a.relativeTimeSeconds - b.relativeTimeSeconds || a.id - b.id);

    const byHandle = new Map();
    for (const s of arr) {
      const h = handleOf(s);
      if (!byHandle.has(h)) byHandle.set(h, []);
      byHandle.get(h).push(s);
    }

    const kept = [];
    const solved = new Set();
    let dropped = 0;
    for (const [h, list] of byHandle) {
      let cut = -1;
      for (let i = 0; i < list.length; i++) if (list[i].verdict === 'OK') { cut = i; break; }
      if (cut < 0) kept.push(...list);
      else { solved.add(h); dropped += list.length - cut - 1; kept.push(...list.slice(0, cut + 1)); }
    }

    out.push({
      index: p.index, name: p.name, points_total: p.points,
      limits: inferLimits(arr),
      solved, dropped,
      points: toPoints(kept),
      all: arr.map(s => [s.relativeTimeSeconds || 0, s.verdict || 'FAILED',
                         handleOf(s)])
    });
  }
  return out;
}

function toPoints(kept) {
  const pts = kept.map(s => ({
    t: s.timeConsumedMillis || 0,
    m: (s.memoryConsumedBytes || 0) / 1048576,
    ok: s.verdict === 'OK',
    v: s.verdict || 'FAILED',
    at: s.relativeTimeSeconds || 0,
    ps: s.passedTestCount || 0,
    ts: s.testset === 'TESTS' ? 1 : 0,
    lg: s.programmingLanguage || '',
    h: handleOf(s)
  }));
  // draw order from plot_problem: zero-memory first, failures below, accepted on top
  pts.sort((a, b) => (a.m <= 0) - (b.m <= 0) || (a.ok - b.ok));
  const stack = new Map();
  for (const p of pts) {
    const k = p.t + '|' + p.m.toFixed(4);
    const s = stack.get(k);
    if (s) { s.n++; if (p.ok) s.ac++; } else stack.set(k, { n: 1, ac: p.ok ? 1 : 0 });
  }
  for (const p of pts) {
    const s = stack.get(p.t + '|' + p.m.toFixed(4));
    p.n = s.n; p.ac = s.ac;
  }
  return pts;
}

function inferLimits(arr) {
  let tl = 0, ml = 0, maxT = 0, maxM = 0, nTL = 0, nMLE = 0;
  for (const s of arr) {
    const t = s.timeConsumedMillis || 0;
    const m = s.memoryConsumedBytes || 0;
    if (s.verdict === 'TIME_LIMIT_EXCEEDED') { nTL++; if (t > tl) tl = t; }
    if (s.verdict === 'MEMORY_LIMIT_EXCEEDED') { nMLE++; if (m > ml) ml = m; }
    if (t > maxT) maxT = t;
    if (m > maxM) maxM = m;
  }
  const mb = 1048576;
  return {
    tl: tl || niceTime(maxT * 1.05),
    ml: ml ? Math.round(ml / mb) : niceMem(maxM / mb * 1.05),
    tlExact: !!tl, mlExact: !!ml, nTL, nMLE
  };
}

function niceTime(v) {
  if (!(v > 0)) return 1000;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return Math.round(m * p);
  return Math.round(10 * p);
}
function niceMem(v) {
  for (const s of [64, 128, 256, 512, 1024, 2048, 4096]) if (s >= v) return s;
  return Math.ceil(v / 1024) * 1024;
}

/* ------------------------------------------------------------- derived stats */
function computeStats(prob) {
  const byH = new Map();                 // handle -> {n, att, at}
  const verdicts = new Map();
  const vc = { AC: 0, WA: 0, TL: 0, ML: 0, RE: 0, CE: 0, other: 0 };
  const shortOf = v => ({
    OK: 'AC', WRONG_ANSWER: 'WA', TIME_LIMIT_EXCEEDED: 'TL',
    MEMORY_LIMIT_EXCEEDED: 'ML', RUNTIME_ERROR: 'RE', COMPILATION_ERROR: 'CE'
  }[v] || 'other');
  const nonOk = [];
  for (const [at, v, h] of prob.all) {
    verdicts.set(v, (verdicts.get(v) || 0) + 1);
    vc[shortOf(v)]++;
    let r = byH.get(h);
    if (!r) { r = { n: 0 }; byH.set(h, r); }
    r.n++;
    if (v === 'OK') { if (r.att === undefined) { r.att = r.n; r.at = at; } }
    else nonOk.push(at);
  }
  nonOk.sort((a, b) => a - b);

  const solvers = [...byH.values()].filter(r => r.att !== undefined);
  const cumSolves = solvers.map(r => r.at).sort((a, b) => a - b);
  const attempts = solvers.map(r => r.att);
  const meanAtt = attempts.length ? attempts.reduce((a, b) => a + b, 0) / attempts.length : 0;

  let fb = null;
  for (const [h, r] of byH) if (r.att !== undefined && (!fb || r.at < fb.at)) fb = { h, at: r.at };

  const okCount = verdicts.get('OK') || 0;
  prob.stats = {
    subs: prob.all.length, solvers: solvers.length, acSubs: okCount,
    cumSolves, nonOk, attempts, meanAtt, verdicts, vc,
    dirt: prob.all.length ? 1 - okCount / prob.all.length : 0
  };
  prob.firstBlood = fb;
  return prob;
}

/* ------------------------------------------------------------------- difficulty
 *
 * Port of plots/difficulty.py. Two estimators, exactly as the Python does it:
 *
 *   1. crossing()    — binned 50% crossing, model-free, only meaningful when the
 *                      crossing really lies inside the rated pool.
 *   2. extrapolate() — 1-parameter logistic P(solve | rating) with the slope pooled
 *                      over every identifiable problem, so the 50% point can be read
 *                      even when it lies outside the pool (the saturated cases).
 *
 * The final value clamps to the Codeforces rating scale and, for saturated problems,
 * falls back to the extrapolation tagged `extrap` / `top` / `floor` — printed as
 * ≈1234, ≤800 and ≥3500 (inequalities, so neither end can be misread as a range).
 */
const FLOOR = 800, CEIL = 3500;
const MIN_RATED = 30;

/* median of the pooled logistic slope, as difficulty.py reports it for cf.db
 * (13 identifiable problems over five contests -> b = 143.9). */
const POOLED_SLOPE = 143.9;

/** numpy.median: even-length groups average their two middle elements */
function medianOf(arr) {
  const m = arr.length;
  if (!m) return 0;
  return (m % 2) ? arr[(m - 1) >> 1] : (arr[m / 2 - 1] + arr[m / 2]) / 2;
}

function crossing(pairs) {
  const n = pairs.length;
  if (n < MIN_RATED) return null;
  pairs.sort((a, b) => a.r - b.r);
  const nb = clamp(Math.floor(n / 20), 3, 10);
  const centers = [], fracs = [];
  // np.array_split: the first (n % nb) groups get one extra element
  const base = Math.floor(n / nb), rem = n % nb;
  let lo = 0;
  for (let b = 0; b < nb; b++) {
    const hi = lo + base + (b < rem ? 1 : 0);
    if (hi <= lo) { continue; }
    let s = 0;
    for (let i = lo; i < hi; i++) s += pairs[i].s;
    centers.push(((hi - lo) % 2)
      ? pairs[(lo + hi - 1) >> 1].r
      : (pairs[(lo + hi - 1) >> 1].r + pairs[((lo + hi - 1) >> 1) + 1].r) / 2);
    fracs.push(s / (hi - lo));
    lo = hi;
  }
  if (centers.length < 2) return null;
  const sm = fracs.slice();
  for (let i = 1; i < fracs.length - 1; i++) sm[i] = (fracs[i - 1] + fracs[i] + fracs[i + 1]) / 3;
  let i = 0;
  while (i < sm.length && sm[i] < .5) i++;
  if (i === 0) return { v: Math.round(centers[0]), kind: 'below' };
  if (i >= sm.length) return { v: Math.round(centers[centers.length - 1]), kind: 'above' };
  const f0 = sm[i - 1], f1 = sm[i], c0 = centers[i - 1], c1 = centers[i];
  const t = f1 === f0 ? 0 : (.5 - f0) / (f1 - f0);
  return { v: Math.round(c0 + t * (c1 - c0)), kind: 'exact' };
}

/** participants collapsed per rating: [{r, n, s}] — the NLL is exact on this */
function groupByRating(pairs) {
  const m = new Map();
  for (const p of pairs) {
    let g = m.get(p.r);
    if (!g) { g = { r: p.r, n: 0, s: 0 }; m.set(p.r, g); }
    g.n++; g.s += p.s;
  }
  return [...m.values()].sort((a, b) => a.r - b.r);
}

/** mean negative log-likelihood of the logistic model, as difficulty.nll_a */
function nll(a, groups, b) {
  let acc = 0, total = 0;
  for (const g of groups) {
    const z = (g.r - a) / b;
    const lp = Math.max(0, -z) + Math.log1p(Math.exp(-Math.abs(z)));   // log(1+e^-z)
    const lq = Math.max(0, z) + Math.log1p(Math.exp(-Math.abs(z)));    // log(1+e^z)
    acc += g.s * lp + (g.n - g.s) * lq;
    total += g.n;
  }
  return total ? acc / total : 0;
}

/** golden-section search, standing in for scipy's bounded minimize_scalar */
function goldenMin(f, lo, hi, tol) {
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi;
  let c = b - gr * (b - a), d = a + gr * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < 300 && (b - a) > (tol || 1e-3); i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

function extrapolate(groups, b, lo = 300, hi = 9000) {
  return goldenMin(t => nll(t, groups, b), lo, hi, .5);
}

/**
 * Full estimate, mirroring the final branch in difficulty.compute():
 *   clamp to top/floor first, then prefer the model-free crossing when it exists.
 */
function estimateDifficulty(pairs, solvers) {
  if (pairs.length < MIN_RATED || !solvers) {
    return { v: null, kind: 'too few' };
  }
  const groups = groupByRating(pairs);
  const cross = crossing(pairs);
  const aHat = extrapolate(groups, POOLED_SLOPE);
  const a = Math.round(aHat);

  if (aHat >= CEIL) return { v: CEIL, kind: 'top', aHat: a, cross };
  if (aHat <= FLOOR) return { v: FLOOR, kind: 'floor', aHat: a, cross };
  if (cross && cross.kind === 'exact') return { v: cross.v, kind: 'exact', aHat: a, cross };
  return { v: a, kind: 'extrap', aHat: a, cross };
}

/** how the ends of the scale are printed: ≤800 and ≥3500, plus 1234 / ≈1234 */
function difficultyLabel(d) {
  if (!d || d.v == null) return 'n/a';
  if (d.kind === 'top') return '≥' + CEIL;
  if (d.kind === 'floor') return '≤' + FLOOR;
  if (d.kind === 'exact') return String(d.v);
  return '≈' + d.v;
}

/* Numbered sub-problems (A1, A2, …) are one idea sold as a ladder: the higher
 * number is the harder level, and because the two are scored separately, walking
 * the ladder in order is what the standings pay for. That is why the chart stacks
 * them — not because the statements contain each other (they need not), but
 * because of the ordering and the scoring rule. */
function subLadders(probs) {
  const groups = new Map();
  for (const p of probs) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(p.index || '');
    if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push([+m[2], p]);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;         // a lone "A3" is just a problem
    list.sort((a, b) => a[0] - b[0]);
    out.push(list.map(x => x[1]));
  }
  return out;
}

/** running point total of every level of every ladder; anything else keeps its own */
function cumulativePoints(probs) {
  const out = new Map();
  for (const list of subLadders(probs)) {
    let acc = 0;
    for (const p of list) { acc += p.points_total || 0; out.set(p.index, acc); }
  }
  return out;
}

/* ----------------------------------------------------------------- IDB cache */
/* Two stores: `payload` holds the compact contest, `meta` holds ~200 bytes per
 * entry so listing, ageing and LRU eviction never deserialise a whole contest.
 * Bump CACHE_V when the payload shape changes; entries carrying another version
 * are dropped on sight instead of lingering as dead weight. */
const CACHE_DB = 'contest-atlas', CACHE_V = 6;
const ST_PAYLOAD = 'payload', ST_META = 'meta';
const CACHE_MAX_ENTRIES = 20;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
let _dbp = null, _cacheErr = '';

function db() {
  if (_dbp) return _dbp;
  _dbp = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('this browser has no IndexedDB'));
    let r;
    try { r = indexedDB.open(CACHE_DB, 2); }
    catch (e) { return rej(e); }
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const name of [...d.objectStoreNames]) d.deleteObjectStore(name);  // v1 layout
      d.createObjectStore(ST_PAYLOAD);
      d.createObjectStore(ST_META, { keyPath: 'cid' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('cannot open the cache'));
    r.onblocked = () => rej(new Error('another tab is holding an old cache open'));
  });
  _dbp.catch(e => { _cacheErr = e && e.message ? e.message : String(e); });
  return _dbp;
}

function idb(stores, mode, work) {
  return db().then(d => new Promise((res, rej) => {
    let t;
    try { t = d.transaction(stores, mode); }
    catch (e) { return rej(e); }
    let out;
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('cache transaction aborted'));
    try { out = work(t); } catch (e) { try { t.abort(); } catch (_) { } rej(e); }
  }));
}

async function metaAll() {
  try {
    return await idb(ST_META, 'readonly', t => {
      const r = t.objectStore(ST_META).getAll();
      return r;
    }).then(r => r && r.result ? r.result : []);
  } catch (e) { return []; }
}

async function cacheMeta(cid) {
  try {
    const r = await idb(ST_META, 'readonly', t => t.objectStore(ST_META).get(String(cid)));
    const m = r && r.result ? r.result : null;
    return m && m.v === CACHE_V ? m : null;
  } catch (e) { return null; }
}

async function cacheGet(cid) {
  try {
    const m = await cacheMeta(cid);
    if (!m) { await cacheDel(cid); return null; }
    const r = await idb(ST_PAYLOAD, 'readonly', t => t.objectStore(ST_PAYLOAD).get(String(cid)));
    const p = r && r.result ? r.result : null;
    if (!p || p.v !== CACHE_V) { await cacheDel(cid); return null; }
    touchMeta(m);
    return p;
  } catch (e) { return null; }
}

/* refresh "last used" without rewriting the payload */
function touchMeta(m) {
  if (Date.now() - (m.used || 0) < 6 * 3600e3) return;   // at most a few writes a day
  idb(ST_META, 'readwrite', t => {
    t.objectStore(ST_META).put({ ...m, used: Date.now() });
  }).catch(() => { });
}

async function cachePut(cid, payload, info) {
  try {
    const rec = { cid: String(cid), v: CACHE_V, at: Date.now(), used: Date.now(),
                  name: info.name || '', teams: info.teams || 0,
                  bytes: info.bytes || 0, rows: info.rows || 0 };
    await idb([ST_PAYLOAD, ST_META], 'readwrite', t => {
      t.objectStore(ST_PAYLOAD).put(payload, rec.cid);
      t.objectStore(ST_META).put(rec);
    });
    cacheEvict();
    return true;
  } catch (e) {
    _cacheErr = e && e.name === 'QuotaExceededError'
      ? 'the browser storage quota is full'
      : (e && e.message ? e.message : String(e));
    return false;
  }
}

async function cacheDel(cid) {
  try {
    await idb([ST_PAYLOAD, ST_META], 'readwrite', t => {
      t.objectStore(ST_PAYLOAD).delete(String(cid));
      t.objectStore(ST_META).delete(String(cid));
    });
    return true;
  } catch (e) { return false; }
}

async function cacheClear() {
  try {
    await idb([ST_PAYLOAD, ST_META], 'readwrite', t => {
      t.objectStore(ST_PAYLOAD).clear();
      t.objectStore(ST_META).clear();
    });
    return true;
  } catch (e) { return false; }
}

/* keep the oldest-used entries from piling up */
async function cacheEvict() {
  try {
    let all = (await metaAll()).sort((a, b) => (b.used || b.at) - (a.used || a.at));
    let total = all.reduce((s, m) => s + (m.bytes || 0), 0);
    for (const m of all.slice(CACHE_MAX_ENTRIES)) { await cacheDel(m.cid); total -= m.bytes || 0; }
    let kept = all.slice(0, CACHE_MAX_ENTRIES);
    while (kept.length > 1 && total > CACHE_MAX_BYTES) {
      const victim = kept.pop();
      await cacheDel(victim.cid);
      total -= victim.bytes || 0;
    }
  } catch (e) { /* eviction is best effort */ }
}

/* rough packed size; JSON length is the honest upper bound of what IDB stores */
function packedBytes(payload) {
  try { return JSON.stringify(payload).length; } catch (e) { return 0; }
}

/* compact encoding: strings factored into dictionaries, one row per submission.
 * Derivable values (difficulty, stats) are deliberately NOT cached — they are recomputed
 * on hydrate so a change to the estimator cannot hide behind a stale cache entry. */
function packContest(cid, contest, meta, probs, official, rating) {
  const handles = [], hi = new Map();
  const langs = [], li = new Map();
  const vcodes = [], vi = new Map();
  const ix = (map, arr, v) => {
    let k = map.get(v);
    if (k === undefined) { k = arr.push(v) - 1; map.set(v, k); }
    return k;
  };

  const out = probs.map(p => ({
    index: p.index, name: p.name, points_total: p.points_total,
    limits: p.limits, dropped: p.dropped,
    solved: [...p.solved],
    pts: p.points.map(pt => [pt.t, +pt.m.toFixed(3), ix(vi, vcodes, pt.v), pt.at,
                             pt.ps, pt.ts, ix(li, langs, pt.lg), ix(hi, handles, pt.h)]),
    rows: p.all.map(([at, v, h]) => [at, ix(vi, vcodes, v), ix(hi, handles, h)])
  }));

  // only the official roster and its pre-contest ratings, so difficulty stays recomputable
  const off = [...official];
  const ratings = [];
  for (const h of off) if (rating.has(h)) ratings.push([h, rating.get(h)]);

  return { v: CACHE_V, at: Date.now(), cid, contest, meta, problems: out,
           handles, langs, vcodes, official: off, ratings };
}

function unpackContest(c) {
  const { handles, langs, vcodes } = c;
  const official = c.official || [];
  const rating = new Map(c.ratings || []);

  return c.problems.map(p => {
    const pts = p.pts.map(r => ({
      t: r[0], m: r[1], v: vcodes[r[2]], at: r[3], ps: r[4], ts: r[5],
      lg: langs[r[6]], h: handles[r[7]], ok: vcodes[r[2]] === 'OK'
    }));
    const stack = new Map();
    for (const pt of pts) {
      const k = pt.t + '|' + pt.m.toFixed(4);
      const s = stack.get(k);
      if (s) { s.n++; if (pt.ok) s.ac++; } else stack.set(k, { n: 1, ac: pt.ok ? 1 : 0 });
    }
    for (const pt of pts) { const s = stack.get(pt.t + '|' + pt.m.toFixed(4)); pt.n = s.n; pt.ac = s.ac; }

    const prob = {
      index: p.index, name: p.name, points_total: p.points_total,
      limits: p.limits, dropped: p.dropped,
      solved: new Set(p.solved), points: pts,
      all: p.rows.map(r => [r[0], vcodes[r[1]], handles[r[2]]])
    };
    computeStats(prob);
    const pairs = [];
    for (const h of official) {
      const r = rating.get(h);
      if (r) pairs.push({ r, s: prob.solved.has(h) ? 1 : 0 });
    }
    prob.difficulty = estimateDifficulty(pairs, prob.stats.solvers);
    return prob;
  });
}

/* ===================================================================== CANVAS */
const canvas = $('chart');
const ctx = canvas.getContext('2d');
const off = document.createElement('canvas');
const octx = off.getContext('2d');
const tip = $('tip');

const state = {
  cid: null, contest: null, probs: [], idx: 0, meta: null,
  at: 0, statsBuilt: false
};

const GEO = { xe: 1, ye: 1 };
let hoverP = null;
let _w = 0, _h = 0;

function step(hi, target) {
  const raw = hi / (target || 6);
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000])
    if (s >= raw) return s;
  return 10000;
}

function metrics() {
  const cssW = canvas.clientWidth || 900;
  const dpr = window.devicePixelRatio || 1;
  const cssH = cssW * UH / UW;
  return { cssW, cssH, dpr, pxW: Math.round(cssW * dpr), pxH: Math.round(cssH * dpr) };
}

function resize() {
  const m = metrics();
  canvas.style.height = m.cssH + 'px';
  if (m.pxW !== _w || m.pxH !== _h) {
    _w = m.pxW; _h = m.pxH;
    canvas.width = _w; canvas.height = _h;
    off.width = _w; off.height = _h;
  }
  renderScatter();
}

function uTransform(c) {
  const s = metrics().pxW / UW;
  c.setTransform(s, 0, 0, s, 0, 0);
}

/* ---- one marker, ported from _group_svg ---------------------------------- */
function markerPath(c, kind, x, y, r) {
  c.beginPath();
  if (kind === 'triangle') {
    c.moveTo(x, y - r * 1.2); c.lineTo(x + r * 1.1, y + r * .8); c.lineTo(x - r * 1.1, y + r * .8);
    c.closePath();
  } else if (kind === 'square') {
    c.rect(x - r, y - r, 2 * r, 2 * r);
  } else if (kind === 'diamond') {
    c.moveTo(x, y - r * 1.25); c.lineTo(x + r * 1.25, y); c.lineTo(x, y + r * 1.25);
    c.lineTo(x - r * 1.25, y); c.closePath();
  } else if (kind === 'cross') {
    c.moveTo(x - r, y - r); c.lineTo(x + r, y + r);
    c.moveTo(x + r, y - r); c.lineTo(x - r, y + r);
  } else {
    c.arc(x, y, r, 0, Math.PI * 2);
  }
}

function paintMarker(c, p, x, y) {
  const kind = (VERDICT[p.v] || ['??', 'circle'])[1];
  const colour = p.ok ? OK_C : BAD_C;
  markerPath(c, kind, x, y, R);
  if (kind === 'cross') {
    c.strokeStyle = colour; c.lineWidth = 2.4; c.lineCap = 'round'; c.stroke();
  } else {
    c.fillStyle = colour; c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = .8; c.stroke();
  }
}

function legendSwatch(c, x, y, colour, kind, r, text) {
  markerPath(c, kind, x, y, r);
  if (kind === 'cross') {
    c.strokeStyle = colour; c.lineWidth = 2.2; c.lineCap = 'round'; c.stroke();
  } else {
    c.fillStyle = colour; c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = .7; c.stroke();
  }
  c.fillStyle = '#374151'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText(text, x + r + 14, y + 4);
}

/* ---- the whole static scatter -------------------------------------------- */
function renderStatic() {
  const prob = state.probs[state.idx];
  if (!prob) return false;
  const c = octx;
  uTransform(c);
  c.clearRect(0, 0, UW, UH);
  c.textBaseline = 'alphabetic';

  const tl = prob.limits.tl, memL = prob.limits.ml;
  const xe = tl * 1.02, ye = memL * 1.02;
  GEO.xe = xe; GEO.ye = ye;

  const X = v => PAD_L + v / xe * (X1 - PAD_L);
  const Y = v => MT + (1 - v / ye) * PLOT_H;
  prob._X = X; prob._Y = Y;

  /* grid + ticks */
  c.font = FONT11;
  c.strokeStyle = '#e8ecf1'; c.lineWidth = 1;
  c.fillStyle = '#6b7280';
  for (let v = 0; v <= xe; v += step(xe)) {
    const px = X(v);
    c.beginPath(); c.moveTo(px, MT); c.lineTo(px, MT + PLOT_H); c.stroke();
    c.textAlign = 'center'; c.fillText(String(v), px, MT + PLOT_H + 16);
  }
  for (let v = 0; v <= ye; v += step(ye)) {
    const py = Y(v);
    c.beginPath(); c.moveTo(PAD_L, py); c.lineTo(X1, py); c.stroke();
    c.textAlign = 'right'; c.fillText(String(v), PAD_L - 9, py + 4);
  }

  /* marginal histograms */
  const tb = new Array(MARGIN_BINS).fill(0);
  const mb2 = new Array(MARGIN_BINS).fill(0);
  for (const p of prob.points) {
    tb[clamp(Math.floor(p.t / xe * MARGIN_BINS), 0, MARGIN_BINS - 1)]++;
    mb2[clamp(Math.floor(p.m / ye * MARGIN_BINS), 0, MARGIN_BINS - 1)]++;
  }
  const tmaxc = Math.max(1, ...tb), mmaxc = Math.max(1, ...mb2);
  c.fillStyle = '#aab6c6';
  const tw = (X1 - PAD_L) / MARGIN_BINS;
  for (let i = 0; i < MARGIN_BINS; i++) {
    if (!tb[i]) continue;
    const h = Math.log1p(tb[i]) / Math.log1p(tmaxc) * STRIP;
    c.fillRect(PAD_L + i * tw, MT - GAP - h, Math.max(tw - 1.2, .8), h);
  }
  const mh = PLOT_H / MARGIN_BINS;
  for (let i = 0; i < MARGIN_BINS; i++) {
    if (!mb2[i]) continue;
    const w = Math.log1p(mb2[i]) / Math.log1p(mmaxc) * STRIP;
    c.fillRect(X1 + GAP, Y(i * mh) - mh, w, Math.max(mh - 1.2, .8));
  }
  c.fillStyle = '#9aa0a6'; c.font = FONT11;
  c.textAlign = 'left';
  c.fillText('submissions over runtime', PAD_L, MT - GAP - STRIP - 6);
  c.save();
  c.translate(X1 + GAP + STRIP + 10, MT + PLOT_H);
  c.rotate(-Math.PI / 2);
  c.fillText('over memory', 0, 0);
  c.restore();

  /* limits */
  c.setLineDash([5, 4]); c.lineWidth = 1.4;
  c.strokeStyle = '#f0a020';
  c.beginPath(); c.moveTo(X(tl), MT); c.lineTo(X(tl), MT + PLOT_H); c.stroke();
  c.strokeStyle = '#8e5cd9';
  c.beginPath(); c.moveTo(PAD_L, Y(memL)); c.lineTo(X1, Y(memL)); c.stroke();
  c.setLineDash([]);
  c.save();
  c.translate(X(tl) - 13, MT + PLOT_H * .30);
  c.rotate(Math.PI / 2);
  c.fillStyle = '#c07c10'; c.textAlign = 'center';
  c.fillText('TL ' + tl + ' ms' + (prob.limits.tlExact ? '' : ' (inferred)'), 0, 0);
  c.restore();
  c.fillStyle = '#6b3fb5'; c.textAlign = 'left';
  c.fillText('ML ' + memL + ' MB' + (prob.limits.mlExact ? '' : ' (inferred)'),
             PAD_L + 8, Y(memL) - 7);

  /* axes */
  c.strokeStyle = '#9aa4b2'; c.lineWidth = 1;
  c.beginPath();
  c.moveTo(PAD_L, MT); c.lineTo(PAD_L, MT + PLOT_H); c.lineTo(X1, MT + PLOT_H);
  c.stroke();
  c.font = FONT12; c.fillStyle = '#374151';
  c.textAlign = 'center';
  c.fillText('runtime / ms', (PAD_L + X1) / 2, MT + PLOT_H + 42);
  c.save();
  c.translate(26, MT + PLOT_H / 2);
  c.rotate(-Math.PI / 2);
  c.fillText('memory used / MB', 0, 0);
  c.restore();

  /* one marker per submission */
  c.globalAlpha = .85;
  for (const p of prob.points) paintMarker(c, p, X(p.t), Y(p.m));
  c.globalAlpha = 1;

  /* legend column */
  const lx = X1 + GAP + STRIP + 24;
  const y = MT + 8;
  c.font = FONT12; c.textAlign = 'left'; c.fillStyle = '#374151';
  c.fillText('colour = accepted', lx, y);
  legendSwatch(c, lx + 8, y + 24, OK_C, 'circle', 5.4, 'accepted');
  legendSwatch(c, lx + 8, y + 46, BAD_C, 'circle', 5.4, 'not accepted');

  const y2 = y + 84;
  c.fillStyle = '#374151';
  c.fillText('shape = verdict', lx, y2);
  MARK_ORDER.forEach(([lab, sh], k) => {
    legendSwatch(c, lx + 8, y2 + 26 + k * 22, '#9aa7b8', sh, 5.2, lab);
  });

  const y3 = y2 + 26 + 5 * 22 + 16;
  c.fillStyle = '#6b7280';
  c.fillText('points overlap —', lx, y3);
  c.fillText('hover one to see how', lx, y3 + 18);
  c.fillText('many share that spot', lx, y3 + 36);
  return true;
}

function paint() {
  const prob = state.probs[state.idx];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, _w, _h);
  ctx.drawImage(off, 0, 0);
  if (hoverP && prob && prob._X) {
    uTransform(ctx);
    ctx.beginPath();
    ctx.arc(prob._X(hoverP.t), prob._Y(hoverP.m), R + 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#111827'; ctx.lineWidth = 1.6; ctx.stroke();
  }
}

/* ----------------------------------------------------------------------- hover */
canvas.addEventListener('mousemove', ev => {
  const prob = state.probs[state.idx];
  if (!prob || !prob._X) return;
  const r = canvas.getBoundingClientRect();
  const x = (ev.clientX - r.left) * UW / r.width;
  const y = (ev.clientY - r.top) * UH / r.height;

  let best = null, bestD = 1e9, bestI = -1, i = 0;
  for (const p of prob.points) {
    const dx = prob._X(p.t) - x, dy = prob._Y(p.m) - y;
    const d = dx * dx + dy * dy;
    if (d <= (R + 3) * (R + 3) && (d < bestD || (d === bestD && i > bestI))) {
      best = p; bestD = d; bestI = i;
    }
    i++;
  }
  if (best !== hoverP) { hoverP = best; paint(); }
  if (!best) { tip.hidden = true; return; }

  const shared = best.n > 1
    ? `<span style="color:#fbbf24">${best.n.toLocaleString('en-US')} submissions share this point ` +
      `(${best.ac.toLocaleString('en-US')} accepted)</span><br>`
    : '';
  const mem = best.m > 0 ? best.m.toFixed(2) + ' MB' : 'under 0.1 MB';
  tip.innerHTML =
    `<b>${escapeHTML(best.h)}</b><br>` +
    `${best.v.replace(/_/g, ' ').toLowerCase()} &nbsp; ${best.t} ms &nbsp; ${mem}<br>` +
    shared +
    `contest time ${best.at}s &nbsp; passed ${best.ps} tests (${best.ts ? 'TESTS' : 'PRETESTS'})<br>` +
    `<span style="color:#9ca3af">${escapeHTML(best.lg)}</span>`;
  tip.hidden = false;
  const pad = 14;
  let px = ev.clientX + pad, py = ev.clientY + pad;
  const tr = tip.getBoundingClientRect();
  if (px + tr.width > innerWidth - 8) px = ev.clientX - tr.width - pad;
  if (py + tr.height > innerHeight - 8) py = ev.clientY - tr.height - pad;
  tip.style.left = px + 'px'; tip.style.top = py + 'px';
});

canvas.addEventListener('mouseleave', () => {
  if (hoverP) { hoverP = null; paint(); }
  tip.hidden = true;
});

/* -------------------------------------------------------------- scatter chrome */
function renderTabs() {
  const box = $('tabs');
  box.textContent = '';
  state.probs.forEach((p, i) => {
    const el = document.createElement('button');
    el.className = 'tab' + (i === state.idx ? ' sel' : '');
    el.innerHTML = `<span>${p.index}</span><span class="n">${p.points.length}</span>`;
    el.title = p.name;
    el.onclick = () => { state.idx = i; hoverP = null; renderTabs(); renderScatter(); };
    box.appendChild(el);
  });
}

function renderMeta() {
  const p = state.probs[state.idx];
  const teams = state.meta.solvers || state.meta.teams;
  const solved = p.stats.solvers;
  const se = teams ? (teams - solved) / teams : 0;
  const fb = p.firstBlood;
  const parts = [
    `<b>${p.index}</b> ${escapeHTML(p.name)}`,
    p.points_total ? `${p.points_total} pts` : '',
    `solved <b>${fmtInt(solved)}</b> / ${fmtInt(teams)}`,
    `dirt <b>${(p.stats.dirt * 100).toFixed(0)}%</b>`,
    `SE <b>${(se * 100).toFixed(0)}%</b>`,
    fb ? `first blood <b>${escapeHTML(fb.h)} @ ${(fb.at / 60).toFixed(0)}m</b>` : '',
    p.difficulty && p.difficulty.v != null
      ? `difficulty <b>${difficultyLabel(p.difficulty)}</b>` : ''
  ].filter(Boolean);
  $('meta').innerHTML = parts.join(' · ');
  $('notes').innerHTML =
    `${fmtInt(p.points.length)} submissions plotted (cut at each contestant's first AC; ` +
    `${fmtInt(p.dropped)} dropped) · axes 0–${p.limits.tl} ms × 0–${p.limits.ml} MB (unchanged)` +
    (state.fetchNote ? ` · <b style="color:#b45309">${escapeHTML(state.fetchNote)}</b>` : '');
}

function renderScatter() {
  if (!state.probs.length) return;
  renderMeta();
  if (!renderStatic()) return;
  paint();
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ================================================================= STATISTICS */
const CW = 1000;

function statCanvas(section, height) {
  const cv = document.createElement('canvas');
  cv.className = 'chartimg';
  cv.style.aspectRatio = CW + '/' + height;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(CW * dpr);
  cv.height = Math.round(height * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.font = FONT11;
  section.appendChild(cv);
  return { c, W: CW, H: height };
}

function niceTicks(a, b, n) {
  const span = b - a;
  if (!(span > 0)) return [a];
  let s = step(span, n);
  const out = [];
  for (let v = Math.ceil(a / s) * s; v <= b + 1e-9; v += s) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function axes(c, W, H, o) {
  const pad = Object.assign({ l: 64, r: 20, t: 12, b: 44 }, o.pad || {});
  const x0 = pad.l, x1 = W - pad.r, y0 = pad.t, y1 = H - pad.b;
  const [xa, xb] = o.xr, [ya, yb] = o.yr;
  const X = v => x0 + (v - xa) / (xb - xa) * (x1 - x0);
  const Y = v => y1 - (v - ya) / (yb - ya) * (y1 - y0);

  const xt = o.xticks || niceTicks(xa, xb, 7);
  const yt = o.yticks || niceTicks(ya, yb, 6);
  c.strokeStyle = '#eef1f5'; c.lineWidth = 1;
  c.font = FONT11; c.fillStyle = '#6b7280';
  for (const v of xt) {
    const px = Math.round(X(v)) + .5;
    c.beginPath(); c.moveTo(px, y0); c.lineTo(px, y1); c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText(fmtInt(v), px, y1 + 7);
  }
  for (const v of yt) {
    const py = Math.round(Y(v)) + .5;
    c.beginPath(); c.moveTo(x0, py); c.lineTo(x1, py); c.stroke();
    c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(fmtInt(v), x0 - 9, py);
  }
  c.strokeStyle = '#c9ced6';
  c.beginPath();
  c.moveTo(x0 + .5, y0); c.lineTo(x0 + .5, y1 + .5); c.lineTo(x1, y1 + .5);
  c.stroke();
  c.font = FONT12; c.fillStyle = '#374151';
  if (o.xlabel) {
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.fillText(o.xlabel, (x0 + x1) / 2, y1 + 26);
  }
  if (o.ylabel) {
    c.save();
    c.translate(16, (y0 + y1) / 2);
    c.rotate(-Math.PI / 2);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(o.ylabel, 0, 0);
    c.restore();
  }
  return { X, Y, x0, x1, y0, y1 };
}

function legendRow(c, x, y, items, opts) {
  const vertical = opts && opts.vertical;
  c.font = FONT11; c.textBaseline = 'middle';
  let total = 0;
  if (!vertical) {
    for (const it of items) total += 17 + c.measureText(it[1]).width + 16;
    total -= 16;
  }
  let cx = (opts && opts.right) ? x - total : x;
  let cy = y;
  for (const [colour, label, shape] of items) {
    if (shape === 'line') {
      c.strokeStyle = colour; c.lineWidth = 2.2;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + 14, cy); c.stroke();
      cx += 19;
    } else {
      c.fillStyle = colour;
      c.fillRect(cx, cy - 5, 12, 10);
      cx += 17;
    }
    c.fillStyle = '#4b5563'; c.textAlign = 'left';
    c.fillText(label, cx, cy);
    if (vertical) { cy += 18; cx = (opts && opts.right) ? x : x; }
    else cx += c.measureText(label).width + 16;
  }
}

function stepLine(c, f, times, colour, drawDots) {
  if (!times.length) return;
  c.strokeStyle = colour; c.lineWidth = 1.8;
  c.beginPath();
  c.moveTo(f.X(0), f.Y(0));
  times.forEach((t, k) => {
    const x = f.X(t / 60);
    c.lineTo(x, f.Y(k));
    c.lineTo(x, f.Y(k + 1));
  });
  c.stroke();
  if (drawDots) {
    c.fillStyle = colour;
    c.beginPath(); c.arc(f.X(times[0] / 60), f.Y(1), 3.4, 0, Math.PI * 2); c.fill();
  }
}

function section(parent, title, desc) {
  const s = document.createElement('section');
  s.innerHTML = `<h2>${title}</h2><p>${desc}</p>`;
  parent.appendChild(s);
  return s;
}

function buildStats() {
  const box = $('paneStats');
  box.textContent = '';
  const probs = state.probs;
  if (!probs.length) return;
  const dur = (state.contest && state.contest.duration) || 7200;
  const durMin = dur / 60;
  const letters = probs.map(p => p.index);

  /* 1 — cumulative solves ------------------------------------------------- */
  {
    const s = section(box, 'Cumulative solves', 'How quickly each problem got cracked and how the ' +
      'solves kept coming. A late flat line means the problem was solved only by a handful of teams early on.');
    const { c, W, H } = statCanvas(s, 420);
    const ymax = Math.max(1, ...probs.map(p => p.stats.cumSolves.length));
    const f = axes(c, W, H, {
      xr: [0, durMin], yr: [0, ymax],
      xlabel: 'contest time / min', ylabel: 'teams solved', pad: { t: 34 }
    });
    probs.forEach((p, i) => stepLine(c, f, p.stats.cumSolves, PALETTE[i % PALETTE.length], true));
    legendRow(c, f.x1 - 10, 20,
      probs.map((p, i) => [PALETTE[i % PALETTE.length], p.index, 'line']), { right: true });
  }

  /* 2 — cumulative unsolved ------------------------------------------------ */
  {
    const s = section(box, 'Cumulative unsolves', 'The same contest, seen through failed submissions. ' +
      'A line that keeps climbing while its solve curve flattens is a problem people kept banging into.');
    const { c, W, H } = statCanvas(s, 420);
    const ymax = Math.max(1, ...probs.map(p => p.stats.nonOk.length));
    const f = axes(c, W, H, {
      xr: [0, durMin], yr: [0, ymax],
      xlabel: 'contest time / min', ylabel: 'unsuccessful submissions', pad: { t: 34 }
    });
    probs.forEach((p, i) => stepLine(c, f, p.stats.nonOk, PALETTE[i % PALETTE.length], false));
    legendRow(c, f.x1 - 10, 20,
      probs.map((p, i) => [PALETTE[i % PALETTE.length], p.index, 'line']), { right: true });
  }

  /* 3 — submission density ------------------------------------------------- */
  {
    const s = section(box, 'Submission density', 'Contest rhythm in 5-minute buckets. ' +
      'The green part is accepted submissions.');
    const { c, W, H } = statCanvas(s, 380);
    const nb = Math.max(1, Math.floor(durMin / 5));
    const ok = new Array(nb).fill(0), bad = new Array(nb).fill(0);
    for (const p of probs) {
      for (const [at, v] of p.all) {
        if (at > dur) continue;
        const b = clamp(Math.floor(at / 300), 0, nb - 1);
        if (v === 'OK') ok[b]++; else bad[b]++;
      }
    }
    const ymax = Math.max(1, ...ok.map((v, i) => v + bad[i]));
    const f = axes(c, W, H, {
      xr: [0, durMin], yr: [0, ymax * 1.06],
      xlabel: 'contest time / min', ylabel: 'submissions', pad: { t: 34 }
    });
    const bw = (f.X(5) - f.X(0)) * .92;
    for (let i = 0; i < nb; i++) {
      if (!ok[i] && !bad[i]) continue;
      const x = f.X(i * 5) + (f.X(5) - f.X(0) - bw) / 2;
      if (bad[i]) {
        c.fillStyle = BAD_C;
        c.fillRect(x, f.Y(bad[i]), bw, f.Y(0) - f.Y(bad[i]));
      }
      if (ok[i]) {
        c.fillStyle = OK_C;
        c.fillRect(x, f.Y(bad[i] + ok[i]), bw, f.Y(bad[i]) - f.Y(bad[i] + ok[i]));
      }
    }
    legendRow(c, f.x1 - 10, 20, [[OK_C, 'accepted', 'box'], [BAD_C, 'not accepted', 'box']],
      { right: true });
  }

  /* 4 — first blood -------------------------------------------------------- */
  {
    const s = section(box, 'First blood', 'When each problem was first solved, with the handle that did it.');
    const { c, W, H } = statCanvas(s, Math.max(220, 46 * probs.length + 90));
    const rec = probs.filter(p => p.firstBlood).map(p => ({
      idx: p.index, min: p.firstBlood.at / 60, h: p.firstBlood.h
    })).sort((a, b) => a.min - b.min);
    const xmax = Math.max(1, ...rec.map(r => r.min)) * 1.5;
    const f = axes(c, W, H, {
      xr: [0, xmax], yr: [0, rec.length],
      xticks: niceTicks(0, xmax, 7),
      yticks: [],
      xlabel: 'minutes into the contest', ylabel: ''
    });
    c.font = FONT12;
    rec.forEach((r, i) => {
      const yTop = f.Y(rec.length - i), yBot = f.Y(rec.length - i - 1);
      const h = (yTop - yBot) * .62;
      const cy = (yTop + yBot) / 2;
      c.fillStyle = '#4f7dd6';
      c.fillRect(f.X(0), cy - h / 2, f.X(r.min) - f.X(0), h);
      c.fillStyle = '#4b5563'; c.textAlign = 'right'; c.textBaseline = 'middle';
      c.fillText(r.idx, f.x0 - 10, cy);
      c.textAlign = 'left';
      c.fillText(`${r.min.toFixed(0)}m · ${r.h}`, f.X(r.min) + 8, cy);
    });
  }

  /* 5 — solves vs attempts ------------------------------------------------ */
  {
    const s = section(box, 'Solves vs. attempts needed',
      'x = teams that solved it, y = mean submissions per solving team');
    const { c, W, H } = statCanvas(s, 400);
    const xs = probs.map(p => p.stats.solvers);
    const ys = probs.map(p => p.stats.meanAtt);
    const xr = [0, Math.max(1, ...xs) * 1.12];
    const yr = [0, Math.max(1.2, Math.max(...ys) * 1.35)];
    const f = axes(c, W, H, {
      xr, yr, xlabel: 'teams that solved', ylabel: 'mean submissions per solver'
    });
    probs.forEach((p, i) => {
      const x = f.X(p.stats.solvers), y = f.Y(p.stats.meanAtt);
      c.fillStyle = PALETTE[i % PALETTE.length];
      c.beginPath(); c.arc(x, y, 5.4, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke();
      c.fillStyle = '#374151'; c.textAlign = 'center'; c.textBaseline = 'bottom';
      c.font = FONT12;
      c.fillText(p.index, x, y - 8);
    });
  }

  /* 6 — submissions needed to solve --------------------------------------- */
  {
    const s = section(box, 'Submissions needed to solve',
      'Teams that solved, split by how many submissions it took them');
    const { c, W, H } = statCanvas(s, Math.max(240, 46 * probs.length + 100));
    const caps = probs.map(p => {
      const m = new Map();
      for (const a of p.stats.attempts) m.set(a, (m.get(a) || 0) + 1);
      return m;
    });
    const maxk = Math.min(8, Math.max(1, ...caps.map(m => Math.max(...m.keys(), 1))));
    const xmax = Math.max(1, ...caps.map(m => [...m.values()].reduce((a, b) => a + b, 0)));
    const f = axes(c, W, H, {
      xr: [0, xmax * 1.04], yr: [0, probs.length], yticks: [], xlabel: 'teams', ylabel: '',
      pad: { t: 34 }
    });
    probs.forEach((p, i) => {
      const yTop = f.Y(probs.length - i), yBot = f.Y(probs.length - i - 1);
      const h = (yTop - yBot) * .68, cy = (yTop + yBot) / 2;
      c.fillStyle = '#4b5563'; c.textAlign = 'right'; c.textBaseline = 'middle';
      c.fillText(p.index, f.x0 - 10, cy);
      let left = 0;
      for (let k = 1; k <= maxk; k++) {
        let v;
        if (k < maxk) v = caps[i].get(k) || 0;
        else { v = 0; for (const [kk, c2] of caps[i]) if (kk >= maxk) v += c2; }
        if (!v) continue;
        const x0 = f.X(left), x1 = f.X(left + v);
        c.fillStyle = ATTEMPT_COLORS[(k - 1) % ATTEMPT_COLORS.length];
        c.fillRect(x0, cy - h / 2, Math.max(x1 - x0, .5), h);
        left += v;
      }
    });
    legendRow(c, f.x1 - 10, 20,
      Array.from({ length: maxk }, (_, k) => {
        const v = k + 1;
        return [ATTEMPT_COLORS[k % ATTEMPT_COLORS.length], v === maxk ? v + '+' : String(v), 'box'];
      }), { right: true });
  }

  /* 7 — verdict mix -------------------------------------------------------- */
  {
    const s = section(box, 'Verdict mix', 'What kind of failure dominates: WA means wrong idea, TL means too slow.');
    const { c, W, H } = statCanvas(s, Math.max(240, 46 * probs.length + 100));
    // row labels sit to the left of the axis, so the left padding has to fit the
    // widest one — "A1  (n=699)" is much wider than the default 64px margin
    const labels = probs.map(p => `${p.index}  (n=${fmtInt(p.all.length || 1)})`);
    c.font = FONT12;
    const labelW = Math.max(0, ...labels.map(t => c.measureText(t).width));
    const f = axes(c, W, H, { xr: [0, 100], yr: [0, probs.length], yticks: [],
                              xlabel: '% of submissions', ylabel: '',
                              pad: { t: 34, l: Math.min(Math.ceil(labelW) + 20, Math.round(W * .34)) } });
    probs.forEach((p, i) => {
      const yTop = f.Y(probs.length - i), yBot = f.Y(probs.length - i - 1);
      const h = (yTop - yBot) * .68, cy = (yTop + yBot) / 2;
      const total = p.all.length || 1;
      c.fillStyle = '#4b5563'; c.textAlign = 'right'; c.textBaseline = 'middle';
      c.font = FONT12;
      c.fillText(labels[i], f.x0 - 10, cy);
      let left = 0;
      for (const v of VORDER) {
        const n = p.stats.vc[v] || 0;
        if (!n) continue;
        const frac = n / total * 100;
        c.fillStyle = VCOL[v];
        c.fillRect(f.X(left), cy - h / 2, f.X(left + frac) - f.X(left), h);
        left += frac;
      }
    });
    const items = VORDER.filter(v => probs.some(p => (p.stats.vc[v] || 0)))
      .map(v => [VCOL[v], v, 'box']);
    legendRow(c, f.x1 - 10, 20, items, { right: true });
  }

  /* 8 — difficulty vs points ---------------------------------------------- */
  {
    const s = section(box, 'Estimated difficulty vs. points',
      'x = rating at which half the participants solve it · filled = measured, ' +
      'hollow = the estimate is extrapolated or clamped to the 800–3500 scale · ' +
      'a numbered sub-problem pair is one ladder, so the dashed link joins its levels');
    const { c, W, H } = statCanvas(s, 400);
    const cum = cumulativePoints(probs);
    const ladders = subLadders(probs);
    const inLadder = new Map();               // index -> {pair, level}
    for (const list of ladders) {
      list.forEach((p, k) => inLadder.set(p.index, { pair: list.map(q => q.index).join('→'), level: k }));
    }
    const pts = probs.filter(p => p.difficulty && p.difficulty.v != null);
    let mode = 'cum';

    const yOf = p => mode === 'cum'
      ? (cum.has(p.index) ? cum.get(p.index) : (p.points_total || 0))
      : (p.points_total || 0);

    const tools = document.createElement('div');
    tools.className = 'chart-tools';
    tools.innerHTML = '<span class="lbl">points</span>' +
      '<button class="on" data-m="cum">cumulative</button>' +
      '<button data-m="own">own</button>';
    s.insertBefore(tools, c.canvas);

    function drawDiff() {
      c.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      c.clearRect(0, 0, W, H);
      if (!pts.length) return;
      const xs = pts.map(p => p.difficulty.v);
      const ys = pts.map(yOf);
      const xr = [Math.min(...xs) - 120, Math.max(...xs) + 120];
      const yr = [0, Math.max(1, ...ys) * 1.16];
      const f = axes(c, W, H, { xr, yr, xlabel: 'estimated difficulty', ylabel: 'points' });

      /* the ladder: a dashed link between consecutive levels of one idea */
      c.save();
      c.setLineDash([3, 3]); c.lineWidth = 1.1; c.strokeStyle = '#c2cad6';
      for (const list of ladders) {
        const vis = list.filter(p => pts.includes(p));
        for (let k = 1; k < vis.length; k++) {
          const a = vis[k - 1], b2 = vis[k];
          c.beginPath();
          c.moveTo(f.X(a.difficulty.v), f.Y(yOf(a)));
          c.lineTo(f.X(b2.difficulty.v), f.Y(yOf(b2)));
          c.stroke();
        }
        if (vis.length >= 2) {
          const mid = vis[Math.floor(vis.length / 2)];
          const prev = vis[Math.floor(vis.length / 2) - 1];
          c.setLineDash([]);
          c.fillStyle = '#9aa0a6'; c.font = FONT11;
          c.textAlign = 'left'; c.textBaseline = 'middle';
          c.fillText(vis.map(p => p.index).join('→'),
            (f.X(prev.difficulty.v) + f.X(mid.difficulty.v)) / 2 + 6,
            (f.Y(yOf(prev)) + f.Y(yOf(mid))) / 2);
          c.setLineDash([3, 3]);
        }
      }
      c.restore();

      for (const p of pts) {
        const x = f.X(p.difficulty.v), y = f.Y(yOf(p));
        const filled = p.difficulty.kind === 'exact';
        c.beginPath(); c.arc(x, y, 5.6, 0, Math.PI * 2);
        if (filled) { c.fillStyle = '#2563eb'; c.fill(); }
        c.strokeStyle = '#2563eb'; c.lineWidth = 1.5; c.stroke();
        c.fillStyle = '#374151'; c.font = FONT12;
        c.textAlign = 'center'; c.textBaseline = 'bottom';
        c.fillText(`${p.index} ${difficultyLabel(p.difficulty)}`, x, y - 9);
      }
    }

    tools.addEventListener('click', ev => {
      const b2 = ev.target.closest('button[data-m]');
      if (!b2) return;
      mode = b2.dataset.m;
      for (const b3 of tools.querySelectorAll('button')) b3.classList.toggle('on', b3 === b2);
      drawDiff();
    });
    drawDiff();
  }

  state.statsBuilt = true;
}

/* ------------------------------------------------------------------ rendering */
function setView(v) {
  document.querySelectorAll('.vw').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('paneScatter').hidden = v !== 'scatter';
  $('paneStats').hidden = v !== 'stats';
  tip.hidden = true;
  if (v === 'stats' && !state.statsBuilt) buildStats();
  if (v === 'scatter') { resize(); paint(); }
}

function renderAll() {
  if (!state.probs.length) return;
  state.statsBuilt = false;
  resize();
}

/* -------------------------------------------------------------------- loading */
function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return s + ' s';
  const m = Math.round(s / 60);
  if (m < 90) return m + ' min';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' h';
  const d = Math.round(h / 24);
  return d + ' d';
}

function bytesText(b) {
  if (!b) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function showCacheHint(meta) {
  const el = $('cache');
  if (!meta) { el.hidden = true; return; }
  el.hidden = false;
  const what = meta.name ? escapeHTML(meta.name) : 'contest ' + meta.cid;
  el.innerHTML = `<b>Cache hit</b> · ${what} · fetched ${agoText(Date.now() - meta.at)} ago ` +
    `· ${bytesText(meta.bytes)} · no requests to Codeforces · ` +
    `<a href="#" id="clearcache">delete</a>`;
  $('clearcache').onclick = async ev => {
    ev.preventDefault();
    await cacheDel(state.cid);
    el.hidden = true;
    renderCacheBox();
  };
}

/* --------------------------------------------------------------- cache panel */
let cacheOpen = false;

async function renderCacheBox() {
  const box = $('cachebox'), btn = $('cachebtn');
  const meta = (await metaAll()).sort((a, b) => (b.used || b.at) - (a.used || a.at));
  btn.textContent = meta.length ? `Cache (${meta.length})` : 'Cache';
  btn.classList.toggle('has', meta.length > 0);
  if (!cacheOpen) { box.hidden = true; return; }

  const total = meta.reduce((s, m) => s + (m.bytes || 0), 0);
  let est = null;
  try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { }
  const quota = est ? ` · browser reports ${bytesText(est.usage)} of ${bytesText(est.quota)} used` : '';

  const rows = meta.length ? meta.map(m => {
    const stale = m.v !== CACHE_V;
    return `<tr class="${stale ? 'stale' : ''}">
      <td class="cid">#${escapeHTML(m.cid)}</td>
      <td class="nm">${escapeHTML(m.name || '—')}</td>
      <td class="num">${m.teams ? fmtInt(m.teams) : '—'}</td>
      <td class="num">${bytesText(m.bytes)}</td>
      <td class="num">${agoText(Date.now() - (m.used || m.at))} ago</td>
      <td class="act">
        <a href="#" data-open="${escapeHTML(m.cid)}">open</a>
        <a href="#" data-del="${escapeHTML(m.cid)}">delete</a>
      </td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">nothing cached yet</td></tr>';

  box.hidden = false;
  box.innerHTML =
    `<div class="cb-head"><b>Local cache</b>` +
    `<span class="dim">${meta.length} contest${meta.length === 1 ? '' : 's'} · ` +
    `${total ? bytesText(total) : '0 B'} packed${quota}</span>` +
    `<a href="#" id="cb-close" class="right">close</a></div>` +
    `<table class="cb"><thead><tr><th>contest</th><th>name</th><th class="num">teams</th>` +
    `<th class="num">size</th><th class="num">last used</th><th></th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    (meta.length ? `<div class="cb-foot"><a href="#" id="cb-clear">clear all</a>` +
      `<span class="dim">keeps at most ${CACHE_MAX_ENTRIES} contests and ` +
      `${bytesText(CACHE_MAX_BYTES)}, dropping the least recently used</span></div>` : '') +
    (_cacheErr ? `<div class="cb-err">cache unavailable: ${escapeHTML(_cacheErr)}</div>` : '');

  $('cb-close').onclick = ev => { ev.preventDefault(); cacheOpen = false; renderCacheBox(); };
  if ($('cb-clear')) $('cb-clear').onclick = async ev => {
    ev.preventDefault();
    await cacheClear();
    await renderCacheBox();
  };
  box.querySelectorAll('a[data-open]').forEach(a => a.onclick = ev => {
    ev.preventDefault();
    const cid = a.dataset.open;
    cacheOpen = false; renderCacheBox();
    $('cid').value = cid;
    location.hash = '#' + cid;
    load(parseInt(cid, 10), false);
  });
  box.querySelectorAll('a[data-del]').forEach(a => a.onclick = async ev => {
    ev.preventDefault();
    await cacheDel(a.dataset.del);
    if (String(state.cid) === a.dataset.del) $('cache').hidden = true;
    await renderCacheBox();
  });
}

async function toggleCacheBox() {
  cacheOpen = !cacheOpen;
  await renderCacheBox();
}

async function load(cid, force) {
  state.cid = cid;
  state.probs = []; state.idx = 0; hoverP = null; state.statsBuilt = false;
  state.fetchNote = '';
  errBox.hidden = true;
  $('view').hidden = true;
  $('cache').hidden = true;
  $('paneStats').textContent = '';
  $('go').disabled = true;
  P.reset();

  if (!force) {
    const cached = await cacheGet(String(cid));
    if (cached) {
      P.phase('draw');
      P.within('draw', .5, 'Restoring from cache…');
      hydrate(cached);
      P.within('draw', 1, 'Done');
      P.allDone();
      setTimeout(() => { P.box.hidden = true; }, 300);
      showCacheHint(await cacheMeta(cid));
      $('go').disabled = false;
      $('refresh').hidden = false;
      renderCacheBox();
      return;
    }
  }

  try {
    /* 1. standings -------------------------------------------------------- */
    P.phase('standings');
    P.within('standings', .12, 'Fetching standings…');
    const st = await apiJSON(`contest.standings?contestId=${cid}`, (got, tot) => {
      if (tot) P.within('standings', Math.min(.95, got / tot));
    });
    const official = new Set();
    let teams = 0;
    for (const row of st.rows) {
      for (const m of row.party.members) official.add(m.handle);
      teams++;
    }
    P.within('standings', 1, `Official standings: ${fmtInt(teams)} teams`);
    await sleep(RATE_GAP);

    /* 2. submissions ------------------------------------------------------ */
    P.phase('subs');
    // Gallop for the in-contest block rather than paging through the practice
    // head. `lo` always stays on the practice side, so the final fetch from
    // there cannot miss an in-contest row; it only re-downloads at most one
    // stride of practice rows.
    let lo = 1, hi = null, at = SEEK_STEP, probes = 0;
    for (;;) {
      const row = await probeAt(cid, at);
      probes++;
      P.within('subs', Math.min(.28, .05 * probes),
        `Looking for the in-contest block · offset ${fmtInt(at)}`);
      if (pastPractice(row)) { hi = at; break; }
      lo = at;
      if (at >= SEEK_LIMIT) { hi = at; break; }
      at *= 2;
      await sleep(RATE_GAP);
    }
    while (hi - lo > SEEK_STEP) {
      const mid = (lo + hi) >> 1;
      const row = await probeAt(cid, mid);
      probes++;
      if (pastPractice(row)) hi = mid; else lo = mid;
      P.within('subs', Math.min(.28, .05 * probes),
        `Narrowing the boundary · within ${fmtInt(hi - lo)} rows`);
      await sleep(RATE_GAP);
    }

    await sleep(RATE_GAP);
    let raw = [], cap = FETCH_CAP;
    for (;;) {
      try {
        raw = await apiJSON(`contest.status?contestId=${cid}&from=${lo}&count=${cap}`,
          (got, tot) => {
            const cur = tot ? Math.min(1, got / tot) : 0;
            P.within('subs', .32 + .62 * cur,
              `Fetching the tail from offset ${fmtInt(lo)} · ${(got / 1048576).toFixed(1)} MB`);
          });
        break;
      } catch (e) {
        if (cap > 10000) { cap = Math.floor(cap / 2); await sleep(RATE_GAP); continue; }
        throw e;
      }
    }
    state.fetchNote = raw.length >= cap
      ? `the API returned the ${fmtInt(raw.length)}-row request cap, so older rows are missing`
      : '';
    P.within('subs', 1,
      `${fmtInt(raw.length)} rows from offset ${fmtInt(lo)} · ${probes + 1} requests`);

    /* 3. pre-contest ratings ---------------------------------------------- */
    P.phase('rating');
    P.within('rating', .15, 'Fetching pre-contest ratings…');
    const rating = new Map();
    try {
      const rc = await apiJSON(`contest.ratingChanges?contestId=${cid}`);
      for (const x of rc) if (x.oldRating) rating.set(x.handle, x.oldRating);
      P.within('rating', 1, `${fmtInt(rating.size)} rated participants`);
    } catch (e) {
      const handles = [...official].filter(h => !h.includes(';'));
      let done = 0;
      for (let i = 0; i < handles.length; i += 300) {
        const chunk = handles.slice(i, i + 300);
        await sleep(RATE_GAP);
        try {
          const info = await apiJSON('user.info?handles=' + chunk.join(';'));
          for (const u of info) if (u.rating) rating.set(u.handle, u.rating);
        } catch (e2) { /* unrated accounts break the batch; skip it */ }
        done += chunk.length;
        P.within('rating', .15 + .85 * done / Math.max(handles.length, 1),
          `Ratings (current-rating fallback): ${fmtInt(rating.size)}`);
      }
    }
    await sleep(RATE_GAP);

    /* 4. shape / difficulty / cache / draw -------------------------------- */
    P.phase('draw');
    P.within('draw', .2, 'Shaping submissions…');
    const probs = shape(raw, official, st.problems);
    if (!probs.length) throw new Error('no contestant submissions available (permission needed, or not a rated contest)');

    const solvers = new Set();
    for (const p of probs) for (const h of p.solved) solvers.add(h);
    const meta = { teams, solvers: solvers.size };

    P.within('draw', .7, 'Writing cache…');
    const packed = packContest(cid,
      { name: st.contest.name, duration: st.contest.durationSeconds || 7200 },
      meta, probs, official, rating);
    const rows = probs.reduce((s, p) => s + p.all.length + p.points.length, 0);
    const ok = await cachePut(cid, packed, {
      name: st.contest.name, teams, rows, bytes: packedBytes(packed)
    });
    P.within('draw', .92, ok ? 'Cached locally' : 'Cache unavailable' + (_cacheErr ? ': ' + _cacheErr : ''));
    hydrate(packed);
    P.within('draw', 1, 'Done');
    P.allDone();
    setTimeout(() => { P.box.hidden = true; }, 700);
    $('refresh').hidden = false;
    renderCacheBox();
  } catch (e) {
    fail('Load failed: ' + (e && e.message ? e.message : e));
    P.box.hidden = true;
    $('refresh').hidden = !!state.cid;
  } finally {
    $('go').disabled = false;
  }
}

function hydrate(packed) {
  state.contest = packed.contest;
  state.meta = packed.meta;
  state.cid = packed.cid;
  state.at = packed.at;
  state.probs = unpackContest(packed);
  state.idx = 0;
  state.statsBuilt = false;
  hoverP = null;
  $('paneStats').textContent = '';
  $('view').hidden = false;
  renderTabs();
  renderAll();
  setView('scatter');
}

/* ---------------------------------------------------------------------- wiring */
$('bar').addEventListener('submit', ev => {
  ev.preventDefault();
  const cid = parseInt($('cid').value.trim(), 10);
  if (!cid || cid < 1) return;
  location.hash = '#' + cid;
  load(cid, false);
});
$('refresh').addEventListener('click', () => load(state.cid, true));
$('cachebtn').addEventListener('click', toggleCacheBox);
document.querySelectorAll('.vw').forEach(b => {
  b.addEventListener('click', () => setView(b.dataset.v));
});
window.addEventListener('resize', () => { if (!$('paneScatter').hidden) resize(); });

(function boot() {
  renderCacheBox();                       // labels the Cache button with the entry count
  const m = location.hash.match(/#(\d+)/);
  if (m) { $('cid').value = m[1]; load(parseInt(m[1], 10), false); }
})();
