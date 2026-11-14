# Migración VMGAS → VMGAS2 (Firebase)

Documento de trabajo para mantener consistentes los módulos que se van migrando.
Última actualización: 2026-11-13.

## Estado

| Módulo | Estado |
|---|---|
| `index.html` (login) | Migrado a `/api/login` + Firestore |
| `inicio.html` | Migrado (token, permisos, alarmas) |
| `clientes.html` | Migrado |
| `precios.html` | Migrado |
| `parametroscomisiones.html` | **Migrado (editor de escalas, permiso `PRECIOS`)** |
| `usuarios.html` | Migrado |
| `controlcarga.html` | Migrado |
| `controlstock.html` | Migrado |
| `treeview.html` | Migrado |
| `alarmas.html` | Migrado en lista Firestore; **pendiente** el alta/vencimientos (revisión diaria) y el audio vía Apps Script |
| `arqueo.html` | **Migrado + historial y permiso `FINANZAS`** |
| `controlfinanzas.html` | **Migrado a Firestore directo + conciliación de arqueos** |
| `controlcomisiones.html` | **Migrado (escalas, pendientes y liquidación)** |
| `controltransferencias.html` | **Migrado (verificación bancaria, lote y reversión)** |
| `controlremitos.html` | **Migrado (conciliación de compras v1)** |
| `flota.html` | Pendiente (sin efecto por ahora) |
| `tablero.html` | **Migrado (Firestore directo + mapa OSM/Leaflet)** |
| `micaja.html` | **Migrado (caja y transferencias, solo lectura)** |
| `index_recepcion.html` | Pendiente |

## Convenciones

- Token de sesión: documento `tokens/{k}` con `usuario`, `expira`, `nombre_mostrar`.
- El usuario activo se guarda en `sessionStorage.usuarioActivo`.
- Fechas de movimientos: `dd/mm/yyyy` (formato `toLocaleDateString('es-AR')`).
- Horas: `HH:mm:ss`.
- Importes: números (no strings con formato).
- En `movimientos` se conservan los nombres de columna históricos:
  `USUARIO`, `TIPO`, `FECHA`, `HORA`, `C`, `N`, `E$`, `T$`, `TOTAL`,
  `G`, `GASTO_TOTAL`, `COMISION_TOTAL`, `ID_CLIENTE`, etc.
- Los módulos nuevos escriben con `writeBatch` / `runTransaction` y validan el token contra `tokens/{k}`.
- Para textos que luego se renderizan con `innerHTML`, escapar o limpiar (`<` y `>`).

## Ventas: coordenadas y trazabilidad (2026-11-13)

- `index4.html` / `app.js` guarda la ubicación del cliente en `clientes/{id}.ubicacion`.
  La coordenada es la del GPS del dispositivo al momento de la venta.
- `PUNTO_GPS` sigue siendo **solo auditoría**: `SI` si la venta se hizo dentro de los
  60 m del cliente, `NO` si fue fuera de ese radio. No define si se guarda o no la
  coordenada.
- Si el cliente nuevo no tiene coordenadas, se guarda `ubicacion` con el GPS de esa
  primera venta. Si un cliente existente no tiene `ubicacion` ni `coordenadas`, la
  próxima venta completa `ubicacion` con el GPS actual. Si ya tiene una coordenada,
  no se pisa.
- `clientes.html` usa `ubicacion` como campo canónico y tolera `coordenadas` de datos
  viejos (lo muestra y lo migra a `ubicacion` al editar).
- Cada movimiento de venta guarda el viaje y el turno activos:
  - `ID_VIAJE` y `idViaje`;
  - `ID_TURNO` y `idTurno`.
- Si el chofer no tiene viaje activo, se guarda `ID_VIAJE = "Sin_Camion"`.
  Si no hay turno abierto, se guarda `ID_TURNO = "SIN_TURNO"`.
- El contexto se busca al momento de guardar: último `turnos` con `estado = ABIERTO`
  y `ccarga` con `estado = EN_RUTA`/`COMPRA_EN_RUTA` del chofer. Si está offline se
  usa la copia `localStorage.vm_contexto_operacion` (con usuario y vencimiento de 12 h).
- `MOV_NETO_10/15/45` y `MOV_NETO_DINERO` actualizan los saldos del cliente en la misma
  transacción de la venta:
  - `env10/15/45` = deuda de envases;
  - `flotante10/15/45` = envases a favor;
  - `plata` = saldo de dinero con signo (positivo = debe, negativo = a favor).
- Cada movimiento de saldo genera un documento en `historial_flotantes` con el antes/después
  y el vínculo al movimiento, viaje y turno. `clientes.ultimaActualizacionMs` y
  `ultimoMovimientoTipo` alimentan el tablero y los envases secuestrados.
- `clientes` pasa a ser la foto de `SALDOS_FLOTANTES`; `historial_flotantes` reemplaza
  `HISTORIAL_FLOTANTES`. No se crea una colección `saldos_flotantes` paralela para no
  duplicar la fuente de verdad.
- La venta sigue siendo idempotente: el documento `movimientos/{N}` se escribe una sola vez.

## Tema, sesión y navegación (2026-11-09)

Todas las pantallas activas cargan `vm-core.js` y comparten el mismo comportamiento:

- **Tema único**: se guarda en `localStorage.vm_theme` (`light` o `dark`). El botón de
  tema de cualquier pantalla cambia el mismo valor y las demás lo respetan al abrirse.
  `VM_THEME_BOOT` aplica la clase antes de pintar para evitar el parpadeo.
