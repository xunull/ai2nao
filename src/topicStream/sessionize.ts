/**
 * Segment a browsing visit stream into "research sessions" (Stage 2).
 *
 * Run this over the FULL visit set of ONE `(profile, source_id)` group, BEFORE
 * the transition noise filter — dropping RELOAD/FORWARD_BACK first would punch
 * holes in the id space and make a kept LINK's parent look dangling.
 *
 * A visit joins its parent's session when the parent (its `from_visit`) resolves
 * within this group AND the time gap to the parent is within `gapUs`. It starts
 * a NEW session when: `from_visit` is 0 (fresh navigation), the parent is not in
 * this group (Chrome archived it — a real gap), or the gap exceeds the threshold.
 *
 * Session keys are `s<rootVisitId>` — deterministic, so a rebuild is idempotent.
 * The caller prefixes them with the `source_id` for a globally unique id.
 */

export type SessionVisit = {
  id: number;
  fromVisit: number; // Chrome `from_visit` (0 = none)
  visitTime: number; // Chrome WebKit microseconds
};

export function sessionize(visits: SessionVisit[], gapUs: number): Map<number, string> {
  const byId = new Map<number, SessionVisit>();
  for (const v of visits) byId.set(v.id, v);
  const order = [...visits].sort((a, b) => a.visitTime - b.visitTime || a.id - b.id);

  const session = new Map<number, string>();
  for (const v of order) {
    const parent = v.fromVisit !== 0 ? byId.get(v.fromVisit) : undefined;
    const parentSession = parent ? session.get(parent.id) : undefined;
    const withinGap =
      parent != null &&
      parentSession != null &&
      v.visitTime >= parent.visitTime &&
      v.visitTime - parent.visitTime <= gapUs;
    session.set(v.id, withinGap ? (parentSession as string) : `s${v.id}`);
  }
  return session;
}
