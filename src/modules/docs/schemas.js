import { boardSchema } from './board-schema.js';
import { z, id, revision } from '../../core/validation.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const coordinate = z.number().finite().min(-50000).max(50000);
export const blockSchema = z.strictObject({
  id,
  type: z.enum([
    'paragraph',
    'heading1',
    'heading2',
    'bullet',
    'numbered',
    'todo',
    'quote',
    'code',
    'divider',
  ]),
  text: z.string().max(12000).default(''),
  checked: z.boolean().default(false),
});
export const elementSchema = z.strictObject({
  id,
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'arrow', 'text', 'pen']),
  x: coordinate,
  y: coordinate,
  width: z.number().finite().min(0).max(20000).default(0),
  height: z.number().finite().min(0).max(20000).default(0),
  stroke: color.default('#264d3e'),
  fill: z.union([color, z.literal('none')]).default('none'),
  strokeWidth: z.number().finite().min(1).max(16).default(2),
  text: z.string().max(4000).default(''),
  points: z
    .array(z.tuple([coordinate, coordinate]))
    .max(2000)
    .default([]),
});
const uniqueIds = (rows) => new Set(rows.map((r) => r.id)).size === rows.length;
const body = {
  title: z.string().trim().min(1).max(200),
  board: boardSchema.nullable().optional(),
  kind: z.enum(['document', 'board']),
  color: color.default('#164e3d'),
  blocks: z.array(blockSchema).max(300).default([]).refine(uniqueIds, 'IDs de bloques repetidos'),
  elements: z
    .array(elementSchema)
    .max(400)
    .default([])
    .refine(uniqueIds, 'IDs de elementos repetidos'),
};
const validContent = (d) =>
  d.kind === 'document'
    ? d.elements.length === 0 && !d.board
    : d.blocks.length === 0 && (!d.board || d.elements.length === 0);
const contentSize = (d) =>
  new TextEncoder().encode(JSON.stringify(d)).length <= (d.board ? 6 * 1024 * 1024 : 220 * 1024);
const pointCount = (d) => d.elements.reduce((n, e) => n + e.points.length, 0) <= 6000;
const constrain = (schema) =>
  schema
    .refine(validContent, 'Un documento usa bloques; un pizarrón usa elementos')
    .refine(contentSize, 'La nota supera el límite permitido de contenido')
    .refine(pointCount, 'El pizarrón admite hasta 6000 puntos de trazo');
export const createDocSchema = constrain(z.strictObject(body));
export const updateDocSchema = constrain(z.strictObject({ ...body, revision }));
export const archiveDocSchema = z.strictObject({ archived: z.boolean(), revision });
export const listDocsSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(60).default(30),
  cursor: id.optional(),
  kind: z.enum(['document', 'board']).optional(),
  archived: z.enum(['true', 'false']).default('false'),
  q: z.string().trim().max(100).optional(),
});
