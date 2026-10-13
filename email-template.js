// The purchase confirmation email: one per transaction, sent to the first person in it.
const fs = require('fs');
const path = require('path');

const EVENT = process.env.EVENT_NAME || 'מסיבת פתיחת שנה';
const SUPPORT = process.env.SUPPORT_EMAIL || 'info@reichman-u.com';
const SUBJECT = process.env.MAIL_SUBJECT || 'אישור רכישת כרטיס/ים מסיבת פתיחת שנה';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let banner = null;
for (const p of [path.join(__dirname, 'public', 'static', 'email-banner.jpg'), path.join(__dirname, 'email-banner.jpg')]) {
  try { banner = fs.readFileSync(p); break; } catch {}
}

function israelDateTime(d) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

module.exports = function confirmation({ name, count, invoice, at }) {
  const { date, time } = israelDateTime(at ? new Date(at) : new Date());
  const ticketsText = count === 1 ? 'כרטיס אחד' : `${count} כרטיסים`;
  const rows = [
    ['שם האירוע', esc(EVENT)],
    ['תאריך', `<span dir="ltr">${date}</span>`],
    ['שעה', `<span dir="ltr">${time}</span>`],
    ['שם המזמין', esc(name)],
    ['מספר כרטיסים', String(count)],
    ['מספר חשבונית', `<span dir="ltr">${esc(invoice)}</span>`],
    ['אימייל לתמיכה', `<a href="mailto:${esc(SUPPORT)}" style="color:#1a56db">${esc(SUPPORT)}</a>`],
  ];
  const text = [
    `שלום ${name}`,
    `אישור רכישה עבור ${ticketsText} בחשבונית מספר ${invoice}`, '',
    `שם האירוע: ${EVENT}`, `תאריך: ${date}`, `שעה: ${time}`, `שם המזמין: ${name}`,
    `מספר כרטיסים: ${count}`, `מספר חשבונית: ${invoice}`, `אימייל לתמיכה: ${SUPPORT}`,
  ].join('\n');
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#222">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:643px" dir="rtl">
${banner ? `<tr><td><img src="cid:banner@tickets" width="643" alt="${esc(EVENT)} – אוניברסיטת רייכמן" style="display:block;width:100%;max-width:643px;height:auto;border:0"></td></tr>` : ''}
<tr><td style="padding:22px 6px 6px;font-size:18px;font-weight:700">שלום ${esc(name)}</td></tr>
<tr><td style="padding:0 6px 18px;font-size:16px">אישור רכישה עבור <b>${ticketsText}</b> בחשבונית מספר <b dir="ltr">${esc(invoice)}</b></td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="font-size:14px">
${rows.map(([k, v]) => `<tr><td style="padding:6px;font-weight:700;width:150px;vertical-align:top">${k}:</td><td style="padding:6px;color:#444">${v}</td></tr>`).join('\n')}
</table></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: SUBJECT, text, html, inline: banner ? [{ cid: 'banner@tickets', type: 'image/jpeg', name: 'banner.jpg', data: banner }] : [] };
};