- **Token cacheado**: `sessionStorage.vm_token_cache_v1` guarda `{ token, data, checkedAt }`.
  `VM.validarToken(k)` usa la copia si sigue vigente y tiene menos de 10 minutos; recién
  entonces consulta `tokens/{k}`. Si no hay red, acepta la copia local mientras `expira`
  no haya pasado.
- **Permisos cacheados**: `sessionStorage.vm_user_cache_v1` guarda `usuarios/{id}` y se
  revalida cada 30 minutos.
- **Inactividad**: 20 minutos sin actividad. La marca está en
  `sessionStorage.vm_last_activity`; al vencer, `VM.expirarSesion()` sale a
  `inicio.html?k=<token>` conservando la sesión. También se controla al volver a la
  pestaña (`visibilitychange`).
- **Navegación**: los botones normales usan `location.href`; la expiración y el logout
  usan `location.replace` para no dejar la pantalla protegida en el historial.
- **Token inválido**: sale a `index.html` y limpia `sessionStorage`.
- **Sin bloqueos horarios**: se eliminó el mantenimiento automático de las 00:00 y el
  bloqueo de “no se puede volver atrás”. Cada módulo decide su navegación.
- **Sin fundido de entrada**: se quitó `body { opacity: 0 }` de todas las pantallas
  activas para que el contenido esté visible desde el primer render.

## Colecciones usadas

| Colección | Uso | Campos clave |
|---|---|---|
| `usuarios` | Usuarios y permisos | doc id = usuario; `nombre_mostrar`, `FINANZAS`, `CONFINANZAS`, etc. |
| `tokens` | Sesiones | `usuario`, `nombre_mostrar`, `creado`, `expira` |
| `clientes` | Maestro de clientes y saldos unificados | `nombre`, `zona`, `categoria`, `ubicacion`, `plata`, `env10/15/45`, `flotante10/15/45`, `ultimaActualizacionMs` |
| `precios` | Lista de precios | `categoria`, `tipo`, `precio` |
| `movimientos` | Operaciones de campo | `USUARIO`, `TIPO`, `FECHA`, `HORA`, `E$`, `T$`, `TOTAL`, `GASTO_TOTAL`, `ARQUEO_ID`, `ID_VIAJE`/`idViaje`, `ID_TURNO`/`idTurno`, `UBICACION` |
| `ccarga` | Viajes / control de carga | `idViaje`, `chofer`, `estado`, `tipoViaje`, `timestampMs` |
| `turnos` | Apertura/cierre de stock | `estado`, `timestampAperturaMs`, `timestampCierreMs` |
| `patrimonio/totales` | Stock global | `env10`, `env15`, `env45` |
| `seguridad/pin` | PIN dinámico y maestro | `dinamico`, `maestro` |
| `historialPin` | Historial de PIN | — |
| `alarmas` | Alertas del sistema | `tipo`, `descripcion`, `usuario`, `pendiente`, `fecha_hora` |
| `auditoria` | Trazabilidad | — |
| `papelera_movimientos` | Movimientos eliminados | — |
| **`arqueos`** | **Cierres de caja** | ver abajo |
| **`confinanzas`** | **Movimientos financieros** | `id`, `fecha` (YYYY-MM-DD), `rubro`, `subrubro`, `detalle`, `monto`, `tipo` (`INGRESO`/`EGRESO`) |
| **`comisiones`** | **Comisión pendiente por venta** | `movimientoId`, `choferKey`, `comision`, `estado`, `pagoId` |
| **`comisiones_pagos`** | **Liquidaciones de comisiones** | `pagoId`, `choferKey`, `total`, `efectivo`, `transferencia`, `detalle` |
| **`historial_flotantes`** | **Historial de saldos de clientes** | `movimientoId`, `idCliente`, `tipoMov`, `movEnv10/15/45`, `movDinero`, `saldo10/15/45`, `saldoDinero`, `idViaje`, `idTurno`, `timestampMs` |

## Contrato de `arqueos`

Un documento por día cerrado. Todos los días de un mismo cierre comparten `idCierre`.

```js
{
  idCierre: "ARQ-20261026-A1B2",
  fecha: "26/10/2026",
  hora: "18:30:00",
  chofer: "JUAN PEREZ",
  choferUsuario: "jperez",
  auditor: "admin",

  sisEfectivo: 145000,
  sisTransf: 18500,
  sisGastos: 5000,
  sisTotal: 140000,       // efectivo esperado = sisEfectivo - sisGastos

  realEfectivo: 120000,
  realTransf: 18500,
  diferencia: -20000,

  observaciones: "Faltante informado...",
  cantidadMovimientos: 12,
  movimientos: ["V-...", "V-..."],
  gastosDetalle: [{ motivo: "Combustible", monto: 5000 }],

  origen: "ARQUEO",
  creado: <serverTimestamp>,
  timestampMs: 179...
}
```

Al cerrar, cada documento de `movimientos` incluido se actualiza con:

```js
{
  ARQUEO_ID: "ARQ-20261026-A1B2",
  ARQUEO_FECHA: "26/10/2026",
  ARQUEO_TS: 179...
}
```

Y se agrega un documento a `confinanzas` (mismo esquema que usaba `CONFINANZAS` en VMGAS):

