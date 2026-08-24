import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dockPillBox, resolveSegmentSlideAction, SLIDE_MS, stressTestDockClicks, stressTestDockDirections } from "../src/segment-motion-policy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("segment slide policy matches console: start, coalesce while pending, skip same target", () => {
  assert.equal(resolveSegmentSlideAction({ fromIndex: 0, toIndex: 1, pending: false }), "start");
  assert.equal(resolveSegmentSlideAction({ fromIndex: 0, toIndex: 1, pending: true }), "coalesce");
  assert.equal(resolveSegmentSlideAction({ fromIndex: 2, toIndex: 2, pending: false }), "skip");
  assert.equal(resolveSegmentSlideAction({ fromIndex: -1, toIndex: 1, pending: false }), "skip");
  assert.equal(resolveSegmentSlideAction({ fromIndex: 0, toIndex: 3, pending: false, reducedMotion: true }), "skip");
});

test("rapid dock clicks never overlap sliding backgrounds and still commit every tap", () => {
  const burst = stressTestDockClicks(80, 16, SLIDE_MS);
  assert.equal(burst.overlappingStarts, 0);
  assert.ok(burst.started.length >= 1);
  assert.ok(burst.coalesced.length > burst.started.length);
  assert.equal(burst.commits.length, burst.started.length + burst.coalesced.length);
  assert.equal(burst.commits.length + burst.skipped.length, 80);
  for (let i = 1; i < burst.started.length; i += 1) {
    assert.ok(burst.started[i] - burst.started[i - 1] >= SLIDE_MS);
  }

  const hammer = stressTestDockClicks(200, 8, SLIDE_MS);
  assert.equal(hammer.overlappingStarts, 0);
  assert.equal(hammer.commits.length, hammer.started.length + hammer.coalesced.length);
  assert.ok(hammer.commits.every((index) => index >= 0 && index < 5));

  const paced = stressTestDockClicks(10, SLIDE_MS, SLIDE_MS);
  assert.equal(paced.overlappingStarts, 0);
  assert.equal(paced.coalesced.length, 0);
  assert.equal(paced.started.length, 10);
});

test("LTR and RTL dock pill steps are equal pixel distances and never use percent transforms", () => {
  const result = stressTestDockDirections(50);
  assert.equal(result.ltrCount, 200);
  assert.equal(result.rtlCount, 200);
  assert.equal(result.ltrAllPositive, true);
  assert.equal(result.rtlAllNegative, true);
  assert.equal(result.sameStep, true);
  assert.equal(result.usesPx, true);
  const left = dockPillBox({ left: 5, top: 5, width: 81, height: 50 }, { left: 0, top: 0 });
  const right = dockPillBox({ left: 341, top: 5, width: 81, height: 50 }, { left: 0, top: 0 });
  assert.equal(left.left, "5px");
  assert.equal(right.left, "341px");
  assert.equal(right.x - left.x, 336);
});

test("CRM dock keeps a persistent pill so selected chrome never unmounts", async () => {
  const css = await read("src/styles.css");
  const app = await read("src/App.tsx");
  const motion = await read("src/segment-motion.ts");
  const policy = await read("src/segment-motion-policy.js");
  assert.match(app, /crm-mobile-dock-pill/);
  assert.match(app, /applyDockPill/);
  assert.doesNotMatch(app, /dockSlide/);
  assert.match(policy, /left: `\$\{x\}px`/);
  assert.match(motion, /pill\.animate/);
  assert.match(motion, /translate3d\(\$\{box\.x\}px, \$\{box\.y\}px, 0\)/);
  const pillRule = css.slice(css.indexOf(".crm-mobile-dock-pill {"), css.indexOf(".crm-mobile-dock button {", css.indexOf(".crm-mobile-dock-pill {")));
  assert.doesNotMatch(pillRule, /100%/);
  assert.match(pillRule, /transition:\s*none/);
  assert.match(css, /body\.crm-page \{[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(css, /\.crm-mobile-dock button\.is-active \{[\s\S]*?background:\s*transparent;/);
  assert.doesNotMatch(css, /\.crm-mobile-dock\.is-segment-background-sliding/);
  assert.match(app, /useLayoutEffect/);
});
