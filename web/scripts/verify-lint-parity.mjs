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

// Every enabled ESLint rule must remain enabled with the same options in
// either the native configuration or the residual ESLint pass, for every file.
const referenceFiles = await original.lintFiles('.');
const listing = spawnSync(path.join(root, 'node_modules/.bin/oxlint'), ['--debug', 'files', '.'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
if (listing.error || listing.status !== 0) throw new Error(`Oxlint file listing failed: ${listing.error?.message ?? listing.stderr}`);
const nativeFiles = new Set(listing.stdout.trim().split(/\r?\n/).map((file) => path.resolve(root, file)));
for (const { filePath } of referenceFiles) {
  if (!nativeFiles.has(filePath)) throw new Error(`Oxlint skips ESLint file ${filePath}`);
  const relative = path.relative(root, filePath);
  const before = await original.calculateConfigForFile(filePath);
  const after = await residualLint.calculateConfigForFile(filePath);
  const nativeRules = { ...config.rules };
  for (const override of config.overrides) {
    if (override.files.some((glob) => path.matchesGlob(relative, glob))) Object.assign(nativeRules, override.rules);
  }
  for (const [rule, options] of Object.entries(before.rules)) {
    if (options[0] === 0) continue;
    let nativeName = rule.replace('@typescript-eslint/', 'typescript/').replace('react-hooks/', 'react/');
    if (['typescript/no-unused-vars', 'typescript/no-unused-expressions', 'typescript/no-array-constructor'].includes(nativeName)) nativeName = nativeName.slice('typescript/'.length);
    const retained = [after.rules[rule], nativeRules[nativeName]].some((value) => JSON.stringify(value) === JSON.stringify(options));
    if (!retained) throw new Error(`${relative}: dropped or changed ${rule}: ${JSON.stringify(options)}`);
  }
}
console.log(`Preserved configured rules and options for ${referenceFiles.length} ESLint files.`);
const cases = [
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
  ['suppression.ts', `// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const explicit: any = 1;
`, []],
  ['unused-suppression.ts', `// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const value = 1;
`, ['unused-disable']],
];

function run(binary, args) {
  const result = spawnSync(path.join(root, 'node_modules/.bin', binary), args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.signal || result.status === null || result.status > 1) throw new Error(`${binary}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return JSON.parse(result.stdout);
}
function eslintCodes(output) {
  return output.flatMap((file) => file.messages.map((message) => message.ruleId ?? 'unused-disable'));
}
function nativeCodes(output, file) {
  return output.diagnostics.filter((d) => path.resolve(root, d.filename) === file).map((d) => {
    if (d.code?.includes('unused-disable')) return 'unused-disable';
    const match = /^(\w[\w-]*)\((.*)\)$/.exec(d.code ?? '');
    if (!match) return d.code ?? 'unused-disable';
    if (match[1] === 'typescript') return `@typescript-eslint/${match[2]}`;
    if (match[1] === 'react' || match[1] === 'react-hooks') return `react-hooks/${match[2]}`;
    if (match[2] === 'no-unused-vars' && /\.tsx?$/.test(file)) return '@typescript-eslint/no-unused-vars';
    return match[2];
  });
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
    const native = nativeCodes(run('oxlint', ['--type-aware', '--report-unused-disable-directives-severity', 'error', '--format', 'json', file]), file);
    const residual = eslintCodes(run('eslint', ['--config', 'eslint.oxlint.config.mjs', '--format', 'json', file]));
    equal(baseline, expected, `${name}: ESLint contract`);
    equal([...native, ...residual], expected, `${name}: combined lint`);
    console.log(`${name}: preserved ${expected.join(', ') || 'valid suppression'}`);
    rmSync(file);
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
  rmSync(jsFile, { force: true });
}
