const { Router } = require('express');
const db = require('../database');

const router = Router();

router.get('/', (req, res) => {
  const { cliente_id, estado } = req.query;
  let sql = `
    SELECT f.*, c.nombre AS cliente_nombre
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
  `;
  const params = [];
  const where = [];
  if (cliente_id) { where.push('f.cliente_id = ?'); params.push(cliente_id); }
  if (estado)     { where.push('f.estado = ?');      params.push(estado); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY f.fecha DESC';

  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const factura = db.prepare(`
    SELECT f.*, c.nombre AS cliente_nombre
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    WHERE f.id = ?
  `).get(req.params.id);
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json(factura);
});

router.post('/', (req, res) => {
  const { cliente_id, numero, fecha, monto, iva } = req.body;
  if (!cliente_id || !numero || !fecha || monto == null || iva == null)
    return res.status(400).json({ error: 'cliente_id, numero, fecha, monto e iva son requeridos' });

  const cliente = db.prepare('SELECT id FROM clientes WHERE id = ?').get(cliente_id);
  if (!cliente) return res.status(400).json({ error: 'cliente_id no existe' });

  const monto_total = Number(monto) + Number(iva);

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO facturas (cliente_id, numero, fecha, monto, iva, monto_total)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(cliente_id, numero, fecha, monto, iva, monto_total);

  res.status(201).json({ id: lastInsertRowid, cliente_id, numero, fecha, monto, iva, monto_total, estado: 'impaga' });
});

router.patch('/:id/estado', (req, res) => {
  const { estado } = req.body;
  if (!['pagada', 'impaga'].includes(estado))
    return res.status(400).json({ error: 'estado debe ser "pagada" o "impaga"' });

  const { changes } = db.prepare('UPDATE facturas SET estado = ? WHERE id = ?').run(estado, req.params.id);
  if (!changes) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json({ id: Number(req.params.id), estado });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM pagos WHERE factura_id = ?').run(req.params.id);
  const { changes } = db.prepare('DELETE FROM facturas WHERE id = ?').run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'Factura no encontrada' });
  res.status(204).send();
});

module.exports = router;
