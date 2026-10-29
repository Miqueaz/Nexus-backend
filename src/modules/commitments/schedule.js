// Calendar dates, anchored to the original day (Jan 31 -> Feb 28 -> Mar 31).
export function dateAt(plan, index) {
  if (index < 0 || !Number.isInteger(index) || (plan.frequency === 'once' && index)) return null;
  const [y, m, d] = plan.startOn.split('-').map(Number),
    step = index * plan.interval;
  let result;
  if (['daily', 'weekly'].includes(plan.frequency)) {
    result = new Date(Date.UTC(y, m - 1, d + step * (plan.frequency === 'weekly' ? 7 : 1)));
  } else {
    const months = plan.frequency === 'once' ? 0 : step * (plan.frequency === 'yearly' ? 12 : 1);
    const first = new Date(Date.UTC(y, m - 1 + months, 1));
    result = new Date(
      Date.UTC(
        first.getUTCFullYear(),
        first.getUTCMonth(),
        Math.min(
          d,
          new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate(),
        ),
      ),
    );
  }
  const value = result.toISOString().slice(0, 10),
    end = [plan.endOn, plan.stoppedOn].filter(Boolean).sort()[0];
  return value > '2100-12-31' || (end && value > end) ? null : value;
}
export function datesBetween(plan, from, to) {
  if (from > to || plan.startOn > to) return [];
  const a = new Date(plan.startOn + 'T00:00:00Z'),
    b = new Date(from + 'T00:00:00Z');
  const distance = ['daily', 'weekly'].includes(plan.frequency)
    ? Math.floor((b - a) / 86400000 / (plan.frequency === 'weekly' ? 7 : 1))
    : (b.getUTCFullYear() - a.getUTCFullYear()) * (plan.frequency === 'yearly' ? 1 : 12) +
      (plan.frequency === 'yearly' ? 0 : b.getUTCMonth() - a.getUTCMonth());
  let index = plan.frequency === 'once' ? 0 : Math.max(0, Math.floor(distance / plan.interval) - 1);
  const out = [];
  for (; index < 40000; index++) {
    const value = dateAt(plan, index);
    if (!value || value > to) break;
    if (value >= from) out.push(value);
  }
  return out;
}
export function commitmentRows(plans, decisions, from, to, today) {
  const resolved = new Map(decisions.map((r) => [r.commitmentId + ':' + r.dueOn, r]));
  return plans
    .flatMap((plan) =>
      datesBetween(plan, from, to).map((dueOn) => {
        const resolution = resolved.get(plan._id + ':' + dueOn);
        return {
          ...plan,
          id: plan._id + ':' + dueOn,
          commitmentId: plan._id,
          dueOn,
          amountMinor: resolution?.amountMinor ?? plan.amountMinor,
          status:
            resolution?.status ||
            (dueOn > today ? 'upcoming' : dueOn < today ? 'overdue' : 'pending'),
          resolution,
        };
      }),
    )
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id));
}
