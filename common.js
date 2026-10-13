// Shared helpers for all pages
window.$ = s => document.querySelector(s);
window.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.api = async (url, opts = {}) => {
  const r = await fetch(url, { headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, ...opts });
  if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'שגיאה בשרת'); e.status = r.status; e.data = data; throw e; }
  return data;
};
window.fmtTime = t => { try { return new Date(t).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
let toastT;
window.toast = m => { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3500); };
window.station = { get() { try { return localStorage.getItem('station') || ''; } catch { return ''; } }, set(v) { try { localStorage.setItem('station', v); } catch {} } };

// header: mark current page, show admin link, logout
document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.nav a').forEach(a => { if (a.getAttribute('href') === location.pathname) a.setAttribute('aria-current', 'page'); });
  const out = $('#logout');
  if (out) out.addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; });
  try {
    const me = await api('/api/me');
    window.me = me;
    if (me.role === 'admin') document.querySelectorAll('[data-admin]').forEach(e => e.hidden = false);
    if (me.station) {
      station.set(me.station);
      const h = document.querySelector('.top h1');
      if (h && !h.querySelector('.who')) { const b = document.createElement('span'); b.className = 'who'; b.textContent = 'עמדה: ' + me.station; h.appendChild(b); }
    }
    document.dispatchEvent(new CustomEvent('me', { detail: me }));
  } catch {}
});
