/**
 * Lógica del formulario de configuración.
 * Carga los valores actuales del .env desde la API y los muestra en los inputs.
 * Los campos sensibles (CLAVE_FISCAL) nunca se revelan en texto claro:
 * muestran "configurado" como placeholder y se envían vacíos si no se quieren cambiar.
 */

/** Campos que no deben mostrarse en texto plano aunque la API los devuelva. */
const SENSIBLES = ['CLAVE_FISCAL', 'PJN_CLAVE'];

/** Todos los campos del formulario que se leen y envían. */
const CAMPOS = ['CUIT', 'CLAVE_FISCAL', 'MAIL_TO', 'PJN_USUARIO', 'PJN_CLAVE'];

/**
 * Muestra una notificación temporaria (toast) en la esquina de la pantalla.
 * Se elimina automáticamente a los 3.5 segundos.
 * @param {string} msg - Texto a mostrar.
 * @param {'success'|'error'} [tipo='success'] - Tipo visual del toast.
 */
function toast(msg, tipo = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${tipo}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/**
 * Carga la configuración desde GET /api/configuracion y rellena los inputs.
 * Para campos sensibles solo actualiza el placeholder, no el valor.
 */
async function cargar() {
  try {
    const data = await fetch('/api/configuracion').then(r => r.json());
    for (const [key, val] of Object.entries(data)) {
      const input = document.getElementById('cfg-' + key);
      if (!input) continue;
      if (SENSIBLES.includes(key)) {
        input.placeholder = val === null
          ? 'Sin configurar'
          : '••••••• (configurado — dejá vacío para no cambiar)';
      } else {
        input.value = val ?? '';
      }
    }
  } catch {
    toast('Error al cargar la configuración', 'error');
  }
}

// Toggle mostrar/ocultar contraseña para campos sensibles
document.querySelectorAll('.btn-revelar').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const oculto = input.type === 'password';
    input.type = oculto ? 'text' : 'password';
    btn.textContent = oculto ? 'Ocultar' : 'Mostrar';
  });
});

/**
 * Maneja el submit del formulario: envía los campos a POST /api/configuracion.
 * Tras guardar, limpia los campos sensibles y recarga los valores actuales.
 */
document.getElementById('form-config').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('btn-guardar');
  btn.disabled = true;

  const body = {};
  for (const key of CAMPOS) {
    const input = document.getElementById('cfg-' + key);
    if (input) body[key] = input.value;
  }

  try {
    const res = await fetch('/api/configuracion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar');
    toast('Configuración guardada correctamente');
    SENSIBLES.forEach(key => {
      const input = document.getElementById('cfg-' + key);
      if (input) input.value = '';
    });
    cargar();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

cargar();
