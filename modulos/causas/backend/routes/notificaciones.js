/**
 * Rutas API para el módulo de notificaciones de causas.
 *
 * Agrega notificaciones de PJN, TAD y SICNEA en una sola colección
 * con esquema normalizado para el frontend.
 *
 * GET    /api/causas/notificaciones           → lista todas las notificaciones + metadata
 * PATCH  /api/causas/notificaciones/marcar-todas → marca todas como leídas
 * POST   /api/causas/notificaciones/ejecutar  → ejecuta el scraper PJN manualmente
 * POST   /api/causas/notificaciones/backfill-pjn → descarga PDFs faltantes de PJN
 * PATCH  /api/causas/notificaciones/:id/leida → alterna leída/no leída
 *
 * @module causas/routes/notificaciones
 */
const express = require('express');
const router  = express.Router();
const db      = require('../../../../core/database');

/**
 * Convierte una ruta absoluta de archivo en una URL relativa servida por Express.
 * Extrae el segmento a partir de `storage/<base>/` y lo encoda para uso en URLs.
 *
 * @param {string|null} p    - Ruta absoluta del archivo
 * @param {string}      base - Subdirectorio base ('pjn', 'tad' o 'sicnea')
 * @returns {string|null} URL relativa o null si la ruta es inválida
 */
function pathAUrl(p, base) {
  if (!p) return null;
  const normalized = p.replace(/\\/g, '/');
  const match = normalized.match(new RegExp(`storage/${base}/(.+)$`));
  if (!match) return null;
  const segments = match[1].split('/');
  return `/causas/storage/${base}/${segments.map(encodeURIComponent).join('/')}`;
}

/**
 * GET /api/causas/notificaciones
 * Devuelve todas las notificaciones (PJN + TAD + SICNEA) normalizadas al mismo esquema,
 * junto con la fecha de la última ejecución automática de cada scraper y el intervalo configurado.
 *
 * @returns {{ ultima_auto, ultima_auto_sicnea, intervalo_min, notificaciones[] }}
 */
