/**
 * Utilidades compartidas del módulo de causas.
 * Usado por causas.html, detalle-causa.html y cualquier otra página del módulo.
 */

const HOY = new Date().toISOString().slice(0, 10);

function diasHasta(fechaStr) {
  const hoy = new Date(HOY + 'T00:00:00');
  const d   = new Date(fechaStr + 'T00:00:00');
  return Math.round((d - hoy) / 86400000);
}

function diasDesde(fechaStr) {
  const hoy = new Date(HOY + 'T00:00:00');
  const d   = new Date(fechaStr + 'T00:00:00');
  return Math.round((hoy - d) / 86400000);
}

/**
 * Convierte una fecha ISO (YYYY-MM-DD) o datetime SQLite al formato DD/MM/AAAA.
 * @param {string|null} fechaStr
 * @returns {string}
 */
function formatFecha(fechaStr) {
  if (!fechaStr) return '—';
  const s = fechaStr.slice(0, 10);
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Badge de tipo de causa. Acepta valores de la API (pjn, tad, sicnea, aduanero, papel).
 * @param {string} tipo
 * @returns {string} HTML
 */
function tipoBadge(tipo) {
  const map = {
    pjn:      ['badge badge-tipo badge-tipo-pjn',    'PJN'],
    tad:      ['badge badge-tipo badge-tipo-tad',    'TAD'],
    sicnea:   ['badge badge-tipo badge-tipo-sicnea', 'SICNEA'],
    aduanero: ['badge badge-tipo badge-tipo-aduana', 'Aduana'],
    papel:    ['badge badge-tipo badge-tipo-fisica', 'Física'],
  };
  const [cls, label] = map[tipo?.toLowerCase()] ?? ['badge badge-tipo', tipo ?? '?'];
  return `<span class="${cls}">${label}</span>`;
}

/**
 * Badge de estado de causa. Acepta valores de la API (en_tramite, archivada, cerrada).
 * @param {{ estado: string }} causa
 * @returns {string} HTML
 */
function estadoBadge({ estado }) {
  if (estado === 'cerrada')   return '<span class="badge badge-muted">Cerrada</span>';
  if (estado === 'archivada') return '<span class="badge" style="background:var(--border);color:var(--text-muted)">Archivada</span>';
  return '<span class="badge badge-info">En trámite</span>';
}

/**
 * Nombre legible del estado.
 * @param {string} estado
 * @returns {string}
 */
function estadoLabel(estado) {
  if (estado === 'en_tramite') return 'En trámite';
  if (estado === 'archivada')  return 'Archivada';
  if (estado === 'cerrada')    return 'Cerrada';
  return estado ?? '—';
}

/**
 * Nombre legible del tipo.
 * @param {string} tipo
 * @returns {string}
 */
function tipoLabel(tipo) {
  const map = { pjn: 'Poder Judicial (PJN)', tad: 'TAD', sicnea: 'SICNEA / Aduanero', aduanero: 'Aduanero', papel: 'Carpeta física' };
  return map[tipo] ?? tipo ?? '—';
}

/**
 * Trunca texto al largo indicado.
 * @param {string} txt
 * @param {number} [max=52]
 * @returns {string}
 */
function truncar(txt, max = 52) {
  if (!txt) return '';
  return txt.length > max ? txt.slice(0, max) + '…' : txt;
}

/**
 * Filtra causas por estado y texto libre.
 * Espera objetos con los campos de la API: numero_expediente, caratula, estado, clientes[].
 * @param {Array}  causas
 * @param {string} filtro   - 'en_tramite' | 'archivada' | 'cerrada' | ''
 * @param {string} busqueda - texto libre
 * @returns {Array}
 */
function filtrarCausas(causas, filtro, busqueda) {
  let resultado = causas;

  if (filtro) {
    resultado = resultado.filter(c => c.estado === filtro);
  }

  if (busqueda) {
    const q = busqueda.toLowerCase();
    resultado = resultado.filter(c =>
      (c.numero_expediente ?? '').toLowerCase().includes(q) ||
      (c.caratula          ?? '').toLowerCase().includes(q) ||
      (c.juzgado           ?? '').toLowerCase().includes(q) ||
      (c.clientes ?? []).some(cl => cl.nombre.toLowerCase().includes(q))
    );
  }

  return resultado;
}

/**
 * Renderiza la tabla de causas en #causas-body.
 * Espera objetos con los campos de la API de biblioteca.
 * @param {Array} causas
 */
function renderTabla(causas) {
  const tbody = document.getElementById('causas-body');
  if (!tbody) return;

  if (!causas.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay causas que coincidan</td></tr>';
    return;
  }

  tbody.innerHTML = causas.map(c => {
    const expediente  = c.numero_expediente ?? '—';
    const clientesTxt = c.clientes?.length
      ? c.clientes.map(cl => cl.nombre).join(', ')
      : '<span class="text-muted">Sin cliente</span>';
    const juzgado     = c.juzgado ?? '—';
    const totalNotif  = (c.notif_pjn || 0) + (c.notif_tad || 0) + (c.notif_sicnea || 0);
    const notifBadge  = totalNotif
      ? `<span class="badge badge-info" style="font-size:.7rem">${totalNotif}</span>`
      : '<span class="text-muted">—</span>';

    return `
    <tr>
      <td class="font-mono">
        ${expediente}
        ${tipoBadge(c.tipo)}
      </td>
      <td>
        <div style="font-weight:500">${clientesTxt}</div>
        <div class="text-muted" style="font-size:.8125rem;margin-top:.15rem">${truncar(c.caratula)}</div>
      </td>
      <td style="max-width:180px;color:var(--text-muted);font-size:.875rem">${truncar(juzgado, 30)}</td>
      <td>${estadoBadge(c)}</td>
      <td>${notifBadge}</td>
      <td>
        <a href="detalle-causa.html?id=${c.id}" class="btn btn-ghost btn-sm">Ver</a>
      </td>
    </tr>`;
  }).join('');
}

/**
 * Actualiza las tarjetas de métricas del dashboard.
 * @param {{ total: number, en_tramite: number, archivadas: number }} stats
 * @param {number} notifSinLeer
 */
function actualizarMetricas(stats, notifSinLeer = 0) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-total',    stats.total      ?? '—');
  set('stat-tramite',  stats.en_tramite ?? '—');
  set('stat-notif',    notifSinLeer);
  set('stat-archivadas', stats.archivadas ?? '—');
  const badge = document.getElementById('badge-notif');
  if (badge) badge.textContent = notifSinLeer || '';
}

// Actualiza el badge de notificaciones en el navbar en cualquier página del módulo
document.addEventListener('DOMContentLoaded', async () => {
  const badge = document.getElementById('badge-notif');
  if (!badge) return;
  try {
    const { notificaciones } = await fetch('/api/causas/notificaciones').then(r => r.json());
    badge.textContent = notificaciones.filter(n => !n.leida).length || '';
  } catch {}
});
