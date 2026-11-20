// test/coerce-test.mjs - run: node test/coerce-test.mjs
import { coerceSubagentCall, BLOCKED_ACTIONS, BLOCK_REASON } from "../extensions/sync-only.js";

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL: " + name); } };

// 1. bare single-child launch gains async:false
let a = { agent: "worker", task: "do it" };
let v = coerceSubagentCall(a);
check("single launch coerced", v.changed === true && a.async === false && v.block === null);

// 2. explicit async:true is overridden, not honoured
let b = { agent: "w", task: "t", async: true };
coerceSubagentCall(b);
check("explicit async:true overridden", b.async === false);

// 3. already-sync call is a no-op
let c = { agent: "w", task: "t", async: false };
let vc = coerceSubagentCall(c);
check("sync call untouched", vc.changed === false && c.async === false && vc.block === null);

// 4. parallel workflow shape
let d = { workflow: "parallel", args: { tasks: [{ agent: "w", task: "t" }] } };
coerceSubagentCall(d);
check("parallel workflow coerced", d.async === false);

// 5. inline script workflow shape
let e = { workflow: true, args: { x: 1 } };
coerceSubagentCall(e);
check("script workflow coerced", e.async === false);

// 6. chain shape
let f = { agent: "w", chain: [{ agent: "w", task: "t1" }, { agent: "w", task: "t2" }] };
coerceSubagentCall(f);
check("chain coerced", f.async === false);

// 7. management actions untouched
for (const act of ["status", "stop", "steer", "interrupt", "guide", "logs", "list", "history"]) {
  const g = { action: act, id: "run-1" };
  const vg = coerceSubagentCall(g);
  check("action " + act + " untouched", vg.changed === false && vg.block === null && g.async === undefined);
}

// 8. deferred launch refused, input unchanged
const h = { action: "schedule.create", options: { cron: "* * * * *" } };
const vh = coerceSubagentCall(h);
check("schedule.create blocked", vh.block === BLOCK_REASON && vh.changed === false && h.async === undefined);
check("BLOCKED_ACTIONS holds schedule.create", BLOCKED_ACTIONS.has("schedule.create"));

// 9. junk inputs do not throw
for (const junk of [null, undefined, 0, "", "x", [], true]) {
  let threw = false;
  try { coerceSubagentCall(junk); } catch { threw = true; }
  check("junk " + JSON.stringify(junk) + " safe", threw === false);
}

// 10. coercion is visible on the caller's object (mutation contract)
const obj = { agent: "w", task: "t" };
coerceSubagentCall(obj);
check("mutates caller object", Object.prototype.hasOwnProperty.call(obj, "async") && obj.async === false);

console.log("RESULT pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
