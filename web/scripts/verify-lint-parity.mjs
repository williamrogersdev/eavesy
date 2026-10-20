import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
const folder = path.join(root, 'src', `lint-parity-${randomUUID()}`);
const jsFile = path.join(root, `lint-parity-${randomUUID()}.cjs`);
const original = new ESLint({ cwd: root, overrideConfigFile: 'eslint.config.mjs' });
const residualLint = new ESLint({ cwd: root, overrideConfigFile: 'eslint.oxlint.config.mjs' });
const config = JSON.parse(readFileSync(path.join(root, '.oxlintrc.json'), 'utf8'));
const ruleMap = JSON.parse(readFileSync(path.join(root, 'lint-rule-map.json'), 'utf8'));
const compiled = spawnSync(path.join(root, 'node_modules/.bin/oxlint'), ['--print-config', '--disable-nested-config'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
if (compiled.error || compiled.status !== 0) throw new Error(`Oxlint configuration did not compile: ${compiled.error?.message ?? compiled.stderr}`);
const validated = JSON.parse(compiled.stdout);
if (!validated.options?.typeAware || !['typescript', 'react'].every((plugin) => validated.plugins.includes(plugin))) throw new Error('Required native plugins or type-aware mode are disabled');
const severity = { deny: 2, warn: 1, allow: 0 };
const normalizeNative = (value) => typeof value === 'string' ? [severity[value]] : [severity[value[0]], ...value[1]];
if (validated.overrides.length !== config.overrides.length) throw new Error('Native override compilation changed scope');
for (let i = 0; i < config.overrides.length; i++) {
  if (JSON.stringify(validated.overrides[i].files) !== JSON.stringify(config.overrides[i].files)) throw new Error('Native override globs changed scope');
  for (const [rule, value] of Object.entries(config.overrides[i].rules ?? {})) {
    if (JSON.stringify(normalizeNative(validated.overrides[i].rules[rule])) !== JSON.stringify(value)) throw new Error(`Oxlint compiled different options for ${rule}`);
  }
}

// Every enabled ESLint rule must remain enabled with the same options in
// either the native configuration or the residual ESLint pass, for every file.
const referenceFiles = await original.lintFiles('.');
const listing = spawnSync(path.join(root, 'node_modules/.bin/oxlint'), ['--disable-nested-config', '--debug', 'files', '.'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
if (listing.error || listing.status !== 0) throw new Error(`Oxlint file listing failed: ${listing.error?.message ?? listing.stderr}`);
const nativeFiles = new Set(listing.stdout.trim().split(/\r?\n/).map((file) => path.resolve(root, file)));
if (!referenceFiles.length || !nativeFiles.has(path.join(root, 'eslint.config.mjs'))) throw new Error('Empty or unexpected lint file listing');
for (const { filePath } of referenceFiles) {
  if (!nativeFiles.has(filePath)) throw new Error(`Oxlint skips ESLint file ${filePath}`);
  const relative = path.relative(root, filePath);
  const before = await original.calculateConfigForFile(filePath);
  const after = await residualLint.calculateConfigForFile(filePath);
  const nativeRules = Object.fromEntries(Object.entries(validated.rules ?? {}).map(([rule, value]) => [rule, normalizeNative(value)]));
  for (const override of validated.overrides) {
    if (override.files.some((glob) => path.matchesGlob(relative, glob))) {
      for (const [rule, value] of Object.entries(override.rules ?? {})) nativeRules[rule] = normalizeNative(value);
    }
  }
  for (const [rule, options] of Object.entries(before.rules)) {
    if (options[0] === 0) continue;
    if (!Object.hasOwn(ruleMap, rule)) throw new Error(`${relative}: unmapped reference rule ${rule}; update lint-rule-map.json and verify coverage`);
    const nativeName = ruleMap[rule];
    const residualOwns = JSON.stringify(after.rules[rule]) === JSON.stringify(options);
    const nativeOwns = nativeName !== null && nativeRules[nativeName]?.[0] > 0 && JSON.stringify(nativeRules[nativeName]) === JSON.stringify(options);
    if (!residualOwns && !nativeOwns) throw new Error(`${relative}: dropped or changed ${rule}: ${JSON.stringify(options)}`);
    if (nativeOwns && after.rules[rule]?.[0] > 0) throw new Error(`${relative}: duplicate rule ownership for ${rule}`);
  }
}
console.log(`Preserved configured rules and options for ${referenceFiles.length} ESLint files.`);
const cases = [
  ['syntax.ts', 'export const broken = ;\n', ['fatal']],
  ['hooks.tsx', `import { useEffect, useState } from 'react';
export function useProbe(flag: boolean, dependency: number) {
  if (flag) useState(0);
  useEffect(() => { console.log(dependency); }, []);
  return 0;
}`, ['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps']],
  ['typed.ts', `export const explicit: any = 1;
export const unsafe: number = JSON.parse('1');
Promise.resolve();
const unused = 1;
const _allowed = 1;
`, ['@typescript-eslint/no-explicit-any', '@typescript-eslint/no-unsafe-assignment', '@typescript-eslint/no-floating-promises', '@typescript-eslint/no-unused-vars']],
  ['scope.test.ts', `Promise.resolve();
export const explicit: any = 1;
`, ['@typescript-eslint/no-explicit-any']],
  ['aliases.test.ts', `export const kept = 1;
new Array();
0;
`, ['@typescript-eslint/no-array-constructor', '@typescript-eslint/no-unused-expressions']],
  ['suppression.ts', `// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const explicit: any = 1;
`, []],
  ['unused-suppression.ts', `// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const value = 1;
`, ['unused-disable']],
  ['unused-fallback.cjs', `// eslint-disable-next-line no-undef
module.exports = 1;
`, ['unused-disable']],
  ['valid-fallback.cjs', `// eslint-disable-next-line no-undef
module.exports = undeclaredLintProbe;
`, []],
  ['described-fallback.cjs', `  // eslint-disable-next-line   no-undef -- injected by a host
module.exports = undeclaredLintProbe;
`, []],
  ['mixed-fallback.cjs', `/* eslint-disable no-debugger,
no-undef */
debugger;
module.exports = undeclaredLintProbe;
`, []],
  ['blanket.cjs', `/* eslint-disable */
module.exports = undeclaredLintProbe;
`, []],
  ['unused-blanket.cjs', `/* eslint-disable */
module.exports = 1;
`, ['unused-disable']],
];

function run(binary, args) {
  const result = spawnSync(binary === 'bun' ? process.execPath : path.join(root, 'node_modules/.bin', binary), args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.signal || result.status === null || result.status > 1) throw new Error(`${binary}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return JSON.parse(result.stdout);
}
function eslintCodes(output) {
  return output.flatMap((file) => file.messages.map((message) => message.fatal ? 'fatal' : message.ruleId ?? (message.message.startsWith('Unused eslint-disable directive') ? 'unused-disable' : 'unmapped-null-rule')));
}
function equal(actual, expected, label) {
  const normalize = (values) => JSON.stringify([...new Set(values)].sort());
  if (normalize(actual) !== normalize(expected)) throw new Error(`${label}: expected ${normalize(expected)}, received ${normalize(actual)}`);
}

mkdirSync(folder);
try {
  for (const [name, source, expected] of [...cases, [jsFile, 'module.exports = undeclaredLintProbe;\n', ['no-undef']]]) {
    const file = path.isAbsolute(name) ? name : path.join(folder, name);
    writeFileSync(file, source);
    const baseline = eslintCodes(run('eslint', ['--config', 'eslint.config.mjs', '--format', 'json', file]));
    const combined = eslintCodes(run('bun', ['scripts/lint.mjs', '--json', file]));
    equal(baseline, expected, `${name}: ESLint contract`);
    equal(combined, expected, `${name}: combined lint`);
    console.log(`${name}: preserved ${expected.join(', ') || 'valid suppression'}`);
    rmSync(file);
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
  rmSync(jsFile, { force: true });
}
