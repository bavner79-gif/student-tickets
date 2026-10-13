// Data layer. Uses PostgreSQL when DATABASE_URL is set (on Render),
// otherwise a local JSON file (for testing on your own computer).
const fs = require('fs');
const path = require('path');

function createPgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'postgres',
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value JSONB)`);
      await q(`CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
      await q(`CREATE TABLE IF NOT EXISTS purchases (
        student_id TEXT PRIMARY KEY, tickets INT NOT NULL, invoice TEXT NOT NULL,
        station TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS purchase_log (
        id SERIAL PRIMARY KEY, student_id TEXT, action TEXT, tickets INT, invoice TEXT, station TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    },
    async getMeta(key) {
      const r = await q(`SELECT value FROM meta WHERE key=$1`, [key]);
      return r.rows[0] ? r.rows[0].value : null;
    },
    async setMeta(key, value) {
      await q(`INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify(value)]);
    },
    async replaceStudents(rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // keep people added manually at the stations; a row in the new file replaces its manual twin
        await client.query(`DELETE FROM students WHERE coalesce(data->>'manual','') <> 'true'`);
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          const vals = [], params = [];
          chunk.forEach((r, j) => { vals.push(`($${j * 2 + 1},$${j * 2 + 2})`); params.push(r.id, JSON.stringify(r.data)); });
          await client.query(`INSERT INTO students(id,data) VALUES ${vals.join(',')} ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`, params);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    },
    async countStudents() {
      const r = await q(`SELECT count(*)::int AS n FROM students`); return r.rows[0].n;
    },
    async countManual() {
      const r = await q(`SELECT count(*)::int AS n FROM students WHERE data->>'manual'='true'`); return r.rows[0].n;
    },
    async sampleStudent() {
      const r = await q(`SELECT data FROM students WHERE coalesce(data->>'manual','') <> 'true' LIMIT 1`); return r.rows[0] ? r.rows[0].data : null;
    },
    async addStudent(row) {
      const r = await q(`INSERT INTO students(id,data) VALUES($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id`, [row.id, JSON.stringify(row.data)]);
      return r.rowCount === 1;
    },
    async getStudent(id) {
      const r = await q(`SELECT data FROM students WHERE id=$1`, [id]); return r.rows[0] ? r.rows[0].data : null;
    },
    async getPurchase(id) {
      const r = await q(`SELECT * FROM purchases WHERE student_id=$1`, [id]); return r.rows[0] ? rowToPurchase(r.rows[0]) : null;
    },
    async findInvoice(invoice) {
      const r = await q(`SELECT * FROM purchases WHERE lower(invoice)=lower($1)`, [invoice]); return r.rows.map(rowToPurchase);
    },
    async savePurchase(p, action) {
      await q(`INSERT INTO purchases(student_id,tickets,invoice,station) VALUES($1,$2,$3,$4)
        ON CONFLICT(student_id) DO UPDATE SET tickets=EXCLUDED.tickets, invoice=EXCLUDED.invoice, station=EXCLUDED.station, updated_at=now()`,
        [p.studentId, p.tickets, p.invoice, p.station]);
      await q(`INSERT INTO purchase_log(student_id,action,tickets,invoice,station) VALUES($1,$2,$3,$4,$5)`, [p.studentId, action, p.tickets, p.invoice, p.station]);
      return this.getPurchase(p.studentId);
    },
    // Save several one-ticket purchases under one invoice; all or nothing.
    async savePurchaseBatch(ids, invoice, station) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const taken = [];
        for (const id of ids) {
          const r = await client.query(`INSERT INTO purchases(student_id,tickets,invoice,station) VALUES($1,1,$2,$3) ON CONFLICT(student_id) DO NOTHING RETURNING student_id`, [id, invoice, station]);
          if (!r.rowCount) taken.push(id);
        }
        if (taken.length) { await client.query('ROLLBACK'); return { taken }; }
        for (const id of ids) await client.query(`INSERT INTO purchase_log(student_id,action,tickets,invoice,station) VALUES($1,'create',1,$2,$3)`, [id, invoice, station]);
        await client.query('COMMIT');
        return { taken: [] };
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    },
    async deletePurchase(id) {
      const p = await this.getPurchase(id);
      await q(`DELETE FROM purchases WHERE student_id=$1`, [id]);
      if (p) await q(`INSERT INTO purchase_log(student_id,action,tickets,invoice,station) VALUES($1,'delete',$2,$3,$4)`, [id, p.tickets, p.invoice, p.station]);
    },
    async listPurchases() {
      const r = await q(`SELECT p.*, s.data AS student FROM purchases p LEFT JOIN students s ON s.id=p.student_id ORDER BY p.updated_at DESC`);
      return r.rows.map(x => ({ ...rowToPurchase(x), student: x.student }));
    },
    async listLog() {
      const r = await q(`SELECT * FROM purchase_log ORDER BY at DESC`); return r.rows;
    },
  };
}

