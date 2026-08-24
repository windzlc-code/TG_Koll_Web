export const SLIDE_MS = 180;
export const SLIDE_EASE = "cubic-bezier(.2, .72, .2, 1)";

export function resolveSegmentSlideAction(input) {
  if (input.fromIndex < 0 || input.toIndex < 0 || input.fromIndex === input.toIndex) return "skip";
  if (input.reducedMotion) return "skip";
  if (input.pending) return "coalesce";
  return "start";
}

export function dockPillBox(button, dock) {
  const x = button.left - dock.left - (dock.clientLeft || 0) + (dock.scrollLeft || 0);
  const y = button.top - dock.top - (dock.clientTop || 0) + (dock.scrollTop || 0);
  return {
    x,
    y,
    width: button.width,
    height: button.height,
    transform: `translate3d(${x}px, ${y}px, 0)`,
  };
}

export function stressTestDockDirections(rounds = 40) {
  const gap = 3;
  const cell = 81;
  const origin = 5;
  const buttons = [0, 1, 2, 3, 4].map((index) => ({
    left: origin + index * (cell + gap),
    width: cell,
    top: 5,
    height: 50,
  }));
  const dock = { left: 0, top: 0, clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0 };
  const ltr = [];
  const rtl = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < 4; index += 1) {
      ltr.push(dockPillBox(buttons[index + 1], dock).x - dockPillBox(buttons[index], dock).x);
    }
    for (let index = 4; index > 0; index -= 1) {
      rtl.push(dockPillBox(buttons[index - 1], dock).x - dockPillBox(buttons[index], dock).x);
    }
  }
  const step = cell + gap;
  return {
    ltrCount: ltr.length,
    rtlCount: rtl.length,
    ltrAllPositive: ltr.every((delta) => delta === step),
    rtlAllNegative: rtl.every((delta) => delta === -step),
    sameStep: ltr.every((delta) => delta === step) && rtl.every((delta) => delta === -step),
    usesPx: buttons.every((_, index) => dockPillBox(buttons[index], dock).transform.includes("px") && !dockPillBox(buttons[index], dock).transform.includes("%")),
  };
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
