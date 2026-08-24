import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveSegmentSlideAction, SLIDE_MS, stressTestDockClicks } from "../src/segment-motion-policy.js";

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

test("CRM dock keeps a persistent pill so selected chrome never unmounts", async () => {
  const css = await read("src/styles.css");
  const app = await read("src/App.tsx");
  assert.match(app, /crm-mobile-dock-pill/);
  assert.match(app, /--crm-dock-index/);
  assert.doesNotMatch(app, /dockSlide/);
  assert.match(css, /\.crm-mobile-dock-pill \{[\s\S]*?transition:\s*transform 180ms cubic-bezier\(\.2, \.72, \.2, 1\)/);
  assert.match(css, /\.crm-mobile-dock button\.is-active \{[\s\S]*?background:\s*transparent;/);
  assert.doesNotMatch(css, /\.crm-mobile-dock\.is-segment-background-sliding/);
  assert.doesNotMatch(css, /\.crm-mobile-dock button\.is-active \{[\s\S]*?background-image:\s*var\(--public-action-gradient/);
  assert.match(app, /useLayoutEffect/);
});
