# API v1

## Clientes libres y consentimiento de asociaciones

Ventas y cotizaciones admiten `customerName` opcional para un nombre libre, o `customerId` para un contacto existente; son excluyentes. Omitir ambos registra la operación sin cliente. El nombre libre queda como instantánea, no crea contactos. Los comisionistas admiten nombres libres o contactos; nunca requieren una cuenta de usuario.

Enviar `userId` al crear/editar un contacto propone una asociación. El contacto conserva `userId: null` y `userLink: {requestId,targetUserId,status: pending,requestedBy,requestedAt}` hasta que la persona acepte. `userId: null` cancela/desvincula. Cambiar de destinatario invalida la solicitud anterior. Guardar la misma solicitud pendiente no genera otra. Los vínculos directos antiguos se consideran pendientes de revisión, sin activarse implícitamente. Las instantáneas de comisión nuevas incluyen `userId` solo con aceptación registrada.

`GET /api/v1/notifications` devuelve hasta 50 solicitudes pendientes del usuario autenticado en espacios a los que conserva acceso. `POST /api/v1/notifications/:contactId/respond` recibe `{businessId,requestId,decision: accepted|rejected}` e `Idempotency-Key`. Solo el destinatario puede responder, incluso con rol viewer; no necesita permiso para editar contactos. La respuesta valida pertenencia y versión de solicitud, registra auditoría y no concede roles ni acceso. Repetir una decisión confirmada no duplica cambios. Un requestId reemplazado/cancelado se rechaza con 409.

Las notificaciones son internas de Nexo (sesión, foco/visibilidad y máximo una comprobación por minuto en primer plano); no se envían correos ni push. La bandeja no carga documentos ni colecciones financieras, y responder invalida solo los contactos del negocio. Las solicitudes se conservan en el contacto y su auditoría, sin una colección ni migración nueva.


## Contactos, usuarios y condiciones de comisión

Los contactos admiten `userId` (UUID o null para desvincular) y `commissionProfile: {enabled,default:{type,value,base,description},services:[{serviceId,type,value,base,description}]}`. Tipo `percent` (puntos base: 1500 = 15%) o `fixed` (centavos); base `sale` o `profit`. Máximo 50 servicios sin repetir. Las condiciones se guardan al crear o editar el contacto con su revisión. Cada servicio debe pertenecer al mismo negocio.

`GET /businesses/:businessId/contacts/linkable-users` devuelve `{data:[{_id,name,email}],nextCursor:null}` de los usuarios con acceso activo al espacio. Requiere lectura de Contactos. Vincular una ficha valida esa pertenencia dentro de la transacción, no crea cuentas ni concede permisos.

Las comisiones de venta aceptan `serviceId` opcional. Cuando está presente, debe existir entre las líneas de la venta y su base se calcula solo sobre ese servicio, prorrateando el descuento del total con redondeo a centavos; la base de ganancia descuenta el costo real registrado de esas líneas. Un monto fijo es el total de esa comisión para la venta, no un multiplicador automático por unidades. Sin `serviceId` se conserva la base de toda la venta.

El cliente aplica las condiciones guardadas al seleccionar un comisionista y permite cambiarlas por operación. La venta guarda los valores negociados y las instantáneas `contactId`, `name`, `userId` y `serviceName` cuando corresponden; los cambios posteriores en el contacto o sus condiciones no reescriben ventas. El pago de comisiones sigue registrándose aparte. No requiere nuevas colecciones ni migración.


## Ajustes y cancelaciones con historial

- `POST /businesses/:businessId/movements/:id/corrections`: `{revision,reason,replacement:{walletId,kind,amountMinor,category,description,occurredOn,toWalletId?}}`. `kind`: `income`, `expense` o `transfer`. Una transferencia conserva su tipo y requiere dos carteras distintas.
- `POST /businesses/:businessId/movements/:id/cancellations`: `{revision,reason}`.
- `GET /businesses/:businessId/movements/:id/changes`: `{rootId,selectedId,rows}`, original y ajustes en orden.
- Mismas rutas bajo `/debts/:id` para compras a crédito sin abonos y fuera de períodos cerrados. Reemplazo: `{name,creditLineId,principalMinor,feeMinor,terms,firstDueOn,mode,category,notes}`; `mode`: `monthly` o `balloon`.

Las escrituras requieren Bearer, permiso de escritura en Finanzas e `Idempotency-Key`. Importes en centavos. Motivo obligatorio. Revisiones obsoletas se rechazan con 409. Cada operación es atómica y auditada, valida saldos finales y corrige ambas caras de una transferencia. Los originales conservan importes, conceptos y fechas; solo reciben estado `edited`/`cancelled` y vínculos. Se insertan asientos `entryRole: reversal` y, al editar, `entryRole: adjustment`. No se admiten ajustes de reversiones ni versiones ya reemplazadas.

El historial usa `rootMovementId`, `previousMovementId`, `adjustmentMovementId`, `reversalMovementId` (o vínculos `DebtId` para compras). `adjustmentReason` y `createdBy` conservan el origen del ajuste; `changeReason`, `changedBy`, `changedAt` describen el cambio posterior. Se carga solo el grupo, sin una consulta por cada versión.

Las compras reemplazadas conservan el calendario original con `status: cancelled`; su reemplazo usa el cupo corregido sin mover efectivo. Saldos y calendario excluyen las versiones reemplazadas. Los cierres y pagos anteriores no se recalculan silenciosamente. Compras con abonos: `CHARGE_HAS_PAYMENTS`; períodos cerrados: `CLOSED_STATEMENT`.

Los movimientos automáticos ligados a ventas, créditos recibidos, abonos y saldos iniciales están protegidos con `SOURCE_MOVEMENT`; no se corrigen como ingresos/gastos manuales. No se crean colecciones ni se requiere migración destructiva.

Base de producción: `https://api.nexo.aethel.ing/api/v1`. Desarrollo: `http://localhost:3000/api/v1`. JSON. Los ejemplos usan IDs UUID de las respuestas `_id`.

## Autenticación

| Método y ruta | Entrada | Respuesta |
|---|---|---|
| POST `/auth/register` | `{name,email,password}` | 201: usuario público, `accessToken`, `tokenType`, `expiresIn` |
| POST `/auth/login` | `{email,password}` | 200: la misma forma de sesión |
| GET `/auth/me` | Bearer | Usuario público |
| POST `/auth/logout` | Bearer | `{revoked:true}` |

