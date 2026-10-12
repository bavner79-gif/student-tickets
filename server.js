// Student lookup & ticket registration — minimal Node.js server (no framework).
// The only external package is "pg", used when DATABASE_URL is set (on Render).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createStore = require('./store');

const PORT = process.env.PORT || 3000;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = 14;
const PUBLIC = path.join(__dirname, 'public');
const store = createStore();

/* ---------------- helpers ---------------- */
const normId = v => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
const ID_HEADER = /^(מ["״']?ז|ת["״'.]?\s*ז|תעודת\s*זהות|מספר\s*זהות|מס['׳]?\s*זהות|id\b|identity)/i;

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff', ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
const json = (res, status, obj) => send(res, status, obj);
const redirect = (res, to) => send(res, 302, '', { Location: to });

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('הקובץ גדול מדי'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('בקשה לא תקינה'), { status: 400 })); } });
    req.on('error', reject);
  });
}

/* ---------------- sessions (signed cookie) ---------------- */
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function makeToken(role) {
  const p = Buffer.from(JSON.stringify({ role, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
  return p + '.' + sign(p);
}
function session(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [p, sig] = m[1].split('.');
  if (!p || !sig) return null;
  const good = sign(p);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const s = JSON.parse(Buffer.from(p, 'base64url').toString()); return s.exp > Date.now() ? s : null; } catch { return null; }
}
const attempts = new Map();

/* ---------------- API handlers ---------------- */
async function api(req, res, url, s) {
  const route = req.method + ' ' + url.pathname;

  if (route === 'POST /api/login') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 10 * 60e3) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) return json(res, 429, { error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' });
    const { password } = await readBody(req, 10000);
    const role = password === ADMIN_PASSWORD ? 'admin' : password === STAFF_PASSWORD ? 'staff' : null;
    if (!role) { a.n++; attempts.set(ip, a); return json(res, 401, { error: 'סיסמה שגויה' }); }
    attempts.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${makeToken(role)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure}`);
    return json(res, 200, { role });
  }
  if (route === 'POST /api/logout') { res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }

  if (!s) return json(res, 401, { error: 'יש להתחבר מחדש' });
  const admin = s.role === 'admin';
  const needAdmin = () => json(res, 403, { error: 'הפעולה מותרת רק למנהל' });

  if (route === 'GET /api/me') return json(res, 200, { role: s.role, students: await store.countStudents(), upload: await store.getMeta('upload') });

  let m;
  if (req.method === 'GET' && (m = /^\/api\/student\/([^/]+)$/.exec(url.pathname))) {
    const id = normId(decodeURIComponent(m[1]));
    if (!id) return json(res, 400, { error: 'יש להזין מספר זהות' });
    const student = await store.getStudent(id);
    if (!student) return json(res, 404, { error: 'לא נמצא במאגר', id });
    return json(res, 200, { student, purchase: await store.getPurchase(id) });
  }

  if (route === 'POST /api/purchase') {
    const b = await readBody(req, 10000);
    const id = normId(b.studentId), tickets = parseInt(b.tickets, 10);
    const invoice = String(b.invoice || '').trim(), station = String(b.station || '').trim().slice(0, 60);
    const student = id && await store.getStudent(id);
    if (!student) return json(res, 404, { error: 'הסטודנט לא נמצא במאגר' });
    if (!(tickets >= 1 && tickets <= 5)) return json(res, 400, { error: 'יש לבחור מספר כרטיסים בין 1 ל-5' });
    if (!invoice) return json(res, 400, { error: 'יש להזין מספר חשבונית' });
    if (invoice.length > 60) return json(res, 400, { error: 'מספר החשבונית ארוך מדי' });
    const clash = (await store.findInvoice(invoice)).filter(p => p.studentId !== id);
    if (clash.length && !b.force) {
      const other = await store.getStudent(clash[0].studentId);
      return json(res, 409, { error: `מספר החשבונית ${invoice} כבר רשום אצל ${other ? other.name : clash[0].studentId}`, duplicateInvoice: true });
    }
    const prev = await store.getPurchase(id);
    const purchase = await store.savePurchase({ studentId: id, tickets, invoice, station }, prev ? 'update' : 'create');
    return json(res, 200, { purchase, updated: !!prev });
  }

  if (route === 'GET /api/purchases') {
    const list = await store.listPurchases();
    return json(res, 200, { purchases: list.map(p => ({ studentId: p.studentId, tickets: p.tickets, invoice: p.invoice, station: p.station, createdAt: p.createdAt, updatedAt: p.updatedAt, name: p.student ? p.student.name : '(לא במאגר)' })) });
  }

  if (req.method === 'DELETE' && (m = /^\/api\/purchase\/([^/]+)$/.exec(url.pathname))) {
    if (!admin) return needAdmin();
    await store.deletePurchase(normId(decodeURIComponent(m[1])));
    return json(res, 200, { ok: true });
  }

  // Admin uploads the student list. The browser reads the Excel file and sends {file, headers, rows}.
  if (route === 'POST /api/upload') {
    if (!admin) return needAdmin();
    const b = await readBody(req);
    const headers = (b.headers || []).map(h => String(h ?? '').trim());
    const rowsIn = Array.isArray(b.rows) ? b.rows : [];
    const idCol = headers.findIndex(h => ID_HEADER.test(h));
    if (idCol < 0) return json(res, 400, { error: 'לא נמצאה עמודת מספר זהות בשורת הכותרות (למשל: מ"ז, ת.ז, תעודת זהות)' });
    const col = re => headers.findIndex(h => re.test(h));
    const firstCol = col(/שם\s*פרטי|first/i), lastCol = col(/שם\s*משפחה|last|surname/i), nameCol = col(/^שם(\s*מלא)?$|full\s*name|^name$/i);
    const rows = [], seen = new Set(); let dups = 0, noId = 0;
    for (const r of rowsIn) {
      if (!Array.isArray(r)) continue;
      const cell = i => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
      const id = normId(cell(idCol));
      if (!id) { if (r.some(v => String(v ?? '').trim())) noId++; continue; }
      if (seen.has(id)) { dups++; continue; }
      seen.add(id);
      const fields = headers.map((h, i) => [h, cell(i)]).filter(([h], i) => h && i !== idCol);
      const name = nameCol >= 0 ? cell(nameCol) : [cell(firstCol), cell(lastCol)].filter(Boolean).join(' ');
      rows.push({ id, data: { id, idDisplay: cell(idCol), name: name || '—', fields } });
    }
    if (!rows.length) return json(res, 400, { error: 'לא נמצאו שורות עם מספר זהות' });
    await store.replaceStudents(rows);
    const info = { file: String(b.file || '').slice(0, 200), count: rows.length, dups, noId, at: new Date().toISOString(), idHeader: headers[idCol] };
    await store.setMeta('upload', info);
    return json(res, 200, info);
  }

  // Full data for the Excel backup (the browser builds the .xlsx file).
  if (route === 'GET /api/export') {
    if (!admin) return needAdmin();
    const list = await store.listPurchases();
    return json(res, 200, {
      purchases: list.map(p => ({ studentId: p.studentId, tickets: p.tickets, invoice: p.invoice, station: p.station, createdAt: p.createdAt, updatedAt: p.updatedAt, name: p.student ? p.student.name : '', fields: p.student ? p.student.fields : [] })),
      log: await store.listLog(),
    });
  }

  return json(res, 404, { error: 'לא נמצא' });
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const s = session(req);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, s);
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (url.pathname.startsWith('/static/')) {
      const f = path.normalize(path.join(PUBLIC, url.pathname));
      if (!f.startsWith(path.join(PUBLIC, 'static'))) return send(res, 404, 'Not found');
      return sendFile(res, f);
    }
    if (url.pathname === '/login') return sendFile(res, path.join(PUBLIC, 'login.html'));
    if (url.pathname === '/') return s ? sendFile(res, path.join(PUBLIC, 'index.html')) : redirect(res, '/login');
    if (url.pathname === '/purchases') return s ? sendFile(res, path.join(PUBLIC, 'purchases.html')) : redirect(res, '/login');
    if (url.pathname === '/admin') return s && s.role === 'admin' ? sendFile(res, path.join(PUBLIC, 'admin.html')) : redirect(res, '/login?admin=1');
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'שגיאה בשרת. נסו שוב.' });
  }
});

store.init().then(() => {
  server.listen(PORT, () => console.log(`Running on port ${PORT} (storage: ${store.kind})`));
  if (!process.env.STAFF_PASSWORD || !process.env.ADMIN_PASSWORD) console.warn('WARNING: STAFF_PASSWORD / ADMIN_PASSWORD not set — using default test passwords "staff" / "admin".');
}).catch(e => { console.error('Failed to start', e); process.exit(1); });