```js
{
  id: "ARQ-20261026-A1B2",
  idCierre: "ARQ-20261026-A1B2",
  fecha: "2026-10-26",           // YYYY-MM-DD
  hora: "18:30:00",
  rubro: "GAS",
  subrubro: "ARQUEO DE VENTA",
  detalle: "Arqueo consolidado ...",
  monto: 120000,                 // absoluto
  chofer: "JUAN PEREZ",
  choferUsuario: "jperez",
  auditor: "admin",
  usuario: "admin",
  tipo: "INGRESO",               // INGRESO | EGRESO
  origen: "ARQUEO",
  referencia: "ARQ-20261026-A1B2",
  // Trazabilidad adicional del cierre
  arqueoDias: 3,
  arqueoMovimientos: 18,
  arqueoSisEfectivo: 145000,
  arqueoSisTransf: 18500,
  arqueoSisGastos: 5000,
  arqueoSisTotal: 140000,
  arqueoRealTransf: 18500,
  arqueoDiferencia: -20000,
  arqueoObservaciones: "Faltante informado...",
  arqueoFechaDesde: "24/10/2026",
  arqueoFechaHasta: "26/10/2026",
  timestamp: <serverTimestamp>,
  timestampMs: 179...
}
```

El documento se guarda con id = `idCierre` para que un reintento no duplique el ingreso.

La conciliación de `controlfinanzas.html` compara `abs(confinanzas.monto)` contra
la suma de `arqueos.realEfectivo` de todos los días con el mismo `idCierre`.
Los estados posibles son:

| Estado | Significado |
|---|---|
| `OK` | El monto de finanzas coincide con la suma de efectivo real de los arqueos. |
| `DIF` | Hay documento en finanzas, pero el monto no coincide. |
| `SIN_FINANZAS` | Hay arqueo(s), pero no existe el documento de finanzas con ese `idCierre`. |
| `SIN_DETALLE` | Hay un registro de finanzas con origen `ARQUEO`, pero no hay documentos en `arqueos`. |

La vista también muestra la diferencia propia de caja (`realEfectivo - sisTotal`)
sin confundirla con la conciliación de finanzas.

El efectivo real informado se reparte entre los días seleccionados en proporción al
efectivo esperado positivo; el último día absorbe el redondeo. Nunca se guardan valores
negativos y la suma de `arqueos.realEfectivo` siempre coincide con el total ingresado.
`arqueos.fecha` conserva el día del movimiento (`dd/mm/yyyy`); `confinanzas.fecha` usa la
fecha del cierre (`YYYY-MM-DD`).

Si `|diferencia| > 50`, se crea una alarma:

```js
{
  tipo: "FALTANTE_CAJA" | "SOBRANTE_CAJA",
  descripcion,
  usuario,
  pendiente: true,
  fecha_hora: <serverTimestamp>
}
```

## Contrato de `controlfinanzas`

`controlfinanzas.html` lee toda la colección `confinanzas` y filtra en el navegador por
`fecha` (`YYYY-MM-DD`). Tolera documentos viejos con campos en mayúsculas
(`FECHA`, `RUBRO`, `SUBRUBRO`, `DETALLE`, `MONTO`, `TIPO`) y fechas `dd/mm/yyyy`.

Documento creado desde el módulo:

```js
{
  id: "<docId>",
  fecha: "2026-10-26",
  rubro: "OPERATIVO",
  subrubro: "COMBUSTIBLE",
  detalle: "Nafta camión | PAGOS: Efvo: $15.000,00 | Transf: $3.000,00 (Op:9988)",
  monto: 18000,                  // absoluto
  usuario: "admin",
  tipo: "INGRESO" | "EGRESO",
  origen: "MANUAL",
  pagos: {
    efectivo: 15000,
    depositos: [{ monto, ref }],
    transferencias: [{ monto, ref }]
  },
  timestamp: <serverTimestamp>,
  timestampMs: 179...
}
```

Por cada transferencia se agrega un egreso automático en
`CUENTA BANCARIA` / `IMPUESTO LEY 25413` por el 0,6% (`monto * 0.006`).

Editar o eliminar requiere PIN (`seguridad/pin`). El PIN dinámico se rota en la misma
transacción y se registra en `historialPin`; la acción queda en `auditoria` (con el
documento anterior en `antes`) y se genera una alarma de `MODIFICACIÓN` o `ELIMINACIÓN`.
Los registros con `origen: "ARQUEO"` se pueden editar/eliminar, pero el módulo advierte
que el cierre de arqueo asociado no se recalcula.

Los registros con `origen: "IMPUESTO"` son derivados y no se pueden editar ni eliminar
directamente. Al eliminar un registro manual, sus impuestos asociados (misma
`referencia`) se borran en la misma transacción. Si se cambia la fecha del registro
principal, también se actualiza la fecha de sus impuestos.

El PIN maestro solo puede inicializarse si todavía no existe y el usuario tiene permiso
`USUARIOS`. Si ya existe, se exige el PIN actual. La operación se hace con
`runTransaction` para evitar condiciones de carrera.

## Comisiones y Mi Caja (2026-11-01)

### Escalas

La fuente es `configuracion/parametros`:

```js
{
  comisiones_10: [{ min: 0, max: 20999, com: 150 }, ...],
  comisiones_15: [{ min: 0, max: 28500, com: 375 }, ...],
  comisiones_45: [{ min: 0, max: 85000, com: 500 }, ...]
}
```

