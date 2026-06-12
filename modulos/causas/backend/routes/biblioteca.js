/**
 * Rutas API para la biblioteca de causas.
 *
 * GET    /api/causas/biblioteca                        → lista causas (filtros: estado, tipo, q)
 * GET    /api/causas/biblioteca/stats                  → conteos por estado y tipo
 * GET    /api/causas/biblioteca/:id                    → detalle completo de una causa
 * POST   /api/causas/biblioteca                        → crear causa
 * PUT    /api/causas/biblioteca/:id                    → actualizar causa
 * DELETE /api/causas/biblioteca/:id                    → eliminar causa
 *
 * POST   /api/causas/biblioteca/:id/clientes           → vincular cliente a causa
 * DELETE /api/causas/biblioteca/:id/clientes/:cliId    → desvincular cliente
 *
 * POST   /api/causas/biblioteca/:id/vincular-notif     → auto-vincular notificaciones por expediente
 * PATCH  /api/causas/biblioteca/notif/:origen/:nId/causa → asignar causa_id a una notificación
 *
 * GET    /api/causas/carpetas                          → lista carpetas (con causa vinculada)
 * POST   /api/causas/carpetas                          → crear carpeta
 * PUT    /api/causas/carpetas/:id                      → actualizar carpeta
 * DELETE /api/causas/carpetas/:id                      → eliminar carpeta
 *
 * @module causas/routes/biblioteca
 */
const express         = require('express');
const router          = express.Router();
const db              = require('../../../../core/database');
const { inferirTodos } = require('../inferirCliente');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Devuelve los clientes vinculados a una o varias causas en un mapa { causa_id: [] }.
 * @param {number[]} ids
 * @returns {Record<number, {id,nombre,cuit}[]>}
 */
