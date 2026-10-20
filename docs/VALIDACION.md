# Validación de entrega

Entorno: Node.js 24.19.0, MongoDB 8.0.16 real en replica set de un nodo, Wrangler 4.151.3 y su runtime local `workerd`.

| Comprobación | Resultado |
|---|---|
| `npm run check` | Sintaxis correcta en fuentes, scripts y pruebas |
| `npm run format:check` | Archivos verificados con Prettier |
| `npm run workers:build` | Bundle Workers generado con `wrangler deploy --dry-run` |
| `TEST_TMP_ROOT=/dev/shm npm run test:node` | 21/21 aprobadas |
| `TEST_TMP_ROOT=/dev/shm npm run test:workers` | 7/7 aprobadas |

La suite de Node incluye 16 pruebas de integración HTTP/Mongo y 5 de reglas de dominio. Cubre autenticación/revocación, aislamiento, roles y retiro de permisos, descuentos, idempotencia normal/concurrente, rollback, sobreventa concurrente, listas/campos dinámicos, revisiones, historial, conversión única de cotizaciones, crédito/pagos/reprogramación, cupo concurrente, servicios sin conteo, recursos internos, PATCH, egresos diferidos, proyectos, eventos y proyecciones.

La suite Workers incluye cinco pruebas que despachan solicitudes al runtime `workerd` con MongoDB real: arranque/CORS/límites de cuerpos, scrypt/JWT/revocación/aislamiento, ventas/idempotencia/rollback/historial/auditoría, límite de login persistido en SQLite de un Durable Object y ventas concurrentes sin sobreventa. Otras dos pruebas verifican la redacción de secretos en logs y el rechazo de una base sin índices de consistencia. El catálogo de rutas se comparte con Express.

Wrangler puede emitir una advertencia de bundling sobre el export default del alias `whatwg-url`; la generación del bundle y las pruebas del driver real en Workerd permiten verificar el recorrido utilizado por esta aplicación. No se silenció la advertencia.

MongoDB temporal usa `/dev/shm` y `--nounixsocket` por restricciones del directorio/socket temporal de este entorno. Las conexiones son TCP y se ejecutan transacciones reales. Los tests no utilizan la base Atlas ni credenciales del usuario y eliminan sus bases aleatorias al terminar.

La comprobación del Atlas proporcionado no pudo completarse: la consulta DNS SRV devolvió `ECONNREFUSED` antes de autenticar. No se confirmó esa conexión ni se prepararon sus índices. Los valores recibidos se conservaron únicamente en archivos locales excluidos de Git y no se incorporan a documentación, bundle, código ni commits.

No se ejecutó Docker Compose (Docker no estaba instalado), no se publicó un Worker en una cuenta Cloudflare, no se migró el frontend ni se realizaron pruebas de carga o una revisión externa de seguridad. La configuración de Cloudflare y sus secretos, el permiso de red de Atlas y la migración de índices del destino deben completarse al desplegar. Ver `docs/CLOUDFLARE.md`.
