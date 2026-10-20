export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export function ensure(condition, status, code, message) {
  if (!condition) throw new AppError(status, code, message);
}
export const missing = () => new AppError(404, 'NOT_FOUND', 'Registro no encontrado');
