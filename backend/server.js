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
    const resultado = await importarFacturas({
      fechaDesde: new Date('2026-01-01'),
      fechaHasta: new Date(),
    });
    res.json(resultado);
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
