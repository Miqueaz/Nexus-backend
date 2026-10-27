import { z, id, text } from '../../core/validation.js';
import { ensure } from '../../core/errors.js';
import { userLink } from './user-links.js';
export function createContactNotifications({ db, uow, workspaceAccess, audit, logger }) {
  async function member(tx, ctx) {
    const m = (await tx.find('memberships', { userId: ctx.userId })).find(
      (m) => m.role !== 'removed',
    );
    ensure(m, 404, 'NOT_FOUND', 'Solicitud no encontrada');
    await workspaceAccess.resolve(m, tx.session);
    return m;
  }
  return {
    async list(ctx) {
      const members = await db
          .collection('memberships')
          .find({ userId: ctx.userId, role: { $ne: 'removed' } })
          .toArray(),
        businessIds = [];
      for (const m of members)
        try {
          await workspaceAccess.resolve(m);
          businessIds.push(m.businessId);
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      const rows = await db
        .collection('contacts')
        .find({
          businessId: { $in: businessIds },
          archived: { $ne: true },
          $or: [
            { 'userLink.targetUserId': ctx.userId, 'userLink.status': 'pending' },
            { userId: ctx.userId, userLink: { $exists: false } },
          ],
        })
        .sort({ updatedAt: -1, _id: 1 })
        .limit(50)
        .toArray();
      const businesses = new Map(
        (
          await db
            .collection('businesses')
            .find(
              { _id: { $in: rows.map((r) => r.businessId) } },
              { projection: { _id: 1, name: 1 } },
            )
            .toArray()
        ).map((b) => [b._id, b.name]),
      );
      const people = new Map(
        (
          await db
            .collection('users')
            .find(
              { _id: { $in: rows.map((r) => userLink(r)?.requestedBy).filter(Boolean) } },
              { projection: { _id: 1, name: 1 } },
            )
            .toArray()
        ).map((u) => [u._id, u.name]),
      );
      return {
        data: rows.map((r) => {
          const link = userLink(r);
          return {
            id: r._id,
            businessId: r.businessId,
            requestId: link.requestId,
            type: 'contact-association',
            contactName: r.name,
            workspaceName: businesses.get(r.businessId) || 'Espacio de trabajo',
            requestedByName: people.get(link.requestedBy) || 'Un miembro del espacio',
            requestedAt: link.requestedAt,
          };
        }),
        nextCursor: null,
      };
    },
    respond(ctx, contactId, input) {
      id.parse(contactId);
      const d = z
        .strictObject({
          businessId: id,
          requestId: text,
          decision: z.enum(['accepted', 'rejected']),
        })
        .parse(input);
      return uow.run(d.businessId, async (tx) => {
        const m = await member(tx, ctx),
          contact = await tx.get('contacts', contactId),
          link = userLink(contact);
        ensure(
          link?.targetUserId === ctx.userId && !contact.archived,
          404,
          'NOT_FOUND',
          'Solicitud no encontrada',
        );
        ensure(
          link.requestId === d.requestId,
          409,
          'REQUEST_CHANGED',
          'La solicitud cambió; vuelve a consultar tus notificaciones',
        );
        if (link.status === d.decision)
          return { status: link.status, contactId, businessId: d.businessId };
        ensure(
          link.status === 'pending',
          409,
          'REQUEST_CLOSED',
          'La solicitud ya fue respondida o cancelada',
        );
        await tx.update('memberships', m._id, m.revision, { lastConsentAt: new Date() });
        await tx.update('contacts', contactId, contact.revision, {
          userId: d.decision === 'accepted' ? ctx.userId : null,
          userLink: {
            ...link,
            status: d.decision,
            respondedBy: ctx.userId,
            respondedAt: new Date(),
          },
        });
        await audit.append(
          tx,
          { ...ctx, businessId: d.businessId },
          'contact.association.' + d.decision,
        );
        logger.info(
          {
            action: 'contact.association.' + d.decision,
            actorId: ctx.userId,
            businessId: d.businessId,
            requestId: ctx.requestId,
          },
          'command.completed',
        );
        return { status: d.decision, contactId, businessId: d.businessId };
      });
    },
  };
}
