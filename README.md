# Nexo · Backend modular

API REST en **JavaScript ESM / Node.js 24**, Express 5 y MongoDB. Incluye autenticación JWT Bearer con sesiones revocables, permisos por negocio y auditoría transaccional. Código organizado por módulos y puertos/adaptadores, con inyección de dependencias.

## Cloudflare Workers

También se incluye un despliegue para Workers con un adaptador Fetch/Hono y Durable Objects que reutilizan MongoDB. Comparte las mismas rutas y reglas del backend Node. Sigue [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) para preparar índices, configurar secretos y desplegar; todavía no hay un Worker productivo publicado.

```bash
npm ci
npm run db:migrate
npm run workers:build
# Después de configurar Cloudflare y sus secretos:
npm run workers:deploy
```

## Iniciar

Requisitos: Node.js 24, npm y Docker Compose, o un MongoDB Atlas/replica set accesible.

```bash
npm ci
npm run setup
# Crea .env con JWT_SECRET aleatorio; no reemplaza un .env existente.
docker compose up --build -d
```

La API estará en `http://localhost:3000`. Prueba `GET /health/ready`. Sigue los logs con `docker compose logs -f api`.

Para ejecutar Node fuera de Docker:

```bash
docker compose up -d mongo-init
npm run dev
```

`.env` ya contiene el URI para acceder al MongoDB local desde Node. El contenedor API lo reemplaza por el URI interno `mongo:27017`. `npm start` inicia sin recarga. `docker compose down` conserva datos en el volumen; `down -v` los elimina.

Para Atlas, reemplaza `MONGO_URI` y `MONGO_DB` en `.env` y ejecuta `npm start`. Debe ser un replica set o un clúster sharded con transacciones. Un `mongod` standalone se rechaza al arrancar. No se incluyen credenciales ni una base remota configurada.

El Compose es para desarrollo local: Mongo no usa usuarios y sus puertos se publican en loopback. Para alojarlo, configura Mongo con autenticación/TLS, un proxy HTTPS, `CORS_ORIGINS` con el origen real del frontend y `TRUST_PROXY_HOPS` según tu proxy. El limitador de login es local a cada instancia; en despliegues con varias réplicas, utiliza un adaptador compartido para rate limiting. Node se ejecuta con usuario sin privilegios en la imagen. Docker Compose no fue ejecutado en el entorno de entrega; las pruebas de integración usan un replica set real de MongoDB 8.

## Funcionalidades

- **Identidad:** registro, login, perfil y logout. Contraseñas con scrypt y sal aleatoria. JWT HS256 con algoritmo, emisor, audiencia y vencimiento verificados; la sesión se consulta en Mongo en cada solicitud. El logout invalida inmediatamente ese token para solicitudes posteriores. No hay refresh token ni recuperación de contraseña: al vencer, se inicia sesión de nuevo.
- **Negocios:** moneda y zona horaria, separación de datos, propietario y miembros con roles `editor` y `viewer`. El propietario incorpora usuarios que ya se registraron; no se envían invitaciones.
- **Finanzas:** carteras de efectivo/banco/tarjeta, saldo inicial, ingresos, egresos, transferencias y resumen. Una tarjeta funciona como cartera; el cupo prestado se representa por separado mediante líneas de crédito.
- **Inventario flexible:** listas con nombre y campos configurables para productos, equipos, materiales o servicios. Conteo opcional, artículos vendibles o internos, cantidades fraccionarias, precios, costos y movimientos de existencias.
- **Contactos:** listas genéricas, pertenencia a varias listas, nombre, teléfono, correo, ocupación, ubicación, enlaces, notas, favoritos y campos dinámicos.
- **Ventas:** múltiples líneas, servicios libres, descuentos fijos o porcentuales, motivo del descuento, descripción y costos guardados como snapshot.
- **Cotizaciones:** borrador, envío, aceptación, cancelación y conversión única a venta. Vista para cliente sin costo ni ganancia interna, autenticada. No envía mensajes ni genera enlaces públicos.
- **Planeación:** proyectos con tareas, calendario con eventos propios y fechas derivadas, escenarios de proyección con inversión, ingresos, costos, descuentos, comisiones, utilidad, ROI, recuperación y equilibrio.
- **Créditos y gastos diferidos:** líneas de crédito, disposiciones, cuotas, pagos parciales y reprogramación del pendiente con capital mensual o al final (`balloon`).
- **Historial:** reconstrucción de entidades a una fecha registrada y consulta paginada de auditoría.

