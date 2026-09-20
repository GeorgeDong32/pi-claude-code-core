import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const mod = await jiti.import("mini-core/types");
if (typeof mod.readCoreStatus !== "function") throw new Error("jiti import failed");
console.log("jiti runtime OK");