El editor es `parametroscomisiones.html`, al que se accede desde el botón
**⚙ Editar comisiones** de `precios.html`. Ese panel valida el token y el permiso
`PRECIOS`, edita únicamente `comisiones_10/15/45` y guarda con
`setDoc(..., { merge: true })`, sin tocar otras claves de `configuracion/parametros`.
`precios.html` ya no edita las escalas: solo guarda los precios y `recargo_flotante`,
por lo que nunca pisa los cambios hechos desde el panel.

El panel permite agregar y quitar rangos, muestra la comisión mínima y máxima de cada
presentación, bloquea solapamientos y avisa si queda un hueco entre dos rangos. Los
montos se guardan como enteros en pesos. `app.js` normaliza el formato nuevo y también
el legacy (`comisiones: [{ RANGO_MENOR, RANGO_MAYOR, COMISION_10, ... }]`). Si dos
rangos se tocan en el límite, gana el rango con `min` más alto. La comisión se calcula
por garrafa según el precio unitario de venta al cliente y no se paga en ventas con
retiro en planta.

### Venta (`index4.html` / `app.js`)

Cada venta guarda en `movimientos`:

```js
{
  COMISION_TOTAL: 650,
  COMISION_DETALLE: [
    { tipo: "10", cantidad: 1, precio: 24000, comUnit: 250, subtotal: 250 },
    { tipo: "15", cantidad: 1, precio: 35000, comUnit: 750, subtotal: 750 }
  ],
  COMISION_PAGADA: false
}
```

Si `COMISION_TOTAL > 0`, la misma transacción crea `comisiones/{movimientoId}`:

```js
{
  movimientoId, choferId, chofer, choferKey,
  clienteId, cliente,
  fecha: "01/11/2026", fechaISO: "2026-11-01", hora,
  tipo, ventaTotal, comision, detalle,
  estado: "PENDIENTE",
  pagoId: null,
  creado: <serverTimestamp>,
  timestampMs
}
```

`choferKey` se calcula con `claveChofer()` (minúsculas, sin acentos ni puntos), igual
en `app.js`, `micaja.html` y `controlcomisiones.html`. `movimientos.USUARIO` sigue
guardando el `nombre_mostrar` en minúsculas; `choferId` guarda el id del token
(`USUARIO_ID`) para trazabilidad. En `comisiones`, `ventaTotal` es el valor de la venta
(gas + envases), no lo cobrado (`movimientos.TOTAL` puede ser un pago parcial).

### Liquidación (`controlcomisiones.html`)

- Requiere `FINANZAS` o `CONFINANZAS`.
- Lee `comisiones` con `estado == "PENDIENTE"` y agrupa por `choferKey` y por día.
- El pago debe cuadrar exactamente (tolerancia de un centavo) entre efectivo +
  transferencia y la suma seleccionada. No se permite pagar de más ni de menos.
- En una única `runTransaction`:
  - vuelve a leer cada comisión y rechaza si ya fue pagada o cambió de chofer/total;
  - crea `comisiones_pagos/{pagoId}` con el detalle y los medios de pago;
  - marca cada `comisiones` como `estado: "PAGADA"` con `pagoId`, `pagadoPor`, `pagadoTs`;
  - actualiza cada `movimientos/{movimientoId}` con
    `COMISION_PAGADA: true`, `COMISION_PAGO_ID`, `COMISION_PAGO_FECHA`,
    `COMISION_PAGADO_TS`;
  - crea `confinanzas/COM-{pagoId}` como `EGRESO`, `origen: "COMISION"`,
    `rubro: "COMISIONES"`, `monto` negativo, `fecha` `YYYY-MM-DD`.
- `controlfinanzas` muestra el badge `COMISIÓN` y bloquea edición/borrado de esos
  asientos automáticos.

### Mi Caja (`micaja.html`)

- Solo lectura; requiere un token válido, sin permisos extra.
- Identifica al chofer por `tokens.usuario` → `usuarios/{id}` y consulta `movimientos`
  por `USUARIO` con alias (`nombre_mostrar`, `nombre_completo`, id), en minúsculas,
  mayúsculas y sin acentos. Además consulta por `USUARIO_ID` para las ventas nuevas.
- La caja usa solo movimientos sin `ARQUEO_ID` (o con `ARQUEO_ID = "S/D"`): el
  **efectivo a rendir** es la suma de `E$` menos `GASTO_TOTAL`.
- Los movimientos se muestran dentro de una etiqueta `<details>` colapsada por defecto.
  Cada venta es una línea compacta con fecha, hora, cliente, cantidades 10/15/45,
  total, transferencia y efectivo; los gastos y saldos se agregan como chips.
- Debajo se lista **Transferencias** leyendo todos los movimientos con `T$ > 0` y
  clasificándolos solo por `ARQUEO_ID`:
  - verde (`SIN ARQUEAR`): todavía forma parte de la caja;
  - rojo (`ARQUEADA`): ya fue rendida en un arqueo.
  Las pendientes se muestran siempre; las arqueadas, solo de los últimos 30 días.
  No se usa `TRF_ESTADO` ni la verificación bancaria para este listado.
- Los movimientos viejos sin `garrafas` usan los contadores `VRP/VC/VS/VU` como
  fallback. Si un movimiento viejo no tiene `E$`/`T$`, se usa `TOTAL` como efectivo
  (igual que `arqueo.html`). Los gastos viejos sin `GASTO_TOTAL` usan `abs(TOTAL)`.

