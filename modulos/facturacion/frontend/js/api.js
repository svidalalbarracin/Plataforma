/**
 * Cliente HTTP centralizado del módulo de facturación.
 *
 * Expone el objeto global `API` con métodos para cada recurso.
 * Todas las funciones devuelven una Promise que resuelve con los datos JSON
 * o rechaza con un Error que contiene el mensaje de error de la API.
 *
 * Uso:
 *   const clientes = await API.clientes.list();
 *   const factura  = await API.facturas.get(42);
 */

const API_BASE = '/api';

/**
 * Realiza una request HTTP y parsea la respuesta como JSON.
 * Respuestas 204 (sin cuerpo) devuelven null.
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
 * @param {string} endpoint - Path relativo a API_BASE (ej: '/clientes/1').
 * @param {Object} [body]   - Cuerpo de la request (se serializa como JSON).
 * @returns {Promise<Object|null>}
 * @throws {Error} Si la respuesta no es OK o no se puede parsear.
 */
async function _req(method, endpoint, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + endpoint, opts);
  if (res.status === 204) return null;
  let data;
  try { data = await res.json(); } catch { throw new Error(`Error ${res.status}`); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

/**
 * Serializa un objeto de parámetros a query string, omitiendo claves vacías y nulas.
 * @param {Object} params
 * @returns {string} Query string con '?' inicial, o '' si no hay parámetros.
 */
function _qs(params) {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))
  ).toString();
  return q ? '?' + q : '';
}

const API = {
  clientes: {
    /** @returns {Promise<Array>} */
    list:   ()         => _req('GET',    '/clientes'),
    /** @returns {Promise<Object>} */
    get:    (id)       => _req('GET',    `/clientes/${id}`),
    /** @param {{ nombre, cuit, email?, telefono?, anticipo_usd?, honorario_exito_usd?, concepto_facturacion? }} data */
    create: (data)     => _req('POST',   '/clientes', data),
    update: (id, data) => _req('PUT',    `/clientes/${id}`, data),
    delete: (id)       => _req('DELETE', `/clientes/${id}`),
  },

  facturas: {
    /** @param {{ cliente_id?, estado?, mes?, anio? }} [p] */
    list:   (p = {})   => _req('GET',    '/facturas' + _qs(p)),
    get:    (id)       => _req('GET',    `/facturas/${id}`),
    create: (data)     => _req('POST',   '/facturas', data),
    /** @param {'pagada'|'impaga'} e */
    estado: (id, e)    => _req('PATCH',  `/facturas/${id}/estado`, { estado: e }),
    delete: (id)       => _req('DELETE', `/facturas/${id}`),
  },

  pagos: {
    /** @param {{ factura_id? }} [p] */
    list:   (p = {})   => _req('GET',    '/pagos' + _qs(p)),
    create: (data)     => _req('POST',   '/pagos', data),
    delete: (id)       => _req('DELETE', `/pagos/${id}`),
  },

  estadisticas: {
    /** @param {{ mes?, anio? }} [p] */
    mes:                (p = {}) => _req('GET', '/estadisticas/mes'  + _qs(p)),
    /** @param {{ anio? }} [p] */
    anio:               (p = {}) => _req('GET', '/estadisticas/anio' + _qs(p)),
    clientesPendientes: ()       => _req('GET', '/estadisticas/clientes-pendientes'),
  },

  recurrentes: {
    list:   ()           => _req('GET',    '/recurrentes'),
    /** Crea o actualiza (upsert) la configuración de un cliente. */
    upsert: (data)       => _req('POST',   '/recurrentes', data),
    toggle: (id, activo) => _req('PUT',    `/recurrentes/${id}`, { activo }),
    delete: (id)         => _req('DELETE', `/recurrentes/${id}`),
  },

  /**
   * Lanza la importación de comprobantes desde ARCA (scraper headless).
   * @param {{ fechaDesde?, fechaHasta?, tipoComprobante?, puntoVenta?, forzar? }} [body]
   */
  importar: (body = {}) => _req('POST', '/importar', body),
};
