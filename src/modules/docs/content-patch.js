import { z, revision } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { createDocSchema } from './schemas.js';
const key = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .refine((v) => !['__proto__', 'constructor', 'prototype'].includes(v));
const rows = z.strictObject({
  upsert: z.array(z.unknown()).max(2000).default([]),
  remove: z.array(key).max(2000).default([]),
  order: z.array(key).max(2000).optional(),
});
const fileMap = z
  .custom(
    (v) =>
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).every((k) => !['__proto__', 'constructor', 'prototype'].includes(k)),
  )
  .pipe(z.record(key, z.unknown()));
const files = z.strictObject({
  upsert: fileMap.default({}),
  remove: z.array(key).max(2000).default([]),
});
export const contentPatchSchema = z.strictObject({
  revision,
  changes: z
    .strictObject({
      title: z.string().trim().min(1).max(200).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      font: z.enum(['sans', 'serif', 'handwritten', 'mono']).optional(),
      blocks: rows.optional(),
      elements: rows.optional(),
      board: z.unknown().optional(),
      boardPatch: z
        .strictObject({
          elements: rows.optional(),
          files: files.optional(),
          appState: z.unknown().optional(),
          libraryItems: z.array(z.unknown()).max(100).optional(),
        })
        .optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'No hay cambios'),
});
function mergeRows(previous, delta) {
  const map = new Map((previous || []).map((row) => [row.id, row]));
  const seen = new Set();
  for (const row of delta.upsert) {
    ensure(
      row && typeof row === 'object' && typeof row.id === 'string' && !seen.has(row.id),
      422,
      'DOC_PATCH',
      'Elemento inválido o repetido',
    );
    seen.add(row.id);
    map.set(row.id, row);
  }
  for (const id of delta.remove) {
    ensure(!seen.has(id), 422, 'DOC_PATCH', 'Cambios contradictorios');
    map.delete(id);
  }
  if (delta.order) {
    ensure(
      new Set(delta.order).size === map.size &&
        delta.order.length === map.size &&
        delta.order.every((id) => map.has(id)),
      422,
      'DOC_PATCH',
      'Orden incompleto o repetido',
    );
    return delta.order.map((id) => map.get(id));
  }
  return [...map.values()];
}
export function mergeContentPatch(current, changes) {
  ensure(
    !(changes.board !== undefined && changes.boardPatch),
    422,
    'DOC_PATCH',
    'Envía una sola forma de actualizar el pizarrón',
  );
  const data = Object.fromEntries(
    ['title', 'kind', 'color', 'font', 'parentId', 'blocks', 'elements', 'board']
      .filter((k) => current[k] !== undefined)
      .map((k) => [k, current[k]]),
  );
  for (const key of ['title', 'color', 'font', 'board'])
    if (changes[key] !== undefined) data[key] = changes[key];
  for (const key of ['blocks', 'elements'])
    if (changes[key]) data[key] = mergeRows(current[key], changes[key]);
  if (changes.boardPatch) {
    ensure(
      current.kind === 'board' && current.board?.format === 'excalidraw',
      422,
      'DOC_PATCH',
      'El pizarrón necesita su contenido inicial',
    );
    const delta = changes.boardPatch,
      board = { ...current.board };
    if (delta.elements) board.elements = mergeRows(board.elements, delta.elements);
    if (delta.files) {
      const removed = new Set(delta.files.remove);
      board.files = Object.fromEntries([
        ...Object.entries(board.files || {}).filter(([id]) => !removed.has(id)),
        ...Object.entries(delta.files.upsert),
      ]);
    }
    for (const key of ['appState', 'libraryItems'])
      if (delta[key] !== undefined) board[key] = delta[key];
    data.board = board;
  }
  // The merged document still passes all existing type, media, binding and size constraints.
  return createDocSchema.parse(data);
}
