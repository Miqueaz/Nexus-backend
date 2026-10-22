# Desplegar Nexis Backend en Cloudflare Workers

El repositorio soporta dos entradas: `src/server.js` para Express en Node/Docker, y `src/workers/index.js` para Workers. Ambos usan el mismo catálogo de rutas y los mismos servicios, validaciones, adaptadores de MongoDB y transacciones.

## Arquitectura

El modo predeterminado `API_RUNTIME=direct` atiende cada solicitud directamente en el Worker mediante Fetch/Hono. Cada invocación crea su propio MongoClient de forma diferida, lo reutiliza solo dentro de esa solicitud y espera su cierre en finally. No comparte sockets, Db ni Collection entre contextos Workers y no envía solicitudes a Durable Objects.

El pool tiene máximo una conexión de operaciones por servidor, monitoreo por polling y conexión gradual. Salud superficial, CORS y rutas que no necesitan servicios no abren MongoDB. Las rutas de negocio, tokens Bearer, sesiones, permisos, idempotencia, transacciones y auditoría conservan el mismo contrato que Express/Node.

Los contadores de acceso se guardan en `authRateLimits` de MongoDB. El identificador combina la ventana fija de 15 minutos y SHA-256 de la IP proporcionada por Cloudflare. Un findOneAndUpdate atómico con _id único incrementa el contador entre invocaciones y ubicaciones del Worker; un índice TTL sobre expiresAt limpia las ventanas vencidas. El vencimiento lógico depende de la ventana, no de que el limpiador TTL haya borrado una fila. Se mantienen los 15 intentos compartidos por IP entre los endpoints limitados y las respuestas 429/Retry-After. Una falla del contador impide continuar con la autenticación.

La clase BusinessApi, su binding y la migración v1 se conservan para compatibilidad y reversión. En modo direct no se invocan, incluso si la cuota DO está agotada. No se borran sus datos SQLite; las ventanas anteriores expiran a los 15 minutos y los nuevos contadores comienzan en MongoDB al cambiar de modo. Solo `API_RUNTIME=durable-object` habilita explícitamente el adaptador anterior.

El servicio de autenticación usa una comparación scrypt de igual costo para usuarios inexistentes, pero ya no calcula un hash adicional al preparar cada servicio. Las contraseñas existentes, sus parámetros criptográficos, las sesiones y las claves JWT permanecen compatibles.

## Requisitos

- Node.js 24 y las dependencias de `npm ci` para compilar y administrar.
- Cuenta de Cloudflare con Workers y Durable Objects habilitados.
- Se usan los límites predeterminados de Cloudflare, sin configurar `limits.cpu_ms`, que puede impedir el despliegue en el plan gratuito. Los Durable Objects con SQLite están disponibles tanto en Workers Free como en Paid y tienen 30 segundos de CPU por solicitud de forma predeterminada. En modo direct la autenticación y los servicios se ejecutan en el Worker normal, que en Free tiene 10 ms de CPU por solicitud. Hay que comprobar en producción el costo de scrypt y de las operaciones; las pruebas locales no reproducen el medidor de CPU del plan. Retirar los DO elimina su cuota de duración, pero no elimina los límites de Workers o Atlas. El hashing scrypt conserva su costo criptográfico. Revisa las cuotas y el rendimiento con tu carga real; no se ha validado un despliegue en una cuenta Free.
- MongoDB Atlas o un replica set accesible desde Cloudflare, con TLS, usuario y permisos de lectura/escritura para la aplicación. Un MongoDB en localhost no es accesible desde un Worker desplegado.
- Configurar las reglas de red de la base para permitir las conexiones desde tu despliegue. Workers no proporciona una IP de egreso fija por defecto; no confíes en la IP de tu computadora como permiso del servidor. Define la conectividad adecuada para tu entorno.

## Preparar MongoDB

La configuración del repositorio incluye `vars.MONGO_AUTO_MIGRATE: "true"`. Al abrir su conexión, cada conexión comprueba los índices únicos críticos. Si faltan, crea las colecciones e índices con el mismo procedimiento idempotente de `db:migrate` y vuelve a validarlos antes de permitir operaciones. No borra documentos, colecciones ni índices existentes. Las conexiones que ya encuentran la base preparada solo comprueban sus restricciones; no repiten la creación de índices.