Contraseña de 12 a 128 caracteres. El token vence por defecto en 30 minutos. Las siguientes rutas requieren `Authorization: Bearer <token>`.

| Método y ruta | Entrada |
|---|---|
| GET `/businesses` | Lista de negocios con rol |
| POST `/businesses` | `{name,currency:"MXN",timezone?,kind?,description?,color?,enabledModules?}` |

## Negocio

En las tablas siguientes, todas las rutas tienen el prefijo **`/businesses/:businessId`**.

`owner` y `editor` pueden escribir. `viewer` puede leer y calcular proyecciones. Solo `owner` puede editar el negocio o gestionar miembros. Un negocio ajeno devuelve 404. No se pueden transferir operaciones de dinero ni recursos entre negocios.

| Método y ruta | Entrada / descripción |
|---|---|
| GET `/` | Identidad, revisión, configuración y rol actual del usuario |
| PATCH `/` | `{name?,kind?,description?,color?,enabledModules?,revision}`; solo propietario |
| GET `/members` | Lista de membresías |
| POST `/members` | `{email,role:"editor"\|"viewer"}`; usuario ya registrado |
| PATCH `/members/:id` | `{role:"editor"\|"viewer"\|"removed",revision}`; el owner está protegido |

Para reincorporar un miembro eliminado, cambia su membresía existente de `removed` a `editor` o `viewer`; la relación es única.

## Lecturas comunes

`GET /:resource` lista datos con `{data:[],nextCursor:null}`. Acepta `limit` (1–100, por defecto 30), `cursor` de la página previa, `listId` y `archived=true|false` cuando corresponda. Sin `archived` se incluyen activos y archivados. Orden: fecha de creación descendente, luego UUID descendente. `GET /:resource/:id` devuelve el documento del negocio. Campos base: `_id`, `businessId`, `revision`, `createdAt`, `updatedAt`.

Recursos: `wallets`, `movements`, `inventory-lists`, `items`, `stock-movements`, `contact-lists`, `contacts`, `sales`, `quotes`, `projects`, `events`, `projections`, `credit-lines`, `debts`, `debt-payments`.

Las escrituras devuelven el documento creado/actualizado salvo donde se indique. Las creaciones responden 201; ediciones y cambios de estado, 200. No hay DELETE físico.

**Idempotencia:** las rutas marcadas con ★ requieren `Idempotency-Key` (8–120 caracteres de letras/números/`_.:-`). En las demás escrituras de negocio es opcional. POST `/businesses` no implementa idempotencia. Incluye `revision` en las ediciones que lo indican; siempre usa la versión recibida por el último GET.

## Finanzas

| Método y ruta | Entrada |
|---|---|
| POST `/wallets` ★ | `{name,kind?:"cash"\|"bank"\|"card",openingBalanceMinor?:0,allowNegative?:false}` |
| PATCH `/wallets/:id` | `{name?,kind?:"cash"\|"bank"\|"card",archived?,revision}` |
| POST `/movements` ★ | `{walletId,kind:"income"\|"expense",amountMinor,category,description?,occurredOn?}` |
| POST `/transfers` ★ | `{fromWalletId,toWalletId,amountMinor,description?}`; devuelve `{from,to}` |
| GET `/summary?from=2026-01-01&to=2026-12-31` | Entradas/salidas y neto operativo del período; carteras con saldo actual |

`amountMinor` público siempre positivo. Internamente egresos son negativos. `occurredOn` no puede ser futuro (fecha UTC); usa eventos para movimientos planeados. Los totales de entradas/salidas incluyen transferencias, créditos y saldos iniciales; `operatingNetMinor` excluye esas partidas. No sumes esos totales como utilidad. El saldo de carteras del resumen corresponde al presente, aunque filtres el período.

## Listas y campos dinámicos

Las mismas operaciones sirven para `/inventory-lists` y `/contact-lists`.

| Método y ruta | Entrada |
|---|---|
| POST `/:lists` | `{name,description?,fields?:[]}` |
| PATCH `/:lists/:id` | `{name?,description?,fields?,archived?,revision}` |

Definición de campo:

```json
{"key":"proveedor_url","label":"Sitio del proveedor","type":"url","required":false}
```

Tipos: `text`, `longtext`, `phone`, `email`, `url`, `number`, `date`, `boolean`. Máximo 40 campos por lista. Clave: letra minúscula inicial seguida de letras minúsculas, números o `_`, máximo 40 caracteres. URLs HTTP(S) sin credenciales. Un mismo registro puede pertenecer a 1–20 listas y sus valores se validan contra la unión de campos. Una clave compartida debe tener el mismo tipo; si es requerida en una lista, es requerida en el registro. Las claves desconocidas se rechazan.

El esquema de una lista que ya tenga registros no se puede alterar, para evitar invalidar valores existentes. Su título y descripción sí se pueden editar. Para otro esquema crea otra lista y migra los registros explícitamente. Las listas archivadas no admiten altas ni modificaciones de sus registros; reactívalas para editarlos.

## Inventario genérico

| Método y ruta | Entrada |
|---|---|
| POST `/items` | Ver ejemplo inferior |
| PATCH `/items/:id` | Cualquier campo del alta, todos opcionales, además `archived?` y `revision` obligatorio |
| POST `/items/:id/adjustments` ★ | `{deltaMilli,reason,revision}`; devuelve `{item,movement}` |

```json
{
  "name":"Tela azul", "sku":"TELA-001", "unit":"metro",
  "listIds":["UUID_LISTA"], "values":{"color":"Azul"}, "notes":"",
  "trackStock":true, "sellable":true,
  "priceMinor":8500, "costMinor":4000, "minStockMilli":2000
}
```

Solo nombre y `listIds` son imprescindibles. Valores iniciales: conteo y venta activos, precios/mínimo cero, unidad `unidad`, notas vacías. Las existencias iniciales son cero: usa un ajuste positivo. `deltaMilli` puede ser positivo o negativo, nunca cero, con motivo. No se aceptan existencias negativas. Un servicio con `trackStock:false` puede venderse sin descontar stock. Un equipo interno con `sellable:false` no puede venderse. No puede desactivarse el conteo mientras exista stock. Archivar conserva la cantidad y bloquea su venta. SKU es opcional y único por negocio, también entre archivados.

