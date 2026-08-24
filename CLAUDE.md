# REGLAS DE GITHUB Y CONTROL DE CAMBIOS

Este proyecto está conectado directamente a un repositorio de GitHub.
**TRATA EL REPOSITORIO COMO CÓDIGO DE PRODUCCIÓN.**

---

## REGLA 1 — NO PUSH AUTOMÁTICO

NO hagas, sin autorización explícita del propietario:

- `git push`
- push a `main` / `master`
- deploy
- merge
- pull request
- release

Puedes modificar archivos localmente y ejecutar tests.

Antes de cualquier push debes mostrar:

- archivos modificados;
- archivos creados;
- archivos eliminados;
- resumen de cambios;
- tests ejecutados;
- resultado de los tests;
- posibles riesgos;
- commit propuesto.

## REGLA 2 — NO DESTRUIR HISTORIAL

NO hagas, sin autorización explícita:

- `git reset --hard`;
- force push;
- rebase destructivo;
- borrar ramas;
- borrar migraciones;
- eliminar tablas;
- eliminar histórico de PostgreSQL.

Si consideras necesaria alguna de estas operaciones, detente y explica primero por qué.

## REGLA 3 — TRABAJAR DE FORMA INCREMENTAL

Cada cambio importante debe ser pequeño y verificable:

```
CAMBIO → TEST → VERIFICACIÓN → SIGUIENTE CAMBIO
```

No se aceptan reescrituras masivas del proyecto.

## REGLA 4 — PROTEGER LO QUE YA FUNCIONA

Antes de modificar una funcionalidad existente:

1. identifica cómo funciona;
2. identifica sus tests;
3. crea o mejora tests si son insuficientes;
4. modifica;
5. ejecuta tests;
6. verifica regresiones.

## REGLA 5 — NO INVENTAR DATOS

Nunca introduzcas datos falsos para hacer que:

- un gráfico se vea mejor;
- una proyección parezca funcionar;
- un dashboard parezca completo;
- un test pase;
- una métrica parezca buena.

Si falta información, **muestra que falta información**.

## REGLA 6 — MIGRACIONES DE BASE DE DATOS

Antes de cambiar PostgreSQL:

- inspecciona el schema actual;
- identifica dependencias;
- determina impacto;
- crea migración reversible cuando sea posible;
- evita destruir columnas o histórico.

No ejecutes migraciones destructivas en producción sin autorización.

## REGLA 7 — VARIABLES Y SECRETOS

Nunca:

- imprimas API keys;
- imprimas tokens;
- expongas credenciales;
- copies secretos al código;
- hagas commit de archivos `.env`;
- modifiques secretos de producción sin autorización.

Si detectas secretos expuestos en el repositorio, detente y notifícalo.

## REGLA 8 — GIT STATUS

Antes de comenzar una modificación importante ejecuta `git status` y determina si
existen cambios previos del propietario.

NO sobrescribas cambios existentes que no hayas creado tú.
Si existen modificaciones no relacionadas con la tarea, presérvalas.

## REGLA 9 — ANTES DE TERMINAR CADA FASE

Entrega este informe:

- **CAMBIOS** — qué modificaste.
- **ARCHIVOS** — qué archivos fueron afectados.
- **TESTS** — qué ejecutaste.
- **RESULTADO** — qué pasó.
- **RIESGOS** — qué queda pendiente.
- **SIGUIENTE PASO** — qué recomiendas hacer después.

## REGLA 10 — COMMIT

No hagas commit automáticamente salvo que se solicite.
Cuando una fase esté terminada puedes **recomendar** un commit con un mensaje claro, por ejemplo:

```text
feat: build market projection feature engine
```

Espera autorización antes de ejecutarlo.

---

## REGLA ESPECIAL PARA ESTE PROYECTO

El repositorio es la **fuente de verdad** del código.
No asumas que una versión anterior del proyecto es correcta.
Inspecciona siempre el estado actual del repositorio antes de modificarlo.

El objetivo NO es simplemente hacer que el proyecto compile.
El objetivo es construir un sistema confiable de:

```
CAPTURA → HISTÓRICO → FEATURES → PROYECCIÓN → BACKTEST → EVALUACIÓN
```

Cada cambio debe acercarnos a ese objetivo.

---

## ESTADO ACTUAL DEL REPOSITORIO (verificado 2026-08-23)

- Stack: React 19 + Vite 6 + Express 4, TypeScript, Tailwind 4. Deploy en Render (`render.yaml`).
- Entrada: `index.html` (raíz), `src/` (React), `server.ts` (Express + Vite/SPA), `server/` (dominio).
- Módulos de dominio: `server/binanceP2PService.ts` (captura), `server/storage.ts` (histórico en
  ficheros JSON bajo `data/`), `server/centralStore.ts`, `server/projectionEngine.ts`, `server/routes.ts`.
- Persistencia: **ficheros JSON**, no hay PostgreSQL todavía (la Regla 6 aplicará cuando se introduzca).
- Scripts: `dev`, `build`, `start`, `preview`, `clean`, `lint` (`tsc --noEmit`).
- **No existe suite de tests ni script `test`** en `package.json`. La Regla 4 no puede cumplirse
  hasta que exista; verificación actual limitada a `npm run lint`.
- **No existe `.gitignore`** en el repositorio.
