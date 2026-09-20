import type { CoreStatus } from "mini-core/types";
import { readCoreStatus } from "mini-core/types";
const s: CoreStatus = readCoreStatus();
console.log(s.modes.mode);