## Contactos genéricos

| Método y ruta | Entrada |
|---|---|
| POST `/contacts` | `{name,listIds,values?,phone?,email?,occupation?,location?,links?:[],notes?,favorite?:false}` |
| PATCH `/contacts/:id` | Campos anteriores opcionales, `archived?`, `revision` obligatorio |

Correo puede ser vacío. `links` acepta hasta 20 URLs HTTP(S) sin usuario/contraseña. Los campos adicionales van en `values` según las listas.

## Ventas y cotizaciones

Línea de artículo: `{itemId,quantityMilli,unitPriceMinor?}`. Se toma costo, unidad y nombre del inventario; un precio explícito representa precio negociado. Línea libre: `{name,quantityMilli,unitPriceMinor,unitCostMinor?}`. Hasta 100 líneas. Un costo suministrado para artículo se ignora y se usa el costo actual de inventario.

Descuento: `{type:"percent",value:1000,reason:"Promoción 10%"}` o `{type:"fixed",value:5000,reason:"Bonificación"}`. Se aplica al documento completo. Valores predeterminados: descuento fijo cero y motivo vacío. No puede superar el subtotal.

| Método y ruta | Entrada |
|---|---|
| POST `/sales` ★ | `{walletId,customerId?,lines,discount?,description?}` |
| POST `/quotes` | `{title,customerId?,lines,discount?,notes?,expiresOn:"YYYY-MM-DD"}` |
| PUT `/quotes/:id` | Documento completo de cotización + `revision`; solo borradores |
| POST `/quotes/:id/status` | `{status:"sent"\|"accepted"\|"cancelled",revision}` |
| POST `/quotes/:id/convert` ★ | `{walletId,revision}`; devuelve venta |
| GET `/quotes/:id/client-view` | Proyección autenticada con líneas, descuentos, totales y cliente, sin costo ni ganancia |

Venta: retorna `subtotalMinor`, `discountMinor`, `totalMinor`, `costMinor`, `profitMinor`, líneas con snapshots y `status:"completed"`. La cotización no mueve dinero ni stock. Para convertir debe estar aceptada, vigente y sin convertir. Se conservan sus precios y descuento; la venta calcula costo actual del artículo y valida stock actual. Una cotización aceptada puede cancelarse; una convertida no puede editarse ni cancelarse mediante este API. No se implementaron anulaciones/devoluciones de venta: no intentes editarlas con PATCH.

## Créditos y gastos diferidos

| Método y ruta | Entrada |
|---|---|
| POST `/credit-lines` | `{name,limitMinor,notes?,statementCutoffOn?,paymentDueOn?,minimumPaymentMinor?,interestFreePaymentMinor?,annualInterestBps?}` |
| PATCH `/credit-lines/:id` | `{name?,limitMinor?,archived?,notes?,...estadoDeCuenta,revision}`; requiere deuda cero |
| GET `/credit-lines/balances` | Lista con cupo usado, disponible y campos del estado de cuenta |
| POST `/credit-lines/:id/payments` ★ | `{walletId,amountMinor,description?,revision}`; devuelve línea, importe y pagos aplicados |
| POST `/debts` ★ | Ejemplo inferior |
| POST `/debts/:id/payments` ★ | `{walletId,amountMinor,description?,revision}`; devuelve `{debt,payment}` |
| POST `/debts/:id/reschedule` ★ | `{terms,firstDueOn,mode,installmentsMinor?,additionalFeeMinor?:0,reason,revision}` |

```json
{
  "name":"Compra de equipo", "kind":"deferred", "principalMinor":120000,
  "feeMinor":6000, "terms":6, "firstDueOn":"2027-01-31", "mode":"monthly",
  "creditLineId":"UUID_LINEA_OPCIONAL", "contactId":"UUID_CONTACTO_OPCIONAL", "notes":""
}
```

Los campos de tarjeta son opcionales y aceptan `null` para borrar el valor. `statementCutoffOn` y `paymentDueOn` son fechas `YYYY-MM-DD` del estado de cuenta actual; el vencimiento no puede ser anterior al corte cuando ambos están informados. `minimumPaymentMinor` y `interestFreePaymentMinor` son importes reportados en ese estado de cuenta, en centavos. No se descuentan automáticamente al registrar un abono: actualízalos con el siguiente estado de cuenta. `annualInterestBps` es la tasa anual ordinaria informativa (6590 = 65.90%, hasta 100000 puntos base). No calcula ni carga intereses automáticamente. Ninguno de estos metadatos modifica el cupo utilizado, las deudas o las carteras. Las ediciones se auditan y pueden consultarse en `/history?collection=creditLines`; las líneas existentes sin estos campos siguen siendo válidas. Un PATCH parcial conserva los valores omitidos.

`kind:"credit"` requiere `walletId` y deposita el principal en esa cartera. `deferred` registra obligación sin salida inicial. Omitir las propiedades UUID opcionales si no se usan. `terms`: 1–120; `mode`: `monthly` o `balloon` (capital al final). `feeMinor` es comisión total fija; no una tasa. Estado automático `active` → `settled`. No hay pagos mayores que lo pendiente ni cambios de pagos confirmados. Reprogramar solo afecta lo pendiente y conserva snapshots previos en auditoría. El cupo incluye comisiones. El cupo puede editarse cuando no hay capital ni cargos pendientes.

## Proyectos, calendario y proyecciones

| Método y ruta | Entrada |
|---|---|
| POST `/projects` | `{name,description?,status?:"planned"\|"active"\|"paused"\|"completed",dueOn?,tasks?:[]}` |
| PUT `/projects/:id` | Documento completo + `revision`, `archived?` |
| POST `/events` | `{title,description?,date,endDate?,kind?:"reminder"\|"meeting"\|"payment"\|"other"}` |
| PUT `/events/:id` | Documento completo + `revision`, `archived?` |
| GET `/calendar?from=2027-01-01&to=2027-01-31` | Eventos, plazos de proyectos, vencimientos de cotizaciones y cuotas pendientes |
| POST `/projections/calculate` | Supuestos inferiores; cálculo sin persistencia |
| POST `/projections` | Mismos supuestos; guarda escenario y resultados |

