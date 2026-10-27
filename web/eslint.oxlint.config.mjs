import oxlint from 'eslint-plugin-oxlint';
import { fileURLToPath } from 'node:url';
import original from './eslint.config.mjs';

// Keep ESLint's original configuration as the migration contract and fallback.
// Oxlint owns only the explicitly configured native rules. ESLint still checks
// unsupported rules and its existing suppression directives.
const withoutTypePrograms = original.map((entry) => {
  const parserOptions = entry.languageOptions?.parserOptions;
  if (!parserOptions) return entry;
  const syntaxOptions = { ...parserOptions };
  delete syntaxOptions.projectService;
  delete syntaxOptions.project;
  return { ...entry, languageOptions: { ...entry.languageOptions, parserOptions: syntaxOptions } };
});

export default [
  ...withoutTypePrograms,
  ...(await oxlint.buildFromConfigFile(fileURLToPath(new URL('./.oxlintrc.json', import.meta.url)))),
  // Suppressions for rules now owned by Oxlint are validated by Oxlint instead.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
];
