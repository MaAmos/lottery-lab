import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const name = `lottery-automation-source-${stamp}`, releases = path.join(root, "releases");
const output = path.join(releases, name);
await mkdir(output, { recursive: true });
const excluded = new Set(["node_modules", ".venv", "__pycache__", ".wrangler", ".git", "data", "dist", ".DS_Store"]);
const filter = filename => !filename.split(path.sep).some(part => excluded.has(part) || part.startsWith(".env") || part.startsWith(".dev.vars"));
for (const entry of [".github", ".gitignore", "README.md", "lottery_lab", "cloudflare", "vue-version"]) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true, filter });
}
const hashes = [];
async function walk(directory, prefix = "") {
  for (const entry of (await readdir(directory)).sort()) {
    const rel = path.posix.join(prefix, entry), absolute = path.join(directory, entry);
    if ((await stat(absolute)).isDirectory()) await walk(absolute, rel);
    else hashes.push(`${createHash("sha256").update(await readFile(absolute)).digest("hex")}  ${rel}`);
  }
}
await walk(output);
await writeFile(path.join(output, "SHA256SUMS"), hashes.join("\n") + "\n");
execFileSync("zip", ["-q", "-r", `${name}.zip`, name], { cwd: releases });
const archive = path.join(releases, `${name}.zip`);
await writeFile(`${archive}.sha256`, `${createHash("sha256").update(await readFile(archive)).digest("hex")}  ${name}.zip\n`);
console.log(JSON.stringify({ archive, directory: output, files: hashes.length, includes_public_history_baseline: true, includes_private_run_data: false }, null, 2));