Tarea: `{id:"UUID",title:"Comprar insumos",done:false}`. Calendario: rango máximo 366 días; `source` distingue `event`, `project`, `quote`, `debt`. Eventos que cruzan un rango se incluyen. El calendario no ejecuta pagos automáticamente.

```json
{
  "name":"Escenario base", "months":12, "initialInvestmentMinor":300000,
  "unitPriceMinor":15000, "unitCostMinor":7000, "quantityMilli":100000,
  "monthlyGrowthBps":500, "discountBps":500, "salesFeeBps":300,
  "fixedMonthlyMinor":250000
}
```

`months` entre 1 y 60. Tasas en puntos base; crecimiento mensual entre -100% y +100%. El resto de las tasas entre 0 y 100%. La respuesta contiene supuestos y meses con ingresos, costo variable, comisiones, utilidad y acumulado después de inversión. Incluye `netAfterInvestmentMinor`, `roiPercent`, `paybackMonth` y `breakEvenQuantityMilli`. Un resultado no calculable se representa por `null` (inversión cero o margen no positivo), no por división infinita.

## Historial y auditoría

| Método y ruta | Parámetros |
|---|---|
| GET `/history` | `collection`, `at` ISO con zona, `limit?`, `cursor?` |
| GET `/audit` | `entityId?`, `before?` ISO, `limit?`, `cursor?` |

`collection` usa el nombre interno: `inventoryLists`, `contactLists`, `stockMovements`, `creditLines`, `debtPayments`, o los demás nombres sin cambios. Historial: `{at,readOnly:true,basis:"recordedAt",data,nextCursor}`. No acepta fechas futuras. Recorre todos los cursores para obtener un corte completo. Orden del historial: UUID ascendente. Auditoría: fecha descendente, luego UUID descendente; incluye `before`, `after`, `revision` dentro de snapshots, `action`, `actorId`, `requestId`, `commandId`, `order` y `recordedAt`. `commandId` agrupa cambios atómicos; `order` los ordena dentro de un comando.

## Errores

```json
{"error":{"code":"REVISION_CONFLICT","message":"El registro cambió; recarga su versión","requestId":"..."}}
```

400 JSON/cabeceras inválidos; 401 token inválido o sesión finalizada; 403 permiso insuficiente; 404 entidad/ruta ajena o inexistente; 409 revisión, idempotencia o duplicado; 413 cuerpo >256KB; 422 datos o regla del dominio; 429 demasiados intentos de login/registro; 500 fallo interno. En validación, `details` lista `{path,message}`. Siempre se devuelve `X-Request-Id`. Para conciliar un error, busca el mismo identificador en los logs.


### Edición y eliminación de cuentas y líneas

Editar nombre, tipo de cuenta, límite, notas y datos del estado de cuenta está permitido aunque haya saldo o deuda; no modifica saldos, deudas ni vencimientos de compras existentes. Cambiar el límite exige cubrir la deuda pendiente (capital y cargos); si es inferior se rechaza con `422 CREDIT_LIMIT_BELOW_DEBT`. Los campos calculados de saldo y deuda no son editables. Solo eliminar requiere saldo cero. En cuentas se comprueba `balanceMinor === 0` (también se bloquean saldos negativos) y que no queden créditos recibidos en esa cuenta con capital o cargos pendientes. En líneas se comprueba cada deuda vinculada, incluidos cargos pendientes; el cupo disponible no es efectivo y no impide eliminar.

La eliminación es lógica: `PATCH /wallets/:id` o `/credit-lines/:id` con `{archived:true,revision}` e `Idempotency-Key`. No borra movimientos, pagos ni auditoría. La interfaz oculta las eliminadas de las tarjetas y selectores; siguen disponibles para referencias e historial. Los rechazos son `409 WALLET_HAS_BALANCE`, `WALLET_HAS_DEBT` o `CREDIT_LINE_HAS_DEBT`. Permisos, revisiones y auditoría se conservan. La comprobación y escritura se ejecutan en la misma transacción; los movimientos y las disposiciones concurrentes actualizan el mismo agregado y no pueden dejar una cuenta eliminada con saldo ni una línea eliminada con deuda.


## Espacios y módulos

`kind`: `business` (predeterminado) o `workspace`. `color`: hexadecimal `#RRGGBB`, predeterminado `#164e3d`. `description`: hasta 4000 caracteres. `enabledModules`: lista única de IDs del catálogo autenticado `GET /api/v1/business-modules`: `finance`, `inventory`, `sales`, `quotes`, `projections`, `contacts`, `calendar`, `projects`, `history`. Al crear se activan todos si se omite la lista; `[]` activa ninguno. Los negocios antiguos conservan todos los módulos sin migración. El resumen y la administración siempre están disponibles.

Ventas requiere Finanzas e Inventario; una combinación inconsistente devuelve 422. Las cotizaciones independientes siguen disponibles; convertir requiere también Ventas. Desactivar un módulo impide sus escrituras con `409 MODULE_DISABLED`, incluyendo servicios compuestos y cálculo de proyecciones. Las lecturas autorizadas siguen disponibles para referencias y consultas históricas, y no se eliminan datos. Los roles conservan sus límites habituales; desactivar módulos no sustituye el control de acceso.

Las ediciones solo admiten identidad y selección de módulos; moneda y zona horaria permanecen constantes. Un PATCH parcial conserva valores omitidos. Se exige `revision`, se rechazan cambios obsoletos con 409, y cada edición queda en auditoría. Editores/lectores reciben 403; usuarios sin membresía reciben 404. Crear un espacio añade al usuario autenticado como su propietario. `Idempotency-Key` es opcional para crear negocios y permite reintentar incluso solicitudes concurrentes sin crear espacios o membresías duplicados; reutilizar la clave con otro cuerpo produce 409.


### Movimientos con líneas de crédito

Una compra usa `POST /debts` con `kind:"deferred"`, `creditLineId`, capital, un plazo y primer vencimiento; `category` es opcional y usa `General` por defecto. Consume cupo sin registrar salida inicial de efectivo ni modificar inventario. La web proyecta esas compras como movimientos de crédito a partir de las deudas persistidas, con su principal original; no suma cargos de una reprogramación al importe de la compra histórica. No son egresos de caja hasta registrar el pago.

