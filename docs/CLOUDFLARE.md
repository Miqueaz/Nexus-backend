# Desplegar Nexis Backend en Cloudflare Workers

El repositorio soporta dos entradas: `src/server.js` para Express en Node/Docker, y `src/workers/index.js` para Workers. Ambos usan el mismo catálogo de rutas y los mismos servicios, validaciones, adaptadores de MongoDB y transacciones.

## Arquitectura

El Worker recibe la solicitud y la dirige a `BusinessApi`, un Durable Object. El objeto atiende HTTP mediante el adaptador Fetch/Hono y conserva la conexión MongoDB durante su vida. El pool usa máximo una conexión de operaciones por servidor, monitoreo por polling y conexión gradual para acotar el uso de sockets. No se ejecuta un servidor TCP/Express dentro de Workers. No se necesita reescribir las reglas de negocio.

Las rutas de identidad y listado/creación de negocios comparten un objeto `identity-v1`. Las rutas de cada negocio se distribuyen entre 16 objetos por el primer dígito de su UUID. Todos usan la misma base de datos; los permisos y filtros por negocio siguen comprobándose en MongoDB. Es partición de conexiones, no de datos. No cambies arbitrariamente estos nombres en producción: el contador de intentos de identidad reside en su almacenamiento.

El cliente MongoDB se crea/importa dentro de la primera solicitud y se reutiliza en el objeto. La inicialización fallida se puede reintentar; los errores de conexión producen 503 sin revelar el URI. Las conexiones pueden desaparecer al desalojarse el DO; no se asume que sean permanentes. No se devuelven objetos MongoClient/Db por RPC.

## Requisitos

- Node.js 24 y las dependencias de `npm ci` para compilar y administrar.
- Cuenta de Cloudflare con Workers y Durable Objects habilitados.
- La configuración incluye `limits.cpu_ms: 30000`: usa un plan que admita ese límite (Workers Paid). El hashing scrypt mantiene su costo criptográfico; no se debilitó para intentar encajar en el presupuesto de CPU del plan gratuito. La facturación y el rendimiento final deben revisarse en tu cuenta antes del despliegue.
- MongoDB Atlas o un replica set accesible desde Cloudflare, con TLS, usuario y permisos de lectura/escritura para la aplicación. Un MongoDB en localhost no es accesible desde un Worker desplegado.
- Configurar las reglas de red de la base para permitir las conexiones desde tu despliegue. Workers no proporciona una IP de egreso fija por defecto; no confíes en la IP de tu computadora como permiso del servidor. Define la conectividad adecuada para tu entorno.

## Preparar MongoDB una vez

Configura el `.env` local con `MONGO_URI` y `MONGO_DB` del destino. Usa el mismo nombre de base en `wrangler.jsonc`.

```bash
npm ci
npm run setup
# Editar .env con el URI de MongoDB del destino.
npm run db:migrate
```

`db:migrate` crea colecciones e índices de forma idempotente. Ejecútalo antes de la primera puesta en servicio y al agregar índices en versiones posteriores. Workers no ejecuta esta preparación por solicitud. Al abrir la conexión comprueba los índices únicos críticos; si faltan, devuelve `503 DATABASE_NOT_PREPARED`. El usuario utilizado para la migración necesita permisos de creación de índices/colecciones; la aplicación necesita los permisos de sus operaciones normales.

## Configurar Cloudflare

Edita `wrangler.jsonc`:

- `name`: nombre del Worker, por defecto `nexis-backend`.
- `vars.MONGO_DB`: misma base preparada en el paso anterior.
- `vars.CORS_ORIGINS`: origen real del frontend, o varios separados por comas.
- `vars.JWT_ISSUER` y `vars.JWT_AUDIENCE`: deben coincidir si quieres conservar la validez de tokens emitidos por otro despliegue.
- Conserva `nodejs_compat`, la declaración de `BusinessApi` y su migración SQLite.

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

`.dev.vars` debe incluir un JWT_SECRET aleatorio válido, sin el texto REEMPLAZAR. Puedes usar el mismo del `.env` local. Wrangler emula el DO y su SQLite localmente. El Compose de MongoDB sigue siendo útil para Node y para el desarrollo local, pero no se ejecuta en la plataforma Workers.

Para verificar toda la aplicación:

```bash
npm run check
npm run format:check
npm run workers:build
npm test
```

La suite Workers usa el test harness oficial de Wrangler sobre `workerd` y un replica set MongoDB temporal. No necesita cuenta de Cloudflare ni secretos productivos. Si tu directorio temporal no soporta los archivos de Mongo, usa `TEST_TMP_ROOT=/ruta/compatible npm test`.

## Seguridad, límites y observabilidad

- Bearer JWT, scrypt, validación de permisos e historial son los mismos en ambos entornos.
- El logger Workers emite JSON estructurado hacia Workers Logs. Redacta secretos y no registra cuerpos ni query strings. La auditoría de movimientos sigue escribiéndose en Mongo dentro de la misma transacción.
- El límite de login/registro es de 15 intentos por IP por ventana fija de 15 minutos. Se persiste en SQLite del objeto de identidad, compartido entre ambos endpoints y conservado ante desalojos normales del DO. Las IP se almacenan como SHA-256, no en texto. Las filas expiradas se eliminan cuando llega el siguiente intento. El origen de IP es `CF-Connecting-IP`, proporcionado por Cloudflare; en Node se conserva el limitador Express.
- El estado durable de SQLite solo contiene contadores de acceso. Los negocios, usuarios, sesiones, dinero, inventario y auditoría permanecen en MongoDB.
- Conserva las claves de idempotencia en los reintentos. Una desconexión no demuestra que una transacción haya fallado.
- Las consultas de historial y calendarios que lean muchos datos deben evaluarse con volumen real. Las pruebas funcionales no sustituyen pruebas de carga, latencia de Atlas ni facturación.

Referencias oficiales: [MongoDB en Workers](https://developers.cloudflare.com/workers/databases/third-party-integrations/mongodb/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), [Wrangler test harness](https://developers.cloudflare.com/workers/wrangler/api/).
