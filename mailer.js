// Minimal SMTP sender over implicit TLS (port 465) — enough for Gmail with an App Password.
// No external packages. Reuses one connection for several messages.
const tls = require('tls');
const crypto = require('crypto');

const HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const PORT = +(process.env.SMTP_PORT || 465);
const USER = (process.env.GMAIL_USER || '').trim();
const PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const FROM_NAME = process.env.MAIL_FROM_NAME || 'מסיבת פתיחת שנה';
const INSECURE = process.env.SMTP_INSECURE === '1'; // local testing only

const configured = () => !!(USER && PASS);
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const wrap = s => s.replace(/.{1,76}/g, '$&\r\n');
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const cleanAddr = a => String(a || '').replace(/[\r\n<>]/g, '').trim();

class Conn {
  constructor() { this.buf = ''; this.waiters = []; this.lines = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.sock = tls.connect({ host: HOST, port: PORT, servername: HOST, rejectUnauthorized: !INSECURE }, () => resolve());
      this.sock.setEncoding('utf8');
      this.sock.setTimeout(20000, () => this.sock.destroy(new Error('SMTP timeout')));
      this.sock.on('data', d => this.onData(d));
      this.sock.on('error', e => { reject(e); this.fail(e); });
      this.sock.on('close', () => this.fail(new Error('SMTP connection closed')));
    });
  }
  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2);
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: +line.slice(0, 3), text: this.lines.join('\n') }; this.lines = [];
        const w = this.waiters.shift(); if (w) w.resolve(reply);
      }
    }
  }
  fail(e) { while (this.waiters.length) this.waiters.shift().reject(e); }
  read() { return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); }
  async cmd(line, expect) {
    const p = this.read();
    if (line != null) this.sock.write(line + '\r\n');
    const r = await p;
    if (!expect.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    return r;
  }
  close() { try { this.sock.write('QUIT\r\n'); this.sock.end(); } catch {} }
}

function buildMessage({ to, subject, text, html }) {
  const boundary = 'b' + crypto.randomBytes(12).toString('hex');
  const domain = USER.split('@')[1] || 'localhost';
  const headers = [
    `From: ${encWord(FROM_NAME)} <${USER}>`,
    `To: <${cleanAddr(to)}>`,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64(body))}`;
  return headers.join('\r\n') + '\r\n\r\n' + part('text/plain', text) + part('text/html', html) + `--${boundary}--\r\n`;
}

// messages: [{to, subject, text, html}] → [{to, ok, error}]
async function sendMany(messages) {
  if (!configured()) return messages.map(m => ({ to: m.to, ok: false, error: 'not_configured' }));
  const c = new Conn();
  const results = [];
  try {
    const greet = c.read();
    await c.open();
    const g = await greet; if (g.code !== 220) throw new Error('SMTP greeting ' + g.code);
    await c.cmd('EHLO student-tickets', [250]);
    await c.cmd('AUTH LOGIN', [334]);
    await c.cmd(b64(USER), [334]);
    await c.cmd(b64(PASS), [235]);
    for (const m of messages) {
      try {
        const to = cleanAddr(m.to);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('כתובת מייל לא תקינה');
        await c.cmd(`MAIL FROM:<${USER}>`, [250]);
        await c.cmd(`RCPT TO:<${to}>`, [250, 251]);
        await c.cmd('DATA', [354]);
        const data = buildMessage(m).replace(/^\./gm, '..');
        await c.cmd(data + '.', [250]);
        results.push({ to, ok: true });
      } catch (e) {
        results.push({ to: m.to, ok: false, error: /SMTP 55\d/.test(e.message) ? 'כתובת המייל נדחתה (ייתכן שהיא לא קיימת)' : e.message });
        try { await c.cmd('RSET', [250]); } catch (e2) { throw e2; }
      }
    }
  } catch (e) {
    const msg = /535|Username and Password|BadCredentials/i.test(e.message) ? 'החיבור ל-Gmail נדחה: כתובת או סיסמת אפליקציה שגויה'
      : /ENETUNREACH|ETIMEDOUT|ECONNREFUSED|timeout/i.test(e.message) ? 'אין חיבור לשרת המייל (ייתכן שהאתר בתוכנית החינמית של Render, שחוסמת שליחת מיילים)'
      : e.message;
    for (const m of messages.slice(results.length)) results.push({ to: m.to, ok: false, error: msg });
  } finally { c.close(); }
  return results;
}

module.exports = { configured, sendMany, from: () => USER };
