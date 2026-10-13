'use strict';
/*
 * Turns the tracker's raw CSV rows into dashboard statistics.
 * Pure functions (no network, no Vercel) so they can be tested on their own.
 *
 * Vocabulary
 *   scan      one fixture checked once (all rows sharing a timestamp + fixture)
 *   complete  every section loaded fine — only complete scans are compared, so a
 *             half-loaded page can never fake a "drop" or a "sell-out"
 *   release   seats went UP by >= RELEASE_MIN between two consecutive complete scans
 *   drop      a release of >= the chosen threshold (default 20) — what the tracker alerts on
 *
 * Timestamps in the CSV are the PC's local clock with no timezone. They're read as
 * plain wall-clock numbers (Date.UTC + getUTC*) so they display exactly as logged.
 */

const HOUR = 3600000;
const MAX_GAP_MS = 3 * HOUR;
const RELEASE_MIN = 5;
const SELL_FRACTION = 0.25;
const UCL_HINTS = ['bayern', 'leipzig', 'roma', 'sabah'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BUCKETS = [[1, 4, '1–4'], [5, 9, '5–9'], [10, 19, '10–19'], [20, 39, '20–39'], [40, 79, '40–79'], [80, Infinity, '80+']];
const TIER_ORDER = { Lower: 0, Middle: 1, Upper: 2, Other: 3 };

// ───────────────────────────── parsing ─────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const toNum = v => { if (v === '' || v == null) return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const stripGA = n => String(n || '').replace(/\s*\(GA\)\s*$/i, '').trim();

// "Upper SAF (N4407)" -> { stand: "Upper SAF", tier: "Upper", base: "SAF" }
function splitStand(raw) {
  const s = String(raw || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!s || /^uncatalogued/i.test(s)) return { stand: 'Uncatalogued', tier: 'Other', base: 'Uncatalogued' };
  const m = /^(Upper|Middle|Lower)\s+(.*)$/.exec(s);
  return m ? { stand: s, tier: m[1], base: m[2] } : { stand: s, tier: 'Other', base: s };
}

function parseFile(text) {
  const rows = parseCSV(String(text).replace(/^\uFEFF/, ''));
  if (rows.length < 2) return [];
  const ix = {};
  rows[0].forEach((h, i) => { ix[h.trim()] = i; });
  if (ix.timestamp === undefined || ix.fixture_name === undefined) return [];
  const g = (r, k) => (ix[k] === undefined || r[ix[k]] === undefined ? '' : r[ix[k]]);

  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 3) continue;
    const ts = g(r, 'timestamp');
    const t = parseTs(ts);
    if (t === null) continue;
    const fixture = stripGA(g(r, 'fixture_name'));
    if (!fixture) continue;
    const key = ts + '|' + fixture;
    let s = map.get(key);
    if (!s) {
      s = { ts, t, fixture, ga: false, total: 0, hosp: 0, noSections: false, checkFailed: false, bad: 0, sections: [], statuses: {} };
      map.set(key, s);
    }
    if (g(r, 'is_ga') === 'True') s.ga = true;
    s.total = toInt(g(r, 'fixture_total_non_hosp'));
    s.hosp = toInt(g(r, 'fixture_total_hosp'));
    if (g(r, 'no_sections_found') === 'True') s.noSections = true;
    const code = g(r, 'section_code');
    const status = g(r, 'section_status');
    if (status === 'fixture_check_failed') { s.checkFailed = true; s.statuses[status] = (s.statuses[status] || 0) + 1; }
    if (code) {
      const st = splitStand(g(r, 'section_stand_name'));
      if (status !== 'ok') s.bad++;
      s.statuses[status || 'unknown'] = (s.statuses[status || 'unknown'] || 0) + 1;
      s.sections.push({
        code, status, stand: st.stand, tier: st.tier, base: st.base,
        n: toInt(g(r, 'section_non_hosp_count')),
        adj: toInt(g(r, 'section_pairs_adjacent')), beh: toInt(g(r, 'section_pairs_behind')), dia: toInt(g(r, 'section_pairs_diagonal')),
        adult: toNum(g(r, 'section_adult_price')),
      });
    }
  }
  const scans = [...map.values()];
  for (const s of scans) {
    s.complete = !s.checkFailed && s.bad === 0 && (s.sections.length > 0 || s.noSections);
    s.pairs = { adj: 0, beh: 0, dia: 0 };
    s.byCode = {};
    s.standOf = {};
    for (const sec of s.sections) {
      s.pairs.adj += sec.adj; s.pairs.beh += sec.beh; s.pairs.dia += sec.dia;
      s.byCode[sec.code] = sec.n;
      s.standOf[sec.code] = sec.stand;
    }
  }
  return scans;
}

