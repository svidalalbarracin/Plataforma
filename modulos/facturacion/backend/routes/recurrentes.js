const { Router } = require('express');
const db = require('../../../../core/database');

const router = Router();

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.nombre AS cliente_nombre, c.cuit AS cliente_cuit
    FROM facturacion_recurrente r
    JOIN clientes c ON c.id = r.cliente_id
    ORDER BY c.nombre ASC
  `).all();
  res.json(rows);
});

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
    res.json(db.prepare('SELECT * FROM facturacion_recurrente WHERE id = ?').get(existing.id));
  } else {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO facturacion_recurrente (cliente_id, honorario_usd, activo) VALUES (?, ?, ?)'
    ).run(cliente_id, honorario_usd, activo ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM facturacion_recurrente WHERE id = ?').get(lastInsertRowid));
  }
});

router.put('/:id', (req, res) => {
  const { activo } = req.body;
  if (activo === undefined) return res.status(400).json({ error: 'activo es requerido' });
  const { changes } = db.prepare('UPDATE facturacion_recurrente SET activo = ? WHERE id = ?')
    .run(activo ? 1 : 0, req.params.id);
  if (!changes) return res.status(404).json({ error: 'No encontrado' });
  res.json({ id: Number(req.params.id), activo: activo ? 1 : 0 });
});

router.delete('/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM facturacion_recurrente WHERE id = ?').run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'No encontrado' });
  res.status(204).send();
});

module.exports = router;
