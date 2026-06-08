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

function formatFecha(fechaStr) {
  if (!fechaStr) return '—';
  const [y, m, d] = fechaStr.split('-');
  return `${d}/${m}/${y}`;
}

function tipoBadge(tipo) {
  const map = {
    PJN:    ['badge badge-tipo badge-tipo-pjn',    'PJN'],
    Aduana: ['badge badge-tipo badge-tipo-aduana', 'Aduana'],
    Fisica: ['badge badge-tipo badge-tipo-fisica', 'Física'],
  };
  const [cls, label] = map[tipo] ?? ['badge badge-tipo', tipo];
  return `<span class="${cls}">${label}</span>`;
}

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

function truncar(txt, max = 52) {
  return txt.length > max ? txt.slice(0, max) + '…' : txt;
}

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

// Actualiza el badge del navbar en cualquier página del módulo
document.addEventListener('DOMContentLoaded', async () => {
  const badge = document.getElementById('badge-notif');
  if (!badge) return;
  try {
    const notifs = await fetch('/api/causas/notificaciones').then(r => r.json());
    badge.textContent = notifs.filter(n => !n.leida).length || '';
  } catch {}
});

// notifCount: cantidad de notificaciones sin leer (viene de la API)
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
