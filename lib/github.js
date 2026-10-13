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
  return { files };
}

async function loadScans(nDays) {
  assertConfigured();
  const { repo, branch, dir, api } = cfg();
  const { files, note } = await listDataFiles();
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
  return { scans, files: pick, warnings, note };
}

module.exports = { loadScans, listDataFiles, cache };
