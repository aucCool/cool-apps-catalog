import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules/pdfjs-dist/build");
const dest = path.join(root, "public/pdfjs");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

let copied = 0;
for (const name of readdirSync(source)) {
  if (!/\.(mjs|js|wasm)$/.test(name) || name.endsWith(".map")) continue;
  copyFileSync(path.join(source, name), path.join(dest, name));
  copied += 1;
}
if (copied === 0) throw new Error(`No pdf.js build files in ${source}`);
console.log(`Copied ${copied} pdf.js files to public/pdfjs`);
