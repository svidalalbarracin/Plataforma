const express = require('express');
const router  = express.Router();
const db      = require('../../../../core/database');

// GET /api/causas/notificaciones
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT id, numero, numero_expediente, caratula, autor, destinatario, fecha_envio, leida, created_at
    FROM notificaciones_pjn
    ORDER BY fecha_envio DESC, id DESC
  `).all();

  res.json(rows.map(r => ({
    id:           r.id,
    numero:       r.numero,
    expediente:   r.numero_expediente,
    caratula:     r.caratula,
    autor:        r.autor,
    destinatario: r.destinatario,
    fecha:        r.fecha_envio,
    origen:       'PJN',
    leida:        r.leida === 1,
  })));
});

// PATCH /api/causas/notificaciones/marcar-todas  (debe ir ANTES de /:id)
router.patch('/marcar-todas', (req, res) => {
  db.prepare('UPDATE notificaciones_pjn SET leida = 1').run();
  res.json({ ok: true });
});

// POST /api/causas/notificaciones/ejecutar — ejecuta el scraper PJN manualmente
router.post('/ejecutar', async (req, res) => {
  try {
    const { obtenerNotificacionesPJN } = require('../scrapers/pjn');
    const limite = req.body?.limite ? parseInt(req.body.limite, 10) : null;
    const nuevas = await obtenerNotificacionesPJN({ limite });
    res.json({ nuevas });
  } catch (e) {
    console.error('[causas/ejecutar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/causas/notificaciones/:id/leida
router.patch('/:id/leida', (req, res) => {
  const result = db.prepare('UPDATE notificaciones_pjn SET leida = 1 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Notificación no encontrada' });
  res.json({ ok: true });
});

module.exports = router;
