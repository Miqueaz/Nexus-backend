import { z, text, notes, money, amount, date, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';

// Datos del estado de cuenta. null significa que el usuario aún no los ha capturado.
const statementFields = {
  statementCutoffOn: date.nullable().default(null),
  paymentDueOn: date.nullable().default(null),
  minimumPaymentMinor: money.nullable().default(null),
  interestFreePaymentMinor: money.nullable().default(null),
  annualInterestBps: z.number().int().min(0).max(100_000).nullable().default(null),
};

export const creditLineCreateSchema = z.strictObject({
  name: text,
  limitMinor: amount,
  notes,
  ...statementFields,
});

// El cupo sigue siendo fijo; editar metadatos nunca cambia deudas ni saldos.
export const creditLineUpdateSchema = z
  .strictObject({ name: text, notes, ...statementFields })
  .partial()
  .extend({ revision });

export function assertStatementDates(line) {
  ensure(
    !line.statementCutoffOn || !line.paymentDueOn || line.paymentDueOn >= line.statementCutoffOn,
    422,
    'INVALID_STATEMENT_DATES',
    'La fecha límite de pago no puede ser anterior a la fecha de corte',
  );
}
