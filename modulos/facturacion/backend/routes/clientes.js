/**
 * Rutas CRUD de clientes.
 *
 * GET    /api/clientes      → lista todos los clientes
 * GET    /api/clientes/:id  → obtiene un cliente por ID
 * POST   /api/clientes      → crea un cliente
 * PUT    /api/clientes/:id  → actualiza un cliente
 * DELETE /api/clientes/:id  → elimina un cliente (falla si tiene facturas)
 *
 * @module facturacion/routes/clientes
 */
const { Router } = require('express');
const db = require('../../../../core/database');

const router = Router();

/** GET /api/clientes — Lista todos los clientes ordenados por nombre. */
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM clientes ORDER BY nombre').all());
});

/**
 * GET /api/clientes/:id — Devuelve un cliente por ID.
 * @returns {Object} Cliente o 404 si no existe
 */
router.get('/:id', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(cliente);
});

/**
 * POST /api/clientes — Crea un cliente.
 * Body: { nombre, cuit, email?, telefono?, anticipo_usd?, honorario_exito_usd?, concepto_facturacion? }
 * @returns {Object} Cliente creado con su ID
 */
router.post('/', (req, res) => {
  const { nombre, cuit, email, telefono, anticipo_usd, honorario_exito_usd, concepto_facturacion } = req.body;
  if (!nombre || !cuit) return res.status(400).json({ error: 'nombre y cuit son requeridos' });

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO clientes (nombre, cuit, email, telefono, anticipo_usd, honorario_exito_usd, concepto_facturacion) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(nombre, cuit, email ?? null, telefono ?? null, anticipo_usd ?? null, honorario_exito_usd ?? null, concepto_facturacion ?? null);

  res.status(201).json({ id: lastInsertRowid, nombre, cuit, email, telefono, anticipo_usd, honorario_exito_usd, concepto_facturacion });
});

/**
 * PUT /api/clientes/:id — Actualiza todos los campos de un cliente.
 * Body: { nombre, cuit, email?, telefono?, anticipo_usd?, honorario_exito_usd?, concepto_facturacion? }
 */
router.put('/:id', (req, res) => {
  const { nombre, cuit, email, telefono, anticipo_usd, honorario_exito_usd, concepto_facturacion } = req.body;
  if (!nombre || !cuit) return res.status(400).json({ error: 'nombre y cuit son requeridos' });

  const { changes } = db.prepare(
    'UPDATE clientes SET nombre = ?, cuit = ?, email = ?, telefono = ?, anticipo_usd = ?, honorario_exito_usd = ?, concepto_facturacion = ? WHERE id = ?'
  ).run(nombre, cuit, email ?? null, telefono ?? null, anticipo_usd ?? null, honorario_exito_usd ?? null, concepto_facturacion ?? null, req.params.id);

  if (!changes) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ id: Number(req.params.id), nombre, cuit, email, telefono, anticipo_usd, honorario_exito_usd, concepto_facturacion });
});

/**
 * DELETE /api/clientes/:id — Elimina un cliente.
 * Falla con 409 si tiene facturas asociadas (FK constraint de SQLite).
 */
router.delete('/:id', (req, res) => {
  try {
    const { changes } = db.prepare('DELETE FROM clientes WHERE id = ?').run(req.params.id);
    if (!changes) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.status(204).send();
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY')
      return res.status(409).json({ error: 'No se puede eliminar: el cliente tiene facturas asociadas' });
    throw e;
  }
});

module.exports = router;
