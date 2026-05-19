const { Router } = require('express');
const db = require('../database');

const router = Router();

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

router.post('/', (req, res) => {
  const { factura_id, fecha, monto, nota } = req.body;
  if (!factura_id || !fecha || monto == null)
    return res.status(400).json({ error: 'factura_id, fecha y monto son requeridos' });

  const factura = db.prepare('SELECT id, monto_total FROM facturas WHERE id = ?').get(factura_id);
  if (!factura) return res.status(400).json({ error: 'factura_id no existe' });

  const retencion = Math.round((factura.monto_total - Number(monto)) * 100) / 100;

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO pagos (factura_id, fecha, monto, retencion, nota) VALUES (?, ?, ?, ?, ?)'
  ).run(factura_id, fecha, monto, retencion, nota ?? null);

  // Al registrar cualquier cobro, marcar la factura como pagada automáticamente
  db.prepare("UPDATE facturas SET estado = 'pagada' WHERE id = ? AND estado = 'impaga'").run(factura_id);

  res.status(201).json({ id: lastInsertRowid, factura_id, fecha, monto, retencion, nota });
});

router.delete('/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM pagos WHERE id = ?').run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'Pago no encontrado' });
  res.status(204).send();
});

module.exports = router;
