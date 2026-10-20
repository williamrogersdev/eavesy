import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const projects = ["web", "workers/processing", "workers/mcp", "web/test"];
const compilers = ["tsc", "tsrs"] as const;
const runs = 5;
const scratch = mkdtempSync(join(tmpdir(), "eavesy-typecheck-"));
let compatible = true;

const packageDir = (project: string) => project === "web/test" ? "web" : project;
const projectArgs = (project: string) => project === "web/test" ? ["--project", "test/tsconfig.json"] : [];

function invoke(project: string, compiler: (typeof compilers)[number], args: string[]) {
  const binary = join(root, packageDir(project), "node_modules/.bin", compiler);
  const result = spawnSync(binary, args, { cwd: join(root, packageDir(project)), encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.signal || result.status === null) {
    throw new Error(`${project}: could not run ${binary}: ${result.error?.message ?? result.signal ?? "no exit status"}`);
  }
  return result;
}

function sourceFiles(project: string, compiler: (typeof compilers)[number]) {
  const result = invoke(project, compiler, ["--listFilesOnly", "--pretty", "false", ...projectArgs(project)]);
  if (result.status !== 0) throw new Error(`${project}/${compiler}: file listing failed: ${result.stdout}${result.stderr}`);
  // Library declarations differ by compiler version; compare repository sources.
  const files = result.stdout.split(/\r?\n/).filter((file) => file.startsWith(`${root}/`) && !file.includes("/node_modules/")).sort();
  if (!files.length) throw new Error(`${project}/${compiler}: no repository source files found`);
  return files;
}

function check(project: string, compiler: (typeof compilers)[number]) {
  const started = performance.now();
  const result = invoke(project, compiler, [
    "--noEmit", "--pretty", "false",
    ...projectArgs(project),
    // Give each compiler its own empty incremental cache on every run.
    "--incremental", "--tsBuildInfoFile", join(scratch, `${randomUUID()}.tsbuildinfo`),
  ]);
  return { seconds: (performance.now() - started) / 1000, status: result.status,
    output: `${result.stdout}${result.stderr}`.trim() };
}

try {
  console.log(`5 timed runs after one warm-up; empty incremental caches; alternating compiler order.`);
  console.log(`Host: ${process.platform}/${process.arch}. Times include process startup.`);
  for (const project of projects) {
    console.log(`\n${project}`);
    const files = { tsc: sourceFiles(project, "tsc"), tsrs: sourceFiles(project, "tsrs") };
    const sameFiles = JSON.stringify(files.tsc) === JSON.stringify(files.tsrs);
    console.log(`  Repository source files: tsc ${files.tsc.length}, tsrs ${files.tsrs.length}; identical: ${sameFiles}`);
    const warmups = [] as ReturnType<typeof check>[];
    for (const compiler of compilers) {
      const version = invoke(project, compiler, ["--version"]);
      if (version.status !== 0) throw new Error(`${project}/${compiler}: version failed: ${version.stdout}${version.stderr}`);
      console.log(`  ${compiler}: ${version.stdout.trim()}`);
      const warmup = check(project, compiler);
      warmups.push(warmup);
      if (warmup.status !== 0) console.log(`  ${compiler} warm-up failed: ${warmup.output}`);
    }
    const results = { tsc: [] as ReturnType<typeof check>[], tsrs: [] as ReturnType<typeof check>[] };
    for (let run = 0; run < runs; run++) {
      for (const compiler of run % 2 ? [...compilers].reverse() : compilers) {
        results[compiler].push(check(project, compiler));
      }
    }
    for (const compiler of compilers) {
      const samples = results[compiler];
      const sorted = samples.map((sample) => sample.seconds).sort((a, b) => a - b);
      console.log(`  ${compiler}: median ${sorted[2].toFixed(3)}s; range ${sorted[0].toFixed(3)}–${sorted[4].toFixed(3)}s; exits ${samples.map((s) => s.status).join(",")}`);
      if (samples[0].output) console.log(samples[0].output);
    }
    const passed = sameFiles && warmups.every((r) => r.status === 0) && compilers.every((compiler) => results[compiler].every((r) => r.status === 0));
    compatible &&= passed;
    if (passed) {
      const median = (compiler: (typeof compilers)[number]) => results[compiler].map((r) => r.seconds).sort((a, b) => a - b)[2];
      console.log(`  Both pass; tsrs speedup: ${(median("tsc") / median("tsrs")).toFixed(2)}x.`);
    } else {
      console.log("  Compatibility gate failed. Timings of failed checks do not establish a valid speedup.");
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = compatible ? 0 : 1;
