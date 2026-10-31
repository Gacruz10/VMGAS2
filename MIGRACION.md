# Migración VMGAS → VMGAS2 (Firebase)

Documento de trabajo para mantener consistentes los módulos que se van migrando.
Última actualización: 2026-10-30.

## Estado

| Módulo | Estado |
|---|---|
| `index.html` (login) | Migrado a `/api/login` + Firestore |
| `inicio.html` | Migrado (token, permisos, alarmas) |
| `clientes.html` | Migrado |
| `precios.html` | Migrado |
| `usuarios.html` | Migrado |
| `controlcarga.html` | Migrado |
| `controlstock.html` | Migrado |
| `treeview.html` | Migrado |
| `alarmas.html` | Migrado (queda pendiente el envío de audio vía Apps Script) |
| `arqueo.html` | **Migrado + historial y permiso `FINANZAS`** |
| `controlfinanzas.html` | **Migrado a Firestore directo + conciliación de arqueos** |
| `controlcomisiones.html` | Pendiente (sin archivo; enlace quitado de Administración) |
| `controltransferencias.html` | **Migrado (auditoría manual v1)** |
| `controlremitos.html` | **Migrado (conciliación de compras v1)** |
| `flota.html` | Pendiente |
| `tablero.html` | Pendiente |
| `micaja.html` | Pendiente |
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

## Colecciones usadas

| Colección | Uso | Campos clave |
|---|---|---|
| `usuarios` | Usuarios y permisos | doc id = usuario; `nombre_mostrar`, `FINANZAS`, `CONFINANZAS`, etc. |
| `tokens` | Sesiones | `usuario`, `nombre_mostrar`, `creado`, `expira` |
| `clientes` | Maestro de clientes | `nombre`, `zona`, `categoria`, `plata`, `env10/15/45` |
| `precios` | Lista de precios | `categoria`, `tipo`, `precio` |
| `movimientos` | Operaciones de campo | `USUARIO`, `TIPO`, `FECHA`, `HORA`, `E$`, `T$`, `TOTAL`, `GASTO_TOTAL`, `ARQUEO_ID` |
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
- `movimientos`: lectura para usuarios autenticados; update limitado a `ARQUEO_ID`, `ARQUEO_FECHA`, `ARQUEO_TS` desde el módulo de arqueo.
- `arqueos`: lectura para usuarios con permiso `FINANZAS` o `CONFINANZAS`; escritura solo desde arqueo.
- `confinanzas`, `alarmas`: escritura solo para usuarios con permiso `FINANZAS` / `CONFINANZAS`.
- `seguridad/pin`, `historialPin`, `auditoria`: las operaciones sensibles se hacen en transacción; las reglas deben impedir que un usuario sin permiso rote el PIN.
- Evitar reglas `allow read, write: if true`.

## Pendiente técnico recomendado

1. Centralizar `firebaseConfig` en un solo archivo (`firebase-config.js`) para no repetirlo en cada HTML.
2. Mover la validación de permisos (`FINANZAS`, `CONFINANZAS`) al servidor o a reglas, no solo a la UI.
3. Terminar la migración de `alarmas.html` y del audio de `app.js` (todavía usan Apps Script).
4. Revisar el tope de lectura de `controlfinanzas` (hoy lee toda la colección `confinanzas`); si crece, paginar o consultar por rango de fechas con un campo índice.

## Alcance v1: transferencias y compras (2026-10-30)

Estas decisiones cierran la primera versión. No incluyen conciliación bancaria automática
ni rentabilidad diaria; quedan para una etapa posterior.

### Transferencias (manual)

- La fuente es `movimientos` con `T$ > 0`. No se crea una colección paralela de
  movimientos ni se duplican los importes.
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
  detalleBanco,
  aprobadoPor, aprobadoTs,
  finIngresoId, finImpuestoId,
  historial: [{ estado, usuario, ts, motivo, antes, despues }],
  creado, timestampMs
}
```

- Aprobar una transferencia crea en `confinanzas`, en la misma transacción:
  - `TRF-{movimientoId}`: `INGRESO`, rubro `GAS`, subrubro `TRANSFERENCIA`.
  - `TRF-{movimientoId}-IMP`: `EGRESO`, rubro `CUENTA BANCARIA`,
    subrubro `IMPUESTO LEY 25413` (0,6 %).
- Los pagos por terceros o desdoblados se registran en `detalles`; la suma debe
  coincidir con `T$` (tolerancia de un centavo).
- Si el movimiento tiene `ARQUEO_ID` distinto de vacío o `S/D`, no se puede aprobar,
  revertir ni ajustar.
- Revertir elimina los dos documentos de finanzas, deja el snapshot en la auditoría y
  vuelve el movimiento a pendiente. No se permite revertir si está arqueado.
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
- No se construye todavía el tablero de rentabilidad diaria.

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
- `controlremitos.html` y `controltransferencias.html`: `FINANZAS` o `CONFINANZAS`.
- `administrativo.html` valida `tokens/{k}` y luego `usuarios/{usuario}`; muestra
  Arqueo solo con `FINANZAS` y Remitos/Transferencias con cualquiera de los dos.
  El enlace a Comisiones se quitó porque el módulo no existe.
- `inicio.html` muestra el tile Administrativo con `FINANZAS` o `CONFINANZAS`.
- Los tiles de `micaja.html`, `tablero.html` e `index_recepcion.html` se quitaron de
  `inicio.html` porque esas páginas todavía no existen en VMGAS2. Se vuelven a agregar
  cuando se migren.
