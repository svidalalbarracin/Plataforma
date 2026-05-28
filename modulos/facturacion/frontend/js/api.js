const API_BASE = '/api';

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

function _qs(params) {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))
  ).toString();
  return q ? '?' + q : '';
}

const API = {
  clientes: {
    list:   ()         => _req('GET',    '/clientes'),
    get:    (id)       => _req('GET',    `/clientes/${id}`),
    create: (data)     => _req('POST',   '/clientes', data),
    update: (id, data) => _req('PUT',    `/clientes/${id}`, data),
    delete: (id)       => _req('DELETE', `/clientes/${id}`),
  },
  facturas: {
    list:   (p = {})   => _req('GET',    '/facturas' + _qs(p)),
    get:    (id)       => _req('GET',    `/facturas/${id}`),
    create: (data)     => _req('POST',   '/facturas', data),
    estado: (id, e)    => _req('PATCH',  `/facturas/${id}/estado`, { estado: e }),
    delete: (id)       => _req('DELETE', `/facturas/${id}`),
  },
  pagos: {
    list:   (p = {})   => _req('GET',    '/pagos' + _qs(p)),
    create: (data)     => _req('POST',   '/pagos', data),
    delete: (id)       => _req('DELETE', `/pagos/${id}`),
  },
  estadisticas: {
    mes:                (p = {}) => _req('GET', '/estadisticas/mes'  + _qs(p)),
    anio:               (p = {}) => _req('GET', '/estadisticas/anio' + _qs(p)),
    clientesPendientes: ()       => _req('GET', '/estadisticas/clientes-pendientes'),
  },
  recurrentes: {
    list:   ()           => _req('GET',    '/recurrentes'),
    upsert: (data)       => _req('POST',   '/recurrentes', data),
    toggle: (id, activo) => _req('PUT',    `/recurrentes/${id}`, { activo }),
    delete: (id)         => _req('DELETE', `/recurrentes/${id}`),
  },
  importar: () => _req('POST', '/importar'),
};