function rowToPurchase(r) {
  return { studentId: r.student_id, tickets: r.tickets, invoice: r.invoice, station: r.station, createdAt: r.created_at, updatedAt: r.updated_at };
}

function createFileStore(file) {
  let db = { meta: {}, students: {}, purchases: {}, log: [] };
  const save = () => fs.writeFileSync(file, JSON.stringify(db));
  return {
    kind: 'file',
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    async getMeta(k) { return db.meta[k] ?? null; },
    async setMeta(k, v) { db.meta[k] = v; save(); },
    async replaceStudents(rows) {
      const keep = {}; for (const [id, d] of Object.entries(db.students)) if (d.manual) keep[id] = d;
      db.students = keep; rows.forEach(r => { db.students[r.id] = r.data; }); save();
    },
    async countStudents() { return Object.keys(db.students).length; },
    async countManual() { return Object.values(db.students).filter(d => d.manual).length; },
    async sampleStudent() { return Object.values(db.students).find(d => !d.manual) || null; },
    async addStudent(row) { if (db.students[row.id]) return false; db.students[row.id] = row.data; save(); return true; },
    async getStudent(id) { return db.students[id] || null; },
    async getPurchase(id) { return db.purchases[id] || null; },
    async findInvoice(inv) { return Object.values(db.purchases).filter(p => p.invoice.toLowerCase() === inv.toLowerCase()); },
    async savePurchase(p, action) {
      const now = new Date().toISOString();
      const prev = db.purchases[p.studentId];
      db.purchases[p.studentId] = { ...p, createdAt: prev ? prev.createdAt : now, updatedAt: now };
      db.log.push({ student_id: p.studentId, action, tickets: p.tickets, invoice: p.invoice, station: p.station, at: now });
      save(); return db.purchases[p.studentId];
    },
    async savePurchaseBatch(ids, invoice, station) {
      const taken = ids.filter(id => db.purchases[id]);
      if (taken.length) return { taken };
      const now = new Date().toISOString();
      for (const id of ids) {
        db.purchases[id] = { studentId: id, tickets: 1, invoice, station, createdAt: now, updatedAt: now };
        db.log.push({ student_id: id, action: 'create', tickets: 1, invoice, station, at: now });
      }
      save(); return { taken: [] };
    },
    async deletePurchase(id) {
      const p = db.purchases[id];
      if (p) { delete db.purchases[id]; db.log.push({ student_id: id, action: 'delete', tickets: p.tickets, invoice: p.invoice, station: p.station, at: new Date().toISOString() }); save(); }
    },
    async listPurchases() {
      return Object.values(db.purchases).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => ({ ...p, student: db.students[p.studentId] || null }));
    },
    async listLog() { return [...db.log].reverse(); },
  };
}

module.exports = function createStore() {
  return process.env.DATABASE_URL
    ? createPgStore(process.env.DATABASE_URL)
    : createFileStore(path.join(__dirname, 'data', 'local-db.json'));
};