Un abono desde Movimientos usa `POST /credit-lines/:id/payments`, indicando la cuenta de origen y la revisión actual de la línea. Reparte el importe entre compromisos activos por su próximo vencimiento; desempata por fecha de creación e ID. Dentro de cada compromiso conserva la asignación habitual de cargos y capital. Descuenta efectivo, crea los pagos auditados y libera cupo. Todo se ejecuta en una sola transacción: saldo insuficiente, revisión obsoleta o sobrepago revierte la operación completa. Es idempotente, exige rol de escritura y Finanzas activo, respeta aislamiento por negocio y no admite líneas archivadas ni abonos mayores a la deuda.

El origen web de producción permitido en CORS es `https://nexo.aethel.ing`, sin barra final. Se conserva el origen del Site y los de desarrollo; no se permite `*`. Los cambios del mínimo reportado o pago para no generar intereses siguen siendo manuales.

### Lectura agrupada para clientes

`GET /businesses/:businessId/snapshot` retorna `{business,collections}` con los metadatos actuales, el rol del miembro y la primera página de los 15 recursos. Requiere Bearer y pertenencia activa al negocio. La autorización y las lecturas comparten una transacción de consulta.

`?collections=wallets,movements` limita los recursos a actualizar. Usa los nombres públicos de las rutas, separados por comas y sin repetidos. Cada recurso retorna `{data,nextCursor}` con un máximo de 100 registros. Si existe `nextCursor`, continúa por su ruta habitual con `?limit=100&cursor=...`; no se deben descartar las páginas siguientes. Cada continuación es una consulta independiente.

`?at=ISO_DATETIME` consulta el historial de los recursos seleccionados con el mismo corte y retorna además `readOnly:true`. Sus continuaciones usan `/history?collection=NOMBRE_INTERNO&at=...&limit=100&cursor=...`. No escribe registros ni acepta fechas futuras. Las rutas individuales siguen disponibles.

### Acceso con Google

Configura `GOOGLE_CLIENT_ID` con el cliente OAuth web. La verificación usa las claves públicas oficiales de Google, RS256, audiencia, emisor, vencimiento, correo verificado y nonce. La API emite su propio Bearer Nexo. El cliente no envía ni decide el identificador del usuario.

- `POST /auth/google/challenge` con `{}`: retorna `{challengeId,nonce,clientId,expiresIn:300}`. El nonce se usa en `google.accounts.id.initialize`.
- `POST /auth/google` con `{credential,challengeId}`: valida el ID token y consume el intento dentro de la transacción que crea la sesión. Retorna el mismo contrato que `/auth/login`.
- `POST /auth/google/link/challenge` con Bearer y `{password}`: confirma la contraseña de Nexo y crea un intento de vinculación asociado al usuario autenticado.
- `POST /auth/google/link` con Bearer y `{credential,challengeId}`: vincula la identidad Google a ese usuario y retorna su información pública. No crea otro usuario ni cambia membresías.

Los intentos vencen en cinco minutos, se consumen una sola vez y almacenan únicamente un hash del nonce. No se guardan ID tokens de Google. Los índices únicos de correo y `googleSub` evitan cuentas duplicadas; `authChallenges.expiresAt` tiene TTL. La migración es aditiva y se ejecuta con `npm run db:migrate`, o automáticamente en Workers si `MONGO_AUTO_MIGRATE=true`.

Una cuenta existente con el mismo correo recibe `409 GOOGLE_LINK_REQUIRED`; debe entrar con su contraseña y vincular Google desde el perfil. La identidad permanente es `sub`, no el correo. Las operaciones están limitadas por IP y generan eventos de seguridad sin credenciales. `GET /auth/me` agrega `googleLinked` y, cuando corresponda, `googleEmail`.

Configura en Google los orígenes `https://nexo.aethel.ing` y, si se usa, `https://nexo-negocios-isaac.mik-chivasrayo-l.chatgpt.site`. Se usa popup con callback JavaScript; este flujo web no requiere un client secret ni URI de redirección. Para una app Android nativa se necesita su propia integración de identidad y configuración de firma; no se ejecuta Google Sign-In dentro de un WebView.

### Reprogramación con importes por mes

`POST /debts/:id/reschedule` admite `mode: "custom"` y `installmentsMinor`, un arreglo de importes en centavos, ordenados por mes a partir de `firstDueOn`. Debe contener exactamente `terms` elementos (1–120); admite meses en cero. La suma debe ser igual al capital pendiente más los cargos pendientes y `additionalFeeMinor`. Se rechazan importes negativos, fraccionarios y planes que no cuadren. Los cargos conocidos se asignan primero y el resto reduce capital. No se calculan intereses automáticamente ni se modifica el efectivo al reprogramar.

Ejemplo: `{ "terms": 3, "firstDueOn": "2027-01-31", "mode": "custom", "installmentsMinor": [20000, 0, 80000], "additionalFeeMinor": 0, "reason": "Pagos según disponibilidad", "revision": 2 }`. Para un saldo pendiente de $1,000.00 conserva los abonos anteriores y programa $200.00, $0.00 y $800.00. `monthly` y `balloon` conservan su contrato sin `installmentsMinor`.

### Estados de cuenta y mínimo estimado/oficial

- `PATCH /credit-lines/:id/minimum-rule`: `{revision,rule}`. Regla configurable aun con deuda: `issuer`, `principalBps` (150), `limitBps` (125), `floorMinor` (0), `includeInstallments`, `includeFees`, `includeArrears` (true), `dayBasis` (360 o 365), `vatBps` (1600). Porcentajes expresados en puntos base; importes en centavos.
- `POST /credit-lines/:id/statements/preview`: cálculo autorizado, sin escritura ni auditoría financiera.
- `POST /credit-lines/:id/statements`: mismo cuerpo más `revision` de la línea e `Idempotency-Key`. Cierra y conserva el cálculo, los saldos, la regla y el límite usados. Impide cortes futuros y períodos superpuestos; los cierres se registran en orden.
- `GET /credit-statements` y `GET /credit-statements/:id`: lectura por negocio, compatible con `snapshot` y `history` (`creditStatements`).
- `PATCH /credit-statements/:id/official`: `{revision,officialMinimumMinor,officialInterestFreeMinor,notes?}`. Los oficiales admiten `null` (sin capturar) y cero. La captura no reemplaza el estimado ni los saldos del cierre; el mínimo oficial tiene prioridad para mostrar lo pendiente.
- `PATCH /debts/:id/billing-kind`: `{revision,billingKind}`. Clasifica como `revolving`, `interestFree` o `installments`. No modifica capital, pagos o cierres anteriores. También se admite `billingKind` al crear la deuda.

