/**
 * Rutas API para la biblioteca de causas.
 *
 * GET    /api/causas/biblioteca                          → lista causas (filtros: estado, tipo, q)
 * GET    /api/causas/biblioteca/stats                    → conteos por estado y tipo
 * GET    /api/causas/biblioteca/notif-doc/:origen/:id    → sirve el PDF de una notificación
 * POST   /api/causas/biblioteca/inferir-clientes         → inferencia batch de clientes
 * GET    /api/causas/biblioteca/:id                      → detalle completo de una causa
 * POST   /api/causas/biblioteca                          → crear causa
 * PUT    /api/causas/biblioteca/:id                      → actualizar causa
 * DELETE /api/causas/biblioteca/:id                      → eliminar causa
 *
 * POST   /api/causas/biblioteca/:id/clientes             → vincular cliente existente { cliente_id }
 *                                                           o crear y vincular nuevo { nombre, cuit? }
 * DELETE /api/causas/biblioteca/:id/clientes/:cliId      → desvincular cliente
 *
 * POST   /api/causas/biblioteca/:id/vincular-notif       → auto-vincular notificaciones por expediente
 * PATCH  /api/causas/biblioteca/notif/:origen/:nId/causa → asignar causa_id a una notificación
 *
 * @module causas/routes/biblioteca
 */