## Diseño

```text
src/
  modules/             Reglas y casos de uso de cada dominio
    auth/ businesses/ finance/ inventory/ contacts/ sales/ planning/ debts/
  core/                Errores, validación, dinero, contratos, ejecución de comandos
  adapters/
    mongo/             Unidad de trabajo, identidad, consultas, auditoría, índices
    modules/           Puentes entre finanzas, inventario, contactos y ventas
    logger.js          Pino con redacción de secretos
  http/routes.js       Catálogo de rutas compartido
  http/app.js          Adaptador Express (Node)
  http/fetch-app.js    Adaptador Fetch/Hono (Workers)
  workers/             Entrada Worker, Durable Object y límite persistente de acceso
  container.js         Composition root: conecta implementaciones con sus puertos
  config.js            Variables de entorno validadas
  server.js            Arranque y cierre ordenado
```

Los módulos no importan el driver de MongoDB, Express ni Hono. Reciben dependencias desde `container.js`. `core/ports.js` describe los contratos. Para cambiar un proveedor de persistencia, implementa sus puertos y conéctalo en el contenedor. Los filtros y agregaciones de lectura viven en `adapters/mongo/queries.js`.

Una venta usa `InventoryPort`, `FinancePort` y `ContactsPort`. Las cotizaciones convierten a venta mediante `SalesPort`. Estos adaptadores comparten la misma unidad de trabajo; no hay llamadas HTTP internas. Así, la comunicación es explícita y se puede sustituir un módulo sin acoplarlo a otro repositorio.

## Consistencia y auditoría

Todos los comandos del negocio se ejecutan en una transacción MongoDB que incluye documentos, movimientos, auditoría y respuesta idempotente. Si falla una parte, se revierte todo. Las transacciones pueden reintentarse; no se envían correos ni se hacen llamadas externas dentro de ellas.

No se permite asignar `balanceMinor` o `stockMilli` con un PATCH. Se usan asientos y ajustes de inventario con motivo. Cada cambio persiste en `audit`: negocio, actor, acción, entidad, versión anterior y posterior, fecha, orden y `requestId`. No hay endpoint para editar/eliminar auditoría. `securityEvents` registra registro/login/logout sin contraseñas ni tokens. Esto es auditoría de aplicación: un administrador con permisos de escritura en la base podría alterarla. Para garantías contra manipulación administrativa, conecta un almacén externo inmutable.

Los logs HTTP en stdout incluyen método, ruta, estado, duración y `requestId`; no incluyen cuerpos, query strings, contraseñas ni encabezados de autorización. Conecta stdout a tu sistema de logs. `GET /audit` permite consultar los cambios persistidos por negocio.

Cada entidad tiene `revision`. Las ediciones requieren la versión leída; una versión antigua produce `409 REVISION_CONFLICT`. Las transacciones y escrituras del agregado protegen stock, saldo y cupo ante concurrencia.

Los movimientos financieros críticos exigen `Idempotency-Key`. Conserva la misma clave para reintentar una operación cuyo resultado se desconoce. La misma clave con diferente operación, usuario o contenido produce `409`. La respuesta se conserva sin TTL para evitar duplicados tardíos; define una política de retención si el volumen lo requiere.

## Convenciones numéricas y temporales

- Una moneda por negocio; sin conversión de divisas. Se asume una moneda de dos decimales.
- Dinero en **unidades menores enteras**: `150050` representa `1,500.50`. No envíes `1500.50`.
- Cantidades en **milésimas enteras**: `1500` representa `1.5` unidades.
- Descuentos porcentuales en **puntos base**: `1000` representa `10 %`; `10000`, `100 %`. Un descuento fijo usa unidades menores.
- Fechas civiles `YYYY-MM-DD`; timestamps ISO 8601 con zona. El redondeo de importes es al centavo, mitades hacia arriba, por línea. No hay impuestos, tipos de cambio ni contabilidad fiscal incluidos.
- Para cuotas mensuales se conserva el día original y se ajusta al último día del mes cuando corresponde.
- El calendario usa fechas civiles; el frontend debe construir el corte diario en la zona IANA del negocio y enviarlo en `at` con su offset. Las comprobaciones de vencimiento y fecha máxima de movimientos usan fecha UTC.

