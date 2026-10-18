// Student lookup & ticket registration — minimal Node.js server (no framework).
// The only external package is "pg", used when DATABASE_URL is set (on Render).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createStore = require('./store');
const mailer = require('./mailer');
const confirmationEmail = require('./email-template');
const hours = require('./hours');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
// Station logins: STATION_USERS="שרה:pass1;גיא:pass2" — each password signs in as that station.
// Falls back to a single STAFF_PASSWORD (station named at login) when STATION_USERS is not set.
const STATIONS = String(process.env.STATION_USERS || '').split(/[;\n]/).map(x => x.trim()).filter(Boolean).map(x => {
  const i = x.lastIndexOf(':'); return { name: x.slice(0, i).trim(), password: x.slice(i + 1).trim() };
}).filter(x => x.name && x.password);
const STAFF_PASSWORD = STATIONS.length ? null : (process.env.STAFF_PASSWORD || 'staff');
const ADMIN_STATION = process.env.ADMIN_STATION_NAME || 'מנהל';
const TOKEN_V = 2;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = 14;
const PUBLIC = path.join(__dirname, 'public');
const store = createStore();

/* ---------------- helpers ---------------- */
const normId = v => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
const YEAR_HEADER = /שנת?\s*לימוד|^שנה$|^year$|study\s*year/i;
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
function makeToken(role, station) {
  const p = Buffer.from(JSON.stringify({ v: TOKEN_V, role, station, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
  return p + '.' + sign(p);
}
function session(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [p, sig] = m[1].split('.');
  if (!p || !sig) return null;
  const good = sign(p);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const s = JSON.parse(Buffer.from(p, 'base64url').toString()); return s.v === TOKEN_V && s.exp > Date.now() ? s : null; } catch { return null; }
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
    const { password, station: typed } = await readBody(req, 10000);
    const pw = String(password || '');
    const hit = STATIONS.find(x => x.password === pw);
    const role = pw === ADMIN_PASSWORD ? 'admin' : hit ? 'staff' : (STAFF_PASSWORD && pw === STAFF_PASSWORD) ? 'staff' : null;
    const station = role === 'admin' ? ADMIN_STATION : hit ? hit.name : String(typed || '').trim().slice(0, 60) || 'עמדה';
    if (!role) { a.n++; attempts.set(ip, a); return json(res, 401, { error: 'סיסמה שגויה' }); }
    attempts.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${makeToken(role, station)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure}`);
    return json(res, 200, { role, station });
  }
  if (route === 'POST /api/logout') { res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }

  if (!s) return json(res, 401, { error: 'יש להתחבר מחדש' });
  const admin = s.role === 'admin';
  const needAdmin = () => json(res, 403, { error: 'הפעולה מותרת רק למנהל' });

  if (route === 'GET /api/me') return json(res, 200, { role: s.role, station: s.station, namedStations: STATIONS.length > 0, students: await store.countStudents(), manual: await store.countManual(), upload: await store.getMeta('upload'),
    mail: { configured: mailer.configured(), from: s.role === 'admin' ? mailer.from() : undefined } });

  if (route === 'POST /api/mail/test') {
    if (!admin) return needAdmin();
    if (!mailer.configured()) return json(res, 400, { error: 'המייל עדיין לא מחובר. צריך להגדיר GMAIL_USER ו-GMAIL_APP_PASSWORD ב-Render.' });
    const b = await readBody(req, 5000);
    const to = String(b.to || mailer.from()).trim();
    const m = confirmationEmail({ name: 'ישראל ישראלי (בדיקה)', count: 2, invoice: 'TEST-1' });
    const [r] = await mailer.sendMany([{ to, ...m, subject: '[בדיקה] ' + m.subject }]);
    return r.ok ? json(res, 200, { ok: true, to }) : json(res, 502, { error: r.error });
  }

  let rm;
  if (req.method === 'POST' && (rm = /^\/api\/mail\/resend\/([^/]+)$/.exec(url.pathname))) {
    if (!mailer.configured()) return json(res, 400, { error: 'המייל לא מחובר' });
    const id = normId(decodeURIComponent(rm[1]));
    const own = await store.getPurchase(id);
    if (!own || (!admin && own.station !== s.station)) return json(res, 404, { error: 'רכישה לא נמצאה' });
    // Optional corrected address: saved as the external email of the person the confirmation goes to (first in the purchase).
    const b = await readBody(req, 5000).catch(() => ({}));
    const email = String((b && b.email) || '').trim();
    if (email) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return json(res, 400, { error: 'כתובת המייל לא תקינה' });
      const rows = own.tx ? await store.listTx(own.tx) : [own];
      const firstId = rows[0].studentId, st = await store.getStudent(firstId);
      if (st) {
        const fields = (st.fields || []).map(f => [...f]);
        const isMail = h => /מייל|דוא"?ל|e-?mail/i.test(h);
        const slot = fields.find(([h]) => isMail(h) && /חיצוני|פרטי|external|personal/i.test(h)) || fields.find(([h]) => isMail(h));
        if (slot) slot[1] = email; else fields.push(['אימייל חיצוני', email]);
        await store.updateStudent(firstId, { ...st, fields, emailAddedAt: new Date().toISOString(), emailAddedBy: s.station || '' });
      }
    }
    await sendConfirmations(id);
    const p = await store.getPurchase(id);
    return p.emailStatus === 'sent' ? json(res, 200, { ok: true, to: p.emailTo }) : json(res, 502, { error: p.emailStatus === 'no_email' ? 'אין כתובת מייל לאדם הזה' : (p.emailError || 'השליחה נכשלה') });
  }

  // The columns a manually added person gets: the same columns as the uploaded Excel, plus a study-year column set to 0.
  if (route === 'GET /api/fields') return json(res, 200, { fields: await newPersonFields() });

  if (route === 'POST /api/student') {
    const b = await readBody(req, 50000);
    const id = normId(b.id);
    if (!id || id.length > 12) return json(res, 400, { error: 'יש להזין מספר זהות תקין' });
    if (await store.getStudent(id)) return json(res, 409, { error: 'מספר הזהות הזה כבר קיים במאגר' });
    const cols = await newPersonFields();
    const vals = b.fields && typeof b.fields === 'object' ? b.fields : {};
    const fields = cols.map(c => [c.header, c.year ? '0' : String(vals[c.header] ?? '').trim().slice(0, 200)]);
    const get = re => { const f = fields.find(([h]) => re.test(h)); return f ? f[1] : ''; };
    const first = get(/שם\s*פרטי|first/i), last = get(/שם\s*משפחה|last|surname/i), full = get(/^שם(\s*מלא)?$|full\s*name|^name$/i);
    const name = full || [first, last].filter(Boolean).join(' ');
    if (!name) return json(res, 400, { error: 'יש להזין שם' });
    // Everyone added by hand needs a personal (non-internal) email; the internal one is optional.
    const mails = fields.filter(([h]) => /מייל|דוא"?ל|e-?mail/i.test(h));
    const ext = mails.filter(([h]) => !/פנימי|internal/i.test(h));
    const need = ext.length ? ext : mails;
    if (need.length && !need.some(([, v]) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) return json(res, 400, { error: 'חובה להזין אימייל חיצוני' });
    const data = { id, idDisplay: String(b.id).trim().slice(0, 20), name, fields, manual: true, addedAt: new Date().toISOString(), addedBy: s.station || '' };
    if (!(await store.addStudent({ id, data }))) return json(res, 409, { error: 'מספר הזהות הזה כבר קיים במאגר' });
    return json(res, 200, { student: data, purchase: null });
  }

  let m;
  // Add or fix the email of a person (the first buyer must have one for the confirmation email).
  if (req.method === 'POST' && (m = /^\/api\/student\/([^/]+)\/email$/.exec(url.pathname))) {
    const id = normId(decodeURIComponent(m[1]));
    const b = await readBody(req, 5000);
    const email = String(b.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return json(res, 400, { error: 'כתובת המייל לא תקינה' });
    const st = await store.getStudent(id);
    if (!st) return json(res, 404, { error: 'לא נמצא במאגר' });
    const fields = (st.fields || []).map(f => [...f]);
    const isMail = h => /מייל|דוא"?ל|e-?mail/i.test(h);
    const slot = fields.find(([h]) => isMail(h) && /חיצוני|פרטי|external|personal/i.test(h)) || fields.find(([h]) => isMail(h));
    if (slot) slot[1] = email; else fields.push(['אימייל חיצוני', email]);
    const data = { ...st, fields, emailAddedAt: new Date().toISOString(), emailAddedBy: s.station || '' };
    await store.updateStudent(id, data);
    return json(res, 200, { student: data });
  }

  // Add a phone number for a person who has none in the list (an existing number is never overwritten here).
  if (req.method === 'POST' && (m = /^\/api\/student\/([^/]+)\/phone$/.exec(url.pathname))) {
    const id = normId(decodeURIComponent(m[1]));
    const b = await readBody(req, 5000);
    const phone = String(b.phone || '').trim();
    const digits = phone.replace(/\D/g, '');
    if (!/^[\d\-+ ()]+$/.test(phone) || digits.length < 9 || digits.length > 13) return json(res, 400, { error: 'מספר הטלפון לא תקין' });
    const st = await store.getStudent(id);
    if (!st) return json(res, 404, { error: 'לא נמצא במאגר' });
    const fields = (st.fields || []).map(f => [...f]);
    const isPhone = h => /טלפון|נייד|phone|mobile/i.test(h);
    const slot = fields.find(([h]) => isPhone(h) && /סלולר|נייד|mobile|cell/i.test(h)) || fields.find(([h]) => isPhone(h));
    if (slot && String(slot[1] || '').trim()) return json(res, 409, { error: 'כבר רשום מספר טלפון במאגר' });
    if (slot) slot[1] = phone; else fields.push(['טלפון סלולארי', phone]);
    const data = { ...st, fields, phoneAddedAt: new Date().toISOString(), phoneAddedBy: s.station || '' };
    await store.updateStudent(id, data);
    return json(res, 200, { student: data });
  }

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
    const invoice = String(b.invoice || '').trim(), station = s.station || String(b.station || '').trim().slice(0, 60);
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

  // One transaction: several people, one ticket each, one shared invoice number.
  if (route === 'POST /api/purchases') {
    const b = await readBody(req, 20000);
    const ids = [...new Set((Array.isArray(b.studentIds) ? b.studentIds : []).map(normId).filter(Boolean))];
    const invoice = String(b.invoice || '').trim(), station = s.station || String(b.station || '').trim().slice(0, 60);
    if (!ids.length) return json(res, 400, { error: 'אין אנשים ברכישה' });
    if (ids.length > 30) return json(res, 400, { error: 'יותר מדי אנשים ברכישה אחת' });
    if (!invoice) return json(res, 400, { error: 'יש להזין מספר חשבונית' });
    if (invoice.length > 60) return json(res, 400, { error: 'מספר החשבונית ארוך מדי' });
    const people = [];
    for (const id of ids) {
      const st = await store.getStudent(id);
      if (!st) return json(res, 404, { error: `מספר זהות ${id} לא נמצא במאגר` });
      people.push(st);
    }
    if (!pickEmail(people[0])) return json(res, 400, { error: `לרוכש הראשון (${people[0].name}) אין כתובת מייל. הוסיפו מייל לפני השמירה.`, needEmail: people[0].id });
    const clash = (await store.findInvoice(invoice)).filter(p => !ids.includes(p.studentId));
    if (clash.length && !b.force) {
      const other = await store.getStudent(clash[0].studentId);
      return json(res, 409, { error: `מספר החשבונית ${invoice} כבר רשום אצל ${other ? other.name : clash[0].studentId}`, duplicateInvoice: true });
    }
    // Price per person: in the list = student; added by hand = guest unless the station chose the student price (manager-approved exception).
    const asked = {};
    (Array.isArray(b.studentIds) ? b.studentIds : []).forEach((raw, i) => { asked[normId(raw)] = Array.isArray(b.priceTypes) ? b.priceTypes[i] : null; });
    const prices = people.map(p => {
      const type = !p.manual ? 'student' : (asked[p.id] === 'student' ? 'student' : 'guest');
      return { type, amount: PRICE[type] };
    });
    const { taken } = await store.savePurchaseBatch(ids, invoice, station, crypto.randomBytes(8).toString('hex'), prices);
    if (taken.length) {
      const names = people.filter(p => taken.includes(p.id)).map(p => p.name).join(', ');
      return json(res, 409, { error: `כבר נרשם כרטיס עבור: ${names}. הסירו אותם מהרכישה ונסו שוב.`, taken });
    }
    sendConfirmations(ids[0]).catch(e => console.error('sendConfirmations', e));
    return json(res, 200, { saved: people.map(p => ({ id: p.id, name: p.name })), invoice, total: prices.reduce((a, x) => a + x.amount, 0), mail: mailer.configured() });
  }

  if (route === 'GET /api/purchases') {
    // Stations see only their own sales; the admin sees everything.
    const list = (await store.listPurchases()).filter(p => admin || p.station === s.station);
    return json(res, 200, { scope: admin ? 'all' : 'station', station: s.station, mail: mailer.configured(), purchases: list.map(p => ({ studentId: p.studentId, tickets: p.tickets, invoice: p.invoice, station: p.station, priceType: p.priceType, price: p.price, createdAt: p.createdAt, updatedAt: p.updatedAt, name: p.student ? p.student.name : '(לא במאגר)', gender: admin ? genderOf(p.student) : undefined,
      emailTo: p.emailTo, emailStatus: p.emailStatus, emailError: p.emailError })) });
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
    const info = { file: String(b.file || '').slice(0, 200), count: rows.length, dups, noId, at: new Date().toISOString(), idHeader: headers[idCol],
      headers: headers.filter((h, i) => h && i !== idCol) };
    await store.setMeta('upload', info);
    return json(res, 200, info);
  }

  // Full data for the Excel backup (the browser builds the .xlsx file).
  if (route === 'GET /api/export') {
    if (!admin) return needAdmin();
    const list = await store.listPurchases();
    return json(res, 200, {
      purchases: list.map(p => ({ studentId: p.studentId, tickets: p.tickets, invoice: p.invoice, station: p.station, priceType: p.priceType, price: p.price, createdAt: p.createdAt, updatedAt: p.updatedAt, name: p.student ? p.student.name : '', fields: p.student ? p.student.fields : [] })),
      log: await store.listLog(),
    });
  }

  return json(res, 404, { error: 'לא נמצא' });
}

// The buyer's email: prefer a personal/external address, fall back to any email column.
function pickEmail(student) {
  const emails = (student.fields || []).filter(([h, v]) => /מייל|דוא"?ל|e-?mail/i.test(h) && /@/.test(v || ''));
  const ext = emails.find(([h]) => /חיצוני|פרטי|external|personal/i.test(h));
  return (ext || emails[0] || [])[1] || '';
}

// One confirmation email per transaction, to the first person in it (or the next one who has an email).
// The status is recorded on every purchase row of the transaction.
async function sendConfirmations(firstId) {
  if (!mailer.configured()) return;
  const first = await store.getPurchase(firstId);
  if (!first) return;
  const rows = first.tx ? await store.listTx(first.tx) : [first];
  const people = [];
  for (const r of rows) people.push({ row: r, st: await store.getStudent(r.studentId) });
  const target = people.find(x => x.st && pickEmail(x.st));
  const mark = async status => { for (const x of people) await store.setEmailStatus(x.row.studentId, status); };
  if (!target) return mark({ status: 'no_email' });
  const to = pickEmail(target.st);
  await mark({ to, status: 'sending' });
  const count = rows.reduce((n, r) => n + (r.tickets || 1), 0);
  const m = confirmationEmail({ name: target.st.name, count, invoice: first.invoice, at: first.createdAt });
  const [r] = await mailer.sendMany([{ to, ...m }]);
  await mark({ to, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : r.error });
  if (!r.ok) console.warn('email failed', first.invoice, r.error);
}

// The "add new person" form shows only these columns (in this order), when they exist in the uploaded file.
// Study year is always included and fixed at 0.
const PRICE = { student: 70, guest: 100 };
// 'm' / 'f' / '' from the gender column (ז / נ, or words like זכר / נקבה / male / female).
function genderOf(st) {
  const f = st && (st.fields || []).find(([h]) => /מגדר|מין|gender|sex/i.test(h));
  const v = f ? String(f[1] || '').trim().toLowerCase() : '';
  if (/^(ז|זכר|m|male|גבר)/.test(v)) return 'm';
  if (/^(נ|נקבה|f|female|אישה)/.test(v)) return 'f';
  return '';
}
const FORM_FIELDS = ['שם פרטי', 'שם משפחה', 'מגדר', 'אימייל פנימי', 'אימייל חיצוני', 'טלפון סלולארי', 'שנת לימוד'];
const normH = h => String(h || '').replace(/["״׳']/g, '').replace(/\s+/g, ' ').trim();

async function newPersonFields() {
  const meta = await store.getMeta('upload');
  let headers = meta && Array.isArray(meta.headers) ? meta.headers : null;
  if (!headers) { const s = await store.sampleStudent(); headers = s ? s.fields.map(f => f[0]) : FORM_FIELDS; }
  const out = [];
  for (const want of FORM_FIELDS) {
    const w = normH(want);
    const h = headers.find(x => normH(x) === w) || headers.find(x => normH(x).startsWith(w));
    const isYear = want === 'שנת לימוד';
    if (h) out.push({ header: h, year: isYear || YEAR_HEADER.test(h), gender: want === 'מגדר' });
    else if (isYear) out.push({ header: 'שנת לימוד', year: true });
  }
  return out;
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const s = session(req);
    if (url.pathname === '/api/hours' || url.pathname.startsWith('/api/hours/')) return await hours.api(req, res, url, s);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, s);
    if (url.pathname === '/hours') return s ? hours.page(res) : redirect(res, '/login?next=/hours');
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
  // The hours module starts on its own; if it fails, ticket sales keep working.
  hours.init().catch(e => console.error('Hours module failed to start', e));
  server.listen(PORT, () => console.log(`Running on port ${PORT} (storage: ${store.kind})`));
  console.log(`Stations: ${STATIONS.length ? STATIONS.map(x => x.name).join(', ') : 'single staff password'}`);
  if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD not set — using default test password "admin".');
}).catch(e => { console.error('Failed to start', e); process.exit(1); });
