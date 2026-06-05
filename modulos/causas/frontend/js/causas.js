const HOY = new Date().toISOString().slice(0, 10);

const CAUSAS = [
  {
    id: 1,
    expediente: 'EXP 12345/2023',
    tipo: 'PJN',
    caratula: 'García, Juan Carlos c/ Empresa SA s/ Despido Injustificado',
    cliente: 'García, Juan Carlos',
    tribunal: 'CNAT Sala III',
    estado: 'tramite',
    ultimoMov: '2026-05-28',
    vencimiento: null,
    carpetaFisica: null,
  },
  {
    id: 2,
    expediente: 'EXP 8891/2024',
    tipo: 'PJN',
    caratula: 'López, Roberto c/ Banco Nacional SA s/ Cobro de Pesos',
    cliente: 'López, Roberto',
    tribunal: 'CNAT Sala I',
    estado: 'tramite',
    ultimoMov: '2026-06-01',
    vencimiento: '2026-06-07',
    carpetaFisica: null,
  },
  {
    id: 3,
    expediente: 'SICNEA 4422/2025',
    tipo: 'Aduana',
    caratula: 'Importaciones XYZ SA s/ Infracción Aduanera - Multa 1887/25',
    cliente: 'Importaciones XYZ SA',
    tribunal: 'Dirección General de Aduanas',
    estado: 'tramite',
    ultimoMov: '2026-06-03',
    vencimiento: '2026-06-04',
    carpetaFisica: null,
  },
  {
    id: 4,
    expediente: 'EXP 3310/2022',
    tipo: 'PJN',
    caratula: 'Martínez, Ana c/ Estado Nacional s/ Daños y Perjuicios',
    cliente: 'Martínez, Ana',
    tribunal: 'Juzgado Federal Civil y Com. Nro. 3',
    estado: 'sin-movimiento',
    ultimoMov: '2026-04-20',
    vencimiento: null,
    carpetaFisica: null,
  },
  {
    id: 5,
    expediente: 'CARPETA-017',
    tipo: 'Fisica',
    caratula: 'Rodríguez, Pedro c/ Municipalidad de Morón s/ Reclamo Administrativo',
    cliente: 'Rodríguez, Pedro',
    tribunal: 'Juzgado Civil Nro. 15',
    estado: 'tramite',
    ultimoMov: '2026-05-15',
    vencimiento: '2026-06-25',
    carpetaFisica: 'Estante B / Carpeta 17',
  },
  {
    id: 6,
    expediente: 'EXP 7712/2020',
    tipo: 'PJN',
    caratula: 'Fernández y otros c/ Constructora Sur SRL s/ Daños y Perjuicios',
    cliente: 'Fernández, Carlos y otros',
    tribunal: 'Juzgado Federal Civil y Com. Nro. 2',
    estado: 'cerrada',
    ultimoMov: '2025-11-10',
    vencimiento: null,
    carpetaFisica: null,
  },
  {
    id: 7,
    expediente: 'SICNEA 1198/2025',
    tipo: 'Aduana',
    caratula: 'Logística Trans SA s/ Impugnación de Multa - Sumario 3302/25',
    cliente: 'Logística Trans SA',
    tribunal: 'Dirección General de Aduanas',
    estado: 'tramite',
    ultimoMov: '2026-05-29',
    vencimiento: '2026-06-18',
    carpetaFisica: null,
  },
  {
    id: 8,
    expediente: 'CARPETA-031',
    tipo: 'Fisica',
    caratula: 'Sucesión de Gómez, Horacio s/ Declaratoria de Herederos',
    cliente: 'Sucesión de Gómez, Horacio',
    tribunal: 'Juzgado Civil Nro. 8',
    estado: 'archivada',
    ultimoMov: '2023-08-22',
    vencimiento: null,
    carpetaFisica: 'Estante A / Carpeta 31',
  },
];

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

function actualizarMetricas(causas) {
  const hoy = HOY;

  const total   = causas.length;
  const notif   = 3; // dato de ejemplo
  const venc    = causas.filter(c => c.vencimiento && diasHasta(c.vencimiento) >= 0 && diasHasta(c.vencimiento) <= 7).length;
  const sinMov  = causas.filter(c => c.estado === 'sin-movimiento' || diasDesde(c.ultimoMov) > 30).length;

  const elTotal  = document.getElementById('stat-total');
  const elNotif  = document.getElementById('stat-notif');
  const elVenc   = document.getElementById('stat-venc');
  const elSinMov = document.getElementById('stat-sin-mov');

  if (elTotal)  elTotal.textContent  = total;
  if (elNotif)  elNotif.textContent  = notif;
  if (elVenc)   elVenc.textContent   = venc;
  if (elSinMov) elSinMov.textContent = sinMov;

  const badgeNotif = document.getElementById('badge-notificaciones');
  const badgeVenc  = document.getElementById('badge-vencimientos');
  if (badgeNotif) badgeNotif.textContent = notif;
  if (badgeVenc)  badgeVenc.textContent  = venc;
}

