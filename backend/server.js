require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── API (antes del static para que Express las encuentre primero) ──────────────
app.get('/api/status', (req, res) => res.json({ status: 'ok' }));

app.use('/api/clientes', require('./routes/clientes'));
app.use('/api/facturas', require('./routes/facturas'));
app.use('/api/pagos',    require('./routes/pagos'));

app.post('/api/importar', async (req, res) => {
  try {
    const { importarFacturas } = require('./arca/scraper');
    const { notificarImportadasVencidas } = require('./notificaciones');
    const resultado = await importarFacturas({
      fechaDesde: new Date('2026-01-01'),
      fechaHasta: new Date(),
    });
    res.json(resultado);
    // Notificar fuera del request para no demorar la respuesta
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
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/pdfs', express.static(path.join(__dirname, '..', 'storage', 'facturas')));

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
