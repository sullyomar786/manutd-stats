'use strict';
/*
 * Reads the tracker's daily CSV files from the (private) GitHub data repo.
 * The token lives only in Vercel's environment variables — it never reaches the browser.
 * Parsed days are cached by file hash, so only a changed file (today's) is re-downloaded.
 */
const { parseFile } = require('./analyze');

const MAX_PARALLEL = 6;
const MAX_CACHED_FILES = 45;
const cache = new Map();              // "2026-10-12.csv@<sha>" -> parsed scans

function cfg() {
  return {
    repo: process.env.GITHUB_REPO,
    token: process.env.GITHUB_TOKEN,
    branch: process.env.GITHUB_BRANCH || 'main',
    dir: process.env.GITHUB_DATA_DIR || 'data',
    api: process.env.GITHUB_API_BASE || 'https://api.github.com',
  };
}

function explain(status, text) {
  if (status === 401) return 'GitHub rejected the token (401). Check GITHUB_TOKEN in the Vercel project settings.';
  if (status === 403) return `GitHub refused the request (403): rate limit, or the token lacks read access to the repo. ${String(text).slice(0, 100)}`;
  if (status === 404) return 'Repo or branch not found (404). Check GITHUB_REPO and GITHUB_BRANCH, and that the token can read that repo.';
  return `GitHub returned HTTP ${status}. ${String(text).slice(0, 100)}`;
}

async function ghFetch(url, accept, timeoutMs) {
  const { token } = cfg();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'manutd-stats' },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'GitHub took too long to respond.' : `Could not reach GitHub: ${e.message}`);
  } finally { clearTimeout(timer); }
}

function assertConfigured() {
  const { repo, token } = cfg();
  const missing = [!repo && 'GITHUB_REPO', !token && 'GITHUB_TOKEN'].filter(Boolean);
  if (missing.length) {
    const err = new Error(`Not set up yet: add ${missing.join(' and ')} in the Vercel project's Environment Variables, then redeploy.`);
    err.status = 500;
    throw err;
  }
}

async function listDataFiles() {
  const { repo, branch, dir, api } = cfg();
  const res = await ghFetch(`${api}/repos/${repo}/contents/${dir}?ref=${encodeURIComponent(branch)}`, 'application/vnd.github+json');
  if (res.status === 404) {
    // A missing data folder is normal before the first push. But a typo in the repo name also
    // gives 404 here, so check the repo itself before claiming "no data yet".
    const repoRes = await ghFetch(`${api}/repos/${repo}`, 'application/vnd.github+json');
    if (repoRes.status === 404) throw new Error(explain(404, ''));
    if (!repoRes.ok) throw new Error(explain(repoRes.status, await repoRes.text()));
    return { files: [], note: 'The tracker has not pushed any data yet (no data folder in the repo).' };
  }
  if (!res.ok) throw new Error(explain(res.status, await res.text()));
  const items = await res.json();
  const files = (Array.isArray(items) ? items : [])
    .filter(i => i.type === 'file' && /^\d{4}-\d{2}-\d{2}\.csv$/.test(i.name))
    .map(i => ({ name: i.name, sha: i.sha, size: i.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // live.csv = the round that is under way (the tracker pushes it after every game; the daily file catches up at round end)
  const liveItem = (Array.isArray(items) ? items : []).find(i => i.type === 'file' && i.name === 'live.csv');
  return { files, live: liveItem ? { name: liveItem.name, sha: liveItem.sha, size: liveItem.size } : null };
}

async function loadScans(nDays) {
  assertConfigured();
  const { repo, branch, dir, api } = cfg();
  const { files, live, note } = await listDataFiles();
  const pick = files.slice(-Math.max(1, nDays));
  const scans = [], warnings = [];
  let next = 0;

  async function worker() {
    while (next < pick.length) {
      const f = pick[next++];
      const key = `${f.name}@${f.sha}`;
      try {
        let parsed = cache.get(key);
        if (!parsed) {
          const res = await ghFetch(`${api}/repos/${repo}/contents/${dir}/${f.name}?ref=${encodeURIComponent(branch)}`, 'application/vnd.github.raw+json', 40000);
          if (!res.ok) throw new Error(explain(res.status, await res.text()));
          parsed = parseFile(await res.text());
          for (const k of [...cache.keys()]) if (k.startsWith(f.name + '@')) cache.delete(k);   // drop the older version of this day
          cache.set(key, parsed);
          while (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value);
        }
        for (const s of parsed) scans.push(s);
      } catch (e) { warnings.push(`${f.name}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, pick.length) }, worker));

  // Add the games from live.csv that the daily files don't have yet (same game + same timestamp = same scan, so no double counting).
  if (live) {
    try {
      const key = `${live.name}@${live.sha}`;
      let parsed = cache.get(key);
      if (!parsed) {
        const res = await ghFetch(`${api}/repos/${repo}/contents/${dir}/${live.name}?ref=${encodeURIComponent(branch)}`, 'application/vnd.github.raw+json', 25000);
        if (!res.ok) throw new Error(explain(res.status, await res.text()));
        parsed = parseFile(await res.text());
        for (const k of [...cache.keys()]) if (k.startsWith(live.name + '@')) cache.delete(k);
        cache.set(key, parsed);
      }
      const seen = new Set(scans.map(s => s.ts + '|' + s.fixture));
      for (const s of parsed) if (!seen.has(s.ts + '|' + s.fixture)) scans.push(s);
    } catch (e) { warnings.push(`live.csv: ${e.message}`); }
  }
  return { scans, files: pick, warnings, note };
}

/*
 * The tracker also pushes a tiny status.json next to the CSVs (running / blocked until X / CAPTCHA pause /
 * stopped). It is optional: if it is missing or unreadable the dashboard simply shows no status notice.
 */
const STATUS_STATES = ['running', 'blocked', 'captcha', 'stopped'];
let statusCache = { at: 0, value: null };

function cleanStatus(j) {
  if (!j || typeof j !== 'object' || !STATUS_STATES.includes(j.state)) return null;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out = { state: j.state, updated: num(j.updated) };
  if (out.updated == null) return null;
  for (const k of ['until', 'ramp_until', 'blocked_at', 'cooldown_hours', 'level']) if (num(j[k]) != null) out[k] = num(j[k]);
  if (typeof j.message === 'string') out.message = j.message.slice(0, 200);
  if (j.round && typeof j.round === 'object') {            // the tracker's current/last scan round
    const r = { in_progress: j.round.in_progress === true };
    for (const k of ['n', 'started', 'completed', 'total']) if (num(j.round[k]) != null) r[k] = num(j.round[k]);
    out.round = r;
  }
  return out;
}

async function loadStatus() {
  if (Date.now() - statusCache.at < 20000) return statusCache.value;     // at most one GitHub call per 20 s
  assertConfigured();
  const { repo, branch, dir, api } = cfg();
  const res = await ghFetch(`${api}/repos/${repo}/contents/${dir}/status.json?ref=${encodeURIComponent(branch)}`, 'application/vnd.github.raw+json', 10000);
  let value = null;
  if (res.status === 200) { try { value = cleanStatus(JSON.parse(await res.text())); } catch (e) { value = null; } }
  else if (res.status !== 404) throw new Error(explain(res.status, await res.text()));
  statusCache = { at: Date.now(), value };
  return value;
}

module.exports = { loadScans, listDataFiles, loadStatus, cleanStatus, cache };
