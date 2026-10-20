import { ensure } from '../../core/errors.js';
export function createContactsAdapter() {
  return {
    async assertCustomer(tx, id) {
      if (!id) return;
      const c = await tx.get('contacts', id);
      ensure(!c.archived, 422, 'CONTACT_ARCHIVED', 'Contacto archivado');
      return { _id: c._id, name: c.name };
    },
  };
}
