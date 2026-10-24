// Guest / contact details completion form — separate small service.
// Each recipient gets a personal link /c/<token>. Their own name is locked; guests' details are editable.
// Storage: PostgreSQL (DATABASE_URL), tables prefixed cf_. Without DATABASE_URL it uses a local JSON file (testing only).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DEADLINE = new Date(process.env.DEADLINE || '2026-10-27T18:00:00Z'); // Tue 27.10 20:00 Israel time
const PAGE = fs.readFileSync(path.join(__dirname, 'form.html'), 'utf8');
const ADMIN_PAGE = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const BANNER = fs.readFileSync(path.join(__dirname, 'banner.jpg'));
const TYPE_LABEL = { student: 'סטודנט/ית אונ׳ רייכמן', nonstudent: 'לא סטודנט/ית אונ׳ רייכמן' };

/* ---------------- storage ---------------- */
function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  const q = (t, p) => pool.query(t, p);
  return {
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS cf_links (
        token TEXT PRIMARY KEY, seed JSONB NOT NULL, response JSONB,
        submitted_at TIMESTAMPTZ, first_opened_at TIMESTAMPTZ, opened_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS cf_log (id SERIAL PRIMARY KEY, token TEXT, response JSONB, ip TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    },
    async upsertSeed(rows) {
      for (const r of rows) await q(`INSERT INTO cf_links(token, seed) VALUES($1,$2) ON CONFLICT(token) DO UPDATE SET seed=EXCLUDED.seed`, [r.token, JSON.stringify(r)]);
    },
    async get(token) { const r = await q(`SELECT * FROM cf_links WHERE token=$1`, [token]); return r.rows[0] || null; },
    async opened(token) { await q(`UPDATE cf_links SET opened_count=opened_count+1, first_opened_at=coalesce(first_opened_at, now()) WHERE token=$1`, [token]); },
    async save(token, response, ip) {
      await q(`UPDATE cf_links SET response=$2, submitted_at=now() WHERE token=$1`, [token, JSON.stringify(response)]);
      await q(`INSERT INTO cf_log(token, response, ip) VALUES($1,$2,$3)`, [token, JSON.stringify(response), ip]);
    },
    async all() { const r = await q(`SELECT * FROM cf_links ORDER BY created_at, token`); return r.rows; },
  };
}
function fileStore(file) {
  let data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const flush = () => fs.writeFileSync(file, JSON.stringify(data, null, 1));
  return {
    async init() {},
    async upsertSeed(rows) { for (const r of rows) data[r.token] = { ...(data[r.token] || { opened_count: 0, created_at: new Date() }), token: r.token, seed: r }; flush(); },
    async get(t) { return data[t] || null; },
    async opened(t) { const x = data[t]; if (x) { x.opened_count++; x.first_opened_at = x.first_opened_at || new Date(); flush(); } },
    async save(t, response) { Object.assign(data[t], { response, submitted_at: new Date() }); flush(); },
    async all() { return Object.values(data); },
  };
}
// On Render, never fall back to the local file (it is wiped on every deploy).
const NEEDS_DB = !!process.env.RENDER && !process.env.DATABASE_URL;
const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore(path.join(__dirname, 'local-data.json'));

function loadSeed() {
  const b64 = process.env.SEED_B64;
  if (!b64) return [];
  return JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
}

/* ---------------- validation ---------------- */
const clean = v => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120);
function israeliIdOk(v) {
  const d = String(v).replace(/\D/g, '');
  if (!d || d.length > 9) return false;
  const p = d.padStart(9, '0');
  let t = 0;
  for (let i = 0; i < 9; i++) { let x = +p[i] * (i % 2 + 1); t += x > 9 ? x - 9 : x; }
  return t % 10 === 0 && +d > 0;
}
function phoneNorm(v) {
  let d = String(v ?? '').replace(/[^\d+]/g, '');
  if (d.startsWith('+972')) d = '0' + d.slice(4);
  else if (d.startsWith('972') && d.length === 12) d = '0' + d.slice(3);
  if (/^05\d{8}$/.test(d)) return d;
  if (/^\+\d{8,15}$/.test(d)) return d;
  return null;
}
const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const uniEmail = v => /(^|[@.])runi\.ac\.il$/i.test(v.split('@')[1] || '');

