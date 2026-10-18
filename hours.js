// Staff work hours for the year-opening party (/hours).
// Self-contained: its own tables (hours_shifts, hours_meta) and its own small DB pool,
// so nothing here touches the ticket data. Uses the same login sessions as the rest of the site.
const fs = require('fs');
const path = require('path');

const START_DATE = '2026-10-13';                       // first work day (Tuesday)
const DEFAULT_WORKERS = ['שרה', 'מיקה', 'איתי', 'אחר'];
const TZ = 'Asia/Jerusalem';

/* ---------------- time helpers (always Israel time, whatever the server's zone) ---------------- */
function nowIL() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(v));
const isTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
const clean = (v, n) => String(v ?? '').trim().slice(0, n);

/* ---------------- storage ---------------- */
function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 3, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  const q = (t, p) => pool.query(t, p);
  const row = r => ({ id: String(r.id), worker: r.worker, date: r.work_date, start: r.start_t, end: r.end_t, note: r.note || '', manual: r.manual, edited: r.edited, createdBy: r.created_by || '', updatedAt: r.updated_at });
  return {
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS hours_meta (key TEXT PRIMARY KEY, value JSONB)`);
      await q(`CREATE TABLE IF NOT EXISTS hours_shifts (
        id SERIAL PRIMARY KEY, worker TEXT NOT NULL, work_date TEXT NOT NULL, start_t TEXT NOT NULL, end_t TEXT,
        note TEXT, manual BOOLEAN NOT NULL DEFAULT false, edited BOOLEAN NOT NULL DEFAULT false, created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      // at most one open shift per worker (guards against double taps)
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS hours_one_open ON hours_shifts(worker) WHERE end_t IS NULL`);
      await q(`INSERT INTO hours_meta(key,value) VALUES('workers',$1) ON CONFLICT(key) DO NOTHING`, [JSON.stringify(DEFAULT_WORKERS)]);
    },
    async workers() { const r = await q(`SELECT value FROM hours_meta WHERE key='workers'`); return r.rows[0] ? r.rows[0].value : []; },
    async setWorkers(list) { await q(`INSERT INTO hours_meta(key,value) VALUES('workers',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(list)]); },
    async list() { const r = await q(`SELECT * FROM hours_shifts ORDER BY work_date DESC, start_t DESC, id DESC`); return r.rows.map(row); },
    async open(worker) { const r = await q(`SELECT * FROM hours_shifts WHERE worker=$1 AND end_t IS NULL`, [worker]); return r.rows[0] ? row(r.rows[0]) : null; },
    async add(s) {
      try {
        const r = await q(`INSERT INTO hours_shifts(worker,work_date,start_t,end_t,note,manual,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [s.worker, s.date, s.start, s.end || null, s.note || '', !!s.manual, s.createdBy || '']);
        return row(r.rows[0]);
      } catch (e) { if (e.code === '23505') return null; throw e; }
    },
    async close(id, end) { const r = await q(`UPDATE hours_shifts SET end_t=$2, updated_at=now() WHERE id=$1 AND end_t IS NULL RETURNING *`, [id, end]); return r.rows[0] ? row(r.rows[0]) : null; },
    async update(id, s) {
      try {
        const r = await q(`UPDATE hours_shifts SET worker=$2, work_date=$3, start_t=$4, end_t=$5, note=$6, edited=true, updated_at=now() WHERE id=$1 RETURNING *`,
          [id, s.worker, s.date, s.start, s.end || null, s.note || '']);
        return r.rows[0] ? row(r.rows[0]) : null;
      } catch (e) { if (e.code === '23505') return 'open'; throw e; }
    },
    async remove(id) { await q(`DELETE FROM hours_shifts WHERE id=$1`, [id]); },
  };
}

function fileStore(file) {
  let db = { workers: DEFAULT_WORKERS, shifts: [], seq: 0 };
  const save = () => fs.writeFileSync(file, JSON.stringify(db));
  const stamp = () => new Date().toISOString();
  return {
    async init() { fs.mkdirSync(path.dirname(file), { recursive: true }); if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); },
    async workers() { return db.workers; },
    async setWorkers(list) { db.workers = list; save(); },
    async list() { return [...db.shifts].sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start) || b.id - a.id); },
    async open(worker) { return db.shifts.find(s => s.worker === worker && !s.end) || null; },
    async add(s) {
      if (!s.end && db.shifts.some(x => x.worker === s.worker && !x.end)) return null;
      const r = { id: String(++db.seq), worker: s.worker, date: s.date, start: s.start, end: s.end || null, note: s.note || '', manual: !!s.manual, edited: false, createdBy: s.createdBy || '', updatedAt: stamp() };
      db.shifts.push(r); save(); return r;
    },
    async close(id, end) { const r = db.shifts.find(s => s.id === id && !s.end); if (!r) return null; r.end = end; r.updatedAt = stamp(); save(); return r; },
    async update(id, s) {
      const r = db.shifts.find(x => x.id === id); if (!r) return null;
      if (!s.end && db.shifts.some(x => x.id !== id && x.worker === s.worker && !x.end)) return 'open';
      Object.assign(r, { worker: s.worker, date: s.date, start: s.start, end: s.end || null, note: s.note || '', edited: true, updatedAt: stamp() }); save(); return r;
    },
    async remove(id) { db.shifts = db.shifts.filter(s => s.id !== id); save(); },
  };
}

const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore(path.join(__dirname, 'data', 'hours.json'));
let ready = false;

/* ---------------- HTTP ---------------- */
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('בקשה גדולה מדי'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('בקשה לא תקינה'), { status: 400 })); } });
    req.on('error', reject);
  });
}

// Validates a full shift sent by the manager or a manual entry. Returns an error message or null.
function checkShift(s, workers, { allowOpen }) {
  if (!workers.includes(s.worker)) return 'יש לבחור עובד מהרשימה';
  if (!isDate(s.date)) return 'תאריך לא תקין';
  if (s.date < START_DATE) return 'אפשר לדווח רק מ-13.10 והלאה';
  if (s.date > nowIL().date) return 'אי אפשר לדווח על תאריך עתידי';
  if (!isTime(s.start)) return 'שעת התחלה לא תקינה';
  if (s.end ? !isTime(s.end) : !allowOpen) return 'שעת סיום לא תקינה';
  if (s.end && s.end === s.start) return 'שעת הסיום זהה לשעת ההתחלה';
  return null;
}

async function api(req, res, url, s) {
  if (!s) return json(res, 401, { error: 'יש להתחבר מחדש' });
  if (!ready) return json(res, 503, { error: 'מערכת השעות עדיין עולה. נסו שוב בעוד רגע.' });
  const admin = s.role === 'admin';
  const route = req.method + ' ' + url.pathname;
  const workers = await store.workers();

  if (route === 'GET /api/hours') {
    return json(res, 200, { admin, station: s.station || '', workers, startDate: START_DATE, now: nowIL(), shifts: await store.list() });
  }

  // Clock in / clock out with the server's clock (Israel time).
  if (route === 'POST /api/hours/clock') {
    const b = await body(req);
    const worker = clean(b.worker, 60);
    if (!workers.includes(worker)) return json(res, 400, { error: 'יש לבחור עובד מהרשימה' });
    const now = nowIL();
    const open = await store.open(worker);
    if (open) {
      if (b.action === 'in') return json(res, 409, { error: `${worker} כבר במשמרת מאז ${open.start}` });
      return json(res, 200, { action: 'out', shift: await store.close(open.id, now.time) });
    }
    if (b.action === 'out') return json(res, 409, { error: `${worker} לא במשמרת כרגע` });
    const shift = await store.add({ worker, date: now.date, start: now.time, createdBy: s.station || '' });
    if (!shift) return json(res, 409, { error: `${worker} כבר במשמרת` });
    return json(res, 200, { action: 'in', shift });
  }

  // A forgotten shift, added after the fact by the worker (marked "manual").
  if (route === 'POST /api/hours/manual') {
    const b = await body(req);
    const sh = { worker: clean(b.worker, 60), date: clean(b.date, 10), start: clean(b.start, 5), end: clean(b.end, 5), note: clean(b.note, 200), manual: true, createdBy: s.station || '' };
    const err = checkShift(sh, workers, { allowOpen: false });
    if (err) return json(res, 400, { error: err });
    return json(res, 200, { shift: await store.add(sh) });
  }

  // ---- manager only ----
  if (!admin) return json(res, 403, { error: 'הפעולה מותרת רק למנהל' });

  if (route === 'PUT /api/hours/workers') {
    const b = await body(req);
    const list = [...new Set((Array.isArray(b.names) ? b.names : []).map(n => clean(n, 60)).filter(Boolean))].slice(0, 50);
    await store.setWorkers(list);
    return json(res, 200, { workers: list });
  }

  let m;
  if ((m = /^\/api\/hours\/(\d+)$/.exec(url.pathname))) {
    const id = m[1];
    if (req.method === 'DELETE') { await store.remove(id); return json(res, 200, { ok: true }); }
    if (req.method === 'PUT') {
      const b = await body(req);
      const sh = { worker: clean(b.worker, 60), date: clean(b.date, 10), start: clean(b.start, 5), end: clean(b.end, 5), note: clean(b.note, 200) };
      // the manager may keep a name that was since removed from the list, on an old shift
      const err = checkShift(sh, sh.worker ? workers.concat(sh.worker) : workers, { allowOpen: true });
      if (err) return json(res, 400, { error: err });
      const r = await store.update(id, sh);
      if (r === 'open') return json(res, 409, { error: `ל${sh.worker} כבר יש משמרת פתוחה. צריך שעת סיום.` });
      if (!r) return json(res, 404, { error: 'המשמרת לא נמצאה' });
      return json(res, 200, { shift: r });
    }
  }
  return json(res, 404, { error: 'לא נמצא' });
}

function page(res) {
  // The Render build moves known pages into public/; this one may sit at the root or in public/.
  const f = [path.join(__dirname, 'hours.html'), path.join(__dirname, 'public', 'hours.html')].find(p => fs.existsSync(p));
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' });
  fs.createReadStream(f).pipe(res);
}

module.exports = {
  init: () => store.init().then(() => { ready = true; console.log('Hours module ready'); }),
  api, page,
  _test: { nowIL, checkShift },
};
