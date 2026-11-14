import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "mods", "flow", "lib");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith(".ts")) continue;
  const source = fs.readFileSync(path.join(srcDir, file), "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  });
  const js = transpiled.outputText.replace(/from "(\.[^"]+)\.ts"/g, 'from "$1.js"');
  fs.writeFileSync(path.join(outDir, file.replace(/\.ts$/, ".js")), js);
}

console.log("emitted", outDir);
