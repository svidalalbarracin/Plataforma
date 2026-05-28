#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo "============================================================"
echo "  PLATAFORMA MEMO"
echo "============================================================"
echo ""

# -- 1. Verificar conexion a internet
echo "Verificando conexion..."
if ping -c 1 -W 2 github.com > /dev/null 2>&1; then

  # -- 2. Actualizar desde GitHub
  echo "Verificando actualizaciones..."
  git checkout main > /dev/null 2>&1

  BEFORE=$(git rev-parse HEAD)
  git pull origin main > /dev/null 2>&1
  AFTER=$(git rev-parse HEAD)

  if [ "$BEFORE" != "$AFTER" ]; then
    echo "Actualizacion disponible. Instalando dependencias..."
    npm install --silent
  else
    echo "Sistema al dia."
  fi
  echo ""

else
  echo "Sin conexion a internet. Iniciando con la version actual."
  echo ""
fi

# -- 3. Matar proceso anterior en el puerto 3000
fuser -k 3000/tcp > /dev/null 2>&1 || true
sleep 1

# -- 4. Crear carpeta de logs
mkdir -p logs

# -- 5. Iniciar servidor en segundo plano
NODE_PID=""

cleanup() {
  echo ""
  echo "Apagando servidor..."
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
  exit 0
}

trap cleanup INT TERM

node core/server.js >> logs/server.log 2>&1 &
NODE_PID=$!

# -- 6. Esperar hasta que el servidor responda
echo "Iniciando servidor..."
INTENTOS=0
until curl -s http://localhost:3000/api/status > /dev/null 2>&1; do
  INTENTOS=$((INTENTOS + 1))
  if [ "$INTENTOS" -ge 30 ]; then
    echo ""
    echo "[ERROR] El servidor no pudo iniciar."
    echo "        Revisa el archivo logs/server.log para mas detalles."
    kill "$NODE_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# -- 7. Abrir navegador
xdg-open http://localhost:3000 > /dev/null 2>&1 || true

echo ""
echo "============================================================"
echo "  Sistema corriendo en http://localhost:3000"
echo "  Presiona Ctrl+C para apagar el sistema."
echo "============================================================"
echo ""

# -- 8. Mantener proceso vivo hasta Ctrl+C
wait "$NODE_PID"
