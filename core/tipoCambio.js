const https = require('https');

let _cache = { fecha: null, valor: null };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Respuesta inválida de ' + url)); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Timeout ' + url)); });
  });
}

async function obtenerTipoCambio() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (_cache.fecha === hoy && _cache.valor != null) return _cache.valor;

  let valor;
  try {
    const data = await fetchJson('https://dolarapi.com/v1/dolares/oficial');
    if (!data.venta) throw new Error('Campo venta ausente');
    valor = data.venta;
  } catch (e) {
    console.warn('[tipoCambio] dolarapi.com falló:', e.message, '— usando exchangerate-api');
    const data = await fetchJson('https://api.exchangerate-api.com/v4/latest/USD');
    valor = data.rates?.ARS;
    if (!valor) throw new Error('No se pudo obtener el tipo de cambio');
  }

  _cache = { fecha: hoy, valor };
  console.log(`[tipoCambio] USD/ARS oficial del ${hoy}: $${valor}`);
  return valor;
}

module.exports = { obtenerTipoCambio };
