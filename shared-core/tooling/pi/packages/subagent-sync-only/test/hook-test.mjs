// test/hook-test.mjs - drives the extension against a fake pi object (no pi needed).
import subagentSyncOnly from "../extensions/sync-only.js";

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.log("FAIL: " + n); } };

let handler = null;
const commands = {};
const fakePi = {
  on(evt, fn) { if (evt === "tool_call") handler = fn; },
  registerCommand(name, def) { commands[name] = def; },
};
subagentSyncOnly(fakePi);

check("tool_call handler registered", typeof handler === "function");
check("/subagent-sync registered", !!commands["subagent-sync"]);

// async:true launch is coerced before execution, not blocked
const ev1 = { toolName: "subagent", toolCallId: "t1", input: { agent: "w", task: "t", async: true } };
const res1 = handler(ev1);
check("async:true coerced to false", ev1.input.async === false && res1 === undefined);

// workflow script launch without async is forced foreground
const ev2 = { toolName: "subagent", toolCallId: "t2", input: { workflow: true, args: {} } };
check("workflow forced sync", handler(ev2) === undefined && ev2.input.async === false);

// other tools untouched
const ev3 = { toolName: "bash", toolCallId: "t3", input: { command: "ls" } };
check("bash untouched", handler(ev3) === undefined && ev3.input.async === undefined);

// management action untouched
const ev4 = { toolName: "subagent", toolCallId: "t4", input: { action: "status" } };
check("status untouched", handler(ev4) === undefined && ev4.input.async === undefined);

// scheduled launch blocked with reason
const ev5 = { toolName: "subagent", toolCallId: "t5", input: { action: "schedule.create" } };
const res5 = handler(ev5);
check("schedule.create blocked", !!res5 && res5.block === true && typeof res5.reason === "string" && ev5.input.async === undefined);

// status command reports counters through notify
let notified = "";
await commands["subagent-sync"].handler("", { ui: { notify: (m) => { notified = m; } } });
check("status command reports", notified.includes("async:false") && notified.includes("2 coerced") && notified.includes("1 deferred"));

console.log("RESULT pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