Cuerpo de cálculo/cierre: `periodStartOn`, `cutoffOn`, `dueOn`, `revolvingMinor`, `interestFreeInstallmentMinor`, `financedInstallmentMinor`, `feesMinor`, `arrearsMinor`, `interestSource` (`captured` o `averageDaily`), `interestMinor`, `vatMinor`, `averageDailyBalanceMinor`, `annualInterestBps`, `officialMinimumMinor`, `officialInterestFreeMinor`, `notes`. Importes opcionales sin capturar se representan con `null` donde corresponda. El período puede abarcar hasta 62 días; los cargos y vencidos deben capturarse sin repetir importes incluidos en otros saldos.

La estimación compara el porcentaje del capital más intereses/IVA/comisiones seleccionadas, el porcentaje del límite y el piso fijo; aplica el tope del saldo revolvente con cargos y añade las mensualidades y vencidos seleccionados, sin exceder el total del período. La base predeterminada toma como referencia la [Circular 34/2010 de Banxico](https://www.banxico.org.mx/marco-normativo/normativa-emitida-por-el-banco-de-mexico/circular-34-2010/%7B0C55B906-6DB4-6B88-FED0-67987E9FB3CC%7D.pdf). Es un estimador configurable, no una reproducción garantizada de todos los contratos de emisores.

En `averageDaily`, los intereses estimados son `saldoPromedio × tasaAnual × días / baseAnual`, con redondeo a centavos; el IVA usa el porcentaje configurado. El promedio corresponde al capital sujeto a intereses según el contrato y debe ser capturado. No se infiere automáticamente de registros incompletos. En `captured`, se conservan los intereses e IVA proporcionados.

Cada abono real a la línea se asocia por fecha al último corte anterior al día del pago en la zona del negocio. Un nuevo cierre concilia esos intervalos y mantiene un solo vínculo por pago: no duplica efectivo ni aplica el mismo abono a dos períodos. El pendiente se limita a cero si los abonos superan el mínimo/total. La auditoría conserva los cambios de regla, cierres, importes oficiales y conciliación. Registrar un estado no crea una deuda nueva ni intereses en el libro de movimientos.

### Panel personal y orden de tarjetas

`PUT /businesses/:businessId/preferences` guarda exclusivamente la presentación del miembro autenticado, también para lectores. No concede permisos financieros. Cuerpo: `{revision, preferences:{version:1, walletOrder:[uuid], creditOrder:[uuid], widgets:[...]}}`. `revision` empieza en 0; una configuración concurrente distinta responde 409 `PREFERENCES_CONFLICT`. Repetir exactamente la configuración guardada es seguro.

Cada widget: `{id:uuid,title,type:"chart"|"list"|"metric",preset,accounts:[],periodMode:"global"|"all"|"custom",category:"",limit:8,size:"normal"|"wide",from?,to?}`. Presets: `activity`, `inflows`, `outflows`, `creditPurchases`, `creditPayments`, `balances`, `debt`, `availableCredit`, `lowStock`, `projects`. Cuentas: UUID de cartera o `credit:<uuid>`. Sin selección incluye todas. Máximo 24 widgets; fechas ISO ordenadas para intervalos personalizados. Los presets de saldos/inventario/proyectos muestran la situación actual y la interfaz desactiva fechas no aplicables.

La respuesta y los metadatos de `GET /businesses/:id` y `/snapshot` incluyen `uiPreferences` y `preferencesRevision` del solicitante, sin nuevas consultas por widget. Se guarda en su membresía con auditoría `preferences.updated`; no necesita migración adicional. La actividad utiliza cuatro series excluyentes: entradas, otras salidas, compras a crédito y abonos a crédito. El preset `outflows` suma las dos clases de salida. Excluye transferencias internas y apertura; no duplica un abono por coincidir con cuenta y línea. Los saldos no se alteran al personalizar.

Los widgets admiten `columns` (entero de 3 a 12), `height` (entero de 220 a 1200, píxeles) y `color` (`#RRGGBB`, normalizado a minúsculas). Son campos opcionales: los paneles anteriores conservan el ancho derivado de `size`, la altura automática y el color del preset. Omitir `height` restablece la altura automática. La interfaz ajusta el ancho a la pantalla disponible en tablet/móvil sin modificar la preferencia guardada para escritorio. Redimensionar o cambiar colores solo modifica el borrador; se persiste en una escritura al guardar el panel.

### Organizaciones y acceso por espacio

Las organizaciones agrupan espacios existentes; no conceden acceso automático. Solo su propietario administra equipo, identidad y roles. Los usuarios agregados deben tener una cuenta Nexo con ese correo; esta versión no envía invitaciones por email.

- `GET/POST /organizations`; `GET/PATCH /organizations/:organizationId`.
- `POST /organizations/:organizationId/roles`; `PATCH .../roles/:roleId`.
- `POST .../members` con `{email}`; `PATCH .../members/:memberId` con `{revision,state:"removed"}` revoca los accesos de sus espacios.
- `PUT .../spaces/:businessId` con `{revision}` incorpora un espacio propio que no pertenezca a otra organización.
- `PUT .../spaces/:businessId/grants/:memberId` con `{revision,roleId,projectScope:{mode:"all"|"selected",ids:[]}}` asigna un rol por persona y espacio. `roleId:null` revoca; `revision:0` solo para membresías que no existan. Los accesos retirados conservan su revisión y pueden reasignarse.

Todas estas escrituras requieren Bearer e `Idempotency-Key`. Roles: `{name,description,color,permissions:{docs,finance,inventory,sales,quotes,projections,contacts,calendar,projects,history}}`, cada permiso `none|read|write`; los omitidos son `none`. Editar Ventas requiere edición de Finanzas e Inventario. Editar un rol requiere su revisión; archivarlo usa `archived:true` y se rechaza mientras tenga asignaciones activas.

Los permisos se resuelven desde Mongo en cada solicitud, sin incorporar privilegios al JWT. Se comprueban en comandos, consultas, snapshots, historial, Docs y calendario. Los proyectos seleccionados se filtran también en consultas históricas y no permiten crear nuevos proyectos. Auditoría y administración de accesos quedan protegidas. El propietario del espacio conserva acceso completo. Los accesos directos anteriores permanecen visibles para su revisión y pueden retirarse o reemplazarse por roles personalizados.

La migración es aditiva: `npm run db:migrate` crea las colecciones e índices de organizaciones. Workers con `MONGO_AUTO_MIGRATE=true` prepara los índices al detectar su ausencia, sin borrar datos. Las mutaciones de organización usan transacciones, revisiones, idempotencia y auditoría; la asignación de accesos se serializa frente a retiros de miembros y cambios de roles.

### Administración global y acceso

`GET /auth/options` es público y devuelve los métodos de registro/inicio de sesión, módulos y funciones disponibles, con `Cache-Control: no-store`. No expone la lista de administradores.

La identidad pública (`/auth/me`, sesión y vinculación de Google) incluye `platformRole: "admin"|"user"`. El administrador global se configura desde el servidor: `PLATFORM_ADMIN_EMAILS` permite únicamente cuentas con esa dirección ya verificada mediante Google (`googleSub` y `googleEmail`); registrarse con ese correo y contraseña no concede el rol. `PLATFORM_ADMIN_USER_IDS` permite asignar IDs existentes de forma explícita como alternativa operativa. El rol de propietario de un negocio y los roles de organización no conceden administración global. El administrador controla configuración y no obtiene acceso a datos de otros negocios.

- `GET /administration/settings`: configuración y métodos disponibles para el administrador actual.
- `PATCH /administration/settings`: requiere administrador, Bearer, `Idempotency-Key` y la revisión actual (0 antes del primer guardado).
- `GET /administration/audit`: últimos 20 cambios de configuración, actor, fecha y revisión.

El cuerpo de actualización es estricto:

```json
{
  "revision": 0,
  "registration": { "portal": true, "google": true },
  "login": { "password": true, "google": true },
  "enabledModules": ["docs", "finance", "inventory", "sales", "quotes", "projections", "contacts", "calendar", "projects", "history"],
  "features": { "workspaceCreation": true, "organizationCreation": true, "docsUploads": true }
}
```

Cerrar un método de registro impide crear usuarios nuevos por ese método y conserva el acceso de cuentas existentes. El inicio de sesión se controla por separado. El ajuste Solo Google desactiva registro e inicio por contraseña, activa Google y requiere identificación firmada, audiencia/emisor, vencimiento, nonce y correo verificado. Las cuentas existentes con contraseña necesitan vincular Google previamente. No se vinculan cuentas automáticamente por coincidencia de correo.

Se rechazan configuraciones sin métodos de inicio, registro con un método de inicio desactivado, Google sin configurar o combinaciones que dejen al administrador actual sin acceso. Las sesiones existentes conservan su vencimiento. La política se consulta en Mongo en cada operación relevante, también en snapshots, historial, calendario y escrituras entre módulos; desactivar conserva los registros. La configuración, revisiones, idempotencia y auditoría se guardan en una sola transacción. Una migración aditiva crea `platformSettings` y su índice; `MONGO_AUTO_MIGRATE=true` prepara esta actualización en Workers.


### Inventario por medida y consumo variable

Las listas de inventario aceptan `inventoryDefaults`: `unit`, `trackStock`, `sellable`, `pricing` (`unit`, `measure`, `fixed`), `tracking` (`aggregate`, `batches`), `priceUnit` y `packageSizeMilli`. Son valores iniciales para fichas nuevas; editar una lista no reinterpreta las fichas existentes. Las listas de contactos no aceptan esta configuración.

Las fichas aceptan `stockConfig: { pricing, tracking, packageSizeMilli, priceUnit? }`. Cantidades y saldos se expresan en milésimas de la unidad base de la ficha; dinero en centavos. Las fichas antiguas conservan la venta por cantidad. No se puede cambiar la unidad o el modo de conteo con saldo pendiente.

Una línea de venta/cotización puede incluir `consumption: { quantityMilli, unit, batchId? }`. En `fixed` el cobro es un trabajo (`quantityMilli=1000`) y el costo usa exclusivamente el consumo real. En `measure`, el cobro usa el consumo convertido a `priceUnit` (o la unidad base si se omite), y el costo usa la unidad de inventario. Es posible controlar rollos de 30 m y cobrar por cm. Unidades compatibles: mm/cm/m, g/kg, ml/l; m2 se registra directamente. Conversiones que pierdan precisión de tres decimales se rechazan.

Las entradas de stock admiten `batchCount` (1–200, cantidad total repartida por igual) y `batchLabel`. Las salidas admiten `batchId`; si se omite, se consumen primero los rollos más antiguos, pudiendo repartir entre varios. El saldo, las asignaciones de rollos, la venta, el movimiento financiero y la auditoría se confirman en una sola transacción idempotente. Las cotizaciones no reservan existencias: se validan otra vez al convertir. Los rollos agotados se conservan en los movimientos y en el historial; se retiran del listado activo al dar otra entrada. Máximo 200 rollos activos por ficha.

Los metadatos de espacio incluyen `capabilities.inventoryMaterials=1`. El cliente usa esta capacidad, sin peticiones adicionales, para no enviar campos nuevos durante despliegues graduales. No requiere una migración destructiva.


### Servicios de venta y materiales de uso interno

`GET /businesses/:id/services` y `GET /businesses/:id/services/:serviceId` consultan el catálogo del módulo Ventas. `POST /services` acepta `{name, description?, priceMinor, materials:[{itemId, quantityMilli, unit}]}`. `PATCH /services/:serviceId` permite editar estos campos o archivar/restaurar con `revision`. Las cantidades de la plantilla corresponden a un servicio; guardar una plantilla no consume stock.

Una línea de venta acepta `{serviceId, quantityMilli, unitPriceMinor?, name?, materials?}`. Si se omiten los materiales, se usa la plantilla multiplicada exactamente por la cantidad de servicios. Si se envían, representan el consumo real total de esa línea y pueden incluir `batchId`. Una línea ocasional puede usar `{name, unitPriceMinor, quantityMilli, materials}` sin crear un registro en el catálogo. No se permite mezclar `itemId` con `serviceId` o `materials`.

Los componentes deben estar activos, pertenecer al mismo negocio y contar existencias; **no necesitan ser vendibles**. El artículo interno sigue rechazándose en ventas directas. El precio se calcula sobre el servicio; el costo se calcula sobre los componentes realmente consumidos. Las líneas conservan sus materiales, costos y asignaciones de rollo como snapshot. Archivar o editar la plantilla no modifica ventas anteriores. Las cotizaciones conservan los consumos previstos y no reservan stock.

Los consumos, la venta, el ingreso, la auditoría y la idempotencia comparten una transacción. Un fallo de stock, rollo o cartera revierte todos los efectos. Máximo 50 materiales por concepto y 200 por operación. El catálogo se incluye en `/snapshot` y respeta los permisos del módulo Ventas. La capacidad `capabilities.saleServices=1` permite al frontend activar estas opciones sin consultas por pulsación.

Se agrega la colección `services` con índice de listado por negocio. `npm run db:migrate` prepara el índice sin borrar datos; Workers con `MONGO_AUTO_MIGRATE=true` lo prepara al detectar que falta.


### Comisionistas dinámicos de venta

`POST /businesses/:id/sales` y `POST /quotes/:id/convert` aceptan `commissions` (hasta 50 registros). Cada entrada contiene `{contactId? | name?, type: "percent" | "fixed", value, base: "sale" | "profit", description?}`. El porcentaje usa puntos base (1000 = 10%) y el monto fijo usa centavos. Con contacto se valida pertenencia/estado y se conserva su nombre como snapshot; también se admiten nombres libres y varias reglas por persona.

`base=sale` toma `totalMinor` después de descuentos; `base=profit` toma `max(0, profitMinor)` antes de comisiones. Todos los porcentajes usan la misma base, sin componerlos sucesivamente. El redondeo se hace por comisión a centavos. La respuesta guarda `commissions[].{name,baseMinor,amountMinor}`, `commissionTotalMinor` y `netProfitMinor`. `profitMinor` conserva la ganancia bruta original. Una comisión fija puede producir pérdida; se muestra el neto negativo.

`PATCH /sales/:saleId/commissions` requiere `{revision, commissions}` y clave de idempotencia. Permite agregar, quitar o cambiar comisionistas en una venta registrada usando sus importes originales. El cambio queda auditado y rechaza revisiones obsoletas. No repite consumo, ingreso ni venta y no modifica el total cobrado.

Las comisiones son importes registrados, no pagos: no generan retiros de cartera. El desembolso real se registra por separado en Movimientos. Las escrituras y consultas siguen los permisos del módulo Ventas. No hay migración de datos ni colecciones adicionales. Las ventas anteriores se interpretan con cero comisión y su ganancia original. La capacidad `saleCommissions=1` activa el formulario en despliegues compatibles.

### Compromisos de pago programados

`POST /commitments` crea un plan: `name`, `amountMinor`, `startOn`, `frequency` (`once`, `daily`, `weekly`, `monthly`, `yearly`), `interval` (1–120), `endOn` opcional, `category`, `paymentMethod` (`cash`, `card` para débito, `transfer`, `other`), `preferredWalletId` opcional y `notes`. El día inicial es el ancla: enero 31 → febrero 28/29 → marzo 31. No crea gastos, deudas ni cargos; no necesita cron ni escribe al consultar vencimientos.

`GET /commitments` y `/commitment-resolutions` son listas paginadas, también incluidas en snapshot e historial, con permisos de Finanzas. Los vencimientos se proyectan en memoria a partir del plan y sus resoluciones. La web muestra avisos dentro de Nexo para los pagos de hoy y vencidos del espacio seleccionado. No son notificaciones push ni órdenes bancarias.

`POST /commitments/:id/resolve` requiere `dueOn`, `decision` (`paid` o `cancelled`), `revision` e `Idempotency-Key`. Para pagar se exige `walletId`, con `amountMinor` real y `occurredOn` opcionales; para cancelar se exige `reason`. Solo se pueden confirmar vencimientos alcanzados, calculando hoy con la zona horaria del espacio. Confirmar crea un gasto en la cartera elegida, resolución y auditoría en una única transacción. Saldo insuficiente revierte todo. Repetir la clave devuelve el mismo resultado; confirmar con otra clave no duplica el gasto. Cancelar un vencimiento no afecta saldo ni pagos posteriores. Dejar pendiente no genera escritura.

`POST /commitments/:id/stop` con `{revision}` e idempotencia detiene nuevos vencimientos posteriores a hoy y conserva los anteriores, sus pagos y cancelaciones. Los widgets admiten `preset: "commitments"` y `commitmentStatus` (`unresolved`, `upcoming`, `pending`, `overdue`, `paid`, `cancelled`, `all`), además de fechas, categoría y carteras. Los planes no se mezclan con el flujo real; en Movimientos se pueden filtrar los gastos ya confirmados de compromisos.

### Abono general uniforme a una línea

`POST /credit-lines/:id/payments` admite `distribution: "uniform"`, junto con `walletId`, `amountMinor`, `description`, `revision` e `Idempotency-Key`. Divide el abono por igual entre compras con deuda pendiente, limita cada parte al saldo de esa compra y redistribuye el sobrante. Los centavos indivisibles se asignan en orden estable de vencimiento, creación e ID. Dentro de cada compra se conservan la prioridad de vencimientos y el pago de cargos antes de capital.

Un abono uniforme crea un solo movimiento de salida en la cartera y un `debtPayment` por compra beneficiada. El movimiento conserva `linePaymentId`, `creditLineId` y `allocations` (compra, pago, capital, cargos e importe) para consultar el reparto. Los registros individuales se enlazan mediante `linePaymentId`. El total, los saldos, el crédito disponible, los estados de cuenta y la auditoría se actualizan en una transacción. Saldo insuficiente revierte todos los efectos; la idempotencia y la revisión evitan duplicados concurrentes. La respuesta incluye `movement` y los pagos individuales. Sin `distribution`, o con `oldest`, se conserva el reparto anterior por vencimiento para clientes existentes.
