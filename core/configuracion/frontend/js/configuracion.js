const SENSIBLES = ['CLAVE_FISCAL', 'MAIL_PASS'];
const CAMPOS    = ['CUIT', 'CLAVE_FISCAL', 'MAIL_USER', 'MAIL_PASS', 'MAIL_TO', 'PUNTO_VENTA'];

function toast(msg, tipo = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${tipo}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function cargar() {
  try {
    const data = await fetch('/api/configuracion').then(r => r.json());
    for (const [key, val] of Object.entries(data)) {
      const input = document.getElementById('cfg-' + key);
      if (!input) continue;
      if (SENSIBLES.includes(key)) {
        input.placeholder = val === null ? 'Sin configurar' : '••••••• (configurado — dejá vacío para no cambiar)';
      } else {
        input.value = val ?? '';
      }
    }
  } catch (e) {
    toast('Error al cargar la configuración', 'error');
  }
}

// Toggle mostrar/ocultar contraseña
document.querySelectorAll('.btn-revelar').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const oculto = input.type === 'password';
    input.type = oculto ? 'text' : 'password';
    btn.textContent = oculto ? 'Ocultar' : 'Mostrar';
  });
});

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
    // Limpiar campos de contraseña y recargar
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
