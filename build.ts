/**
 * Bundles vendor-repo.ts into a single Node-compatible ESM file at dist/vendor-repo.js.
 * Run with `bun run build`.
 */
import { chmodSync } from "node:fs";

const result = await Bun.build({ entrypoints: ["vendor-repo.ts"], target: "node", format: "esm" });
const output = result.outputs[0];
if (!result.success || !output) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Swap the Bun shebang for Node so the published bin runs anywhere Node 20+ is installed.
const code = (await output.text()).replace(/^#!.*\n/, "").replace(/^\/\/ @bun\n/m, "");
await Bun.write("dist/vendor-repo.js", `#!/usr/bin/env node\n${code}`);
chmodSync("dist/vendor-repo.js", 0o755);
console.log("Built dist/vendor-repo.js");