// ── Pendientes de ejemplo ─────────────────────────
const PENDIENTES = [
  {
    id: 101,
    descripcion: 'Presentar escrito de apelación',
    causaId: 1,
    fechaLimite: (() => { const d = new Date(); d.setDate(d.getDate()+5); return d.toISOString().slice(0,10); })(),
    diasAviso: 2,
    fechaAviso: (() => { const d = new Date(); d.setDate(d.getDate()+3); return d.toISOString().slice(0,10); })(),
    nota: 'Adjuntar prueba documental nueva',
    completado: false,
  },
  {
    id: 102,
    descripcion: 'Contestar traslado de multa',
    causaId: 3,
    fechaLimite: (() => { const d = new Date(); d.setDate(d.getDate()+2); return d.toISOString().slice(0,10); })(),
    diasAviso: 1,
    fechaAviso: (() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); })(),
    nota: '',
    completado: false,
  },
  {
    id: 103,
    descripcion: 'Solicitar copia de actuaciones',
    causaId: 7,
    fechaLimite: (() => { const d = new Date(); d.setDate(d.getDate()+14); return d.toISOString().slice(0,10); })(),
    diasAviso: 3,
    fechaAviso: (() => { const d = new Date(); d.setDate(d.getDate()+11); return d.toISOString().slice(0,10); })(),
    nota: '',
    completado: false,
  },
  {
    id: 104,
    descripcion: 'Presentar liquidación de honorarios',
    causaId: 6,
    fechaLimite: (() => { const d = new Date(); d.setDate(d.getDate()-3); return d.toISOString().slice(0,10); })(),
    diasAviso: 2,
    fechaAviso: (() => { const d = new Date(); d.setDate(d.getDate()-5); return d.toISOString().slice(0,10); })(),
    nota: '',
    completado: true,
  },
];

// ── Notificaciones de ejemplo ─────────────────────
const NOTIFICACIONES = [
  {
    id: 201,
    causaId: 2,
    fecha: (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })(),
    descripcion: 'Nueva cédula de notificación electrónica — Resolución Interlocutoria Nro. 48/26. Se hace saber lo resuelto en autos.',
    origen: 'PJN',
    leida: false,
  },
  {
    id: 202,
    causaId: 3,
    fecha: (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })(),
    descripcion: 'Nuevo movimiento en sumario SICNEA 4422/2025 — Proveído: "Pasen los autos a resolver." Estado actualizado a resolución pendiente.',
    origen: 'Aduana',
    leida: false,
  },
  {
    id: 203,
    causaId: 1,
    fecha: (() => { const d = new Date(); d.setDate(d.getDate()-2); return d.toISOString().slice(0,10); })(),
    descripcion: 'Nuevo escrito presentado por la parte actora — Memorial de agravios. Traslado a la demandada por 10 días hábiles.',
    origen: 'PJN',
    leida: false,
  },
  {
    id: 204,
    causaId: 7,
    fecha: (() => { const d = new Date(); d.setDate(d.getDate()-4); return d.toISOString().slice(0,10); })(),
    descripcion: 'Movimiento registrado en SICNEA 1198/2025 — Resolución de recursos: desestimado el recurso de reconsideración. Traslado para alegato.',
    origen: 'Aduana',
    leida: true,
  },
  {
    id: 205,
    causaId: 4,
    fecha: (() => { const d = new Date(); d.setDate(d.getDate()-6); return d.toISOString().slice(0,10); })(),
    descripcion: 'Nueva cédula electrónica — Auto de sustanciación. Se corre traslado del informe pericial a las partes por 5 días.',
    origen: 'PJN',
    leida: true,
  },
];

document.addEventListener('DOMContentLoaded', () => {
  let filtroActivo = '';
  let busqueda     = '';

  actualizarMetricas(CAUSAS);
  renderTabla(filtrarCausas(CAUSAS, filtroActivo, busqueda));

  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filtroActivo = btn.dataset.filtro;
      renderTabla(filtrarCausas(CAUSAS, filtroActivo, busqueda));
    });
  });

  const buscador = document.getElementById('buscador');
  if (buscador) {
    buscador.addEventListener('input', () => {
      busqueda = buscador.value.trim();
      renderTabla(filtrarCausas(CAUSAS, filtroActivo, busqueda));
    });
  }
});
