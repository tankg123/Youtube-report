// Copies the runtime assets of pdfjs-dist (character maps, standard fonts, image decoders, colour profiles)
// into public/pdfjs/<version>/ so that Vite serves them in development and copies them into dist/ on build.
// The /pdf editor fetches single files from there on demand; without them CJK text, JPEG 2000 / JBIG2 /
// CCITT images and CMYK colours are wrong or missing. Runs before "npm run dev" and "npm run build".
//
//   node pdfjs-assets.mjs [--quiet] [--check]
//
// The folder is versioned and ignored by git: the copy is skipped when the stamp matches the installed
// pdfjs-dist version and redone (old versions removed) after an upgrade.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const checkOnly = args.includes("--check");

const require = createRequire(path.join(root, "package.json"));
const packageJsonPath = require.resolve("pdfjs-dist/package.json");
const packageRoot = path.dirname(packageJsonPath);
const { version } = JSON.parse(await readFile(packageJsonPath, "utf8"));

const base = path.join(root, "public", "pdfjs");
const dest = path.join(base, version);
const stampFile = path.join(dest, ".complete");

// directory in the package -> the files needed at run time
const DIRECTORIES = [
  { name: "cmaps", keep: (file) => file.endsWith(".bcmap") || file === "LICENSE" },
  { name: "standard_fonts", keep: () => true },
  { name: "wasm", keep: () => true },
  { name: "iccs", keep: () => true }
];

const log = (...parts) => {
  if (!quiet) console.log(...parts);
};

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    bytes += (await stat(path.join(directory, entry.name))).size;
    files += 1;
  }
  return { bytes, files };
}

if (await exists(stampFile)) {
  log(`pdfjs assets ${version}: up to date (public/pdfjs/${version})`);
  process.exit(0);
}
if (checkOnly) {
  console.error(`pdfjs assets ${version} are missing: run "node pdfjs-assets.mjs"`);
  process.exit(1);
}

// Remove assets of other versions and any half-finished copy of this one.
await rm(base, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
let total = 0;
for (const { name, keep } of DIRECTORIES) {
  const from = path.join(packageRoot, name);
  const to = path.join(dest, name);
  await cp(from, to, { recursive: true, filter: (source) => source === from || keep(path.basename(source)) });
  const { bytes, files } = await directorySize(to);
  total += bytes;
  log(`  ${name.padEnd(15)} ${String(files).padStart(4)} files ${(bytes / 1024).toFixed(1).padStart(8)} kB`);
}
await writeFile(stampFile, `${version}\n`);
log(`pdfjs assets ${version} copied to public/pdfjs/${version} (${(total / 1024).toFixed(1)} kB)`);