function validate(seed, body) {
  const errors = {};
  const out = { self: {}, guests: [] };
  const s = body.self || {};
  const email = clean(s.email).toLowerCase(), phone = phoneNorm(s.phone);
  if (!emailOk(email)) errors['self.email'] = 'כתובת מייל לא תקינה';
  else if (uniEmail(email) && !seed.isGuest) errors['self.email'] = 'נא לרשום מייל אישי (לא של האוניברסיטה)';
  if (!phone) errors['self.phone'] = 'מספר נייד לא תקין';
  out.self = { email, phone: phone || clean(s.phone) };
  if (seed.askAttending) {
    if (!['yes', 'no'].includes(s.attending)) errors['self.attending'] = 'נא לבחור';
    out.self.attending = s.attending;
  }
  const expected = (seed.guests || []).length + (seed.newSlots || 0);
  const list = Array.isArray(body.guests) ? body.guests.slice(0, expected) : [];
  const seen = new Set();
  for (let i = 0; i < expected; i++) {
    const g = list[i] || {};
    const base = (seed.guests || [])[i];
    const name = clean(g.name);
    const raw = clean(g.idnum).replace(/[\s\-./]/g, '').toUpperCase();
    // Israeli ID if it passes the check digit; otherwise accept a passport / foreign ID (5–12 letters or digits),
    // except a 9-digit number that fails the check — most likely a typo — unless "passport" was ticked.
    const isIsraeli = /^\d{1,9}$/.test(raw) && israeliIdOk(raw);
    const foreign = !isIsraeli && /^[A-Z0-9]{5,12}$/.test(raw) && (!!g.foreign || !/^\d{9}$/.test(raw));
    const idnum = raw;
    const gphone = phoneNorm(g.phone), gemail = clean(g.email).toLowerCase();
    const k = `g${i}`;
    // A friend left completely empty is allowed: they stay "missing" and are handled at the exceptions desk.
    if (!base && !name && !idnum && !clean(g.phone) && !gemail) {
      out.guests.push({ key: `new${i - (seed.guests || []).length + 1}`, missing: true });
      continue;
    }
    if (!/\S+\s+\S+/.test(name)) errors[`${k}.name`] = 'נא לרשום שם פרטי ושם משפחה';
    if (!isIsraeli && !foreign) errors[`${k}.idnum`] = /^\d{9}$/.test(idnum)
      ? 'מספר ת״ז לא תקין. אם זה מספר דרכון, סמנו "דרכון / תושב חוץ"'
      : 'נא לרשום ת״ז או מספר דרכון (5–12 תווים)';
    else if (seen.has(idnum)) errors[`${k}.idnum`] = 'מספר זה כבר הוזן למשתתף אחר';
    seen.add(idnum);
    // Registered guests: phone is optional (without it the ticket goes to the buyer); new friends: required.
    if (!gphone && (!base || clean(g.phone))) errors[`${k}.phone`] = 'מספר נייד לא תקין';
    if (gemail && !emailOk(gemail)) errors[`${k}.email`] = 'כתובת מייל לא תקינה';
    out.guests.push({ key: base ? base.key : `new${i - (seed.guests || []).length + 1}`, name, idnum, foreign, phone: gphone || clean(g.phone), email: gemail });
  }
  return { errors, out };
}

/* ---------------- http helpers ---------------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 30;
}
function adminOk(req) {
  if (!ADMIN_PASSWORD) return false;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const embed = obj => JSON.stringify(obj).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
const maskId = v => { const d = String(v || ''); return d.length > 4 ? '•'.repeat(d.length - 4) + d.slice(-4) : d; };
const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const keep = v => (v && /^[0+]/.test(String(v)) ? `="${v}"` : v); // keep leading zeros in Excel
const csv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
const fmt = d => d ? new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '';

/* ---------------- views ---------------- */
function publicSeed(row) {
  const s = row.seed;
  return {
    name: s.name, idMasked: maskId(s.idnum), isGuest: !!s.isGuest, askAttending: !!s.askAttending,
    self: { email: s.email || '', phone: s.phone || '' },
    guests: (s.guests || []).map(g => ({ name: g.name || '', idnum: g.idnum || '', phone: g.phone || '', email: g.email || '', type: g.type || 'nonstudent' })),
    newSlots: s.newSlots || 0,
    newTypes: s.newTypes || [],
    response: row.response || null,
    submittedAt: row.submitted_at || null,
    deadline: DEADLINE.toISOString(),
    closed: Date.now() > DEADLINE.getTime(),
  };
}

