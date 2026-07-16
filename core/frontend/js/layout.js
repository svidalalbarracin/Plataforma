/**
 * Sidebar global de navegación entre módulos.
 * Se inyecta como primer elemento de <body> en todas las páginas.
 * Marca como "active" el módulo cuya ruta coincide con el pathname actual.
 *
 * Para agregar un módulo nuevo, añadir una entrada en el array MODULOS.
 * Los módulos con `pronto: true` se muestran deshabilitados (sin interacción).
 */
(function () {
  const MODULOS = [
    { slug: 'facturacion', label: 'Facturación', href: '/facturacion/' },
    { slug: 'causas',      label: 'Causas',      href: '/causas/' },
  ];

  const path = window.location.pathname;

  const items = MODULOS.map(m => {
    const activo = m.slug
      ? path.startsWith('/' + m.slug + '/') || path === '/' + m.slug
      : path === '/';
    const clases = ['sidebar-item', activo ? 'active' : '', m.pronto ? 'disabled' : ''].filter(Boolean).join(' ');
    return `<a href="${m.href}" class="${clases}">${m.label}</a>`;
  }).join('');

  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <a href="/" class="sidebar-brand">
      <span class="sidebar-brand-name">Plataforma Memo</span>
      <span class="sidebar-brand-sub">Plataforma de gestión</span>
    </a>
    <nav class="sidebar-nav">
      <div class="sidebar-section">Módulos</div>
      ${items}
    </nav>
  `;

  document.body.prepend(sidebar);
})();