Con esta opción basta configurar los secretos, desplegar y abrir `GET /health/ready` desde la app o el navegador. La primera consulta puede tardar más mientras prepara la base. El usuario MongoDB debe tener permisos para crear colecciones e índices. Si encuentra duplicados o una definición incompatible, el arranque falla y no comienza a servir operaciones sobre una base sin las restricciones requeridas.

Para separar los permisos de migración de los de la aplicación, usa `MONGO_AUTO_MIGRATE: "false"` y prepara la base con el comando de Node. La opción se interpreta como texto `true` o `false`; fuera de la configuración de Wrangler, su valor predeterminado es `false`.

### Migración manual o cambios posteriores de índices

Configura el `.env` local con `MONGO_URI` y `MONGO_DB` del destino. Usa el mismo nombre de base en `wrangler.jsonc`.

```bash
npm ci
npm run setup
# Editar .env con el URI de MongoDB del destino.
npm run db:migrate
```

`db:migrate` crea colecciones e índices de forma idempotente. Ejecútalo antes de la primera puesta en servicio si desactivaste la preparación automática, y al agregar índices secundarios o TTL en versiones posteriores: la comprobación automática solo detecta la ausencia de las restricciones críticas. Con la preparación automática desactivada, los índices críticos ausentes producen `503 DATABASE_NOT_PREPARED`. El usuario utilizado para la migración necesita permisos de creación de índices/colecciones; la aplicación necesita los permisos de sus operaciones normales.

## Configurar Cloudflare

Edita `wrangler.jsonc`:

- `name`: nombre del Worker, por defecto `nexis-backend`.
- `vars.MONGO_DB`: nombre de la base que se utilizará (por ejemplo, `nexo`), nunca el URI de conexión.
- `vars.MONGO_AUTO_MIGRATE`: `"true"` permite preparar una base nueva al conectarse; `"false"` exige la migración manual previa.
- `vars.CORS_ORIGINS`: origen real del frontend, o varios separados por comas.
- `vars.JWT_ISSUER` y `vars.JWT_AUDIENCE`: deben coincidir si quieres conservar la validez de tokens emitidos por otro despliegue.
- Conserva `nodejs_compat`. `vars.API_RUNTIME: "direct"` evita el uso de DO. La declaración histórica de `BusinessApi` y la migración SQLite se mantienen para una reversión sin borrar datos.

Autentícate y registra los secretos desde tu terminal:

```bash
npx wrangler login
npx wrangler secret put MONGO_URI
npx wrangler secret put JWT_SECRET
```

Los comandos solicitan los valores de forma interactiva. Usa la misma clave JWT del backend Node si ambos comparten sesiones y tokens; usa otra clave si quieres separar los entornos. `npm run secret` genera una clave aleatoria nueva. No guardes las claves en el repositorio, `vars` ni mensajes de commit.

```bash
npm run workers:build
npm run workers:deploy
```

`workers:build` valida y genera el bundle sin publicar. `workers:deploy` publica en tu cuenta y aplica la migración declarada del Durable Object. La URL real se muestra al desplegar; no hay una URL de producción creada por esta entrega.

Si el despliegue termina con `A request to the Cloudflare API (...) failed`, consulta las líneas siguientes del registro: contienen el motivo y, normalmente, un código `[code: ...]`. Ese encabezado por sí solo no identifica la causa. Si aparece el código `100328` indicando que los límites de CPU no están disponibles en Free, verifica que estés desplegando la versión actual sin `limits.cpu_ms`.

Verifica en esa URL:

```text
GET /health/live
GET /health/ready
POST /api/v1/auth/register
```

En el frontend cambia `baseUrl` por la URL del Worker terminada en `/api/v1`. Los endpoints y cuerpos de `docs/API.md` se mantienen.

## Desarrollo local

```bash
cp .dev.vars.example .dev.vars
# Configurar MONGO_URI y JWT_SECRET en .dev.vars.
npm run workers:dev
```

`.dev.vars` debe incluir un JWT_SECRET aleatorio válido, sin el texto REEMPLAZAR. Puedes usar el mismo del `.env` local. Wrangler ejecuta el Worker directo localmente; el binding DO histórico no se utiliza. El Compose de MongoDB sigue siendo útil para Node y para el desarrollo local, pero no se ejecuta en la plataforma Workers.