### Tablero (`tablero.html`, 2026-11-13)

- Requiere token válido y permiso `TABLERO` (`usuarios/{id}.TABLERO`).
- Se agregó el tile **Tablero de Comando** en `inicio.html` cuando el usuario tiene
  el permiso.
- Lee Firestore directo, sin Apps Script:
  - `movimientos` por `FECHA` en bloques de 30 días (6 meses para promedios);
  - `confinanzas`, `ccarga`, `clientes`, `usuarios`, `turnos` y `patrimonio/totales`.
- Mantiene las tres vistas del tablero legacy:
  - **Riesgo & Stock**: stock planta/calle, turno, flota en tránsito, cuenta corriente,
    cauciones, envases secuestrados, transferencias adeudadas, arqueos pendientes y
    remitos de compra sin conciliar.
  - **Operativa**: kilos, unidades, facturación, viajes, promedios, mix, efecto
    logístico, ventas por chofer/zona y mapa de calor.
  - **Finanzas**: ingresos, egresos, renta, evolución diaria y gastos por rubro.
- **Mapa**: Leaflet + `leaflet.heat` con tiles estándar de **OpenStreetMap** (sin API key)
  y un filtro CSS oscuro para integrarlo al tablero. El mapa de calor prioriza
  `clientes.ubicacion`/`coordenadas` y usa `movimientos.UBICACION` como respaldo. El
  peso de cada punto es el kilos de la venta.
- `PUNTO_GPS` se conserva como dato de auditoría, no como fuente del mapa.
- La tarjeta de **Cauciones** queda visible con estado “sin datos” hasta que exista el
  módulo; la cuenta corriente se arma con `clientes.env*` y `clientes.plata`.
- Para volúmenes altos de OSM conviene pasar a un proveedor con key o self-host; el
  tiles estándar de OSM es gratuito pero tiene política de uso moderado.

### Visor Pro (`treeview.html`)

- **Colores por jerarquía**: bloque **DÍA** = borde azul (`--blue`), bloque
  **TURNO** = fondo/borde rojizos (`--turnoBg` / `--turnoBd`, clase `.card.turno`),
  bloque **CHOFER** = morado (`.purple`). "SIN TURNO" queda neutro (sin clase).
- **Edición total de datos** (control total de modificaciones, con PIN + motivo +
  registro en `auditoria`):
  - Botón **✎ Editar** fuerza la vista Planilla; **todas las columnas excepto
    `N` (N° operación)** son editables haciendo clic en la celda
    (`EDIT_MAP` cubre `usuario, tipo, fecha, hora, cliente, L10-45, V10-45, total,
    efe, tra, ID_CLIENTE, idTurno, idViaje, GASTO_TOTAL, COMISION_TOTAL,
    clienteZona, clienteCategoria, operacionEnvase, esPagoDeuda, esFlotante,
    ventaDesdePlanta, garrafas`).
  - Los cambios quedan en la barra roja inferior (**pend**) hasta confirmar;
    se escriben con `writeBatch` sobre `movimientos/{id}` + auditoría tipo
    `EDITAR_PLANILLA`.
  - Tipos de celda: `txt` (texto libre), `int` (admite negativos con `-`),
    `bool` (S/N o SÍ/NO/1/0; vacío = no).
- **Vínculos viaje/turno**: al editar `idViaje` o `idTurno` del movimiento se
  escriben tanto el campo canónico `idViaje`/`idTurno` como la llave legacy
  `ID_VIAJE`/`ID_TURNO` con el mismo valor. Al dejarlos vacíos se **borran los
  cuatro campos** (`deleteField`), no se escriben strings vacíos. Igual en la
  ficha (formulario completo) con los mismos campos.
- **Asociación venta → viaje** en `cargar`: si `movimientos` trae `idViaje`
  explícito, se busca solo ese viaje (`ccarga`) y **no hay fallback** por
  chofer/ventana horaria (si el viaje no existe en el rango, la venta aparece
  "sin camión"). Sin `idViaje` se mantiene la deducción por chofer y ventana.
  `idTurno` explícito también anula el fallback por hora para asignar turno.
- La ficha muestra los campos del sistema que no son editables en "solo lectura";
  al ampliar `EDITABLE` esos campos dejaron de listarse ahí.

### Gestión de Clientes (`clientes.html`)

- **Velocidad**: al abrir, primero se maqueta la copia local
  (`localStorage.vm_clientes_data`) y recién después se refresca contra Firebase
  en segundo plano; el panel de edición de cada cliente se genera **al abrirlo**
  (lazy), no junto con la lista completa. El buscador filtra en memoria sobre un
  índice precomputado (`_search` sin tildes, incluye nombre, dirección, CUIT,
  CUIL, CUIL de pago y zona) con anti-rebote de 130 ms.
- **Edición**: además de zona/categoría/dirección/teléfono/coordenadas/precios
  ahora son editables **nombre**, **cuil** y **cuil_pago** (con estos dos se
  identifica a desconocidos en la cuenta bancaria de las transferencias).
  Todo lo editable existe también en el alta de nuevo cliente.
- **`seguridad/pin.version_datos`**: cada `Guardar cambios` con cambios reales
  suma `+1` (y guarda `actualizadoPor`/`actualizadoTs`). El paquete offline de
  `app.js` (`vm_paquete_offline`) guarda la `version_datos` con la que fue
  descargado; `cargarDatos` (index4) lee `seguridad/pin` (1 lectura con
  `getDoc`) y solo vuelve a descargar la colección `clientes` si la versión
  cambió o no hay copia. Precios y parámetros se bajan siempre (livianos).
