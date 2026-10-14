// Excel read/write in the browser (uses SheetJS, loaded on the page before this file)
function cellToText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString('he-IL');
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return String(v).trim();
}

window.readStudentsFile = file => new Promise((resolve, reject) => {
  const rd = new FileReader();
  rd.onerror = () => reject(new Error('לא הצלחנו לקרוא את הקובץ'));
  rd.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).map(r => r.map(cellToText));
      const h = all.findIndex(r => r.filter(Boolean).length >= 2);
      if (h < 0) throw new Error('empty');
      resolve({ file: file.name, headers: all[h], rows: all.slice(h + 1).filter(r => r.some(Boolean)) });
    } catch (err) { reject(new Error('לא הצלחנו לקרוא את הקובץ. ודאו שזה קובץ אקסל שבשורה הראשונה שלו כותרות.')); }
  };
  rd.readAsArrayBuffer(file);
});

window.downloadPurchasesXlsx = async () => {
  const { purchases, log } = await api('/api/export');
  const extra = [];
  purchases.forEach(p => (p.fields || []).forEach(([h]) => { if (!extra.includes(h)) extra.push(h); }));
  const dt = t => t ? new Date(t) : '';
  const rows = [['מספר זהות', 'שם', 'מספר כרטיסים', 'מספר חשבונית', 'סוג מחיר', 'מחיר', 'עמדה', 'נרשם', 'עודכן', ...extra]];
  for (const p of purchases) {
    const get = h => { const f = (p.fields || []).find(x => x[0] === h); return f ? f[1] : ''; };
    rows.push([p.studentId, p.name, p.tickets, p.invoice, p.priceType === 'student' ? 'סטודנט' : p.priceType === 'guest' ? 'אורח' : '', p.price ?? '', p.station || '', dt(p.createdAt), dt(p.updatedAt), ...extra.map(get)]);
  }
  const act = { create: 'רכישה', update: 'עדכון', delete: 'מחיקה' };
  const logRows = [['זמן', 'מספר זהות', 'פעולה', 'כרטיסים', 'חשבונית', 'עמדה'], ...log.map(l => [dt(l.at), l.student_id, act[l.action] || l.action, l.tickets, l.invoice, l.station || ''])];
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  const s1 = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy hh:mm' });
  s1['!cols'] = rows[0].map(() => ({ wch: 18 }));
  const s2 = XLSX.utils.aoa_to_sheet(logRows, { cellDates: true, dateNF: 'dd/mm/yyyy hh:mm:ss' });
  s2['!cols'] = logRows[0].map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, s1, 'רכישות');
  XLSX.utils.book_append_sheet(wb, s2, 'יומן שינויים');
  XLSX.writeFile(wb, `רכישות-${new Date().toISOString().slice(0, 10)}.xlsx`);
};
