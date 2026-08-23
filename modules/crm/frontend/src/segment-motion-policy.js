export const SLIDE_MS = 180;
export const SLIDE_EASE = "cubic-bezier(.2, .72, .2, 1)";

export function resolveSegmentSlideAction(input) {
  if (input.fromIndex < 0 || input.toIndex < 0 || input.fromIndex === input.toIndex) return "skip";
  if (input.reducedMotion) return "skip";
  if (input.pending) return "coalesce";
  return "start";
}

export function stressTestDockClicks(clicks, intervalMs, slideMs = SLIDE_MS) {
  let pendingUntil = -1;
  let active = 0;
  const started = [];
  const coalesced = [];
  const skipped = [];
  const commits = [];
  for (let i = 0; i < clicks; i += 1) {
    const at = i * intervalMs;
    const fromIndex = active;
    const toIndex = (active + 1 + (i % 3)) % 5;
    const action = resolveSegmentSlideAction({
      fromIndex,
      toIndex,
      pending: at < pendingUntil,
    });
    if (action === "start") {
      started.push(at);
      pendingUntil = at + slideMs;
    } else if (action === "coalesce") coalesced.push(at);
    else skipped.push(at);
    if (action !== "skip") {
      active = toIndex;
      commits.push(toIndex);
    }
  }
  const overlappingStarts = started.filter((time, index) => {
    const next = started[index + 1];
    return next !== undefined && next - time < slideMs;
  }).length;
  return { started, coalesced, skipped, commits, overlappingStarts };
}
