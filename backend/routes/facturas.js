const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../database');

const PDF_DIR = path.join(__dirname, '../../storage/facturas');

const router = Router();

function pdfUrl(pdfPath) {
  return pdfPath ? '/pdfs/' + path.basename(pdfPath) : null;
}

function addComputed(f) {
  f.pdf_url = pdfUrl(f.pdf_path);
  return f;
}

router.get('/', (req, res) => {
  const { cliente_id, estado } = req.query;
  let sql = `
    SELECT f.*, c.nombre AS cliente_nombre, c.cuit AS cliente_cuit
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
  `;
  const params = [];
  const where = [];
  if (cliente_id) { where.push('f.cliente_id = ?'); params.push(cliente_id); }
  if (estado)     { where.push('f.estado = ?');      params.push(estado); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY f.fecha DESC';

  res.json(db.prepare(sql).all(...params).map(addComputed));
});

router.get('/:id', (req, res) => {
  const factura = db.prepare(`
    SELECT f.*, c.nombre AS cliente_nombre, c.cuit AS cliente_cuit
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    WHERE f.id = ?
  `).get(req.params.id);
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json(addComputed(factura));
});

router.post('/', (req, res) => {
  const { cliente_id, numero, fecha, monto, iva } = req.body;
  if (!cliente_id || !numero || !fecha || monto == null || iva == null)
    return res.status(400).json({ error: 'cliente_id, numero, fecha, monto e iva son requeridos' });

  const cliente = db.prepare('SELECT id FROM clientes WHERE id = ?').get(cliente_id);
  if (!cliente) return res.status(400).json({ error: 'cliente_id no existe' });

  const monto_total = Number(monto) + Number(iva);
  const monto_neto  = Math.round((monto_total / 1.21) * 100) / 100;
  const iva_calc    = Math.round((monto_total - monto_neto) * 100) / 100;

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO facturas (cliente_id, numero, fecha, monto, iva, monto_neto, monto_total)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cliente_id, numero, fecha, monto_neto, iva_calc, monto_neto, monto_total);

  res.status(201).json({ id: lastInsertRowid, cliente_id, numero, fecha, monto: monto_neto, iva: iva_calc, monto_neto, monto_total, estado: 'impaga' });
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
  const factura = db.prepare('SELECT pdf_path FROM facturas WHERE id = ?').get(req.params.id);
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });

  db.prepare('DELETE FROM pagos WHERE factura_id = ?').run(req.params.id);
  db.prepare('DELETE FROM facturas WHERE id = ?').run(req.params.id);

  if (factura.pdf_path) {
    const pdfFile = path.join(PDF_DIR, path.basename(factura.pdf_path));
    try { fs.unlinkSync(pdfFile); } catch { /* ya no existía */ }
  }

  res.status(204).send();
});

module.exports = router;
