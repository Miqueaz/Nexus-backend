import { id } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { createDocSchema, updateDocSchema, archiveDocSchema, listDocsSchema } from './schemas.js';

export function createDocsService({ commands, store }) {
  return {
    list(ctx, query) {
      const data = listDocsSchema.parse(query);
      return commands.read(ctx, (tx) => store.list(tx, data));
    },
    get(ctx, documentId) {
      id.parse(documentId);
      return commands.read(ctx, (tx) => tx.get('documents', documentId));
    },
    create(ctx, input) {
      const data = createDocSchema.parse(input);
      return commands.run(ctx, 'docs.created', data, (tx) =>
        tx.insert('documents', {
          ...data,
          archived: false,
          createdBy: ctx.userId,
          editedBy: ctx.userId,
        }),
      );
    },
    update(ctx, documentId, input) {
      id.parse(documentId);
      const data = updateDocSchema.parse(input);
      return commands.run(ctx, 'docs.updated', { documentId, ...data }, async (tx) => {
        const current = await tx.get('documents', documentId);
        ensure(!current.archived, 409, 'DOC_ARCHIVED', 'Restaura la nota antes de editarla');
        ensure(current.kind === data.kind, 422, 'DOC_KIND', 'El tipo de nota no se puede cambiar');
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
        (tx) =>
          tx.update('documents', documentId, data.revision, {
            archived: data.archived,
            editedBy: ctx.userId,
          }),
      );
    },
  };
}
