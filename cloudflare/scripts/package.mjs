import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../vue-version/client/node_modules/esbuild/lib/main.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const releaseRoot = path.join(root, "releases");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const name = `lottery-cloudflare-${stamp}`;
const output = path.join(releaseRoot, name);
await mkdir(output, { recursive: true });

// A same-origin build must not accidentally inherit an old production API URL.
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  cwd: path.join(root, "vue-version/client"), stdio: "inherit",
  env: { ...process.env, VITE_API_BASE_URL: "" },
});
await build({
  entryPoints: [path.join(root, "cloudflare/src/index.js")],
  outfile: path.join(output, "worker.js"), bundle: true, format: "esm",
  platform: "browser", target: "es2022", legalComments: "none",
});
await cp(path.join(root, "vue-version/client/dist"), path.join(output, "assets"), { recursive: true });
await cp(path.join(root, "cloudflare/wrangler.template.json"), path.join(output, "wrangler.json"));
await cp(path.join(root, "cloudflare/DEPLOY.md"), path.join(output, "DEPLOY.md"));
await cp(path.join(root, "cloudflare/AUTOMATION.md"), path.join(output, "AUTOMATION.md"));
const oldSchema = await readFile(path.join(root, "vue-version/worker/schema.sql"), "utf8");
const researchSchema = await readFile(path.join(root, "vue-version/worker/research-schema.sql"), "utf8");
await writeFile(path.join(output, "schema.sql"), oldSchema + "\n" + researchSchema);

const tooling = JSON.parse(await readFile(path.join(root, "cloudflare/package.json"), "utf8"));
const releasePackage = {
  name: tooling.name, version: tooling.version, private: true, type: "module", engines: tooling.engines,
  scripts: {
    dev: "wrangler dev --port 8790",
    "db:local": "wrangler d1 execute DB --local --file=./schema.sql",
    "db:remote": "wrangler d1 execute DB --remote --file=./schema.sql",
    check: "wrangler deploy --dry-run --outdir .wrangler/check",
    deploy: "wrangler deploy",
    tail: "wrangler tail",
  },
  devDependencies: tooling.devDependencies,
};
await writeFile(path.join(output, "package.json"), JSON.stringify(releasePackage, null, 2) + "\n");
await cp(path.join(root, "cloudflare/package-lock.json"), path.join(output, "package-lock.json"));
const report = JSON.parse(await readFile(path.join(root, "vue-version/worker/src/generated/research.json"), "utf8"));
await writeFile(path.join(output, "model-report.json"), JSON.stringify(report, null, 2) + "\n");

const release = {
  built_at: new Date().toISOString(), model_run_id: report.model_run_id,
  dataset_sha256: report.dataset_sha256,
  node_version: process.version, wrangler_version: tooling.devDependencies.wrangler,
  deployment: "one Worker with Static Assets + D1; frontend uses same-origin /api",
  model_deadlines: Object.fromEntries(Object.entries(report.lotteries).map(([kind, value]) => {
    const deadline = `${value.target_date_estimate}T20:00:00+08:00`;
    return [kind, { last_issue: value.coverage.last_issue, generation_deadline: deadline,
      stale_at_packaging: Date.now() >= Date.parse(deadline) }];
  })),
  includes_raw_training_data: false, remotely_deployed: false,
  automation: "GitHub Actions -> authenticated Worker publish -> D1 active snapshot; requires one-time secrets setup",
};
await writeFile(path.join(output, "release-info.json"), JSON.stringify(release, null, 2) + "\n");

async function filesIn(directory, prefix = "") {
  const result = [];
  for (const file of (await readdir(directory)).sort()) {
    const rel = path.posix.join(prefix, file);
    const absolute = path.join(directory, file);
    if ((await stat(absolute)).isDirectory()) result.push(...await filesIn(absolute, rel));
    else result.push(rel);
  }
  return result;
}
const checksums = [];
for (const file of await filesIn(output)) {
  checksums.push(`${createHash("sha256").update(await readFile(path.join(output, file))).digest("hex")}  ${file}`);
}
await writeFile(path.join(output, "SHA256SUMS"), checksums.join("\n") + "\n");
execFileSync("zip", ["-q", "-r", `${name}.zip`, name], { cwd: releaseRoot });
const archive = path.join(releaseRoot, `${name}.zip`);
await writeFile(`${archive}.sha256`, `${createHash("sha256").update(await readFile(archive)).digest("hex")}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ directory: output, archive, ...release }, null, 2));
