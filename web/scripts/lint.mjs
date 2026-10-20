import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ruleMap = JSON.parse(readFileSync(path.join(root, 'lint-rule-map.json'), 'utf8'));
const inverseRules = new Map();
for (const [eslintRule, nativeRule] of Object.entries(ruleMap)) {
  if (nativeRule === null) continue;
  if (!inverseRules.has(nativeRule)) inverseRules.set(nativeRule, []);
  inverseRules.get(nativeRule).push(eslintRule);
}
const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((arg) => arg !== '--json');
const delegatedPaths = new Set();
const residual = new ESLint({ cwd: root, overrideConfigFile: 'eslint.oxlint.config.mjs', overrideConfig: [{
  plugins: { 'lint-migration': { rules: { 'directives': {
    meta: { schema: [] },
    create(context) {
      // Use parser comment tokens, including multiline directives; text in
      // strings/templates must not influence which linter owns a file.
      for (const comment of context.sourceCode.getAllComments()) {
        const directive = /^\s*eslint-disable(?:-next-line|-line)?\b([\s\S]*)/.exec(comment.value);
        if (!directive) continue;
        const rules = directive[1].split('--')[0].trim().split(/[,\s]+/).filter(Boolean);
        if (!rules.length || rules.some((rule) => !Object.hasOwn(ruleMap, rule) || ruleMap[rule] === null)) delegatedPaths.add(context.filename);
      }
      return {};
    },
  } } } },
  rules: { 'lint-migration/directives': 'error' },
}] });
const results = await residual.lintFiles(files.length ? files : '.');

// Oxlint cannot decide whether an ESLint-only rule used a suppression. Delegate
// the whole file to the original configuration for bare/unsupported directives,
// including unused-directive validation. Ordinary files keep the fast path.
let referenceResults = [];
if (delegatedPaths.size) {
  const reference = new ESLint({ cwd: root, overrideConfigFile: 'eslint.config.mjs' });
  referenceResults = await reference.lintFiles([...delegatedPaths]);
}

const native = spawnSync(path.join(root, 'node_modules/.bin/oxlint'), [
  '--disable-nested-config', '--type-aware', '--report-unused-disable-directives-severity', 'error', '--format', 'json', ...(files.length ? files : ['.']),
], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
if (native.error || native.status === null || native.status > 1) throw new Error(`Oxlint failed: ${native.error?.message ?? native.stderr}`);
let diagnostics;
try { diagnostics = JSON.parse(native.stdout).diagnostics; }
catch { throw new Error(`Oxlint did not return diagnostics: ${native.stdout}\n${native.stderr}`); }
const combined = results.filter(({ filePath }) => !delegatedPaths.has(filePath)).concat(referenceResults);
const byPath = new Map(combined.map((result) => [result.filePath, result]));
for (const diagnostic of diagnostics) {
  const filePath = path.resolve(root, diagnostic.filename);
  if (delegatedPaths.has(filePath)) continue;
  const span = diagnostic.labels?.[0]?.span;
  const match = /^(\w[\w-]*)\((.*)\)$/.exec(diagnostic.code ?? '');
  let ruleId = null;
  if (diagnostic.code) {
    if (!match) throw new Error(`Unmapped Oxlint diagnostic: ${diagnostic.code}`);
    const scope = match[1] === 'react-hooks' ? 'react' : match[1];
    let nativeName = scope === 'eslint' ? match[2] : `${scope}/${match[2]}`;
    // Some TypeScript extension rules are implemented by core native rules.
    if (!inverseRules.has(nativeName) && scope === 'typescript' && inverseRules.get(match[2])?.includes(`@typescript-eslint/${match[2]}`)) nativeName = match[2];
    const candidates = inverseRules.get(nativeName);
    if (!candidates?.length) throw new Error(`Unmapped Oxlint diagnostic: ${diagnostic.code}; update lint-rule-map.json`);
    const typescript = /\.[cm]?tsx?$/.test(filePath);
    ruleId = candidates.find((candidate) => candidate.startsWith('@typescript-eslint/') === typescript) ?? candidates[0];
  }
  // In this pinned Oxlint version, unused directives have no code and this
  // exact message. Parser diagnostics likewise have no ESLint rule id.
  const unusedDirective = !diagnostic.code && diagnostic.message === 'Unused eslint-disable directive (no problems were reported).';
  const message = { ruleId, severity: diagnostic.severity === 'warning' ? 1 : 2,
    message: diagnostic.message, line: span?.line ?? 1, column: span?.column ?? 1,
    fatal: !diagnostic.code && !unusedDirective };
  let result = byPath.get(filePath);
  if (!result) { result = { filePath, messages: [] }; combined.push(result); byPath.set(filePath, result); }
  result.messages.push(message);
}
if (json) console.log(JSON.stringify(combined));
else {
  const formatter = await residual.loadFormatter('stylish');
  for (const result of combined) {
    result.errorCount = result.messages.filter((m) => m.severity === 2).length;
    result.warningCount = result.messages.filter((m) => m.severity === 1).length;
    result.fixableErrorCount = 0; result.fixableWarningCount = 0;
  }
  const formatted = formatter.format(combined);
  if (formatted) console.log(formatted);
}
process.exitCode = combined.some((result) => result.messages.some((message) => message.severity > 0)) ? 1 : 0;
