// Bundles the API into dist/server.js. Workspace packages (TypeScript source) are bundled;
// npm dependencies stay external and come from node_modules at run time.
import { readFileSync } from "node:fs";

import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@platform/"));

await build({
  entryPoints: ["src/server.ts", "src/cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  logLevel: "info",
});
