import { randomUUID } from 'node:crypto';
export function userLink(contact) {
  if (contact.userLink) return contact.userLink;
  return contact.userId
    ? {
        requestId: 'legacy:' + contact._id,
        targetUserId: contact.userId,
        status: 'pending',
        requestedAt: contact.createdAt,
      }
    : null;
}
export function requestedLink(ctx, data, old = {}) {
  if (!Object.hasOwn(data, 'userId')) return data;
  const target = data.userId,
    previous = userLink(old);
  if (!target)
    return {
      ...data,
      userId: null,
      ...(previous
        ? { userLink: { ...previous, status: 'cancelled', cancelledAt: new Date() } }
        : {}),
    };
  if (previous?.targetUserId === target && ['pending', 'accepted'].includes(previous.status))
    return { ...data, userId: previous.status === 'accepted' ? target : null, userLink: previous };
  return {
    ...data,
    userId: null,
    userLink: {
      requestId: randomUUID(),
      targetUserId: target,
      status: 'pending',
      requestedBy: ctx.userId,
      requestedAt: new Date(),
    },
  };
}
export const acceptedUserId = (contact) =>
  contact.userId &&
  contact.userLink?.status === 'accepted' &&
  contact.userLink.targetUserId === contact.userId
    ? contact.userId
    : null;
