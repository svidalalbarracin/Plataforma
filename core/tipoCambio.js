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

  const fuentes = [
    { url: 'https://dolar-bna.vercel.app/api/cotizacion',  nombre: 'BNA Vercel' },
    { url: 'https://dolarapi.com/v1/dolares/oficial',       nombre: 'DolarAPI Oficial' },
  ];

  let valor;
  for (const fuente of fuentes) {
    try {
      const data = await fetchJson(fuente.url);
      if (!data.venta) throw new Error('Campo venta ausente');
      valor = data.venta;
      console.log(`[tipoCambio] USD/ARS (${fuente.nombre}) del ${hoy}: $${valor}`);
      break;
    } catch (e) {
      console.warn(`[tipoCambio] ${fuente.nombre} falló:`, e.message);
    }
  }

  if (valor == null) throw new Error('No se pudo obtener el tipo de cambio de ninguna fuente');
  return valor;
}

module.exports = { obtenerTipoCambio };