- Respaldo pre-optimización: `clientes_backup_20261102.html`.

## Conciliación arqueos ↔ finanzas

`controlfinanzas.html` lee `confinanzas` y `arqueos` en paralelo. Si la lectura de
`arqueos` falla, el módulo financiero sigue operativo y muestra una advertencia en la
vista de arqueos.

La vista **Arqueos** agrupa los documentos de `arqueos` por `idCierre`, los compara
contra el documento de `confinanzas` con el mismo id y muestra:

- KPIs de cierres, conciliados, diferencias y cierres sin finanzas.
- Tabla por cierre con efectivo real, monto en finanzas, conciliación, diferencia de
  caja y estado.
- Modal con el detalle por día, gastos declarados, observaciones, auditor y vínculo al
  módulo de arqueo.
- Registros huérfanos de finanzas con estado `SIN_DETALLE`.

El acceso directo a un cierre se hace con:

```text
controlfinanzas.html?k=<token>&arqueo=<idCierre>
```

Al abrir ese enlace, el módulo amplía el rango de fechas, cambia a la vista Arqueos y
abre el modal del cierre.

`arqueo.html` valida el permiso `FINANZAS` contra `usuarios/{usuario}` antes de cargar.
El historial muestra los últimos 25 cierres agrupados por `idCierre` y cada fila tiene
el botón **Ver en Finanzas** con el deep link anterior. Al cerrar la caja ya no se
redirige automáticamente: se muestra un modal con el `idCierre`, el resumen y el enlace
a finanzas.

## Reglas de Firestore a revisar

Las páginas nuevas leen y escriben directo desde el navegador. Hay que asegurar reglas para:

- `tokens/{k}`: lectura permitida solo para validar la sesión (o vía API).
- `configuracion/parametros`: lectura/escritura solo para usuarios con permiso `PRECIOS`; el panel de comisiones actualiza únicamente `comisiones_10/15/45` y `precios.html` solo precios y `recargo_flotante`.
- `movimientos`: lectura para usuarios autenticados; update limitado a `ARQUEO_ID`, `ARQUEO_FECHA`, `ARQUEO_TS` desde el módulo de arqueo.
- `transferencias_auditoria`: lectura/escritura solo para `FINANZAS` / `CONFINANZAS`; el update de `movimientos` para `TRF_ESTADO`, `TRF_FECHA`, `TRF_USUARIO`, `TRF_TS`, `TRF_REVERTIDA`, `VERIFICADO_BANCO` y `DETALLE_BANCO` sale del mismo flujo.
- `arqueos`: lectura para usuarios con permiso `FINANZAS` o `CONFINANZAS`; escritura solo desde arqueo.
- `comisiones`: lectura y update solo para `FINANZAS` / `CONFINANZAS`; `create` lo hace `app.js` al vender (usuario con `FORMULARIO`). El chofer no necesita leerla para Mi Caja.
- `comisiones_pagos`: lectura/escritura solo para `FINANZAS` / `CONFINANZAS`.
- `confinanzas`, `alarmas`: escritura solo para usuarios con permiso `FINANZAS` / `CONFINANZAS`.
- `seguridad/pin`, `historialPin`, `auditoria`: las operaciones sensibles se hacen en transacción; las reglas deben impedir que un usuario sin permiso rote el PIN.
- `clientes`: permitir `update` de `ubicacion`, `plata`, `env10/15/45`, `flotante10/15/45`, `ultimaActualizacionMs` y `ultimoMovimientoTipo` desde la transacción de venta (`FORMULARIO`).
- `historial_flotantes`: `create` desde la venta y lectura para `FORMULARIO`/`FINANZAS`/`CONFINANZAS`.
- Evitar reglas `allow read, write: if true`.

## Pendiente técnico recomendado

1. Centralizar `firebaseConfig` en un solo archivo (`firebase-config.js`) para no repetirlo en cada HTML.
2. Mover la validación de permisos (`FINANZAS`, `CONFINANZAS`, `TABLERO`) al servidor o a reglas, no solo a la UI.
3. Terminar la migración de `alarmas.html` y del audio de `app.js` (todavía usan Apps Script).
4. Revisar el tope de lectura de `controlfinanzas` y `tablero` (hoy leen toda la colección `confinanzas`); si crece, paginar o consultar por rango de fechas con un campo índice.
5. Implementar la revisión diaria de vencimientos (`FIN_CALENDARIO` → `alarmas`) con una tarea programada (cron/Cloud Function) que corra al menos una vez por día.
6. `flota.html`, `index_recepcion.html` y el audio quedan fuera de alcance por ahora; `flota` y recepción de flotantes se retoman después.

## Alcance v1: transferencias y compras (actualizado 2026-11-09)

Estas decisiones cierran la primera versión. No incluyen conciliación bancaria automática
ni rentabilidad diaria; quedan para una etapa posterior.

### Transferencias (verificación bancaria)

- La fuente es `movimientos` con `T$ > 0`. No se crea una colección paralela de
  movimientos ni se duplican los importes. El arqueo es **solo de efectivo**: la
  transferencia se revisa manualmente y se registra en Finanzas al verificarla.
