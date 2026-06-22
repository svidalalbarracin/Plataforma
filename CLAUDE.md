# CLAUDE.md — Instrucciones para Claude Code

## Flujo de Git

### Ramas
- `main` — producción. Solo recibe merges desde `development` cuando el código está probado y listo para lanzar.
- `development` — rama principal de trabajo. Todo parte de acá.
- `feature/*`, `fix/*`, `refactor/*` — ramas temporales que salen de `development` para trabajo específico.

### Regla de trabajo
1. El trabajo del día a día va en `development` directamente (cambios chicos, correcciones, ajustes).
2. Para cambios más grandes o funcionalidades nuevas, crear una rama desde `development`:
   ```
   git checkout development
   git checkout -b feature/nombre-descriptivo
   ```
3. Al terminar, hacer PR hacia `development`, mergear, y **eliminar la rama inmediatamente** (remota y local):
   ```
   git push origin --delete feature/nombre-descriptivo
   git branch -D feature/nombre-descriptivo
   git checkout development && git pull
   ```
4. Cuando el código en `development` está probado y se quiere lanzar, se hace PR hacia `main`.
5. Después de mergear `development` → `main`, volver a `development`. **No eliminar `development`**.

### Resumen: después de cada merge
- Si se mergeó una rama feature → eliminarla, volver a `development`.
- Si se mergeó `development` → `main` → volver a `development`. No eliminar nada.

---

## Mensajes de commits

Usar el formato **Conventional Commits**:

```
<tipo>(<scope>): <descripción corta en imperativo>

[cuerpo opcional — qué cambió y por qué, si no es obvio]
```

### Tipos
| Tipo | Cuándo usarlo |
|---|---|
| `feat` | Nueva funcionalidad |
| `fix` | Corrección de bug |
| `refactor` | Cambio de código sin agregar funcionalidad ni corregir bug |
| `chore` | Tareas de mantenimiento (deps, config, CI) |
| `docs` | Solo documentación |
| `style` | Formato, espacios, punto y coma (sin cambio de lógica) |
| `test` | Agregar o corregir tests |

### Scope
El módulo o área afectada: `causas`, `facturacion`, `scrapers`, `db`, `scheduler`, `frontend`, etc.

### Ejemplos correctos
```
feat(causas): agregar módulo de pendientes con aviso por mail
fix(scrapers): corregir timeout post-login SSO en PJN
refactor(causas): cambiar mails a resumen único diario a las 18hs
fix(calendario): corregir fechas en vista mensual por offset UTC-3
chore(deps): actualizar playwright a v1.44
```

### Reglas
- La descripción va en **minúsculas**, en **imperativo** ("agregar", "corregir", "cambiar" — no "agregado" ni "se agregó").
- Máximo 72 caracteres en la primera línea.
- Si el cambio necesita más contexto, agregar cuerpo separado por una línea en blanco.
- Siempre incluir `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` al final.

---

## Mensajes de PR y merge

### Título del PR
Mismo formato que el commit: `tipo(scope): descripción corta`.

### Cuerpo del PR
```
## Summary
- Bullet points con los cambios principales

## Test plan
- [ ] Qué se probó manualmente
- [ ] Qué hay que verificar antes de mergear
```
