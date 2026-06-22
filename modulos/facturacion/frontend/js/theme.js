/**
 * Toggle de tema claro/oscuro (módulo facturación).
 * Idéntico a core/frontend/js/theme.js — se mantiene separado porque las páginas
 * del módulo no comparten el bundle de core.
 */
(function () {
  function update() {
    const dark = document.documentElement.classList.contains('dark');
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = dark ? '☀' : '☾';
  }

  function toggle() {
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    update();
  }

  document.addEventListener('DOMContentLoaded', () => {
    update();
    const btn = document.getElementById('btn-theme');
    if (btn) btn.addEventListener('click', toggle);
  });
})();