- La auditoría vive en `transferencias_auditoria/{movimientoId}`:

```js
{
  movimientoId,
  fecha: "2026-10-30",          // YYYY-MM-DD, para consultas
  fechaCorta: "30/10/2026",     // visual
  hora, chofer, cliente, viaje,
  montoE, montoT, montoTotal,
  estado: "PENDIENTE" | "ACREDITADA" | "REVERTIDA" | "RECHAZADA",
  detalles: [{ monto, referencia, pagador }], // terceros o pagos desdoblados
  detalleBanco,                 // nota compuesta + referencias/pagadores
  notaUsuario,                  // solo la nota escrita por el usuario
  verificadoBanco,              // copia de VERIFICADO_BANCO
  aprobadoPor, aprobadoTs,
  revertidoPor, revertidoTs, motivoReversion,
  finIngresoId, finImpuestoId,
  historial: [{ estado, usuario, ts, nota, notaUsuario, detalles, motivo }],
  creado, timestampMs
}
```

- Aprobar una transferencia escribe en `movimientos`, en la misma transacción:
  - `TRF_ESTADO: "ACREDITADA"`, `TRF_FECHA`, `TRF_USUARIO`, `TRF_TS`;
  - `VERIFICADO_BANCO` con el formato legacy
    `OK: <usuario> - [TRF-<movimientoId>] dd/mm/yyyy HH:mm`;
  - `DETALLE_BANCO` con la nota del usuario y las referencias/pagadores/montos de
    cada línea.
- También crea en `confinanzas`, en la misma transacción:
  - `TRF-{movimientoId}`: `INGRESO`, rubro `GAS`, subrubro `TRANSFERENCIA`.
  - `TRF-{movimientoId}-IMP`: `EGRESO`, rubro `CUENTA BANCARIA`,
    subrubro `IMPUESTO LEY 25413` (0,6 %).
- Los pagos por terceros o desdoblados se registran en `detalles`; la suma debe
  coincidir con `T$` (tolerancia de un centavo).
- **Vista compacta**: cada fila muestra en una línea cliente, fecha, CUIL, CUIT/DNI,
  CUIL pago, monto y estado, con checkbox y chevron. Al tocar la fila se despliega el
  resto (chofer, viaje, hora, efectivo, arqueo, verificación, detalle bancario y
  acciones). Los datos del cliente salen de `clientes` cruzando `ID_CLIENTE`; se usa
  la caché `localStorage.vm_clientes_data` y se refresca en segundo plano.
- Si `cuil_pago` trae varios CUIL separados por `;`, la fila compacta muestra el
  primero y `+N`; al expandir se listan completos.
- Se puede verificar **una o varias** transferencias con los checkboxes. En el lote se
  carga una nota/referencia **individual por fila** y se graban todos los movimientos,
  auditorías y asientos de Finanzas.
- `VERIFICADO_BANCO` vacío significa **pendiente**. El estado verificado guarda fecha,
  hora y usuario. Se puede **deshacer y volver a verificar**; `REVERTIDA` vuelve a
  contar como pendiente y muestra el botón **VOLVER A VERIFICAR**.
- Aprobar y revertir se permiten aunque el movimiento tenga `ARQUEO_ID`; el ajuste de
  `E$`/`T$` sí queda bloqueado cuando está arqueado.
- Revertir elimina los dos documentos de Finanzas, limpia `VERIFICADO_BANCO` y
  `DETALLE_BANCO`, deja `TRF_ESTADO: "PENDIENTE"` y `TRF_REVERTIDA: true`, y conserva
  el historial en la auditoría. También admite registros legacy verificados que no
  tengan `transferencias_auditoria`.
- Al volver a verificar se precarga `notaUsuario`, no el `detalleBanco` compuesto, para
  no duplicar referencias.
- Ajustar `E$`/`T$` solo se permite en pendientes, con motivo y auditoría. Recalcula
  `TOTAL = E$ + T$`; no toca `COMISION_TOTAL`.
- No hay importación de resumen bancario en v1.

### Compras y envases

- `ccarga` sigue siendo la fuente operativa del viaje de compra.
- Al confirmar la llegada de una compra, `controlcarga` guarda `compraEnv10/15/45`
  (envases comprados), además de `lL*`/`lV*`.
- La conciliación vive en `compras_conciliaciones/{idViaje}`:

```js
{
  idViaje, chofer, fechaLlegada, horaLlegada, proveedor, remito, factura,
  fechaFactura, vencimiento,
  cargas: { l10, l15, l45 },              // cargas de gas
  envasesComprados: { e10, e15, e45 },    // envases comprados
  precios: { p10, p15, p45 },             // precio de la carga
  preciosEnvase: { pe10, pe15, pe45 },
  ivaPorc, percPorc, retencionPorTransf,
  subtotalCargas, subtotalEnvases, iva, percepcion, retencion, total,
  pagos: [{ tipo: "DEPOSITO" | "TRANSFERENCIA", monto, referencia }],
  totalPagos, saldo,
  estado: "CONCILIADO" | "CON_DIFERENCIA",
  observacion, usuarioConciliacion, fechaConciliacion,
  finIds: ["CMP-{idViaje}-GAS", ...],
  ccargaAntes, ccargaDespues,
  historial: [{ accion, usuario, ts, antes, despues, motivo }]
}
```

