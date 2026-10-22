import { z } from '../../core/validation.js';

// Versioned boundary for the official @excalidraw/excalidraw 0.18.1 scene format.
const number = z.number().finite().min(-1000000).max(1000000);
const dimension = z.number().finite().min(0).max(1000000);
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const paint = z.string().regex(/^(?:#[0-9a-fA-F]{3,8}|transparent)$/);
const point = z.tuple([number, number]);
const link = z
  .string()
  .max(2048)
  .refine((v) => !v || /^(https?:\/\/|mailto:|tel:|#)/i.test(v), 'Enlace no permitido');
const binding = z.strictObject({
  elementId: key,
  focus: number,
  gap: dimension,
  fixedPoint: point.optional(),
});
const arrowhead = z
  .enum([
    'arrow',
    'bar',
    'dot',
    'circle',
    'circle_outline',
    'triangle',
    'triangle_outline',
    'diamond',
    'diamond_outline',
    'crowfoot_one',
    'crowfoot_many',
    'crowfoot_one_or_many',
  ])
  .nullable();
export const excalidrawElementSchema = z.strictObject({
  id: key,
  type: z.enum([
    'rectangle',
    'ellipse',
    'diamond',
    'line',
    'arrow',
    'freedraw',
    'text',
    'image',
    'frame',
    'embeddable',
  ]),
  x: number,
  y: number,
  width: dimension,
  height: dimension,
  strokeColor: paint,
  backgroundColor: paint,
  fillStyle: z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag']),
  strokeWidth: z.number().finite().min(0).max(64),
  strokeStyle: z.enum(['solid', 'dashed', 'dotted']),
  roundness: z
    .strictObject({ type: z.number().int().min(1).max(3), value: dimension.optional() })
    .nullable(),
  roughness: z.number().finite().min(0).max(10),
  opacity: z.number().finite().min(0).max(100),
  angle: number,
  seed: z.number().int(),
  version: z.number().int().min(1),
  versionNonce: z.number().int(),
  index: z.string().max(128).nullable(),
  isDeleted: z.boolean(),
  groupIds: z.array(key).max(100),
  frameId: key.nullable(),
  boundElements: z
    .array(z.strictObject({ id: key, type: z.enum(['arrow', 'text']) }))
    .max(2000)
    .nullable(),
  updated: z.number().finite().nonnegative(),
  link: link.nullable(),
  locked: z.boolean(),
  fontSize: z.number().finite().min(1).max(1000).optional(),
  fontFamily: z.number().int().min(1).max(20).optional(),
  text: z.string().max(30000).optional(),
  originalText: z.string().max(30000).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  containerId: key.nullable().optional(),
  autoResize: z.boolean().optional(),
  lineHeight: z.number().finite().positive().max(20).optional(),
  points: z.array(point).max(15000).optional(),
  lastCommittedPoint: point.nullable().optional(),
  pressures: z.array(z.number().finite().min(0).max(1)).max(15000).optional(),
  simulatePressure: z.boolean().optional(),
  startBinding: binding.nullable().optional(),
  endBinding: binding.nullable().optional(),
  startArrowhead: arrowhead.optional(),
  endArrowhead: arrowhead.optional(),
  elbowed: z.boolean().optional(),
  fixedSegments: z
    .array(z.strictObject({ start: point, end: point, index: z.number().int().min(0) }))
    .max(2000)
    .nullable()
    .optional(),
  startIsSpecial: z.boolean().nullable().optional(),
  endIsSpecial: z.boolean().nullable().optional(),
  fileId: key.nullable().optional(),
  status: z.enum(['pending', 'saved', 'error']).optional(),
  scale: z
    .tuple([z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1)])
    .optional(),
  crop: z
    .strictObject({
      x: dimension,
      y: dimension,
      width: dimension,
      height: dimension,
      naturalWidth: dimension,
      naturalHeight: dimension,
    })
    .nullable()
    .optional(),
  name: z.string().max(200).nullable().optional(),
});
const elements = z
  .array(excalidrawElementSchema)
  .max(2000)
  .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, 'IDs repetidos');
const raster = z.strictObject({
  id: key,
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataURL: z
    .string()
    .max(4 * 1024 * 1024)
    .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/),
  created: z.number().finite().nonnegative(),
  lastRetrieved: z.number().finite().nonnegative().optional(),
  version: z.number().finite().nonnegative().optional(),
});
export const boardSchema = z
  .strictObject({
    format: z.literal('excalidraw'),
    version: z.literal(2),
    elements,
    appState: z.strictObject({
      viewBackgroundColor: paint.default('#ffffff'),
      gridSize: z.number().finite().min(1).max(256).nullable().default(null),
      gridStep: z.number().finite().min(1).max(100).optional(),
      gridModeEnabled: z.boolean().optional(),
      nexoBackgroundPattern: z.enum(['none', 'dots', 'lines']).optional(),
    }),
    files: z
      .record(key, raster)
      .refine((files) => Object.keys(files).length <= 20, 'Máximo 20 imágenes'),
    libraryItems: z
      .array(
        z.strictObject({
          id: key,
          status: z.enum(['published', 'unpublished']),
          created: z.number().finite().nonnegative(),
          name: z.string().max(200).optional(),
          elements,
        }),
      )
      .max(100)
      .default([]),
  })
  .superRefine((scene, ctx) => {
    const all = [...scene.elements, ...scene.libraryItems.flatMap((i) => i.elements)];
    if (all.length > 4000 || all.reduce((sum, e) => sum + (e.points?.length || 0), 0) > 50000)
      ctx.addIssue({
        code: 'custom',
        message: 'El pizarrón supera el límite de elementos o trazos',
      });
    if (new TextEncoder().encode(JSON.stringify(scene)).length > 5 * 1024 * 1024)
      ctx.addIssue({ code: 'custom', message: 'El pizarrón supera 5 MB' });
    for (const [id, file] of Object.entries(scene.files))
      if (file.id !== id || !file.dataURL.startsWith('data:' + file.mimeType + ';base64,'))
        ctx.addIssue({ code: 'custom', message: 'Imagen inválida' });
    for (const e of all) {
      if (['line', 'arrow', 'freedraw'].includes(e.type) && (!e.points || e.points.length < 1))
        ctx.addIssue({ code: 'custom', message: 'Faltan puntos del trazo' });
      if (e.type === 'text' && (!e.fontSize || !e.fontFamily || typeof e.text !== 'string'))
        ctx.addIssue({ code: 'custom', message: 'Texto incompleto' });
      if (e.type === 'image' && (!e.fileId || !scene.files[e.fileId]))
        ctx.addIssue({ code: 'custom', message: 'Falta la imagen del elemento' });
    }
  });
