# API v1

Base: `http://localhost:3000/api/v1`. JSON. Los ejemplos usan IDs UUID de las respuestas `_id`.

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
| POST `/businesses` | `{name,currency:"MXN",timezone:"America/Mexico_City"}`; timezone opcional |

## Negocio

En las tablas siguientes, todas las rutas tienen el prefijo **`/businesses/:businessId`**.

`owner` y `editor` pueden escribir. `viewer` puede leer y calcular proyecciones. Solo `owner` puede editar el negocio o gestionar miembros. Un negocio ajeno devuelve 404. No se pueden transferir operaciones de dinero ni recursos entre negocios.

| Método y ruta | Entrada / descripción |
|---|---|
| PATCH `/` | `{name,revision}`; propietario |
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
| PATCH `/wallets/:id` | `{name?,archived?,revision}` |
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
| POST `/credit-lines` | `{name,limitMinor,notes?}` |
| GET `/credit-lines/balances` | Lista con cupo usado y disponible |
| POST `/debts` ★ | Ejemplo inferior |
| POST `/debts/:id/payments` ★ | `{walletId,amountMinor,description?,revision}`; devuelve `{debt,payment}` |
| POST `/debts/:id/reschedule` ★ | `{terms,firstDueOn,mode,additionalFeeMinor?:0,reason,revision}` |

```json
{
  "name":"Compra de equipo", "kind":"deferred", "principalMinor":120000,
  "feeMinor":6000, "terms":6, "firstDueOn":"2027-01-31", "mode":"monthly",
  "creditLineId":"UUID_LINEA_OPCIONAL", "contactId":"UUID_CONTACTO_OPCIONAL", "notes":""
}
```

`kind:"credit"` requiere `walletId` y deposita el principal en esa cartera. `deferred` registra obligación sin salida inicial. Omitir las propiedades UUID opcionales si no se usan. `terms`: 1–120; `mode`: `monthly` o `balloon` (capital al final). `feeMinor` es comisión total fija; no una tasa. Estado automático `active` → `settled`. No hay pagos mayores que lo pendiente ni cambios de pagos confirmados. Reprogramar solo afecta lo pendiente y conserva snapshots previos en auditoría. El cupo incluye comisiones. La línea se crea con cupo fijo: no hay endpoint para alterarlo en esta versión.

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
