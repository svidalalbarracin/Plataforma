/**
 * Genera causas desde las notificaciones existentes en la DB.
 * Agrupa PJN por numero_expediente, TAD por numero_tramite, SICNEA por documento_ref.
 * Luego auto-vincula las notificaciones a sus causas por número.
 *
 * Uso: node scripts/seed-causas.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), quiet: true });
const db = require('../core/database');

function insertar({ numero_expediente, caratula, tipo, estado, juzgado, fecha_inicio }) {
  const existe = db.prepare('SELECT id FROM causas WHERE numero_expediente = ? AND tipo = ?')
    .get(numero_expediente, tipo);
  if (existe) {
    console.log(`  [--] Ya existe: ${numero_expediente} (${tipo})`);
    return existe.id;
  }
  const r = db.prepare(`
    INSERT INTO causas (numero_expediente, caratula, tipo, estado, juzgado, fecha_inicio)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(numero_expediente, caratula ?? null, tipo, estado ?? 'en_tramite', juzgado ?? null, fecha_inicio ?? null);
  console.log(`  [OK] ${tipo.toUpperCase()} — ${numero_expediente}`);
  return r.lastInsertRowid;
}

function vincularNotif(causaId, numeroExpediente, tipo) {
  let pjn = 0, tad = 0, sicnea = 0;

  if (tipo === 'pjn') {
    pjn = db.prepare(`
      UPDATE notificaciones_pjn SET causa_id = ?
      WHERE causa_id IS NULL AND numero_expediente = ?
    `).run(causaId, numeroExpediente).changes;
  } else if (tipo === 'tad') {
    tad = db.prepare(`
      UPDATE notificaciones_tad SET causa_id = ?
      WHERE causa_id IS NULL AND numero_tramite = ?
    `).run(causaId, numeroExpediente).changes;
  } else if (tipo === 'sicnea') {
    sicnea = db.prepare(`
      UPDATE notificaciones_sicnea SET causa_id = ?
      WHERE causa_id IS NULL AND documento_ref = ?
    `).run(causaId, numeroExpediente).changes;
  }

  const total = pjn + tad + sicnea;
  if (total) console.log(`       → ${total} notificación(es) vinculada(s)`);
}

// ── PJN: agrupar por numero_expediente ────────────────────────────────────────
console.log('\n── PJN ──────────────────────────────────────────────');
const pjnGrupos = db.prepare(`
  SELECT
    numero_expediente,
    caratula,
    autor AS juzgado,
    MIN(fecha_envio) AS fecha_inicio
  FROM notificaciones_pjn
  WHERE numero_expediente IS NOT NULL
  GROUP BY numero_expediente
  ORDER BY fecha_inicio ASC
`).all();

for (const g of pjnGrupos) {
  const id = insertar({
    numero_expediente: g.numero_expediente,
    caratula:          g.caratula,
    tipo:              'pjn',
    juzgado:           g.juzgado,
    fecha_inicio:      g.fecha_inicio,
  });
  vincularNotif(id, g.numero_expediente, 'pjn');
}

// ── TAD: agrupar por numero_tramite ───────────────────────────────────────────
console.log('\n── TAD ──────────────────────────────────────────────');
const tadGrupos = db.prepare(`
  SELECT
    numero_tramite,
    nombre AS caratula,
    MIN(fecha) AS fecha_inicio
  FROM notificaciones_tad
  WHERE numero_tramite IS NOT NULL
  GROUP BY numero_tramite
  ORDER BY fecha_inicio ASC
`).all();

for (const g of tadGrupos) {
  const id = insertar({
    numero_expediente: g.numero_tramite,
    caratula:          g.caratula,
    tipo:              'tad',
    juzgado:           'Tribunal Fiscal de la Nación',
    fecha_inicio:      g.fecha_inicio,
  });
  vincularNotif(id, g.numero_tramite, 'tad');
}

// ── SICNEA: agrupar por documento_ref ─────────────────────────────────────────
console.log('\n── SICNEA ───────────────────────────────────────────');
const sicneaGrupos = db.prepare(`
  SELECT
    documento_ref,
    motivo AS caratula,
    razon_social,
    aduana AS juzgado,
    MIN(fecha_alta) AS fecha_inicio
  FROM notificaciones_sicnea
  WHERE documento_ref IS NOT NULL
  GROUP BY documento_ref
  ORDER BY fecha_inicio ASC
`).all();

for (const g of sicneaGrupos) {
  const id = insertar({
    numero_expediente: g.documento_ref,
    caratula:          `${g.razon_social} — ${g.caratula}`,
    tipo:              'sicnea',
    juzgado:           g.juzgado,
    fecha_inicio:      g.fecha_inicio,
  });
  vincularNotif(id, g.documento_ref, 'sicnea');
}

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log('\n── Resumen ──────────────────────────────────────────');
const stats = db.prepare(`SELECT tipo, COUNT(*) AS n FROM causas GROUP BY tipo`).all();
const totalVinc = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM notificaciones_pjn    WHERE causa_id IS NOT NULL) AS pjn,
    (SELECT COUNT(*) FROM notificaciones_tad    WHERE causa_id IS NOT NULL) AS tad,
    (SELECT COUNT(*) FROM notificaciones_sicnea WHERE causa_id IS NOT NULL) AS sicnea
`).get();

stats.forEach(s => console.log(`  ${s.tipo.toUpperCase()}: ${s.n} causa(s)`));
console.log(`  Notificaciones vinculadas → PJN: ${totalVinc.pjn}, TAD: ${totalVinc.tad}, SICNEA: ${totalVinc.sicnea}`);
