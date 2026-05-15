const { Router } = require('express');
const db = require('../database');

const router = Router();

router.get('/', (req, res) => {
  const clientes = db.prepare('SELECT * FROM clientes ORDER BY nombre').all();
  res.json(clientes);
});

router.get('/:id', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(cliente);
});

router.post('/', (req, res) => {
  const { nombre, cuit, email, telefono } = req.body;
  if (!nombre || !cuit) return res.status(400).json({ error: 'nombre y cuit son requeridos' });

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO clientes (nombre, cuit, email, telefono) VALUES (?, ?, ?, ?)'
  ).run(nombre, cuit, email ?? null, telefono ?? null);

  res.status(201).json({ id: lastInsertRowid, nombre, cuit, email, telefono });
});

router.put('/:id', (req, res) => {
  const { nombre, cuit, email, telefono } = req.body;
  if (!nombre || !cuit) return res.status(400).json({ error: 'nombre y cuit son requeridos' });

  const { changes } = db.prepare(
    'UPDATE clientes SET nombre = ?, cuit = ?, email = ?, telefono = ? WHERE id = ?'
  ).run(nombre, cuit, email ?? null, telefono ?? null, req.params.id);

  if (!changes) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ id: Number(req.params.id), nombre, cuit, email, telefono });
});

router.delete('/:id', (req, res) => {
  const { changes } = db.prepare('DELETE FROM clientes WHERE id = ?').run(req.params.id);
  if (!changes) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.status(204).send();
});

module.exports = router;
