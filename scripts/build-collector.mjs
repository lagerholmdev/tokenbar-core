#!/usr/bin/env node
import * as esbuild from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distDir = join(root, "dist");
const outFile = join(distDir, "tokenbar-collector.js");

mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: outFile,
  external: ["better-sqlite3"],
  banner: { js: "#!/usr/bin/env node" },
});

let content = readFileSync(outFile, "utf8");
if (!content.startsWith("#!")) {
  content = "#!/usr/bin/env node\n" + content;
  writeFileSync(outFile, content, "utf8");
}
chmodSync(outFile, 0o755);

copyFileSync(
  join(__dirname, "com.tokenbar.collector.plist"),
  join(distDir, "com.tokenbar.collector.plist"),
);
console.log("Built dist/tokenbar-collector.js and dist/com.tokenbar.collector.plist");
