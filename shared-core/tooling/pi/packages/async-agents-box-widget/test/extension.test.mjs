/**
 * extension.test.mjs — end-to-end test of the real glue (async-agents-box-widget.ts),
 * loaded through jiti exactly as pi loads it, against a fake ui and a stand-in for
 * pi-subagents' mounted widget component.
 *
 * Run: node test/extension.test.mjs
 *
 * What is actually being asserted here, because these are the load-bearing assumptions:
 *  - only the "subagent-async" slot is framed; every other widget is passed through by identity
 *  - the box asks the inner component for lines at width-3, so upstream's own truncation
 *    still matches what is displayed
 *  - updating the INNER component in place (how pi-subagents pushes progress) is reflected
 *    without re-registering the widget — this is what makes the wrapper stateless
 *  - a click on the box title reaches upstream's fold toggle
 *  - the wrapper keeps passing instanceof, dispose() and an unrelated component through
 *  - a throwing render falls back instead of killing the frame loop
 *  - a second session_start does not double-frame
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.dirname(here);

/** jiti ships with pi's own npm install; reuse it rather than adding a dependency. */
async function loadJiti() {
  const require = createRequire(import.meta.url);
  const candidates = [
    "jiti",
    path.join(pkg, "node_modules/jiti/lib/jiti.mjs"),
    path.join(pkg, "../beads-box-widget/node_modules/jiti/lib/jiti.mjs"),
    path.join(process.env.HOME || "", ".pi/agent/npm/node_modules/jiti/lib/jiti.mjs"),
  ];
  for (const c of candidates) {
    const resolved = c.endsWith(".mjs") ? c : (() => {
      try {
        return require.resolve(c);
      } catch {
        return "";
      }
    })();
    if (resolved && existsSync(resolved)) return (await import(`file://${resolved}`)).createJiti(import.meta.url, { interopDefault: true });
  }
  throw new Error("jiti not found — run `npm install` in this package (devDependency) or point the test at pi's node_modules");
}

const plain = (s) => (Array.isArray(s) ? s.map((line) => plain(line)) : String(s).replace(/\x1b\[[0-9;]*m/g, ""));
const width = (s) => [...plain(s)].length;
const pad = (line, w) => {
  const t = ` ${line}`;
  return `${t}${" ".repeat(Math.max(0, w - width(t)))}`;
};
const theme = { fg: (_c, s) => s, strikethrough: (s) => s };

/** Stand-in for pi-subagents' mounted component (Container subclass from render.js). */
class FakeUpstreamComponent {
  constructor() {
    this.collapsed = false;
    this.disposed = false;
    this.runs = 2;
    this.lastWidth = 0;
    this.throwOnRender = false;
  }

  render(renderWidth) {
    this.lastWidth = renderWidth;
    if (this.throwOnRender) throw new Error("upstream render blew up");
    if (this.collapsed) return [pad("○ Async agents · 0/2 running", renderWidth)];
    const lines = [pad("⠴ Async agents · background", renderWidth)];
    for (let i = 0; i < this.runs; i++) lines.push(pad(`├─ ⠼ delegate [fresh] · run ${i}`, renderWidth));
    lines.push(pad("└─ +5 more (5 running)", renderWidth));
    return lines;
  }

  handleMouse(event) {
    if (event?.type === "click" && event.button === 0 && event.y === 0) {
      this.collapsed = !this.collapsed;
      return { handled: true };
    }
    return undefined;
  }

  dispose() {
    this.disposed = true;
  }
}

/** pi's setExtensionWidget, reduced to the parts this wrapper depends on. */
function makeUi() {
  const above = new Map();
  return {
    above,
    setWidget(key, content, _options) {
      above.get(key)?.dispose?.();
      above.delete(key);
      if (content === undefined) return;
      above.set(key, typeof content === "function" ? content({ requestRender() {} }, theme) : content);
    },
  };
}

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
};

const jiti = await loadJiti();
const mod = await jiti.import(path.join(pkg, "extensions/async-agents-box-widget.ts"));
const activate = mod.default ?? mod;

const handlers = {};
activate({ on: (event, handler) => { handlers[event] = handler; } });