`GET /history?collection=wallets&at=...` reconstruye lo que la aplicación había registrado hasta ese instante mediante snapshots auditados. Es de solo lectura. No inventa el pasado anterior a la creación/importación de los datos ni interpreta un `occurredOn` retroactivo como un cambio registrado en el pasado. El corte usa `recordedAt`, no la hora exacta de commit del servidor. Para una pantalla histórica completa consulta cada colección con el mismo `at` y recorre sus páginas. El encabezado `X-History-At` bloquea comandos cuando el frontend está en modo historial; las consultas normales GET siguen devolviendo el presente.

En créditos, el dinero recibido no cuenta como ingreso operativo; devolver capital no es gasto operativo y las comisiones sí lo son. En gastos diferidos, no hay salida inicial y cada pago se cuenta como egreso operativo una sola vez, bajo criterio de caja. La compra diferida no incrementa inventario automáticamente: registra el ajuste de entrada correspondiente. El resumen operativo es flujo de caja y no un estado contable ni utilidad por devengo. Las ventas sí calculan su utilidad con el costo del snapshot. Transferencias y saldos iniciales no cuentan como resultado operativo.

La comisión de una deuda es un importe total acordado, no una tasa de interés calculada. Los pagos se aplican a la cuota más antigua, primero su comisión y después capital. Reprogramar conserva lo pagado, distribuye solo lo pendiente y puede agregar una comisión explícita. Los calendarios anteriores permanecen en auditoría. El cupo utilizado incluye capital y comisiones pendientes; no se suma al efectivo disponible.

## Uso de la API y frontend

Lee [docs/API.md](docs/API.md) y abre [docs/requests.http](docs/requests.http) para probar el recorrido registro → negocio → cartera → artículo → venta. Todas las rutas de negocio están bajo `/api/v1/businesses/:businessId`.

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
Idempotency-Key: 985e9567-5b52-43fd-b731-85d158e8b0fa
```

`docs/frontend-adapter.js` ofrece un adaptador fetch sin framework para conectar la interfaz. Mantiene el token en memoria y evita persistirlo en localStorage. El backend se entrega como proyecto separado: la vista previa existente todavía utiliza sus datos locales. Para conectarla se debe reemplazar su adaptador de persistencia, registrar usuarios y migrar o importar los datos que se quieran conservar. No se migró ni publicó nada automáticamente.

## Verificación

```bash
npm run check
npm run format:check
npm test
```

Las pruebas de Node y de Workers levantan temporalmente un **MongoDB 8.0.16 replica set real** mediante `mongodb-memory-server`; la primera ejecución descarga el binario. No usan un mock de Mongo. Para una base de pruebas propia: `TEST_MONGO_URI='mongodb://...' npm run test:node`; se crea una base aleatoria y se elimina al terminar. Nunca apuntes pruebas al nombre de una base productiva mediante cambios al harness.

Si el sistema de archivos temporal no soporta el bloqueo que necesita MongoDB, selecciona un directorio compatible con `TEST_TMP_ROOT=/ruta npm test`. En el entorno de entrega se usó `/dev/shm`. Se deshabilita el socket Unix en el Mongo de prueba; la conexión se hace por TCP local.

Las pruebas cubren autenticación/revocación, aislamiento y roles, descuentos, idempotencia, venta atómica/rollback, sobreventa concurrente, validación dinámica, revisión, historial, conversión única de cotizaciones, pagos/reprogramación y límites concurrentes de crédito. Consulta `docs/VALIDACION.md` para los resultados y límites de la verificación.

Documentación técnica consultada: [transacciones del driver oficial MongoDB](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/), [Express 5](https://expressjs.com/en/api/) y [jose jwtVerify](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).
