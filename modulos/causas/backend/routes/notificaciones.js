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

  const tad = db.prepare(`
    SELECT id, fecha, nombre, mensaje, numero_tramite, archivo_path, leida
    FROM notificaciones_tad
    ORDER BY fecha DESC, id DESC
  `).all();

  const docsExternos = db.prepare(`
    SELECT numero_tramite, fecha_envio, motivo, archivos_paths
    FROM documentos_externos_tad
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
    ...tad.map(r => {
      const storageBase = '/causas/storage/tad';

      const pathAUrl = (p) => {
        if (!p) return null;
        const match = p.match(/storage[\\/]tad[\\/](.+)$/);
        return match ? `${storageBase}/${match[1].replace(/\\/g, '/')}` : null;
      };

      const archivos = [];
      if (r.archivo_path) {
        archivos.push({ nombre: 'Notificación', url: pathAUrl(r.archivo_path) });
      }
      docsExternos
        .filter(d => d.numero_tramite === r.numero_tramite)
        .forEach(d => {
          const paths = JSON.parse(d.archivos_paths || '[]');
          paths.forEach((p, i) => {
            archivos.push({ nombre: `Doc. Externo ${i + 1} (${d.fecha_envio || ''})`, url: pathAUrl(p) });
          });
        });

      return {
        id:         r.id,
        numero:     r.numero_tramite,
        expediente: r.numero_tramite,
        caratula:   r.mensaje,
        autor:      r.nombre,
        fecha:      r.fecha,
        origen:     'TAD',
        leida:      r.leida === 1,
        archivos,
      };
    }),
  ];

  res.json({
    ultima_auto:    metaAuto?.value ?? null,
    intervalo_min:  intervaloMin,
    notificaciones,
  });
});

// PATCH /api/causas/notificaciones/marcar-todas  (debe ir ANTES de /:id)
router.patch('/marcar-todas', (req, res) => {
  db.prepare('UPDATE notificaciones_pjn SET leida = 1').run();
  db.prepare('UPDATE notificaciones_tad SET leida = 1').run();
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
  const table  = origen === 'TAD' ? 'notificaciones_tad' : 'notificaciones_pjn';
  const result = db.prepare(`UPDATE ${table} SET leida = 1 WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Notificación no encontrada' });
  res.json({ ok: true });
});

module.exports = router;
