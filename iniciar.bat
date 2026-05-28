@echo off
setlocal EnableDelayedExpansion
chcp 65001 > nul
title Sistema Estudio
cd /d "%~dp0"

echo.
echo ============================================================
echo   SISTEMA ESTUDIO
echo ============================================================
echo.

rem -- 1. Verificar conexion a internet
echo Verificando conexion...
ping -n 1 -w 2000 github.com > nul 2>&1
if errorlevel 1 (
    echo Sin conexion a internet. Iniciando con la version actual.
    echo.
    goto :iniciar_servidor
)

rem -- 2. Actualizar desde GitHub
echo Verificando actualizaciones...
git checkout main > nul 2>&1
git pull origin main > "%TEMP%\git_pull_out.txt" 2>&1
findstr /i "Already up to date" "%TEMP%\git_pull_out.txt" > nul
if errorlevel 1 (
    echo Actualizacion disponible. Instalando dependencias...
    call npm install --silent
    if errorlevel 1 echo [AVISO] npm install fallo. Continuando de todas formas...
) else (
    echo Sistema al dia.
)
del "%TEMP%\git_pull_out.txt" > nul 2>&1
echo.

rem -- 3. Preparar entorno
:iniciar_servidor
if not exist logs mkdir logs

rem Liberar puerto 3000 si hay un proceso anterior
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }" > nul 2>&1
timeout /t 1 /nobreak > nul

rem -- 4. Iniciar servidor en segundo plano
echo Iniciando servidor...
start /B cmd /c "node core/server.js 1>>logs\server.log 2>&1"

rem -- 5. Esperar hasta que el servidor responda (maximo 30 segundos)
set /a INTENTOS=0
:esperar
set /a INTENTOS+=1
if %INTENTOS% gtr 30 (
    echo.
    echo [ERROR] El servidor no pudo iniciar.
    echo         Revisa el archivo logs\server.log para mas detalles.
    echo.
    pause
    exit /b 1
)
timeout /t 1 /nobreak > nul
curl -s http://localhost:3000/api/status > nul 2>&1
if errorlevel 1 goto :esperar

rem -- 6. Abrir navegador
start http://localhost:3000

echo.
echo ============================================================
echo   Sistema corriendo en http://localhost:3000
echo   Cerra esta ventana para apagar el sistema.
echo ============================================================
echo.

rem -- 7. Mantener la ventana abierta
:mantener
timeout /t 10 /nobreak > nul
goto :mantener
