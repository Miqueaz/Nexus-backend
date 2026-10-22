import { validateFile, docMetadata } from './files.js';
import { containerSchema, locationSchema, uploadSchema } from './schemas.js';
import { id } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { createDocSchema, updateDocSchema, archiveDocSchema, listDocsSchema } from './schemas.js';

export function createDocsService({ commands, store }) {
  async function parent(tx, parentId, kind) {
    if (!parentId) {
      ensure(kind !== 'section', 422, 'DOC_PARENT', 'Crea la sección dentro de una carpeta');
      return;
    }
    const container = await tx.get('documents', parentId);
    ensure(
      !container.archived && ['folder', 'section'].includes(container.kind),
      422,
      'DOC_PARENT',
      'La ubicación debe ser una carpeta o sección activa',
    );
    ensure(
      kind !== 'folder' && (kind !== 'section' || container.kind === 'folder'),
      422,
      'DOC_PARENT',
      'Las carpetas van en la raíz y las secciones dentro de una carpeta',
    );
    // Serializes child placement with concurrent container archival.
    await tx.update('documents', container._id, container.revision, {});
  }
  async function references(tx, data) {
    const seen = new Set();
    const media = (data.blocks || []).filter((b) => ['image', 'boardRef'].includes(b.type));
    ensure(
      media.length <= 40,
      422,
      'DOC_MEDIA_LIMIT',
      'Un documento admite hasta 40 imágenes y pizarrones vinculados',
    );
    for (const block of media) {
      const key = block.attachmentId || block.boardId;
      if (seen.has(key)) continue;
      seen.add(key);
      if (block.type === 'image') {
        const file = await tx.get('documents', block.attachmentId);
        ensure(
          file.kind === 'file' && file.attachment?.mime.startsWith('image/'),
          422,
          'DOC_IMAGE',
          'Selecciona una imagen activa de este negocio',
        );
      }
      if (block.type === 'boardRef') {
        const board = await tx.get('documents', block.boardId);
        ensure(
          board.kind === 'board',
          422,
          'DOC_BOARD_REF',
          'Selecciona un pizarrón activo de este negocio',
        );
      }
    }
  }
  return {
    library(ctx, query) {
      const data = listDocsSchema.parse(query);
      return commands.read(ctx, async (tx) => {
        const page = await store.list(tx, data);
        const containers = await store.containers(tx);
        const recent = (await store.list(tx, { limit: 8, archived: 'false' })).data;
        return { ...page, containers, recent };
      });
    },
    createContainer(ctx, input) {
      const data = containerSchema.parse(input);
      return commands.run(ctx, 'docs.container.created', data, async (tx) => {
        await parent(tx, data.parentId, data.kind);
        const containers = await store.containers(tx);
        ensure(
          containers.filter((r) => !r.archived).length < 500,
          422,
          'DOC_CONTAINERS',
          'Este espacio admite hasta 500 carpetas y secciones',
        );
        return tx.insert('documents', {
          ...data,
          archived: false,
          createdBy: ctx.userId,
          editedBy: ctx.userId,
        });
      });
    },
    upload(ctx, input) {
      const data = uploadSchema.parse(input),
        attachment = validateFile(data);
      return commands.run(ctx, 'docs.file.uploaded', data, async (tx) => {
        await parent(tx, data.parentId, 'file');
        return docMetadata(
          await tx.insert('documents', {
            title: data.title,
            parentId: data.parentId,
            kind: 'file',
            color: '#164e3d',
            attachment,
            archived: false,
            createdBy: ctx.userId,
            editedBy: ctx.userId,
          }),
        );
      });
    },
    content(ctx, documentId) {
      id.parse(documentId);
      return commands.read(ctx, async (tx) => {
        const row = await tx.get('documents', documentId);
        ensure(row.kind === 'file', 404, 'NOT_FOUND', 'Archivo no encontrado');
        return row.attachment;
      });
    },
    relocate(ctx, documentId, input) {
      id.parse(documentId);
      const data = locationSchema.parse(input);
      return commands.run(ctx, 'docs.organized', { documentId, ...data }, async (tx) => {
        const row = await tx.get('documents', documentId);
        ensure(!row.archived, 409, 'DOC_ARCHIVED', 'Restaura el elemento antes de organizarlo');
        if (data.parentId !== undefined) await parent(tx, data.parentId, row.kind);
        const { revision, ...patch } = data;
        return docMetadata(
          await tx.update('documents', documentId, revision, { ...patch, editedBy: ctx.userId }),
        );
      });
    },
    list(ctx, query) {
      const data = listDocsSchema.parse(query);
      return commands.read(ctx, (tx) => store.list(tx, data));
    },
    get(ctx, documentId) {
      id.parse(documentId);
      return commands.read(ctx, async (tx) => {
        const row = await tx.get('documents', documentId);
        return row.kind === 'file' ? docMetadata(row) : row;
      });
    },
    create(ctx, input) {
      const data = createDocSchema.parse(input);
      return commands.run(ctx, 'docs.created', data, async (tx) => {
        await references(tx, data);
        await parent(tx, data.parentId, data.kind);
        return tx.insert('documents', {
          ...data,
          archived: false,
          createdBy: ctx.userId,
          editedBy: ctx.userId,
        });
      });
    },
    update(ctx, documentId, input) {
      id.parse(documentId);
      const data = updateDocSchema.parse(input);
      return commands.run(ctx, 'docs.updated', { documentId, ...data }, async (tx) => {
        const current = await tx.get('documents', documentId);
        await references(tx, data);
        ensure(!current.archived, 409, 'DOC_ARCHIVED', 'Restaura la nota antes de editarla');
        ensure(
          ['document', 'board'].includes(current.kind) && current.kind === data.kind,
          422,
          'DOC_KIND',
          'El tipo de nota no se puede cambiar',
        );
        if (data.parentId !== undefined && data.parentId !== current.parentId)
          await parent(tx, data.parentId, data.kind);
        return tx.update('documents', documentId, data.revision, { ...data, editedBy: ctx.userId });
      });
    },
    archive(ctx, documentId, input) {
      id.parse(documentId);
      const data = archiveDocSchema.parse(input);
      return commands.run(
        ctx,
        data.archived ? 'docs.archived' : 'docs.restored',
        { documentId, ...data },
        async (tx) => {
          const row = await tx.get('documents', documentId);
          if (data.archived && ['folder', 'section'].includes(row.kind)) {
            const children = await tx.find('documents', { parentId: documentId, archived: false });
            ensure(
              !children.length,
              409,
              'DOC_NOT_EMPTY',
              'Mueve o archiva el contenido antes de archivar esta ubicación',
            );
          }
          if (!data.archived) await parent(tx, row.parentId, row.kind);
          const result = await tx.update('documents', documentId, data.revision, {
            archived: data.archived,
            editedBy: ctx.userId,
          });
          return result.kind === 'file' ? docMetadata(result) : result;
        },
      );
    },
  };
}