const path            = require('path');
const fs              = require('fs');
const express         = require('express');
const router          = express.Router();
const db              = require('../../../../core/database');
const { inferirTodos, autoCrearCausas, vincularNotificacionesPendientes } = require('../inferirCliente');

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
      (SELECT COUNT(*) FROM notificaciones_sicnea WHERE causa_id = c.id) AS notif_sicnea
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
router.post('/inferir-clientes', async (req, res) => {
  try {
    const nuevas   = autoCrearCausas();
    const vinc     = vincularNotificacionesPendientes();
    const resultado = await inferirTodos();
    res.json({ nuevas_causas: nuevas, vinculaciones: vinc, ...resultado });
  } catch (err) {
    console.error('[inferir-clientes]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/causas/biblioteca/clientes
 * Devuelve todos los clientes con sus causas anidadas.
 * Por cada causa incluye: pendientes activos y fecha de última actividad.
 */
router.get('/clientes', (req, res) => {
  const rows = db.prepare(`
    SELECT
      cl.id       AS cliente_id,
      cl.nombre,
      cl.cuit,
      cl.email,
      cl.telefono,
      c.id        AS causa_id,
      c.numero_expediente,
      c.caratula,
      c.tipo,
      c.estado,
      c.juzgado,
      c.fecha_inicio,
      c.created_at,
      (SELECT COUNT(*) FROM pendientes p WHERE p.causa_id = c.id AND p.completado = 0)
        AS pendientes_activos,
      (SELECT MAX(f) FROM (
        SELECT fecha_envio AS f FROM notificaciones_pjn    WHERE causa_id = c.id
        UNION ALL
        SELECT fecha      AS f FROM notificaciones_tad    WHERE causa_id = c.id
        UNION ALL
        SELECT fecha_alta AS f FROM notificaciones_sicnea WHERE causa_id = c.id
      )) AS ultima_actividad
    FROM clientes cl
    LEFT JOIN causa_cliente cc ON cc.cliente_id = cl.id
    LEFT JOIN causas c ON c.id = cc.causa_id
    ORDER BY cl.nombre ASC, c.created_at DESC
  `).all();

  const mapa = new Map();
  for (const row of rows) {
    if (!mapa.has(row.cliente_id)) {
      mapa.set(row.cliente_id, {
        id: row.cliente_id, nombre: row.nombre, cuit: row.cuit,
        email: row.email, telefono: row.telefono, causas: [],
      });
    }
    if (row.causa_id !== null) {
      mapa.get(row.cliente_id).causas.push({
        id:                 row.causa_id,
        numero_expediente:  row.numero_expediente,
        caratula:           row.caratula,
        tipo:               row.tipo,
        estado:             row.estado,
        juzgado:            row.juzgado,
        fecha_inicio:       row.fecha_inicio,
        pendientes_activos: row.pendientes_activos ?? 0,
        ultima_actividad:   row.ultima_actividad,
      });
    }
  }

  // Causas sin cliente asignado
  const sinCliente = db.prepare(`
    SELECT
      c.id, c.numero_expediente, c.caratula, c.tipo, c.estado,
      c.juzgado, c.fecha_inicio, c.created_at,
      (SELECT COUNT(*) FROM pendientes p WHERE p.causa_id = c.id AND p.completado = 0) AS pendientes_activos,
      (SELECT MAX(f) FROM (
        SELECT fecha_envio AS f FROM notificaciones_pjn    WHERE causa_id = c.id
        UNION ALL
        SELECT fecha      AS f FROM notificaciones_tad    WHERE causa_id = c.id
        UNION ALL
        SELECT fecha_alta AS f FROM notificaciones_sicnea WHERE causa_id = c.id
      )) AS ultima_actividad
    FROM causas c
    WHERE c.id NOT IN (SELECT causa_id FROM causa_cliente WHERE causa_id IS NOT NULL)
    ORDER BY c.created_at DESC
  `).all();

  const result = [...mapa.values()];
  if (sinCliente.length > 0) {
    result.push({ id: null, nombre: null, cuit: null, email: null, telefono: null, causas: sinCliente, sinCliente: true });
  }

  res.json(result);
});

/**
 * PATCH /api/causas/biblioteca/clientes/:id
 * Actualiza los datos de un cliente (nombre, cuit, email, telefono).
 */
router.patch('/clientes/:id', (req, res) => {
  const cliente = db.prepare('SELECT id FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  const campos = ['nombre', 'cuit', 'email', 'telefono'];
  const sets   = [];
  const vals   = [];
  for (const campo of campos) {
    if (campo in req.body) {
      sets.push(`${campo} = ?`);
      vals.push(req.body[campo]?.trim() || null);
    }
  }

  if (sets.length) {
    db.prepare(`UPDATE clientes SET ${sets.join(', ')} WHERE id = ?`).run(...vals, cliente.id);
  }

  res.json(db.prepare('SELECT id, nombre, cuit, email, telefono FROM clientes WHERE id = ?').get(cliente.id));
});

/**
 * GET /api/causas/biblioteca/notif-doc/:origen/:id
 * Sirve el PDF de una notificación como inline PDF.
 * El path del archivo se obtiene desde la DB (sin posibilidad de path traversal).
 * origen: 'pjn' | 'tad' | 'sicnea'
 */
router.get('/notif-doc/:origen/:id', (req, res) => {
  const { origen, id } = req.params;
  let filePath;

  if (origen === 'pjn') {
    const row = db.prepare('SELECT archivo_path FROM notificaciones_pjn WHERE id = ?').get(id);
    filePath = row?.archivo_path ?? null;
  } else if (origen === 'tad') {
    const row = db.prepare('SELECT archivo_path FROM notificaciones_tad WHERE id = ?').get(id);
    filePath = row?.archivo_path ?? null;
  } else if (origen === 'sicnea') {
    const row = db.prepare('SELECT archivos_paths FROM notificaciones_sicnea WHERE id = ?').get(id);
    if (row?.archivos_paths) {
      try { filePath = JSON.parse(row.archivos_paths)[0] ?? null; } catch { filePath = null; }
    }
  } else {
    return res.status(400).json({ error: 'Origen inválido' });
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Documento no disponible' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
  res.sendFile(filePath);
});

/**
 * GET /api/causas/biblioteca/:id
 * Detalle completo: causa + clientes + notificaciones vinculadas + pendientes + notas.
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

  const pendientes = db.prepare(`
    SELECT id, descripcion, fecha_limite, completado, origen, nota, created_at
    FROM pendientes WHERE causa_id = ? ORDER BY completado ASC, fecha_limite ASC
  `).all(causa.id);

  const causa_notas = db.prepare(`
    SELECT id, texto, fecha, created_at
    FROM causa_notas WHERE causa_id = ? ORDER BY fecha DESC, created_at DESC
  `).all(causa.id);

  res.json({ ...causa, clientes, notif_pjn, notif_tad, notif_sicnea, pendientes, causa_notas });
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

  // Auto-vincular notificaciones existentes que coincidan por número de expediente
  if (numero_expediente) {
    db.prepare(`UPDATE notificaciones_pjn    SET causa_id = ? WHERE causa_id IS NULL AND numero_expediente = ?`).run(causaId, numero_expediente);
    db.prepare(`UPDATE notificaciones_tad    SET causa_id = ? WHERE causa_id IS NULL AND numero_tramite    = ?`).run(causaId, numero_expediente);
    db.prepare(`UPDATE notificaciones_sicnea SET causa_id = ? WHERE causa_id IS NULL AND documento_ref    = ?`).run(causaId, numero_expediente);
  }

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
 * Vincula un cliente a la causa. Dos modos:
 *   { cliente_id }        → vincula un cliente existente
 *   { nombre, cuit? }     → crea el cliente y lo vincula en un solo paso
 */
router.post('/:id/clientes', (req, res) => {
  const causa = getCausa(req.params.id);
  if (!causa) return res.status(404).json({ error: 'Causa no encontrada' });

  const { cliente_id, nombre, cuit } = req.body;
  let cliente;

  if (nombre?.trim()) {
    const r = db.prepare('INSERT INTO clientes (nombre, cuit) VALUES (?, ?)')
      .run(nombre.trim(), cuit?.trim() || null);
    cliente = db.prepare('SELECT id, nombre, cuit FROM clientes WHERE id = ?').get(r.lastInsertRowid);
  } else if (cliente_id) {
    cliente = db.prepare('SELECT id, nombre, cuit FROM clientes WHERE id = ?').get(cliente_id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  } else {
    return res.status(400).json({ error: 'Se requiere cliente_id o nombre' });
  }

  db.prepare('INSERT OR IGNORE INTO causa_cliente (causa_id, cliente_id) VALUES (?, ?)').run(causa.id, cliente.id);
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

// ── Notas manuales ────────────────────────────────────────────────────────────

/**
 * POST /api/causas/biblioteca/:id/notas
 * Crea una nota manual vinculada a una causa.
 * Body: { texto, fecha? }
 */
router.post('/:id/notas', (req, res) => {
  const causa = getCausa(req.params.id);
  if (!causa) return res.status(404).json({ error: 'Causa no encontrada' });
  const { texto, fecha } = req.body;
  if (!texto?.trim()) return res.status(400).json({ error: 'El texto es requerido' });
  const hoy = new Date().toLocaleDateString('sv'); // YYYY-MM-DD local
  const r = db.prepare('INSERT INTO causa_notas (causa_id, texto, fecha) VALUES (?, ?, ?)')
    .run(causa.id, texto.trim(), fecha || hoy);
  res.status(201).json(db.prepare('SELECT id, texto, fecha, created_at FROM causa_notas WHERE id = ?').get(r.lastInsertRowid));
});

/**
 * PATCH /api/causas/biblioteca/notas/:notaId
 * Actualiza texto y/o fecha de una nota.
 */
router.patch('/notas/:notaId', (req, res) => {
  const { texto, fecha } = req.body;
  const sets = [];
  const vals = [];
  if (texto !== undefined) { sets.push('texto = ?'); vals.push(texto.trim()); }
  if (fecha !== undefined) { sets.push('fecha = ?'); vals.push(fecha); }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
  const r = db.prepare(`UPDATE causa_notas SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.notaId);
  if (r.changes === 0) return res.status(404).json({ error: 'Nota no encontrada' });
  res.json(db.prepare('SELECT id, texto, fecha, created_at FROM causa_notas WHERE id = ?').get(req.params.notaId));
});

/**
 * DELETE /api/causas/biblioteca/notas/:notaId
 * Elimina una nota manual.
 */
router.delete('/notas/:notaId', (req, res) => {
  const r = db.prepare('DELETE FROM causa_notas WHERE id = ?').run(req.params.notaId);
  if (r.changes === 0) return res.status(404).json({ error: 'Nota no encontrada' });
  res.json({ ok: true });
});

module.exports = router;
