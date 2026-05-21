require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── API (antes del static para que Express las encuentre primero) ──────────────
app.get('/api/status', (req, res) => res.json({ status: 'ok' }));

app.use('/api/clientes', require('../modulos/facturacion/backend/routes/clientes'));
app.use('/api/facturas', require('../modulos/facturacion/backend/routes/facturas'));
app.use('/api/pagos',    require('../modulos/facturacion/backend/routes/pagos'));

app.post('/api/importar', async (req, res) => {
  try {
    const { importarFacturas } = require('../modulos/facturacion/backend/arca/scraper');
    const { notificarImportadasVencidas } = require('../modulos/facturacion/backend/notificaciones');
    const resultado = await importarFacturas({
      fechaDesde: new Date('2026-01-01'),
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

// ── Archivos estáticos (después de las rutas API) ─────────────────────────────
app.use(express.static(path.join(__dirname, '../core/frontend')));
app.use('/facturacion', express.static(path.join(__dirname, '../modulos/facturacion/frontend')));
app.use('/pdfs', express.static(path.join(__dirname, '../modulos/facturacion/storage/facturas')));

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
