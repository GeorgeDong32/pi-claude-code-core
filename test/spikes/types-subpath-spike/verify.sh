#!/bin/zsh
# P0-SK-05 spike ① — verify a /types subpath survives npm pack → install and
# resolves for BOTH runtime import (node + jiti, the CCTUI consumption mode)
# and `import type` (tsc). Run: zsh verify.sh
set -euo pipefail
cd "$(dirname "$0")"
rm -rf consumer mini-core-*.tgz(N)

echo "== 1. npm pack =="
(cd mini-core && npm pack --quiet --pack-destination ..)
tarball=$(ls | grep '^mini-core-.*\.tgz$')
tar -tzf "$tarball" | sed 's/^/   packed: /'
if ! tar -tzf "$tarball" | grep -q "package/types/index.js"; then
  echo "FAIL: types/index.js not in tarball"; exit 1
fi
if ! tar -tzf "$tarball" | grep -q "package/types/index.d.ts"; then
  echo "FAIL: types/index.d.ts not in tarball"; exit 1
fi

echo "== 2. install into consumer =="
mkdir -p consumer
cd consumer
cat > package.json <<'EOF'
{ "name": "spike-consumer", "private": true, "type": "module" }
EOF
npm install --silent --no-audit --no-fund "../$tarball"

echo "== 3. runtime import via node =="
cat > check.mjs <<'EOF'
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
EOF
node check.mjs

echo "== 4. runtime import via jiti (CCTUI consumption mode) =="
cat > check-jiti.mjs <<'EOF'
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const mod = await jiti.import("mini-core/types");
if (typeof mod.readCoreStatus !== "function") throw new Error("jiti import failed");
console.log("jiti runtime OK");
EOF
npm install --silent --no-audit --no-fund jiti
node check-jiti.mjs

echo "== 5. tsc type resolution =="
cat > check-types.ts <<'EOF'
import type { CoreStatus } from "mini-core/types";
import { readCoreStatus } from "mini-core/types";
const s: CoreStatus = readCoreStatus();
console.log(s.modes.mode);
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "strict": true,
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["check-types.ts"]
}
EOF
npm install --silent --no-audit --no-fund --save-dev typescript
npx tsc -p .
node --experimental-strip-types check-types.ts
echo "tsc types OK"

echo ""
echo "SPIKE ① PASS: /types subpath layout works for node, jiti, and tsc."