function exportRows(rows) {
  const out = [['קישור', 'סטטוס', 'נשלח בתאריך', 'תפקיד', 'סוג כרטיס', 'שם', 'ת״ז / דרכון', 'דרכון?', 'טלפון', 'מייל', 'מגיע/ה בעצמו/ה', 'שם הרוכש', 'ת״ז הרוכש', 'מפתח מקור']];
  for (const r of rows) {
    const s = r.seed, resp = r.response;
    const status = resp ? (resp.guests.some(g => g.missing) ? 'נשמר חלקית' : 'הושלם') : r.opened_count ? 'נפתח, לא הושלם' : 'לא נפתח';
    const self = resp ? resp.self : { email: s.email, phone: s.phone };
    out.push([r.token, status, fmt(r.submitted_at), s.isGuest ? 'משתתף (מקבל ישירות)' : 'רוכש', s.isGuest ? TYPE_LABEL.nonstudent : '', s.name, keep(s.idnum), '', keep(self.phone), self.email, self.attending === 'yes' ? 'כן' : self.attending === 'no' ? 'לא' : '', '', '', '']);
    const guests = resp ? resp.guests : [...(s.guests || []), ...Array.from({ length: s.newSlots || 0 }, (_, i) => ({ key: `new${i + 1}` }))];
    const types = [...(s.guests || []).map(g => g.type || 'nonstudent'), ...(s.newTypes || [])];
    guests.forEach((g, gi) => out.push([r.token, status, fmt(r.submitted_at), g.missing || !g.name ? 'משתתף נוסף – חסרים פרטים' : 'משתתף נוסף', TYPE_LABEL[types[gi]] || '', g.name || '', keep(g.idnum), g.foreign ? 'כן' : '', keep(g.phone), g.email || '', '', s.name, keep(s.idnum), g.key]));
  }
  return out;
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (url.pathname === '/banner.jpg') return send(res, 200, BANNER, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    if (NEEDS_DB) return send(res, 503, notFound('הטופס ייפתח בקרוב.'), { 'Content-Type': 'text/html; charset=utf-8' });
    const m = url.pathname.match(/^\/c\/([A-Za-z0-9]{10,40})$/);
    if (m) {
      const row = await store.get(m[1]);
      if (!row) return send(res, 404, notFound(), { 'Content-Type': 'text/html; charset=utf-8' });
      if (req.method === 'GET') {
        await store.opened(m[1]);
        return send(res, 200, PAGE.replace('/*__DATA__*/null', embed(publicSeed(row))), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (req.method === 'POST') {
        const ip = ipOf(req);
        if (limited(ip)) return json(res, 429, { error: 'יותר מדי ניסיונות. נסו שוב בעוד דקה.' });
        if (Date.now() > DEADLINE.getTime()) return json(res, 403, { error: 'מועד ההשלמה הסתיים. לפרטים: info@reichman-u.com' });
        const body = await readJson(req);
        const { errors, out } = validate(row.seed, body);
        if (Object.keys(errors).length) return json(res, 400, { error: 'יש שדות שצריך לתקן', errors });
        await store.save(m[1], out, ip);
        return json(res, 200, { ok: true });
      }
      return send(res, 405, 'Method not allowed');
    }
    if (url.pathname.startsWith('/admin')) {
      if (!adminOk(req)) return send(res, 401, 'נדרשת סיסמה', { 'WWW-Authenticate': 'Basic realm="admin", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      const rows = await store.all();
      if (url.pathname === '/admin/export.csv') return send(res, 200, csv(exportRows(rows)), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="completion-export.csv"' });
      if (url.pathname === '/admin/data.json') {
        const list = rows.map(r => ({ token: r.token, name: r.seed.name, reasons: r.seed.reasons || '', isGuest: !!r.seed.isGuest,
          slots: (r.seed.guests || []).length + (r.seed.newSlots || 0), opened: r.opened_count, firstOpened: r.first_opened_at, submittedAt: r.submitted_at,
          done: !!r.response, missing: r.response ? r.response.guests.filter(g => g.missing).length : (r.seed.guests || []).length + (r.seed.newSlots || 0), attending: r.response && r.response.self ? r.response.self.attending || '' : '' }));
        return json(res, 200, { list, deadline: DEADLINE.toISOString() });
      }
      if (url.pathname === '/admin') return send(res, 200, ADMIN_PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (url.pathname === '/') return send(res, 200, notFound('הקישור שקיבלתם אישי. פתחו אותו מתוך ההודעה.'), { 'Content-Type': 'text/html; charset=utf-8' });
    return send(res, 404, notFound(), { 'Content-Type': 'text/html; charset=utf-8' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'שגיאה בשרת. נסו שוב.' });
  }
});

function notFound(msg = 'הקישור לא נמצא. בדקו שהעתקתם אותו במלואו, או פנו אלינו: info@reichman-u.com') {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>מסיבת פתיחת שנה</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#0f1d4a;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}p{max-width:360px;line-height:1.6}</style></head>
<body><p>${msg}</p></body></html>`;
}

store.init()
  .then(async () => {
    if (NEEDS_DB) { console.warn('DATABASE_URL not set — serving a "coming soon" page only.'); return server.listen(PORT); }
    const seed = loadSeed();
    if (seed.length) { await store.upsertSeed(seed); console.log(`Seed loaded: ${seed.length} links`); }
    server.listen(PORT, () => console.log(`complete-form on port ${PORT}`));
    if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD not set — admin page disabled.');
  })
  .catch(e => { console.error('Failed to start', e); process.exit(1); });
