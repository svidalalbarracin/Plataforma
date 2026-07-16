/**
 * Utilidades compartidas del módulo de causas.
 * Usado por causas.html, detalle-causa.html y cualquier otra página del módulo.
 */

const HOY = new Date().toISOString().slice(0, 10);

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

// Actualiza el badge de notificaciones en el navbar en cualquier página del módulo
document.addEventListener('DOMContentLoaded', async () => {
  const badge = document.getElementById('badge-notif');
  if (!badge) return;
  try {
    const { notificaciones } = await fetch('/api/causas/notificaciones').then(r => r.json());
    badge.textContent = notificaciones.filter(n => !n.leida).length || '';
  } catch {}
});
