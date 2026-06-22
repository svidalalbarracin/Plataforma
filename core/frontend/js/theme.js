/**
 * Toggle de tema claro/oscuro.
 * Lee y persiste la preferencia en localStorage bajo la clave 'theme'.
 * El estado real de la clase 'dark' en <html> lo establece el HTML antes de cargar este script
 * para evitar el flash de tema incorrecto.
 */
(function () {
  /**
   * Sincroniza el ícono del botón con el tema activo.
   * ☀ = modo oscuro activo (click vuelve a claro), ☾ = modo claro activo (click va a oscuro).
   */
  function update() {
    const dark = document.documentElement.classList.contains('dark');
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = dark ? '☀' : '☾';
  }

  /** Alterna el tema y lo guarda en localStorage. */
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
