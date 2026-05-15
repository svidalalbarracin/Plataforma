require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/clientes', require('./routes/clientes'));
app.use('/api/facturas', require('./routes/facturas'));
app.use('/api/pagos',    require('./routes/pagos'));

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
