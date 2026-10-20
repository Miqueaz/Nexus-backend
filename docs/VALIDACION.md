# Validación de entrega

Ejecutado sobre Node.js 24.19.0 y un MongoDB 8.0.16 real, temporal, configurado como replica set de un nodo.

| Comprobación | Resultado |
|---|---|
| `npm run check` | Sintaxis correcta en fuentes, scripts y pruebas |
| `npm run format:check` | Todos los archivos verificados pasan Prettier |
| `TEST_TMP_ROOT=/dev/shm npm test` | **21/21 aprobadas**, 0 omitidas, 0 fallidas |

Las 21 pruebas se dividen en 16 de integración HTTP/MongoDB y 5 de reglas de dominio. Se verificaron autenticación y revocación, separación de negocios, roles y retiro de permisos, venta con descuento, idempotencia normal y concurrente, rollback de venta, prevención de sobreventa concurrente, validación de listas/campos, revisiones, snapshots históricos, conversión única de cotización, crédito/pagos/reprogramación, cupo concurrente, artículos sin conteo, recursos internos, preservación de campos en PATCH, egresos diferidos, rollback de pagos, proyectos, eventos, proyecciones y ausencia de secretos en eventos de seguridad.

Las pruebas se ejecutaron usando el almacenamiento temporal `/dev/shm` y deshabilitando el socket Unix del proceso MongoDB, por restricciones del directorio/socket temporal del entorno. La API se conectó por TCP y ejecutó transacciones reales con rollback y conflictos de escritura.

No se ejecutó Docker Compose porque Docker no estaba instalado. Los archivos Docker/Compose se entregan como configuración de desarrollo. No se realizó despliegue, conexión a una cuenta MongoDB remota, migración del frontend, pruebas de carga ni una revisión de seguridad externa. El frontend existente todavía debe conectarse mediante su adaptador de persistencia; se incluye un adaptador fetch de ejemplo.
