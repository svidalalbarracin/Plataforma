/**
 * Utilidades y lógica de UI del módulo de causas.
 * Usado por index.html (tabla de causas) y cualquier página que necesite
 * calcular vencimientos o renderizar badges.
 */

/** Fecha de hoy fija al momento de cargar la página (evita recalcular en cada llamada). */
const HOY = new Date().toISOString().slice(0, 10);

/**
 * Calcula cuántos días faltan desde hoy hasta una fecha futura.
 * Devuelve un número negativo si la fecha ya pasó.
 * @param {string} fechaStr - Fecha en formato YYYY-MM-DD.
 * @returns {number} Días hasta la fecha (puede ser negativo).
 */
function diasHasta(fechaStr) {
  const hoy = new Date(HOY + 'T00:00:00');
  const d   = new Date(fechaStr + 'T00:00:00');
  return Math.round((d - hoy) / 86400000);
}

/**
 * Calcula cuántos días pasaron desde una fecha hasta hoy.
 * @param {string} fechaStr - Fecha en formato YYYY-MM-DD.
 * @returns {number} Días transcurridos (positivo = pasado).
 */
function diasDesde(fechaStr) {
  const hoy = new Date(HOY + 'T00:00:00');
  const d   = new Date(fechaStr + 'T00:00:00');
  return Math.round((hoy - d) / 86400000);
}

/**
 * Convierte una fecha ISO (YYYY-MM-DD) al formato visual DD/MM/AAAA.
 * @param {string|null} fechaStr
 * @returns {string} Fecha formateada o '—' si es nula.
 */
