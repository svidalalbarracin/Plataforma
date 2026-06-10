/**
 * Rutas CRUD de pagos.
 *
 * GET    /api/pagos            → lista pagos (filtrable por factura_id)
 * GET    /api/pagos/:id        → obtiene un pago
 * POST   /api/pagos            → registra un pago (calcula retención automáticamente)
 * DELETE /api/pagos/:id        → elimina un pago
 *
 * Al crear un pago, la factura se marca automáticamente como pagada.
 * La retención se calcula como el saldo restante después del cobro
 * (monto_total - pagos_anteriores - monto_nuevo), representando lo que queda pendiente.
 *
 * @module facturacion/routes/pagos
 */
const { Router } = require('express');
const db = require('../../../../core/database');

const router = Router();

/**
 * GET /api/pagos — Lista pagos con número de factura incluido.
 * @query {string} [factura_id] - Filtra por factura
 */
router.get('/', (req, res) => {
  const { factura_id } = req.query;
  let sql = `
    SELECT p.*, f.numero AS factura_numero
    FROM pagos p
    JOIN facturas f ON f.id = p.factura_id
  `;
  const params = [];
  if (factura_id) { sql += ' WHERE p.factura_id = ?'; params.push(factura_id); }
  sql += ' ORDER BY p.fecha DESC';
  res.json(db.prepare(sql).all(...params));
});

/**
 * GET /api/pagos/:id — Devuelve un pago por ID.
 */
router.get('/:id', (req, res) => {
  const pago = db.prepare(`
    SELECT p.*, f.numero AS factura_numero
    FROM pagos p
    JOIN facturas f ON f.id = p.factura_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!pago) return res.status(404).json({ error: 'Pago no encontrado' });
  res.json(pago);
});

/**
 * POST /api/pagos — Registra un pago y marca la factura como pagada.
 * Body: { factura_id, fecha, monto, nota? }
 * La retención se calcula automáticamente como el saldo que queda tras el pago.
 * @returns {Object} Pago creado con retención calculada
 */
router.post('/', (req, res) => {
  const { factura_id, fecha, monto, nota } = req.body;
  if (!factura_id || !fecha || monto == null)
    return res.status(400).json({ error: 'factura_id, fecha y monto son requeridos' });

  const factura = db.prepare('SELECT id, monto_total FROM facturas WHERE id = ?').get(factura_id);
  if (!factura) return res.status(400).json({ error: 'factura_id no existe' });

  const pagado    = db.prepare('SELECT COALESCE(SUM(monto), 0) AS total FROM pagos WHERE factura_id = ?').get(factura_id).total;
  const saldo     = Math.round((factura.monto_total - pagado) * 100) / 100;
  const retencion = Math.round(Math.max(0, saldo - Number(monto)) * 100) / 100;

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO pagos (factura_id, fecha, monto, retencion, nota) VALUES (?, ?, ?, ?, ?)'
  ).run(factura_id, fecha, monto, retencion, nota ?? null);

  db.prepare("UPDATE facturas SET estado = 'pagada' WHERE id = ? AND estado = 'impaga'").run(factura_id);

  res.status(201).json({ id: lastInsertRowid, factura_id, fecha, monto, retencion, nota });
});

/**
 * DELETE /api/pagos/:id — Elimina un pago.
 * Nota: no revierte el estado de la factura a impaga automáticamente.
 */
router.delete('/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM pagos WHERE id = ?').run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'Pago no encontrado' });
  res.status(204).send();
});

module.exports = router;
