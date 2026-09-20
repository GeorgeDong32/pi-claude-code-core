import { readCoreStatus } from "mini-core/types";
const cases = [
  [undefined, () => ({ modes: { mode: "ask", workingStats: null }, version: 1 })],
];
const s1 = readCoreStatus(); // no global set → defaults
if (s1.modes.mode !== "") throw new Error("default failed: " + JSON.stringify(s1));
const fakeGlobal = { __miniCore: { version: 1, modes: { mode: "plan", workingStats: "x" } } };
const s2 = readCoreStatus(fakeGlobal);
if (s2.modes.mode !== "plan") throw new Error("fresh key failed");
const s3 = readCoreStatus({ __miniLegacy: { mode: "auto" } });
if (s3.modes.mode !== "auto") throw new Error("legacy fallback failed");
const s4 = readCoreStatus("garbage");
if (s4.modes.mode !== "") throw new Error("garbage input failed");
console.log("node runtime matrix OK");