function formatFecha(fechaStr) {
  if (!fechaStr) return '—';
  const [y, m, d] = fechaStr.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Devuelve el HTML de un badge coloreado con el tipo de causa.
 * @param {'PJN'|'Aduana'|'Fisica'|string} tipo
 * @returns {string} HTML del badge.
 */
function tipoBadge(tipo) {
  const map = {
    PJN:    ['badge badge-tipo badge-tipo-pjn',    'PJN'],
    Aduana: ['badge badge-tipo badge-tipo-aduana', 'Aduana'],
    Fisica: ['badge badge-tipo badge-tipo-fisica', 'Física'],
  };
  const [cls, label] = map[tipo] ?? ['badge badge-tipo', tipo];
  return `<span class="${cls}">${label}</span>`;
}

/**
 * Devuelve el HTML del badge de estado para una causa.
 * Prioridad: cerrada/archivada → vencimiento próximo → sin movimiento → en trámite.
 * "Sin movimiento" se activa si el estado es 'sin-movimiento' o si el último movimiento
 * fue hace más de 30 días.
 * @param {{ estado: string, vencimiento: string|null, ultimoMov: string }} causa
 * @returns {string} HTML del badge.
 */
function estadoBadge(causa) {
  const { estado, vencimiento, ultimoMov } = causa;

  if (estado === 'cerrada')   return '<span class="badge badge-muted">Cerrada</span>';
  if (estado === 'archivada') return '<span class="badge" style="background:var(--border);color:var(--text-muted)">Archivada</span>';

  if (vencimiento) {
    const dias = diasHasta(vencimiento);
    if (dias <= 0) return '<span class="badge badge-danger">Vence hoy</span>';
    if (dias <= 7) return `<span class="badge badge-warning">Vence en ${dias} día${dias !== 1 ? 's' : ''}</span>`;
  }

  if (estado === 'sin-movimiento' || diasDesde(ultimoMov) > 30) {
    return '<span class="badge badge-orange">Sin movimiento</span>';
  }

  return '<span class="badge badge-info">En trámite</span>';
}

/**
 * Trunca un texto al largo máximo indicado, agregando "…" si se cortó.
 * @param {string} txt
 * @param {number} [max=52]
 * @returns {string}
 */
function truncar(txt, max = 52) {
  return txt.length > max ? txt.slice(0, max) + '…' : txt;
}

/**
 * Filtra una lista de causas por estado y texto de búsqueda libre.
 * La búsqueda abarca expediente, cliente y carátula (case-insensitive).
 * @param {Array} causas - Lista completa de causas.
 * @param {'tramite'|'cerrada'|'vencimiento'|'sin-movimiento'|string} filtro - Filtro activo.
 * @param {string} busqueda - Texto ingresado por el usuario.
 * @returns {Array} Causas que cumplen ambos filtros.
 */
function filtrarCausas(causas, filtro, busqueda) {
  let resultado = causas;

  if (filtro === 'tramite') {
    resultado = resultado.filter(c => c.estado === 'tramite' || c.estado === 'sin-movimiento');
  } else if (filtro === 'cerrada') {
    resultado = resultado.filter(c => c.estado === 'cerrada' || c.estado === 'archivada');
  } else if (filtro === 'vencimiento') {
    resultado = resultado.filter(c => c.vencimiento && diasHasta(c.vencimiento) <= 7);
  } else if (filtro === 'sin-movimiento') {
    resultado = resultado.filter(c => c.estado === 'sin-movimiento' || diasDesde(c.ultimoMov) > 30);
  }

  if (busqueda) {
    const q = busqueda.toLowerCase();
    resultado = resultado.filter(c =>
      c.expediente.toLowerCase().includes(q) ||
      c.cliente.toLowerCase().includes(q) ||
      c.caratula.toLowerCase().includes(q)
    );
  }

  return resultado;
}

/**
 * Renderiza la tabla de causas en el elemento `#causas-body`.
 * Muestra un mensaje vacío si no hay causas que mostrar.
 * @param {Array} causas - Causas ya filtradas a renderizar.
 */
function renderTabla(causas) {
  const tbody = document.getElementById('causas-body');
  if (!tbody) return;

  if (causas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay causas que coincidan con la búsqueda</td></tr>';
    return;
  }

  tbody.innerHTML = causas.map(c => `
    <tr>
      <td class="font-mono">
        ${c.expediente}
        ${tipoBadge(c.tipo)}
      </td>
      <td>
        <div style="font-weight:500">${c.cliente}</div>
        <div class="text-muted" style="font-size:.8125rem;margin-top:.15rem">${truncar(c.caratula)}</div>
      </td>
      <td style="max-width:200px">${c.tribunal}</td>
      <td>${estadoBadge(c)}</td>
      <td class="font-mono text-muted">${formatFecha(c.ultimoMov)}</td>
      <td>
        <a href="detalle-causa.html?id=${c.id}" class="btn btn-ghost btn-sm">Ver</a>
      </td>
    </tr>
  `).join('');
}

// Actualiza el badge del navbar con las notificaciones sin leer en cualquier página del módulo
document.addEventListener('DOMContentLoaded', async () => {
  const badge = document.getElementById('badge-notif');
  if (!badge) return;
  try {
    const { notificaciones } = await fetch('/api/causas/notificaciones').then(r => r.json());
    badge.textContent = notificaciones.filter(n => !n.leida).length || '';
  } catch {}
});

/**
 * Actualiza las tarjetas de métricas del dashboard (total, notificaciones, vencimientos, sin movimiento).
 * Si algún elemento no existe en el DOM, lo ignora silenciosamente.
 * @param {Array} causas - Lista completa de causas (sin filtrar).
 * @param {number} [notifCount=0] - Cantidad de notificaciones sin leer.
 */
function actualizarMetricas(causas, notifCount = 0) {
  const total  = causas.length;
  const venc   = causas.filter(c => c.vencimiento && diasHasta(c.vencimiento) >= 0 && diasHasta(c.vencimiento) <= 7).length;
  const sinMov = causas.filter(c => c.estado === 'sin-movimiento' || diasDesde(c.ultimoMov) > 30).length;

  const elTotal  = document.getElementById('stat-total');
  const elNotif  = document.getElementById('stat-notif');
  const elVenc   = document.getElementById('stat-venc');
  const elSinMov = document.getElementById('stat-sin-mov');

  if (elTotal)  elTotal.textContent  = total;
  if (elNotif)  elNotif.textContent  = notifCount;
  if (elVenc)   elVenc.textContent   = venc;
  if (elSinMov) elSinMov.textContent = sinMov;

  const badgeNotif = document.getElementById('badge-notif');
  if (badgeNotif) badgeNotif.textContent = notifCount;
}
