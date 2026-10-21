# Validación de entrega

Entorno: Node.js 24.19.0, MongoDB 8.0.16 real en replica set de un nodo, Wrangler 4.151.3 y su runtime local `workerd`.

| Comprobación | Resultado |
|---|---|
| `npm run check` | Sintaxis correcta en fuentes, scripts y pruebas |
| `npm run format:check` | Archivos verificados con Prettier |
| `npm run workers:build` | Bundle Workers generado con `wrangler deploy --dry-run` |
| `TEST_TMP_ROOT=/dev/shm npm run test:node` | 32/32 aprobadas |
| `TEST_TMP_ROOT=/dev/shm npm run test:workers` | 12/12 aprobadas |

La suite de Node incluye 27 pruebas de integración HTTP/Mongo y 5 de reglas de dominio. Cubre autenticación/revocación, aislamiento, roles y retiro de permisos, descuentos, idempotencia normal/concurrente, rollback, sobreventa concurrente, listas/campos dinámicos, revisiones, historial, conversión única de cotizaciones, crédito/pagos/reprogramación, cupo concurrente, servicios sin conteo, recursos internos, PATCH, egresos diferidos, proyectos, eventos y proyecciones.

La suite Workers incluye nueve pruebas que despachan solicitudes al runtime `workerd` con MongoDB real: arranque/CORS/límites de cuerpos, preparación de índices desde varios Durable Objects sobre una base nueva conservando datos existentes, scrypt/JWT/revocación/aislamiento, ventas/idempotencia/rollback/historial/auditoría, límite de login persistido en SQLite y ventas concurrentes sin sobreventa, campos de estado de cuenta y bloqueo de edición/eliminación con saldo o deuda. Otras dos pruebas verifican la redacción de secretos en logs y el rechazo de una base sin índices de consistencia. El catálogo de rutas se comparte con Express.

Wrangler puede emitir una advertencia de bundling sobre el export default del alias `whatwg-url`; la generación del bundle y las pruebas del driver real en Workerd permiten verificar el recorrido utilizado por esta aplicación. No se silenció la advertencia.

MongoDB temporal usa `/dev/shm` y `--nounixsocket` por restricciones del directorio/socket temporal de este entorno. Las conexiones son TCP y se ejecutan transacciones reales. Los tests no utilizan la base Atlas ni credenciales del usuario y eliminan sus bases aleatorias al terminar.

La comprobación del Atlas proporcionado no pudo completarse: la consulta DNS SRV devolvió `ECONNREFUSED` antes de autenticar. No se confirmó esa conexión ni se prepararon sus índices. Los valores recibidos se conservaron únicamente en archivos locales excluidos de Git y no se incorporan a documentación, bundle, código ni commits.

No se ejecutó Docker Compose (Docker no estaba instalado), no se publicó un Worker en una cuenta Cloudflare desde este entorno ni se realizaron pruebas de carga o una revisión externa de seguridad. La configuración de Cloudflare y sus secretos, el permiso de red de Atlas y la preparación de índices del destino deben verificarse al desplegar. La opción `MONGO_AUTO_MIGRATE=true` permite preparar una base nueva desde Workers y fue validada en el runtime local contra MongoDB real; no se confirmó su resultado en el Atlas del usuario. Ver `docs/CLOUDFLARE.md`.

La gestión de cuentas y líneas se prueba con saldo positivo/negativo, créditos vinculados, cargos pendientes de un centavo, liquidación completa, cambio de cupo, roles, revisión obsoleta, reintentos idempotentes, borrado lógico, conservación del historial y carreras contra ingresos/compras. Las validaciones y la actualización del agregado comparten la transacción.


La administración de espacios cubre propiedad exclusiva, aislamiento, edición parcial, revisiones, color/identidad, dependencias de módulos, desactivación/reactivación, compatibilidad con negocios antiguos y creación idempotente concurrente. Workerd también comprueba identidad/módulos. El dominio `https://api.nexo.aethel.ing` respondió 200 tanto en `/health/live` como en `/health/ready` y el preflight CORS devolvió 204 con el origen de la web permitido. No se utilizaron cuentas de producción para las pruebas de escritura; la integración completa se ejecutó con MongoDB temporal.

Movimientos de línea: se verificaron pagos repartidos entre deudas con distinto vencimiento, cargos/capital, cupo liberado, idempotencia, rollback completo, conflictos concurrentes, aislamiento, rol viewer y línea archivada. Workerd verifica el preflight del origen `https://nexo.aethel.ing` con configuración de producción, el rechazo de un origen parecido y el recorrido compra/abono con MongoDB real.