function clientesPorCausas(ids) {
  if (!ids.length) return {};
  const rows = db.prepare(`
    SELECT cc.causa_id, cl.id, cl.nombre, cl.cuit
    FROM causa_cliente cc
    JOIN clientes cl ON cl.id = cc.cliente_id
    WHERE cc.causa_id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  const map = {};
  rows.forEach(r => {
    if (!map[r.causa_id]) map[r.causa_id] = [];
    map[r.causa_id].push({ id: r.id, nombre: r.nombre, cuit: r.cuit });
  });
  return map;
}

/**
 * Devuelve la fila de una causa o null si no existe.
 * @param {number} id
 */
function getCausa(id) {
  return db.prepare('SELECT * FROM causas WHERE id = ?').get(id) ?? null;
}

// ── Causas — listado y detalle ────────────────────────────────────────────────

/**
 * GET /api/causas/biblioteca
 * Lista causas con conteo de notificaciones y clientes vinculados.
 * Query params opcionales: estado, tipo, q (busca en expediente y carátula).
 */
router.get('/', (req, res) => {
  const { estado, tipo, q } = req.query;

  const conds  = [];
  const params = [];

  if (estado) { conds.push('c.estado = ?');                      params.push(estado); }
  if (tipo)   { conds.push('c.tipo = ?');                        params.push(tipo); }
  if (q)      { conds.push('(c.numero_expediente LIKE ? OR c.caratula LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const causas = db.prepare(`
    SELECT
      c.id, c.numero_expediente, c.caratula, c.tipo, c.estado,
      c.juzgado, c.fecha_inicio, c.notas, c.created_at,
      (SELECT COUNT(*) FROM notificaciones_pjn    WHERE causa_id = c.id) AS notif_pjn,
      (SELECT COUNT(*) FROM notificaciones_tad    WHERE causa_id = c.id) AS notif_tad,
      (SELECT COUNT(*) FROM notificaciones_sicnea WHERE causa_id = c.id) AS notif_sicnea,
      (SELECT COUNT(*) FROM carpetas              WHERE causa_id = c.id) AS carpetas_count
    FROM causas c
    ${where}
    ORDER BY c.created_at DESC
  `).all(...params);

  const mapa = clientesPorCausas(causas.map(c => c.id));
  res.json(causas.map(c => ({ ...c, clientes: mapa[c.id] ?? [] })));
});

/**
 * GET /api/causas/biblioteca/stats
 * Conteos agrupados por estado y por tipo. Va antes de /:id para que Express
 * no lo interprete como un ID.
 */
router.get('/stats', (req, res) => {
  const porEstado = db.prepare(`
    SELECT estado, COUNT(*) AS total FROM causas GROUP BY estado
  `).all();
  const porTipo = db.prepare(`
    SELECT tipo, COUNT(*) AS total FROM causas GROUP BY tipo
  `).all();
  res.json({ por_estado: porEstado, por_tipo: porTipo });
});

/**
 * POST /api/causas/biblioteca/inferir-clientes
 * Recorre todas las causas sin cliente vinculado e intenta inferirlo
 * a partir de sus notificaciones (SICNEA: razon_social, PJN: carátula,
 * TAD: solo si el cliente ya existe). Devuelve un resumen del proceso.
 */
router.post('/inferir-clientes', (req, res) => {
  try {
    const resultado = inferirTodos();
    res.json(resultado);
  } catch (err) {
    console.error('[inferir-clientes]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/causas/biblioteca/:id
 * Detalle completo: causa + clientes + notificaciones vinculadas + carpetas.
 */
router.get('/:id', (req, res) => {
  const causa = getCausa(req.params.id);
  if (!causa) return res.status(404).json({ error: 'Causa no encontrada' });

  const clientes = db.prepare(`
    SELECT cl.id, cl.nombre, cl.cuit, cl.email, cl.telefono
    FROM causa_cliente cc
    JOIN clientes cl ON cl.id = cc.cliente_id
    WHERE cc.causa_id = ?
  `).all(causa.id);

  const notif_pjn = db.prepare(`
    SELECT id, numero, numero_expediente, caratula, autor, fecha_envio, leida, archivo_path
    FROM notificaciones_pjn WHERE causa_id = ? ORDER BY fecha_envio DESC
  `).all(causa.id);

  const notif_tad = db.prepare(`
    SELECT id, fecha, nombre, mensaje, numero_tramite, archivo_path, leida
    FROM notificaciones_tad WHERE causa_id = ? ORDER BY fecha DESC
  `).all(causa.id);

  const notif_sicnea = db.prepare(`
    SELECT id, numero, razon_social, aduana, motivo, documento_ref, fecha_alta, estado, archivos_paths, leida
    FROM notificaciones_sicnea WHERE causa_id = ? ORDER BY fecha_alta DESC
  `).all(causa.id);

  const carpetas = db.prepare(`
    SELECT id, numero, ubicacion, descripcion, created_at
    FROM carpetas WHERE causa_id = ? ORDER BY created_at DESC
  `).all(causa.id);

  res.json({ ...causa, clientes, notif_pjn, notif_tad, notif_sicnea, carpetas });
});

// ── Causas — CRUD ─────────────────────────────────────────────────────────────

/**
 * POST /api/causas/biblioteca
 * Crea una causa. Body: { numero_expediente, caratula, tipo, estado?, juzgado?, fecha_inicio?, notas?, clientes?: number[] }
 * `clientes` es un array opcional de cliente_id existentes a vincular al crear.
 */
router.post('/', (req, res) => {
  const { numero_expediente, caratula, tipo, estado, juzgado, fecha_inicio, notas, clientes = [] } = req.body;
  if (!tipo) return res.status(400).json({ error: 'El campo tipo es obligatorio' });

  const result = db.prepare(`
    INSERT INTO causas (numero_expediente, caratula, tipo, estado, juzgado, fecha_inicio, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(numero_expediente ?? null, caratula ?? null, tipo, estado ?? 'en_tramite',
         juzgado ?? null, fecha_inicio ?? null, notas ?? null);

  const causaId = result.lastInsertRowid;

  const insertCliente = db.prepare('INSERT OR IGNORE INTO causa_cliente (causa_id, cliente_id) VALUES (?, ?)');
  for (const cliId of clientes) insertCliente.run(causaId, cliId);

  res.status(201).json(getCausa(causaId));
});

/**
 * PUT /api/causas/biblioteca/:id
 * Actualiza los campos de una causa. Solo pisa los campos enviados.
 */
router.put('/:id', (req, res) => {
  const causa = getCausa(req.params.id);
  if (!causa) return res.status(404).json({ error: 'Causa no encontrada' });

  const campos = ['numero_expediente', 'caratula', 'tipo', 'estado', 'juzgado', 'fecha_inicio', 'notas'];
  const sets   = [];
  const vals   = [];

  for (const campo of campos) {
    if (campo in req.body) { sets.push(`${campo} = ?`); vals.push(req.body[campo]); }
  }

  if (sets.length) {
    db.prepare(`UPDATE causas SET ${sets.join(', ')} WHERE id = ?`).run(...vals, causa.id);
  }

  res.json(getCausa(causa.id));
});

/**
 * DELETE /api/causas/biblioteca/:id
 * Elimina la causa. Las notificaciones vinculadas quedan con causa_id = NULL (ON DELETE SET NULL en la DB no aplica acá, lo hacemos explícito).
 */
router.delete('/:id', (req, res) => {
  const causa = getCausa(req.params.id);
  if (!causa) return res.status(404).json({ error: 'Causa no encontrada' });

  db.prepare('UPDATE notificaciones_pjn    SET causa_id = NULL WHERE causa_id = ?').run(causa.id);
  db.prepare('UPDATE notificaciones_tad    SET causa_id = NULL WHERE causa_id = ?').run(causa.id);
  db.prepare('UPDATE notificaciones_sicnea SET causa_id = NULL WHERE causa_id = ?').run(causa.id);
  db.prepare('DELETE FROM causas WHERE id = ?').run(causa.id);

  res.json({ ok: true });
});

// ── Clientes vinculados ───────────────────────────────────────────────────────

/**
 * POST /api/causas/biblioteca/:id/clientes
 * Vincula un cliente existente a la causa. Body: { cliente_id }
 */
router.post('/:id/clientes', (req, res) => {
  const causa = getCausa(req.params.id);
  if (!causa) return res.status(404).json({ error: 'Causa no encontrada' });

  const { cliente_id } = req.body;
  if (!cliente_id) return res.status(400).json({ error: 'cliente_id es obligatorio' });

  const cliente = db.prepare('SELECT id, nombre, cuit FROM clientes WHERE id = ?').get(cliente_id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  db.prepare('INSERT OR IGNORE INTO causa_cliente (causa_id, cliente_id) VALUES (?, ?)').run(causa.id, cliente_id);
  res.json({ ok: true, cliente });
});

/**
 * DELETE /api/causas/biblioteca/:id/clientes/:cliId
 * Desvincula un cliente de la causa.
 */
router.delete('/:id/clientes/:cliId', (req, res) => {
  const result = db.prepare(
    'DELETE FROM causa_cliente WHERE causa_id = ? AND cliente_id = ?'
  ).run(req.params.id, req.params.cliId);
  if (result.changes === 0) return res.status(404).json({ error: 'Vínculo no encontrado' });
  res.json({ ok: true });
});

// ── Vinculación de notificaciones ─────────────────────────────────────────────

/**
 * POST /api/causas/biblioteca/:id/vincular-notif
 * Intenta vincular automáticamente las notificaciones sin causa asignada
 * cuyo número de expediente coincida con el de esta causa.
 * Solo toca notificaciones con causa_id IS NULL para no pisar asignaciones existentes.
 *
 * @returns {{ vinculadas: { pjn, tad, sicnea } }}
 */
router.post('/:id/vincular-notif', (req, res) => {
  const causa = getCausa(req.params.id);
  if (!causa) return res.status(404).json({ error: 'Causa no encontrada' });
  if (!causa.numero_expediente) return res.json({ vinculadas: { pjn: 0, tad: 0, sicnea: 0 } });

  const exp = causa.numero_expediente;

  const pjn = db.prepare(`
    UPDATE notificaciones_pjn SET causa_id = ?
    WHERE causa_id IS NULL AND numero_expediente = ?
  `).run(causa.id, exp).changes;

  const tad = db.prepare(`
    UPDATE notificaciones_tad SET causa_id = ?
    WHERE causa_id IS NULL AND numero_tramite = ?
  `).run(causa.id, exp).changes;

  const sicnea = db.prepare(`
    UPDATE notificaciones_sicnea SET causa_id = ?
    WHERE causa_id IS NULL AND documento_ref = ?
  `).run(causa.id, exp).changes;

  res.json({ vinculadas: { pjn, tad, sicnea } });
});

/**
 * PATCH /api/causas/biblioteca/notif/:origen/:nId/causa
 * Asignación manual: vincula una notificación suelta a una causa.
 * Body: { causa_id } — pasar null para desvincular.
 */
router.patch('/notif/:origen/:nId/causa', (req, res) => {
  const tabla = req.params.origen === 'tad'    ? 'notificaciones_tad'
              : req.params.origen === 'sicnea' ? 'notificaciones_sicnea'
              :                                   'notificaciones_pjn';

  const { causa_id } = req.body;
  const result = db.prepare(`UPDATE ${tabla} SET causa_id = ? WHERE id = ?`)
    .run(causa_id ?? null, req.params.nId);

  if (result.changes === 0) return res.status(404).json({ error: 'Notificación no encontrada' });
  res.json({ ok: true });
});

// ── Carpetas ──────────────────────────────────────────────────────────────────

/**
 * GET /api/causas/carpetas
 * Lista todas las carpetas con la causa vinculada (si tiene).
 */
router.get('/carpetas', (req, res) => {
  const carpetas = db.prepare(`
    SELECT
      ca.id, ca.numero, ca.ubicacion, ca.descripcion, ca.created_at,
      c.id AS causa_id, c.numero_expediente, c.caratula, c.estado
    FROM carpetas ca
    LEFT JOIN causas c ON c.id = ca.causa_id
    ORDER BY ca.created_at DESC
  `).all();
  res.json(carpetas);
});

/**
 * POST /api/causas/carpetas
 * Crea una carpeta física. Body: { causa_id?, numero?, ubicacion?, descripcion? }
 */
router.post('/carpetas', (req, res) => {
  const { causa_id, numero, ubicacion, descripcion } = req.body;
  const result = db.prepare(`
    INSERT INTO carpetas (causa_id, numero, ubicacion, descripcion)
    VALUES (?, ?, ?, ?)
  `).run(causa_id ?? null, numero ?? null, ubicacion ?? null, descripcion ?? null);
  res.status(201).json(
    db.prepare('SELECT * FROM carpetas WHERE id = ?').get(result.lastInsertRowid)
  );
});

/**
 * PUT /api/causas/carpetas/:id
 * Actualiza una carpeta.
 */
router.put('/carpetas/:id', (req, res) => {
  const carpeta = db.prepare('SELECT id FROM carpetas WHERE id = ?').get(req.params.id);
  if (!carpeta) return res.status(404).json({ error: 'Carpeta no encontrada' });

  const campos = ['causa_id', 'numero', 'ubicacion', 'descripcion'];
  const sets   = [];
  const vals   = [];
  for (const campo of campos) {
    if (campo in req.body) { sets.push(`${campo} = ?`); vals.push(req.body[campo]); }
  }
  if (sets.length) {
    db.prepare(`UPDATE carpetas SET ${sets.join(', ')} WHERE id = ?`).run(...vals, carpeta.id);
  }
  res.json(db.prepare('SELECT * FROM carpetas WHERE id = ?').get(carpeta.id));
});

/**
 * DELETE /api/causas/carpetas/:id
 * Elimina una carpeta.
 */
router.delete('/carpetas/:id', (req, res) => {
  const result = db.prepare('DELETE FROM carpetas WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Carpeta no encontrada' });
  res.json({ ok: true });
});

module.exports = router;