- Al conciliar se actualizan en `ccarga`: `conciliado`, `estadoConciliacion`,
  `factura`, `precio10/15/45`, `precioEnv10/15/45`, `ivaPorc`, `percPorc`,
  `retencion`, `pagoDeposito`, `pagoTransf`, `opDepo`, `opTransf`,
  `usuarioConciliacion`, `fechaConciliacion` y los totales de la factura.
- Si las cantidades auditadas difieren del remito, se actualizan en `ccarga`
  `lL10/15/45` y `compraEnv10/15/45`. Los vacíos (`lV*`) no se tocan: son los que
  informó `controlcarga`. El antes/después queda en `ccargaAntes`/`ccargaDespues`,
  en el `historial` y en `auditoria` (`CONCILIAR_COMPRA` / `RECTIFICAR_COMPRA`).
- La transacción vuelve a leer `ccarga` y compara las cantidades contra el snapshot
  con el que se abrió el editor. Si otro usuario las cambió, la operación se rechaza
  para evitar pisar datos. En las rectificaciones también se compara `timestampMs`
  de `compras_conciliaciones` contra el leído al abrir el detalle.
- Los asientos de finanzas son determinísticos:
  `CMP-{idViaje}-GAS`, `-ENV`, `-IVA`, `-PER`, `-RET`, todos con `origen: "COMPRA"`.
  Al rectificar se borran los que dejan de existir y se reescriben los demás.
- Si el saldo no es cero se genera una alarma `COMPRA_CON_DIFERENCIA`. El estado
  queda `CON_DIFERENCIA` y se exige una observación.
- El estado de llenos/vacíos no se lleva en una colección nueva: se deriva de
  `ccarga` (`sL*`, `sV*`, `lL*`, `lV*`) y `movimientos` (`ALL*`, `AV*`), como ya hace
  `controlstock`. Los `compraEnv*` **no se suman aparte**: ya están incluidos en los
  conteos de llegada `lL*`/`lV*`, porque `controlcarga` exige que lleguen las unidades
  de salida más las compradas. Sumarlos de nuevo duplicaría el stock.
- El `patrimonio` sigue siendo una línea base manual (se actualiza con PIN y fecha
  cero). Comprar envases no lo modifica automáticamente; el control diario se hace
  contra el teórico del turno, que sí incluye la llegada.
- En `confinanzas` se registran los componentes de la factura como `EGRESO`:
  `COMPRA GAS`, `COMPRA ENVASES`, `IVA INSCRIPTO`, `PERCEPCION IVA`,
  `RETENCION TRANSFERENCIA`. El detalle incluye los medios de pago.
- No se registra un segundo egreso por el pago si la factura se paga al conciliar;
  el medio de pago queda en el detalle y en `pagos`. Si queda impaga, el circuito de
  cuenta corriente se define más adelante.
- `controlfinanzas` muestra un badge `COMPRA` y bloquea edición/borrado de los
  asientos con `origen: "COMPRA"`. La rectificación se hace solo desde
  `controlremitos`.
- El tablero de comando ya está migrado. La rentabilidad diaria por costo
  (`CU10/15/45`) sigue pendiente porque la venta nueva no guarda el costo unitario.

### Arqueo

- Se agrega un input de **transferencias reales** contadas/verificadas manualmente.
  Es obligatorio, igual que el efectivo real.
- `realTransf` deja de copiar `sisTransf`; se guarda el valor informado y la
  diferencia `realTransf - sisTransf` se muestra en el resumen.
- Cada documento de `arqueos` guarda `sisTransf`, `realTransf` y
  `diferenciaTransf` de su día. El cierre reparte el total informado entre los días
  seleccionados en forma proporcional a `sisTransf`, sin negativos.
- Si la diferencia de transferencias supera un centavo, se exige observación y se
  genera una alarma `DIFERENCIA_TRANSFERENCIA`. La diferencia de efectivo mantiene
  el umbral de $ 50 y sus alarmas `FALTANTE_CAJA`/`SOBRANTE_CAJA`.
- El historial muestra efectivo real, transferencias reales y estado; el detalle de
  diferencias queda en el `title` del estado.
- El cierre sigue registrando en `confinanzas` solo el efectivo (`realEfectivo`).
  Las transferencias se registran cuando se aprueban en `controltransferencias`.
  Esto evita el doble conteo.

### Permisos y navegación

- `arqueo.html`: permiso `FINANZAS`.
- `controlfinanzas.html`: permiso `CONFINANZAS`.
- `controlcomisiones.html`: `FINANZAS` o `CONFINANZAS`.
- `controlremitos.html` y `controltransferencias.html`: `FINANZAS` o `CONFINANZAS`.
- `parametroscomisiones.html`: permiso `PRECIOS`; se abre desde `precios.html`.
- `tablero.html`: permiso `TABLERO`; el tile de `inicio.html` también depende de ese permiso.
- `micaja.html`: solo token válido; cada chofer ve únicamente sus movimientos.
- `administrativo.html` valida `tokens/{k}` y luego `usuarios/{usuario}`; muestra
  Arqueo solo con `FINANZAS` y Comisiones/Remitos/Transferencias con cualquiera de los
  dos.
- `inicio.html` muestra el tile Administrativo con `FINANZAS` o `CONFINANZAS`, el
  tile Mi Caja con `FORMULARIO` y el tile Tablero con `TABLERO`.
- El tile de `index_recepcion.html` sigue fuera de `inicio.html` porque esa página
  todavía no existe en VMGAS2.
