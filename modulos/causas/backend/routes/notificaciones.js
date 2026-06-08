const express = require('express');
const router  = express.Router();
const db      = require('../../../../core/database');

// GET /api/causas/notificaciones
router.get('/', (req, res) => {
  const pjn = db.prepare(`
    SELECT id, numero, numero_expediente, caratula, autor, fecha_envio, leida
    FROM notificaciones_pjn
    ORDER BY fecha_envio DESC, id DESC
  `).all();

  const sicnea = db.prepare(`
    SELECT id, numero, razon_social, motivo, fecha_alta, fecha_vencimiento, leida
    FROM notificaciones_sicnea
    ORDER BY fecha_alta DESC, id DESC
  `).all();

  const metaAuto     = db.prepare("SELECT value FROM scraper_meta WHERE key = 'pjn_ultima_auto'").get();
  const intervaloMin = parseInt(process.env.CAUSAS_INTERVALO_MIN, 10) || 30;

  const notificaciones = [
    ...pjn.map(r => ({
      id:         r.id,
      numero:     r.numero,
      expediente: r.numero_expediente,
      caratula:   r.caratula,
      autor:      r.autor,
      fecha:      r.fecha_envio,
      origen:     'PJN',
      leida:      r.leida === 1,
    })),
    ...sicnea.map(r => ({
      id:               r.id,
      numero:           r.numero,
      expediente:       null,
      caratula:         r.razon_social,
      autor:            r.motivo,
      fecha:            r.fecha_alta,
      fecha_vencimiento: r.fecha_vencimiento,
      origen:           'SICNEA',
      leida:            r.leida === 1,
    })),
  ];

  res.json({
    ultima_auto:    metaAuto?.value ?? null,
    intervalo_min:  intervaloMin,
    notificaciones,
  });
});

// PATCH /api/causas/notificaciones/marcar-todas  (debe ir ANTES de /:id)
router.patch('/marcar-todas', (req, res) => {
  db.prepare('UPDATE notificaciones_pjn    SET leida = 1').run();
  db.prepare('UPDATE notificaciones_sicnea SET leida = 1').run();
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
// ?origen=PJN (default) | ?origen=SICNEA
router.patch('/:id/leida', (req, res) => {
  const origen = req.query.origen || 'PJN';
  const table  = origen === 'SICNEA' ? 'notificaciones_sicnea' : 'notificaciones_pjn';
  const result = db.prepare(`UPDATE ${table} SET leida = 1 WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Notificación no encontrada' });
  res.json({ ok: true });
});

module.exports = router;
