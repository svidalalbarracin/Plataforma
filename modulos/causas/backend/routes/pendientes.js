/**
 * GET    /api/causas/pendientes           → lista (query: estado=pendiente|completado)
 * POST   /api/causas/pendientes           → crear
 * PUT    /api/causas/pendientes/:id/completar → marcar completado
 * PATCH  /api/causas/pendientes/:id       → actualizar campos
 * DELETE /api/causas/pendientes/:id       → eliminar
 */
const express = require('express');
const router  = express.Router();
const db      = require('../../../../core/database');

const SELECT = `
  SELECT
    p.id, p.descripcion, p.causa_id,
    p.fecha_limite, p.dias_aviso, p.fecha_aviso,
    p.nota, p.completado, p.created_at, p.completado_at,
    p.origen, p.notificacion_id, p.notificacion_tipo,
    COALESCE(p.numero_expediente, c.numero_expediente) AS numero_expediente,
    COALESCE(p.caratula, c.caratula) AS caratula
  FROM pendientes p
  LEFT JOIN causas c ON c.id = p.causa_id
`;

function getPendiente(id) {
  return db.prepare(`${SELECT} WHERE p.id = ?`).get(id) ?? null;
}

router.get('/', (req, res) => {
  const { estado } = req.query;
  const conds  = [];
  const params = [];

  if (estado === 'pendiente')  conds.push('p.completado = 0');
  if (estado === 'completado') conds.push('p.completado = 1');

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = db.prepare(`${SELECT} ${where} ORDER BY p.completado ASC, p.fecha_limite ASC`).all(...params);
  res.json(rows);
});

router.post('/', (req, res) => {
  const {
    descripcion, causa_id, fecha_limite, dias_aviso, fecha_aviso, nota,
    numero_expediente, caratula, origen, notificacion_id, notificacion_tipo,
  } = req.body;

  if (!descripcion?.trim()) return res.status(400).json({ error: 'descripcion es obligatoria' });
  if (!fecha_limite)        return res.status(400).json({ error: 'fecha_limite es obligatoria' });
  if (!fecha_aviso)         return res.status(400).json({ error: 'fecha_aviso es obligatoria' });

  // Resolver causa_id por numero_expediente si no viene explícito
  let resolvedCausaId = causa_id ?? null;
  if (!resolvedCausaId && numero_expediente?.trim()) {
    const causa = db.prepare('SELECT id FROM causas WHERE numero_expediente = ?').get(numero_expediente.trim());
    resolvedCausaId = causa?.id ?? null;
  }

  const r = db.prepare(`
    INSERT INTO pendientes
      (descripcion, causa_id, fecha_limite, dias_aviso, fecha_aviso, nota,
       numero_expediente, caratula, origen, notificacion_id, notificacion_tipo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    descripcion.trim(),
    resolvedCausaId,
    fecha_limite,
    dias_aviso ?? 3,
    fecha_aviso,
    nota?.trim() ?? null,
    numero_expediente?.trim() ?? null,
    caratula?.trim() ?? null,
    origen ?? null,
    notificacion_id ?? null,
    notificacion_tipo ?? null,
  );

  res.status(201).json(getPendiente(r.lastInsertRowid));
});

router.put('/:id/completar', (req, res) => {
  const p = getPendiente(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pendiente no encontrado' });

  const ahora = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (!p.causa_id && p.numero_expediente) {
    const causa = db.prepare('SELECT id FROM causas WHERE numero_expediente = ?').get(p.numero_expediente);
    if (causa) db.prepare('UPDATE pendientes SET causa_id = ? WHERE id = ?').run(causa.id, p.id);
  }

  db.prepare('UPDATE pendientes SET completado = 1, completado_at = ? WHERE id = ?').run(ahora, p.id);
  res.json(getPendiente(p.id));
});

router.patch('/:id', (req, res) => {
  const p = getPendiente(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pendiente no encontrado' });

  if (!p.causa_id && p.numero_expediente) {
    const causa = db.prepare('SELECT id FROM causas WHERE numero_expediente = ?').get(p.numero_expediente);
    if (causa) db.prepare('UPDATE pendientes SET causa_id = ? WHERE id = ?').run(causa.id, p.id);
  }

  const campos = [
    'descripcion', 'causa_id', 'fecha_limite', 'dias_aviso', 'fecha_aviso',
    'nota', 'completado', 'numero_expediente', 'caratula', 'origen',
  ];
  const sets = [];
  const vals = [];

  for (const campo of campos) {
    if (campo in req.body) { sets.push(`${campo} = ?`); vals.push(req.body[campo]); }
  }

  if ('completado' in req.body) {
    sets.push('completado_at = ?');
    vals.push(req.body.completado ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null);
  }

  if (sets.length) {
    db.prepare(`UPDATE pendientes SET ${sets.join(', ')} WHERE id = ?`).run(...vals, p.id);
  }

  res.json(getPendiente(p.id));
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM pendientes WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Pendiente no encontrado' });
  res.json({ ok: true });
});

module.exports = router;
