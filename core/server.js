/**
 * Punto de entrada del servidor Express.
 *
 * Monta todas las rutas API, sirve los archivos estáticos de cada módulo
 * e inicia los schedulers de facturación y causas.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Rutas API ─────────────────────────────────────────────────────────────────
// Deben registrarse antes del middleware static para que Express las resuelva primero.

app.get('/api/status', (req, res) => res.json({ status: 'ok' }));

app.use('/api/clientes',              require('../modulos/facturacion/backend/routes/clientes'));
app.use('/api/facturas',              require('../modulos/facturacion/backend/routes/facturas'));
app.use('/api/pagos',                 require('../modulos/facturacion/backend/routes/pagos'));
app.use('/api/recurrentes',           require('../modulos/facturacion/backend/routes/recurrentes'));
app.use('/api/estadisticas',          require('../modulos/facturacion/backend/routes/estadisticas'));
app.use('/api/configuracion',         require('../core/configuracion/backend/routes'));
app.use('/api/causas/notificaciones', require('../modulos/causas/backend/routes/notificaciones'));
app.use('/api/causas/biblioteca',    require('../modulos/causas/backend/routes/biblioteca'));

/**
 * POST /api/importar
 * Ejecuta el scraper de ARCA para importar facturas emitidas.
 * Acepta `fechaDesde` en el body (ISO string); si no se provee, usa los últimos 30 días.
 * Tras la importación, envía mail de alerta para facturas que ya estén vencidas.
 */
app.post('/api/importar', async (req, res) => {
  try {
    const { importarFacturas }            = require('../modulos/facturacion/backend/arca/scraper');
    const { notificarImportadasVencidas } = require('../modulos/facturacion/backend/notificaciones');
    const { fechaDesde } = req.body;
    const resultado = await importarFacturas({
      fechaDesde: fechaDesde ? new Date(fechaDesde) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      fechaHasta: new Date(),
    });
    res.json(resultado);
    if (resultado.numerosImportados?.length) {
      notificarImportadasVencidas(resultado.numerosImportados).catch(e =>
        console.error('[importar] Error al notificar:', e.message)
      );
    }
  } catch (e) {
    console.error('[importar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Archivos estáticos ────────────────────────────────────────────────────────

app.get('/configuracion', (req, res) =>
  res.sendFile(path.resolve(__dirname, '../core/configuracion/frontend/configuracion.html'))
);

app.use(express.static(path.join(__dirname, '../core/frontend')));
app.use('/facturacion',    express.static(path.join(__dirname, '../modulos/facturacion/frontend')));
app.use('/causas',         express.static(path.join(__dirname, '../modulos/causas/frontend')));
app.use('/configuracion',  express.static(path.join(__dirname, '../core/configuracion/frontend')));
app.use('/pdfs',           express.static(path.join(__dirname, '../modulos/facturacion/storage/facturas')));
app.use('/causas/storage', express.static(path.join(__dirname, '../modulos/causas/storage')));

// ── Schedulers ────────────────────────────────────────────────────────────────

require('../modulos/facturacion/backend/scheduler');
require('../modulos/causas/backend/scheduler');

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