// ───────────────────────────── helpers ─────────────────────────────
const pad = n => String(n).padStart(2, '0');
function fmtT(t) {
  const d = new Date(t);
  return `${DAY_NAMES[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function median(a) {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y), m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
const isUcl = name => UCL_HINTS.some(h => name.toLowerCase().includes(h));

function nowInTz(tz, nowMs) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(nowMs == null ? Date.now() : nowMs));
  const g = Object.fromEntries(p.map(x => [x.type, x.value]));
  return Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute, +g.second);
}

// keep the biggest value in each time bucket so spikes (drops) survive thinning
function downsample(pts, max) {
  if (pts.length <= max) return pts;
  const size = pts.length / max, out = [pts[0]];
  for (let i = 0; i < max; i++) {
    const a = Math.floor(i * size), b = Math.min(pts.length, Math.floor((i + 1) * size));
    let best = null;
    for (let j = a; j < b; j++) if (best === null || pts[j][1] > best[1]) best = pts[j];
    if (best && best !== out[out.length - 1]) out.push(best);
  }
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

const zeros2d = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
const dayHour = t => { const d = new Date(t); return [(d.getUTCDay() + 6) % 7, d.getUTCHours()]; };

function blockGains(prev, cur) {
  const out = [];
  for (const [code, n] of Object.entries(cur.byCode)) {
    const d = n - (prev.byCode[code] || 0);
    if (d > 0) out.push({ code, stand: cur.standOf[code], delta: d });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

// how long until a drop's surplus was snapped up again
function sellThrough(comp, i, from, to) {
  const target = from + (to - from) * SELL_FRACTION;
  for (let j = i + 1; j < comp.length; j++) {
    if (comp[j].t - comp[j - 1].t > MAX_GAP_MS) return { state: 'unknown', min: null };
    if (comp[j].total <= target) return { state: 'sold', min: Math.round((comp[j].t - comp[i].t) / 60000) };
  }
  if (i === comp.length - 1) return { state: 'unknown', min: null };
  return { state: 'open', min: Math.round((comp[comp.length - 1].t - comp[i].t) / 60000) };
}

// ───────────────────────────── analysis ─────────────────────────────
function emptyResult(opts, note) {
  return {
    generatedAt: new Date().toISOString(), params: { hours: opts.hours, threshold: opts.threshold, fixture: opts.fixture || 'all' },
    empty: true, note: note || 'No data yet.',
    tracker: { state: 'nodata', lastScan: null, minutesAgo: null, cycles: 0, medianCycleMin: null },
    fixtures: [], drops: [], stats: {}, trends: {}, blocks: [], stands: [], fixtureStats: [], ga: [],
    competition: {}, quality: {}, insights: [],
  };
}

function analyze(allScans, opts = {}) {
  const hours = opts.hours || 168;
  const threshold = Math.max(1, opts.threshold || 20);
  const fixtureFilter = opts.fixture && opts.fixture !== 'all' ? opts.fixture : null;
  const o = { hours, threshold, fixture: fixtureFilter || 'all' };
  if (!allScans.length) return emptyResult(o, 'No data yet — the tracker has not pushed any scans.');

  const scans = allScans.slice().sort((a, b) => a.t - b.t);
  const latestT = scans[scans.length - 1].t;
  const cutoff = latestT - hours * HOUR;

  const byFx = new Map();
  for (const s of scans) { if (!byFx.has(s.fixture)) byFx.set(s.fixture, []); byFx.get(s.fixture).push(s); }

  // ── events: change in seats between consecutive COMPLETE scans of one fixture
  const events = [];
  const compByFx = new Map();
  for (const [fx, arr] of byFx) {
    const comp = arr.filter(s => s.complete);
    compByFx.set(fx, comp);
    for (let i = 1; i < comp.length; i++) {
      const prev = comp[i - 1], cur = comp[i];
      if (cur.t - prev.t > MAX_GAP_MS) continue;
      const ev = { fixture: fx, t: cur.t, ts: cur.ts, prevT: prev.t, from: prev.total, to: cur.total, delta: cur.total - prev.total, ga: cur.ga };
      if (ev.delta >= RELEASE_MIN) {
        ev.blocks = blockGains(prev, cur).slice(0, 8);
        ev.pairs = { adj: cur.pairs.adj - prev.pairs.adj, beh: cur.pairs.beh - prev.pairs.beh, dia: cur.pairs.dia - prev.pairs.dia };
        const st = sellThrough(comp, i, ev.from, ev.to);
        ev.sellState = st.state; ev.sellMin = st.min;
      }
      events.push(ev);
    }
  }
  const inScope = e => e.t >= cutoff && (!fixtureFilter || e.fixture === fixtureFilter);
  const scoped = events.filter(inScope);
  const drops = scoped.filter(e => e.delta >= threshold).sort((a, b) => b.t - a.t);
  const releases = scoped.filter(e => e.delta >= RELEASE_MIN);

  // ── when do releases happen (rate per scan interval, so uneven sampling doesn't mislead)
  const heatRel = zeros2d(), heatDrop = zeros2d(), heatScans = zeros2d();
  for (const e of scoped) {
    const [wd, hr] = dayHour(e.t);
    heatScans[wd][hr]++;
    if (e.delta >= RELEASE_MIN) heatRel[wd][hr]++;
    if (e.delta >= threshold) heatDrop[wd][hr]++;
  }
  const sum24 = m => Array.from({ length: 24 }, (_, h) => m.reduce((s, row) => s + row[h], 0));
  const hourly = { drops: sum24(heatDrop), releases: sum24(heatRel), scans: sum24(heatScans) };
  const weekday = {
    drops: heatDrop.map(r => r.reduce((a, b) => a + b, 0)),
    releases: heatRel.map(r => r.reduce((a, b) => a + b, 0)),
    scans: heatScans.map(r => r.reduce((a, b) => a + b, 0)),
  };

  const increases = scoped.filter(e => e.delta > 0);
  const histogram = BUCKETS.map(([lo, hi, label]) => ({ label, count: increases.filter(e => e.delta >= lo && e.delta <= hi).length }));
  const seatsGained = increases.reduce((s, e) => s + e.delta, 0);
  const seatsInDrops = drops.reduce((s, e) => s + e.delta, 0);

  // ── series for charts (complete scans only, in range)
  const series = {};
  for (const [fx, comp] of compByFx) {
    const pts = comp.filter(s => s.t >= cutoff).map(s => [s.t, s.total, s.pairs.adj + s.pairs.beh + s.pairs.dia, s.pairs.adj]);
    if (pts.length) series[fx] = downsample(pts, 700);
  }

  // ── block / stand abundance (complete scans in range)
  const rangeComplete = [];
  for (const [fx, comp] of compByFx) {
    if (fixtureFilter && fx !== fixtureFilter) continue;
    for (const s of comp) if (s.t >= cutoff) rangeComplete.push(s);
  }
  const bAgg = new Map(), sAgg = new Map();
  for (const s of rangeComplete) {
    const perStand = new Map();
    for (const sec of s.sections) {
      let b = bAgg.get(sec.code);
      if (!b) { b = { code: sec.code, stand: sec.stand, tier: sec.tier, base: sec.base, appear: 0, sum: 0, max: 0, adj: 0, priceSum: 0, priceN: 0 }; bAgg.set(sec.code, b); }
      if (sec.n > 0) {
        b.appear++; b.sum += sec.n; b.max = Math.max(b.max, sec.n); b.adj += sec.adj;
        if (sec.adult != null) { b.priceSum += sec.adult; b.priceN++; }
      }
      const key = sec.tier + '|' + sec.base;
      let p = perStand.get(key);
      if (!p) { p = { tier: sec.tier, base: sec.base, stand: sec.stand, n: 0, adj: 0 }; perStand.set(key, p); }
      p.n += sec.n; p.adj += sec.adj;
    }
    for (const [key, p] of perStand) {
      let a = sAgg.get(key);
      if (!a) { a = { stand: p.stand, tier: p.tier, base: p.base, appear: 0, sum: 0, max: 0, adj: 0 }; sAgg.set(key, a); }
      if (p.n > 0) { a.appear++; a.sum += p.n; a.max = Math.max(a.max, p.n); a.adj += p.adj; }
    }
  }
  const nScans = rangeComplete.length;
  const pct = x => (nScans ? Math.round((x / nScans) * 1000) / 10 : 0);
  const blocks = [...bAgg.values()].map(b => ({
    code: b.code, stand: b.stand, tier: b.tier, appearPct: pct(b.appear), avgAll: round1(nScans ? b.sum / nScans : 0),
    avgWhenOpen: round1(b.appear ? b.sum / b.appear : 0), max: b.max, avgAdjPairs: round1(nScans ? b.adj / nScans : 0),
    avgAdult: b.priceN ? Math.round((b.priceSum / b.priceN) * 100) / 100 : null,
  })).filter(b => b.max > 0).sort((a, b) => b.avgAll - a.avgAll).slice(0, 30);
  const stands = [...sAgg.values()].map(a => ({
    stand: a.stand, tier: a.tier, base: a.base, appearPct: pct(a.appear), avgSeats: round1(nScans ? a.sum / nScans : 0), max: a.max,
  })).filter(a => a.max > 0).sort((a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (b.appearPct - a.appearPct));

  // ── fixture cards
  const fixtureNames = [...byFx.keys()].filter(fx => byFx.get(fx).some(s => s.t >= cutoff)).sort();
  const fixtures = fixtureNames.map(fx => {
    const arr = byFx.get(fx), comp = compByFx.get(fx);
    const last = arr[arr.length - 1];
    const cur = comp[comp.length - 1] || null;
    const fxEvents = events.filter(e => e.fixture === fx);
    const lastDrop = [...fxEvents].reverse().find(e => e.delta >= threshold) || null;
    const spark = comp.filter(s => s.t >= latestT - 24 * HOUR).map(s => [s.t, s.total]);
    const inRange = fxEvents.filter(e => e.t >= cutoff);
    return {
      name: fx, ga: last.ga, ucl: isUcl(fx),
      lastScan: last.ts, lastScanT: last.t, lastScanComplete: last.complete,
      minutesBehind: Math.round((latestT - last.t) / 60000),
      now: cur ? { ts: cur.ts, t: cur.t, seats: cur.total, adj: cur.pairs.adj, beh: cur.pairs.beh, dia: cur.pairs.dia,
        noSections: cur.noSections,
        blocks: Object.entries(cur.byCode).filter(([, n]) => n > 0).map(([code, n]) => ({ code, stand: cur.standOf[code], n }))
          .sort((a, b) => b.n - a.n).slice(0, 5) } : null,
      lastDrop: lastDrop ? { t: lastDrop.t, ts: lastDrop.ts, delta: lastDrop.delta } : null,
      spark: downsample(spark, 60),
      releasesInRange: inRange.filter(e => e.delta >= RELEASE_MIN).length,
      dropsInRange: inRange.filter(e => e.delta >= threshold).length,
    };
  });

  // ── per-fixture stats, UCL vs PL, GA flips
  const fixtureStats = fixtureNames.map(fx => {
    const ev = events.filter(e => e.fixture === fx && e.t >= cutoff);
    const rel = ev.filter(e => e.delta >= RELEASE_MIN), dr = ev.filter(e => e.delta >= threshold);
    return { fixture: fx, ucl: isUcl(fx), intervals: ev.length, releases: rel.length, drops: dr.length,
      biggest: rel.length ? Math.max(...rel.map(e => e.delta)) : 0, medianRelease: rel.length ? median(rel.map(e => e.delta)) : null,
      releasesPer100: ev.length ? round1((rel.length / ev.length) * 100) : null };
  });
  const comp = { ucl: { fixtures: 0, intervals: 0, releases: 0, drops: 0 }, pl: { fixtures: 0, intervals: 0, releases: 0, drops: 0 } };
  for (const f of fixtureStats) {
    const k = f.ucl ? comp.ucl : comp.pl;
    k.fixtures++; k.intervals += f.intervals; k.releases += f.releases; k.drops += f.drops;
  }
  for (const k of [comp.ucl, comp.pl]) k.releasesPer100 = k.intervals ? round1((k.releases / k.intervals) * 100) : null;

  const ga = [];
  for (const fx of fixtureNames) {
    const arr = byFx.get(fx), idx = arr.findIndex(s => s.ga);
    if (idx > 0) {
      const before = arr.slice(0, idx).filter(s => s.complete).slice(-6).map(s => s.total);
      const after = arr.slice(idx).filter(s => s.complete).slice(0, 6).map(s => s.total);
      ga.push({ fixture: fx, since: arr[idx].ts, sinceT: arr[idx].t, avgBefore: round1(mean(before)), avgAfter: round1(mean(after)) });
    }
  }

  // ── data quality
  const inRange = scans.filter(s => s.t >= cutoff);
  const statusCounts = {};
  for (const s of inRange) for (const [k, v] of Object.entries(s.statuses)) statusCounts[k] = (statusCounts[k] || 0) + v;
  const cycleTimes = [...new Set(inRange.map(s => s.t))].sort((a, b) => a - b);
  const cycleGaps = [];
  for (let i = 1; i < cycleTimes.length; i++) cycleGaps.push(cycleTimes[i] - cycleTimes[i - 1]);
  const offline = [];
  for (let i = 1; i < cycleTimes.length; i++) {
    const gap = cycleTimes[i] - cycleTimes[i - 1];
    if (gap > 75 * 60000) offline.push({ from: fmtT(cycleTimes[i - 1]), to: fmtT(cycleTimes[i]), minutes: Math.round(gap / 60000) });
  }
  const completeN = inRange.filter(s => s.complete).length;
  const quality = {
    scans: inRange.length, complete: completeN, completePct: inRange.length ? Math.round((completeN / inRange.length) * 1000) / 10 : 0,
    statusCounts, cycles: cycleTimes.length, medianCycleMin: cycleGaps.length ? Math.round(median(cycleGaps) / 60000) : null,
    offline: offline.slice(-10),
  };

  // ── tracker health (compares to "now" in the data's own timezone)
  const minutesAgo = opts.nowMs != null ? Math.max(0, Math.round((opts.nowMs - latestT) / 60000)) : null;
  const tracker = {
    lastScan: scans[scans.length - 1].ts, lastScanT: latestT, minutesAgo, cycles: cycleTimes.length, medianCycleMin: quality.medianCycleMin,
    state: minutesAgo == null ? 'unknown' : minutesAgo <= 60 ? 'live' : minutesAgo <= 180 ? 'delayed' : 'offline',
  };

  // ── plain-English insights
  const insights = [];
  const label = hours % 24 === 0 ? (hours === 24 ? '24 hours' : `${hours / 24} days`) : `${hours} hours`;
  if (drops.length) {
    const d = drops[0], top = d.blocks && d.blocks[0];
    insights.push(`Latest drop: +${d.delta} seats for ${d.fixture}${d.ga ? ' (GA)' : ''} on ${fmtT(d.t)}${top ? `, mostly ${top.stand} (${top.code})` : ''}.`);
    const sizes = drops.map(x => x.delta), sold = drops.filter(x => x.sellState === 'sold').map(x => x.sellMin);
    insights.push(`${drops.length} drop${drops.length === 1 ? '' : 's'} of ${threshold}+ seats in the last ${label}; the typical one is +${Math.round(median(sizes))}.`);
    if (sold.length >= 3) insights.push(`Drops usually sell back down within ${Math.round(median(sold))} min (median of ${sold.length}).`);
    else if (sold.length) insights.push(`${sold.length === 1 ? 'The one drop' : 'The drops'} measured so far sold back down in about ${Math.round(median(sold))} min.`);
  } else {
    insights.push(`No drops of ${threshold}+ seats in the last ${label}.`);
  }
  if (seatsGained > 0 && increases.length >= 5) {
    insights.push(`${Math.round((seatsInDrops / seatsGained) * 100)}% of all new seats arrived in drops of ${threshold}+; the rest trickled in.`);
  }
  const hourRates = hourly.scans.map((n, h) => ({ h, n, r: n >= 5 ? hourly.releases[h] / n : -1 })).filter(x => x.r >= 0 && hourly.releases[x.h] >= 3);
  if (hourRates.length) {
    const best = hourRates.sort((a, b) => b.r - a.r)[0];
    insights.push(`New seats show up most often around ${pad(best.h)}:00–${pad((best.h + 1) % 24)}:00 (${Math.round(best.r * 100)} releases per 100 scans).`);
  }
  const bestStand = [...stands].sort((a, b) => b.appearPct - a.appearPct)[0];
  if (bestStand && bestStand.appearPct > 0) insights.push(`${bestStand.stand} has seats in ${bestStand.appearPct}% of scans, more than any other stand.`);
  if (quality.scans && quality.completePct < 90) insights.push(`Only ${quality.completePct}% of scans loaded fully, so counts may be understated.`);

  return {
    generatedAt: new Date().toISOString(), params: o, empty: false,
    dataRange: { from: scans[0].ts, to: scans[scans.length - 1].ts },
    tracker, fixtures,
    drops: drops.slice(0, 60),
    stats: { drops: drops.length, releases: releases.length, seatsGained, seatsInDrops, dropPct: seatsGained ? Math.round((seatsInDrops / seatsGained) * 100) : 0 },
    trends: { series, hourly, weekday, heat: { releases: heatRel, drops: heatDrop, scans: heatScans }, histogram },
    blocks, stands, fixtureStats, ga, competition: comp, quality, insights,
  };
}

module.exports = { parseCSV, parseFile, analyze, nowInTz, fmtT, RELEASE_MIN };
