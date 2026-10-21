import { ZodError } from 'zod';
import { id } from '../core/validation.js';
import { AppError, ensure } from '../core/errors.js';
export async function authorizeRoute(route, req, services) {
  const context = { requestId: req.requestId, key: req.headers['idempotency-key'] };
  if (!route.public)
    Object.assign(context, await services.auth.authenticate(req.headers.authorization));
  if (route.business) {
    id.parse(req.params.businessId);
    context.businessId = req.params.businessId;
    context.key = req.headers['idempotency-key'];
    ensure(
      !req.headers['x-history-at'] || ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()),
      409,
      'READ_ONLY_HISTORY',
      'El historial es de solo lectura',
    );
  }
  if (route.idempotent)
    ensure(
      context.key,
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Incluye una Idempotency-Key única por operación',
    );
  return context;
}
export function errorResponse(err, requestId, logger) {
  let status = err.status ?? 500,
    code = err.code ?? 'INTERNAL_ERROR',
    message = err.message,
    details;
  if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Datos inválidos';
    details = err.issues.map(({ path, message }) => ({ path, message }));
  } else if (err.code === 11000) {
    status = 409;
    code = 'DUPLICATE';
    message = 'Ya existe un registro con esa clave';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'JSON inválido';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'BODY_TOO_LARGE';
    message = 'Solicitud demasiado grande';
  } else if (!(err instanceof AppError)) {
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Error interno';
    logger.error({ requestId, errorType: err.name }, 'request.failed');
  }
  return { status, body: { error: { code, message, ...(details ? { details } : {}), requestId } } };
}