router.get('/', (req, res) => {
  const pjn = db.prepare(`
    SELECT id, numero, numero_expediente, caratula, autor, fecha_envio, leida, archivo_path
    FROM notificaciones_pjn
    ORDER BY fecha_envio DESC, id DESC
  `).all();

  const tad = db.prepare(`
    SELECT id, fecha, nombre, mensaje, numero_tramite, archivo_path, leida
    FROM notificaciones_tad
    ORDER BY fecha DESC, id DESC
  `).all();

  const sicnea = db.prepare(`
    SELECT id, numero, dependencia, razon_social, motivo,
           documento_ref, fecha_alta, estado, archivos_paths, leida, aduana
    FROM notificaciones_sicnea
    ORDER BY fecha_alta DESC, id DESC
  `).all();

  // Documentos externos TAD se adjuntan a la notificación TAD del mismo trámite
  const docsExternos = db.prepare(`
    SELECT numero_tramite, fecha_envio, motivo, archivos_paths
    FROM documentos_externos_tad
  `).all();

  const metaAuto       = db.prepare("SELECT value FROM scraper_meta WHERE key = 'pjn_ultima_auto'").get();
  const metaAutoSicnea = db.prepare("SELECT value FROM scraper_meta WHERE key = 'sicnea_ultima_auto'").get();
  const intervaloMin   = parseInt(process.env.CAUSAS_INTERVALO_MIN, 10) || 30;

  const notificaciones = [
    ...pjn.map(r => {
      const archivos = r.archivo_path
        ? [{ nombre: 'Notificación', url: pathAUrl(r.archivo_path, 'pjn') }]
        : [];
      return {
        id:         r.id,
        numero:     r.numero,
        expediente: r.numero_expediente,
        caratula:   r.caratula,
        autor:      r.autor,
        fecha:      r.fecha_envio,
        origen:     'PJN',
        leida:      r.leida === 1,
        archivos,
      };
    }),

    ...tad.map(r => {
      const archivos = r.archivo_path
        ? [{ nombre: 'Notificación', url: pathAUrl(r.archivo_path, 'tad') }]
        : [];
      // Adjuntar documentos externos del mismo trámite
      docsExternos
        .filter(d => d.numero_tramite === r.numero_tramite)
        .forEach(d => {
          const paths = JSON.parse(d.archivos_paths || '[]');
          paths.forEach((p, i) =>
            archivos.push({ nombre: `Doc. Externo ${i + 1} (${d.fecha_envio || ''})`, url: pathAUrl(p, 'tad') })
          );
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

    ...sicnea.map(r => {
      const paths = JSON.parse(r.archivos_paths || '[]');
      let adjNum  = 1;
      const archivos = paths.map(p => ({
        nombre: p.includes('_notif.') ? 'Notificación' : `Adjunto ${adjNum++}`,
        url:    pathAUrl(p, 'sicnea'),
      }));
      return {
        id:          r.id,
        numero:      r.numero,
        expediente:  r.documento_ref,
        caratula:    r.motivo,
        autor:       r.razon_social,
        fecha:       r.fecha_alta,
        origen:      'SICNEA',
        leida:       r.leida === 1,
        archivos,
        dependencia: r.dependencia,
        aduana:      r.aduana,
        estado:      r.estado,
      };
    }),
  ];

  res.json({
    ultima_auto:        metaAuto?.value       ?? null,
    ultima_auto_sicnea: metaAutoSicnea?.value ?? null,
    intervalo_min:      intervaloMin,
    notificaciones,
  });
});

/**
 * PATCH /api/causas/notificaciones/marcar-todas
 * Marca todas las notificaciones de PJN, TAD y SICNEA como leídas.
 * Debe estar registrada ANTES de /:id para que Express no la interprete como ID.
 */
router.patch('/marcar-todas', (req, res) => {
  db.prepare('UPDATE notificaciones_pjn    SET leida = 1').run();
  db.prepare('UPDATE notificaciones_tad    SET leida = 1').run();
  db.prepare('UPDATE notificaciones_sicnea SET leida = 1').run();
  res.json({ ok: true });
});

/**
 * POST /api/causas/notificaciones/ejecutar
 * Dispara los scrapers de PJN y TAD en secuencia.
 * Acepta `limite` en el body (solo aplica a PJN).
 *
 * @returns {{ nuevas_pjn: number, nuevas_tad: number, nuevas_docs_tad: number }}
 */
router.post('/ejecutar', async (req, res) => {
  try {
    const { obtenerNotificacionesPJN } = require('../scrapers/pjn');
    const { obtenerNotificacionesTAD } = require('../scrapers/tad');
    const { main: repararDuplicadosTAD } = require('../scrapers/reparar-tad-duplicados');
    const limite = req.body?.limite ? parseInt(req.body.limite, 10) : null;

    await repararDuplicadosTAD({ headless: true }).catch(err =>
      console.error('[causas/ejecutar] Error al reparar duplicados TAD:', err.message)
    );

    const nuevas_pjn                    = await obtenerNotificacionesPJN({ limite });
    const { nuevasNotif, nuevosDocs }   = await obtenerNotificacionesTAD();
    res.json({ nuevas_pjn, nuevas_tad: nuevasNotif, nuevas_docs_tad: nuevosDocs });
  } catch (e) {
    console.error('[causas/ejecutar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/causas/notificaciones/ejecutar-sicnea
 * Dispara SICNEA Abogados y luego Aduanero, en serie ("Poner SICNEA al
 * día"). Sin restricción de día: el scraper se adapta solo — sábado/domingo
 * trae todo, entre semana filtra a NOTIFICADA únicamente (ver sicnea.js).
 * Cada sistema se corre con su propio try/catch para que un fallo en uno no
 * le impida correr al otro; la respuesta siempre es 200 con el desglose,
 * incluidos los errores parciales si los hubo.
 *
 * @returns {{ nuevas_abogados: number, nuevas_aduanero: number, nuevas: number, errores: Array<{sistema: string, error: string}> }}
 */
router.post('/ejecutar-sicnea', async (req, res) => {
  const { obtenerNotificacionesAbogados, obtenerNotificacionesAduanero } = require('../scrapers/sicnea');
  const limite = req.body?.limite ? parseInt(req.body.limite, 10) : null;

  const resultado = { nuevas_abogados: 0, nuevas_aduanero: 0, errores: [] };

  try {
    resultado.nuevas_abogados = await obtenerNotificacionesAbogados({ limite });
  } catch (e) {
    // Si el lock está tomado ya en el primer sistema no se hizo nada todavía,
    // así que se corta acá con 409 en vez de devolver un resultado en cero que
    // parece un scraper roto. No se intenta aduanero: el lock es de SICNEA
    // entero, no por sistema.
    if (e.code === 'SICNEA_EN_CURSO') return res.status(409).json({ error: e.message });
    console.error('[causas/ejecutar-sicnea] Error en abogados:', e.message);
    resultado.errores.push({ sistema: 'abogados', error: e.message });
  }

  try {
    resultado.nuevas_aduanero = await obtenerNotificacionesAduanero({ limite });
  } catch (e) {
    // Acá sí se sigue de largo aunque sea el lock: abogados ya corrió y su
    // resultado no se tira. Alguien pudo tomar el lock en el medio.
    console.error('[causas/ejecutar-sicnea] Error en aduanero:', e.message);
    resultado.errores.push({ sistema: 'aduanero', error: e.message });
  }

  resultado.nuevas = resultado.nuevas_abogados + resultado.nuevas_aduanero;
  res.json(resultado);
});

/**
 * POST /api/causas/notificaciones/backfill-pjn
 * Descarga los PDFs de notificaciones PJN que ya están en la base pero no tienen archivo.
 *
 * @returns {{ descargados: number }}
 */
router.post('/backfill-pjn', async (req, res) => {
  try {
    const { backfillAdjuntosPJN } = require('../scrapers/pjn');
    const descargados = await backfillAdjuntosPJN();
    res.json({ descargados });
  } catch (e) {
    console.error('[causas/backfill-pjn]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/causas/notificaciones/:id/leida
 * Alterna el estado leída/no leída de una notificación.
 * El query param `origen` determina la tabla (PJN, TAD o SICNEA).
 *
 * @param {string} req.params.id      - ID de la notificación
 * @param {string} req.query.origen   - 'PJN' | 'TAD' | 'SICNEA' (default 'PJN')
 * @returns {{ ok: true, leida: boolean }}
 */
router.patch('/:id/leida', (req, res) => {
  const origen = req.query.origen || 'PJN';
  const table  = origen === 'TAD'    ? 'notificaciones_tad'
               : origen === 'SICNEA' ? 'notificaciones_sicnea'
               :                       'notificaciones_pjn';
  const result = db.prepare(`UPDATE ${table} SET leida = 1 - leida WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Notificación no encontrada' });
  const row = db.prepare(`SELECT leida FROM ${table} WHERE id = ?`).get(req.params.id);
  res.json({ ok: true, leida: row.leida === 1 });
});

module.exports = router;
