// The confirmation email a buyer receives after the purchase is saved.
const EVENT = process.env.EVENT_NAME || 'מסיבת פתיחת שנה – אוניברסיטת רייכמן';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const maskId = id => { const s = String(id || ''); return s.length > 4 ? '•'.repeat(s.length - 4) + s.slice(-4) : s; };

module.exports = function confirmation({ name, id, invoice }) {
  const subject = `אישור רכישה – ${EVENT}`;
  const text = [
    `שלום ${name},`, '',
    'הרכישה שלך הושלמה בהצלחה.', '',
    `כרטיס אחד על שם: ${name}`,
    `מספר זהות: ${maskId(id)}`,
    `מספר חשבונית: ${invoice}`, '',
    'הכרטיס יישלח אליך באפליקציית מוביטי.',
    'הכרטיס אישי ואינו ניתן להעברה. הכניסה מובטחת לבעלי כרטיס בלבד.', '',
    'נתראה במסיבה!', '',
    'הודעה זו נשלחה אוטומטית בעקבות רכישה בעמדת המכירה.',
  ].join('\n');
  const row = (k, v) => `<tr><td style="padding:8px 0;color:#5b6b82;font-size:14px">${k}</td><td style="padding:8px 0;font-size:15px;font-weight:700;text-align:left;direction:ltr">${v}</td></tr>`;
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="margin:0;background:#eef1f6;font-family:Arial,Helvetica,sans-serif;color:#16233a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden" dir="rtl">
<tr><td style="background:#26354d;color:#ffffff;padding:22px 24px;text-align:center;font-size:20px;font-weight:700">${esc(EVENT)}</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 6px;font-size:17px">שלום ${esc(name)},</p>
<p style="margin:0 0 18px;font-size:17px;font-weight:700;color:#137a43">✓ הרכישה שלך הושלמה בהצלחה</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e3e8ef;border-bottom:1px solid #e3e8ef;margin-bottom:18px">
${row('כרטיס אחד על שם', `<span style="direction:rtl">${esc(name)}</span>`)}
${row('מספר זהות', esc(maskId(id)))}
${row('מספר חשבונית', esc(invoice))}
</table>
<p style="margin:0 0 8px;font-size:15px">הכרטיס יישלח אליך באפליקציית <b>מוביטי</b>.</p>
<p style="margin:0 0 18px;font-size:14px;color:#5b6b82">הכרטיס אישי ואינו ניתן להעברה. הכניסה מובטחת לבעלי כרטיס בלבד.</p>
<p style="margin:0;font-size:16px;font-weight:700">נתראה במסיבה!</p>
</td></tr>
<tr><td style="padding:14px 24px;background:#f5f7fa;color:#8a97ab;font-size:12px;text-align:center">הודעה זו נשלחה אוטומטית בעקבות רכישה בעמדת המכירה.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
};
