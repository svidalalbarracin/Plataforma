/**
 * Rutas de facturación recurrente (honorarios mensuales).
 *
 * Cada cliente puede tener a lo sumo una configuración de honorario en USD.
 * El día 1 de cada mes el scheduler envía un aviso por mail con el monto en pesos
 * calculado al tipo de cambio oficial del día.
 *
 * GET    /api/recurrentes      → lista todas las configuraciones activas e inactivas
 * POST   /api/recurrentes      → crea o actualiza (upsert) la configuración de un cliente
 * PUT    /api/recurrentes/:id  → activa o desactiva una configuración
 * DELETE /api/recurrentes/:id  → elimina una configuración
 *
 * @module facturacion/routes/recurrentes
 */
const { Router } = require('express');
const db = require('../../../../core/database');

const router = Router();

/**
 * GET /api/recurrentes — Lista todas las facturaciones recurrentes con datos del cliente.
 */
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.nombre AS cliente_nombre, c.cuit AS cliente_cuit
    FROM facturacion_recurrente r
    JOIN clientes c ON c.id = r.cliente_id
    ORDER BY c.nombre ASC
  `).all();
  res.json(rows);
});

/**
 * POST /api/recurrentes — Crea o actualiza (upsert) la facturación recurrente de un cliente.
 * Si ya existe una configuración para el cliente, actualiza honorario y estado activo.
 * Body: { cliente_id, honorario_usd, activo? }
 * @returns {Object} Configuración creada o actualizada
 */
router.post('/', (req, res) => {
  const { cliente_id, honorario_usd, activo = 1 } = req.body;
  if (!cliente_id || honorario_usd == null)
    return res.status(400).json({ error: 'cliente_id y honorario_usd son requeridos' });

  const cliente = db.prepare('SELECT id FROM clientes WHERE id = ?').get(cliente_id);
  if (!cliente) return res.status(400).json({ error: 'cliente_id no existe' });

  const existing = db.prepare('SELECT id FROM facturacion_recurrente WHERE cliente_id = ?').get(cliente_id);

  if (existing) {
    db.prepare('UPDATE facturacion_recurrente SET honorario_usd = ?, activo = ? WHERE id = ?')
      .run(honorario_usd, activo ? 1 : 0, existing.id);
    return res.json(db.prepare('SELECT * FROM facturacion_recurrente WHERE id = ?').get(existing.id));
  }

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO facturacion_recurrente (cliente_id, honorario_usd, activo) VALUES (?, ?, ?)'
  ).run(cliente_id, honorario_usd, activo ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM facturacion_recurrente WHERE id = ?').get(lastInsertRowid));
});

/**
 * PUT /api/recurrentes/:id — Activa o desactiva una configuración.
 * Body: { activo: 0 | 1 }
 */
router.put('/:id', (req, res) => {
  const { activo } = req.body;
  if (activo === undefined) return res.status(400).json({ error: 'activo es requerido' });
  const { changes } = db.prepare('UPDATE facturacion_recurrente SET activo = ? WHERE id = ?')
    .run(activo ? 1 : 0, req.params.id);
  if (!changes) return res.status(404).json({ error: 'No encontrado' });
  res.json({ id: Number(req.params.id), activo: activo ? 1 : 0 });
});

/**
 * DELETE /api/recurrentes/:id — Elimina una configuración de facturación recurrente.
 */
router.delete('/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM facturacion_recurrente WHERE id = ?').run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'No encontrado' });
  res.status(204).send();
});

module.exports = router;
