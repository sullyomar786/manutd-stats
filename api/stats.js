'use strict';
const { loadScans } = require('../lib/github');
const { analyze, nowInTz } = require('../lib/analyze');

const clamp = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

module.exports = async (req, res) => {
  try {
    // Optional access key: set DASHBOARD_KEY in Vercel to keep the page private.
    const key = process.env.DASHBOARD_KEY;
    if (key) {
      const sent = req.headers['x-dashboard-key'] || '';
      if (sent !== key) { res.setHeader('Cache-Control', 'no-store'); return res.status(401).json({ error: 'unauthorized' }); }
    }

    const q = req.query || {};
    const hours = clamp(q.hours, 6, 24 * 45, 168);
    const threshold = clamp(q.threshold, 3, 500, 20);
    const fixture = typeof q.fixture === 'string' && q.fixture ? q.fixture : 'all';

    const { scans, files, warnings, note } = await loadScans(Math.ceil(hours / 24) + 1);
    const out = analyze(scans, { hours, threshold, fixture, nowMs: nowInTz(process.env.DATA_TZ || 'Europe/London') });
    out.files = files.map(f => ({ name: f.name, kb: Math.round((f.size || 0) / 1024) }));
    if (warnings.length) out.warnings = warnings;
    if (note && out.empty) out.note = note;

    res.setHeader('Cache-Control', key ? 'no-store' : 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(out);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(e.status || 502).json({ error: e.message || 'Something went wrong.' });
  }
};