await check("exports a session_start handler", async () => {
  assert.equal(typeof activate, "function");
  assert.equal(typeof handlers.session_start, "function");
});

await check("other widget keys are passed through untouched", async () => {
  const ui = makeUi();
  await handlers.session_start(undefined, { ui });
  const foreign = { render: (w) => [pad("someone else's panel", w)] };
  ui.setWidget("goal-dashboard", foreign);
  assert.equal(ui.above.get("goal-dashboard"), foreign, "foreign component must be the same instance");
});

await check("subagent-async mounts framed and inner renders at width-3", async () => {
  const ui = makeUi();
  await handlers.session_start(undefined, { ui });
  let inner;
  ui.setWidget("subagent-async", () => (inner = new FakeUpstreamComponent()));
  const mounted = ui.above.get("subagent-async");
  const out = mounted.render(100);
  assert.equal(inner.lastWidth, 97, "inner must be asked for width-3 lines");
  assert.equal(width(out[0]), 100);
  assert.ok(plain(out[0]).startsWith("\u256d"), "first line is the box header");
  assert.ok(plain(out[out.length - 1]).startsWith("\u2570"), "last line is the box footer");
  assert.equal(plain(out).join("\n").match(/async agents/gi).length, 1, "title appears once");
});

await check("in-place update of the inner component shows up without re-registering", async () => {
  const ui = makeUi();
  await handlers.session_start(undefined, { ui });
  let inner;
  ui.setWidget("subagent-async", () => (inner = new FakeUpstreamComponent()));
  const mounted = ui.above.get("subagent-async");
  const before = mounted.render(100).length;
  inner.runs = 4; // how pi-subagents pushes progress: mutate the mounted component
  const after = mounted.render(100);
  assert.ok(after.length > before, "framed output must grow with upstream state");
  assert.match(plain(after).join("\n"), /run 3/);
});

await check("instanceof survives the wrapper; dispose reaches upstream", async () => {
  const ui = makeUi();
  await handlers.session_start(undefined, { ui });
  let inner;
  ui.setWidget("subagent-async", () => (inner = new FakeUpstreamComponent()));
  const mounted = ui.above.get("subagent-async");
  assert.ok(mounted instanceof FakeUpstreamComponent, "Proxy must preserve the prototype chain");
  assert.notEqual(mounted, inner);
  mounted.dispose();
  assert.equal(inner.disposed, true);
});

await check("a click on the box title folds upstream's widget", async () => {
  const ui = makeUi();
  await handlers.session_start(undefined, { ui });
  let inner;
  ui.setWidget("subagent-async", () => (inner = new FakeUpstreamComponent()));
  const mounted = ui.above.get("subagent-async");
  assert.equal(inner.collapsed, false);
  assert.deepEqual(mounted.handleMouse({ type: "click", button: 0, y: 0 }), { handled: true });
  assert.equal(inner.collapsed, true, "title click must reach upstream's fold toggle");
  const folded = mounted.render(100);
  assert.equal(folded.length, 1, "folded state stays a one-liner");
  assert.match(plain(folded[0]), /Async agents|async agents/);
});

await check("a throwing upstream render falls back instead of propagating", async () => {
  const ui = makeUi();
  await handlers.session_start(undefined, { ui });
  let inner;
  ui.setWidget("subagent-async", () => (inner = new FakeUpstreamComponent()));
  const mounted = ui.above.get("subagent-async");
  inner.throwOnRender = true;
  assert.deepEqual(mounted.render(100), []);
  inner.throwOnRender = false;
  assert.ok(mounted.render(100).length > 2, "recovers on the next frame");
});

await check("a second session_start does not double-frame", async () => {
  const ui = makeUi();
  await handlers.session_start(undefined, { ui });
  await handlers.session_start(undefined, { ui });
  ui.setWidget("subagent-async", () => new FakeUpstreamComponent());
  const out = plain(ui.above.get("subagent-async").render(100)).join("\n");
  assert.equal((out.match(/\u256d/g) || []).length, 1, "exactly one box header");
});

process.stdout.write(`\n${passed} checks passed\n`);