Para verificar toda la aplicación:

```bash
npm run check
npm run format:check
npm run workers:build
npm test
```

La suite Workers usa el test harness oficial de Wrangler sobre `workerd`, sin bindings ni namespaces DO, y un replica set MongoDB temporal. No necesita cuenta de Cloudflare ni secretos productivos. Si tu directorio temporal no soporta los archivos de Mongo, usa `TEST_TMP_ROOT=/ruta/compatible npm test`.

## Seguridad, límites y observabilidad

- Bearer JWT, scrypt, validación de permisos e historial son los mismos en ambos entornos.
- El logger Workers emite JSON estructurado hacia Workers Logs. Redacta secretos y no registra cuerpos ni query strings. La auditoría de movimientos sigue escribiéndose en Mongo dentro de la misma transacción.
- El límite de login/registro es de 15 intentos por IP por ventana fija de 15 minutos. En el Worker directo se persiste en authRateLimits de MongoDB, compartido entre invocaciones. Las IP se almacenan como SHA-256. TTL limpia las filas expiradas. El origen de IP es CF-Connecting-IP, proporcionado por Cloudflare; en Node se conserva el limitador Express.
- En modo direct, tanto los contadores como los negocios, usuarios, sesiones, dinero, inventario y auditoría permanecen en MongoDB. El SQLite histórico queda inactivo.
- Conserva las claves de idempotencia en los reintentos. Una desconexión no demuestra que una transacción haya fallado.
- Las consultas de historial y calendarios que lean muchos datos deben evaluarse con volumen real. Las pruebas funcionales no sustituyen pruebas de carga, latencia de Atlas ni facturación.

Referencias oficiales: [MongoDB en Workers](https://developers.cloudflare.com/workers/databases/third-party-integrations/mongodb/), [límites de Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/), [configuración de límites de Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/#limits), [Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), [Wrangler test harness](https://developers.cloudflare.com/workers/wrangler/api/).


El dominio de producción `api.nexo.aethel.ing` está declarado en `routes` como `custom_domain: true`; Wrangler lo enlaza al mismo Worker al desplegar en la cuenta que administra la zona `aethel.ing`. `workers_dev` sigue habilitado para conservar el alias existente. Los clientes usan `https://api.nexo.aethel.ing`; CORS debe contener el origen de la web, no la URL de la API. Los secretos y la base MongoDB no cambian por este cambio de dominio.

`CORS_ORIGINS` incluye `https://nexo.aethel.ing`. Configúralo como origen exacto sin la barra final de la URL. El preflight permite Authorization, Content-Type e Idempotency-Key. Si mantienes una variable equivalente en un entorno distinto o en una instalación Node, agrega allí el mismo origen.

## Cuota de duración y cambio al Worker directo

`Exceeded allowed duration in Durable Objects free tier.` indica que la cuenta agotó la cuota diaria de duración DO. El modo direct no invoca DO y permite atender solicitudes sin depender de esa cuota. No reinicia ni altera las cuotas consumidas, el plan ni la facturación.

El adaptador histórico durable-object cierra sus conexiones al terminar las solicitudes activas para evitar gasto en reposo. Free incluye 13,000 GB-s diarios DO y se reinicia a las 00:00 UTC. Las conexiones salientes abiertas y timers impiden hibernar. Esas reglas siguen aplicando si se vuelve a habilitar el adaptador histórico.

En modo direct hay que considerar otros límites: CPU, solicitudes y conexiones de Workers; operaciones y conexiones de Atlas. Abrir conexiones por solicitud añade latencia. No reduzcas el costo criptográfico para ocultar errores de CPU. Si una carga excede Free, se necesita un plan o entorno adecuado. El harness local comprueba funcionamiento, aislamiento, cierre de conexiones y concurrencia; no garantiza caber en cuotas productivas.

Referencias: [conexión MongoDB directa](https://developers.cloudflare.com/workers/databases/third-party-integrations/mongodb/), [límites Workers](https://developers.cloudflare.com/workers/platform/limits/), [precios DO](https://developers.cloudflare.com/durable-objects/platform/pricing/), [hibernación](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
