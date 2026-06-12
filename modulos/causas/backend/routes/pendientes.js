/**
 * GET    /api/causas/pendientes          → lista (query: estado=pendiente|completado, causa_id)
 * POST   /api/causas/pendientes          → crear
 * PATCH  /api/causas/pendientes/:id      → actualizar campos (completado, descripcion, etc.)
 * DELETE /api/causas/pendientes/:id      → eliminar
 */
const express = require('express');
const router  = express.Router();
const db      = require('../../../../core/database');

function getPendiente(id) {
  return db.prepare(`
    SELECT p.*, c.numero_expediente, c.caratula
    FROM pendientes p
    LEFT JOIN causas c ON c.id = p.causa_id
    WHERE p.id = ?
  `).get(id) ?? null;
}

router.get('/', (req, res) => {
  const { estado, causa_id } = req.query;
  const conds  = [];
  const params = [];

  if (estado === 'pendiente')  { conds.push('p.completado = 0'); }
  if (estado === 'completado') { conds.push('p.completado = 1'); }
  if (causa_id)                { conds.push('p.causa_id = ?'); params.push(causa_id); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT p.*, c.numero_expediente, c.caratula
    FROM pendientes p
    LEFT JOIN causas c ON c.id = p.causa_id
    ${where}
    ORDER BY p.completado ASC, p.fecha_limite ASC
  `).all(...params);

  res.json(rows);
});

router.post('/', (req, res) => {
  const { descripcion, causa_id, fecha_limite, dias_aviso, fecha_aviso, nota } = req.body;
  if (!descripcion?.trim()) return res.status(400).json({ error: 'descripcion es obligatoria' });
  if (!fecha_limite)        return res.status(400).json({ error: 'fecha_limite es obligatoria' });
  if (!fecha_aviso)         return res.status(400).json({ error: 'fecha_aviso es obligatoria' });

  const r = db.prepare(`
    INSERT INTO pendientes (descripcion, causa_id, fecha_limite, dias_aviso, fecha_aviso, nota)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    descripcion.trim(),
    causa_id ?? null,
    fecha_limite,
    dias_aviso ?? 3,
    fecha_aviso,
    nota?.trim() ?? null
  );

  res.status(201).json(getPendiente(r.lastInsertRowid));
});

router.patch('/:id', (req, res) => {
  const p = getPendiente(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pendiente no encontrado' });

  const campos = ['descripcion', 'causa_id', 'fecha_limite', 'dias_aviso', 'fecha_aviso', 'nota', 'completado'];
  const sets   = [];
  const vals   = [];

  for (const campo of campos) {
    if (campo in req.body) { sets.push(`${campo} = ?`); vals.push(req.body[campo]); }
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
