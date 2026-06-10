/**
 * Módulo de tipo de cambio USD/ARS.
 *
 * Obtiene el valor de venta del dólar oficial del día desde fuentes externas,
 * con caché en memoria para no repetir el request dentro del mismo día.
 *
 * @module tipoCambio
 */
const https = require('https');

/** @type {{ fecha: string|null, valor: number|null }} */
let _cache = { fecha: null, valor: null };

/**
 * Realiza un GET HTTPS y parsea la respuesta como JSON.
 *
 * @param {string} url - URL a consultar
 * @returns {Promise<Object>} Cuerpo de la respuesta parseado
 * @throws {Error} Si la respuesta no es JSON válido o hay timeout
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Respuesta inválida de ' + url)); }
      });
    }).on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('Timeout ' + url)); });
  });
}

/**
 * Devuelve el tipo de cambio USD/ARS (valor de venta) para el día actual.
 * Consulta las fuentes en orden y usa la primera que responde correctamente.
 * El resultado se almacena en caché y se reutiliza durante el mismo día.
 *
 * @returns {Promise<number>} Valor de venta del dólar oficial
 * @throws {Error} Si ninguna fuente responde correctamente
 */
async function obtenerTipoCambio() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (_cache.fecha === hoy && _cache.valor != null) return _cache.valor;

  const fuentes = [
    { url: 'https://dolar-bna.vercel.app/api/cotizacion', nombre: 'BNA Vercel'      },
    { url: 'https://dolarapi.com/v1/dolares/oficial',      nombre: 'DolarAPI Oficial' },
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
  _cache = { fecha: hoy, valor };
  return valor;
}

module.exports = { obtenerTipoCambio };
