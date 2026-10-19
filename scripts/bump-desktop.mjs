#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  conf: join(root, 'desktop/src-tauri/tauri.conf.json'),
  cargo: join(root, 'desktop/src-tauri/Cargo.toml'),
  lock: join(root, 'desktop/src-tauri/Cargo.lock'),
  changelog: join(root, 'CHANGELOG.md'),
};
const repo = process.env.GITHUB_REPOSITORY || 'williamrogersdev/eavesy';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim();
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current, kind) {
  if (SEMVER.test(kind)) return kind;
  const [, major, minor, patch] = current.match(SEMVER).map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${kind}"`);
}

const SECTIONS = { feat: 'Added', fix: 'Fixed', perf: 'Changed', refactor: 'Changed', revert: 'Changed' };
const SKIP = new Set(['chore', 'ci', 'docs', 'test', 'build', 'style']);

export function entriesFromSubjects(subjects) {
  const grouped = { Added: [], Changed: [], Fixed: [] };
  for (const subject of subjects) {
    const match = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
    const type = match ? match[1].toLowerCase() : '';
    if (SKIP.has(type)) continue;
    let text = (match ? match[2] : subject).trim();
    const pr = text.match(/\s*\(#(\d+)\)$/);
    if (pr) text = text.slice(0, pr.index);
    text = `Mac app: ${text}`;
    if (pr) text += ` ([#${pr[1]}](https://github.com/${repo}/pull/${pr[1]}))`;
    grouped[SECTIONS[type] || 'Changed'].push(`- ${text}`);
  }
  return Object.entries(grouped)
    .filter(([, items]) => items.length)
    .map(([heading, items]) => `### ${heading}\n\n${items.join('\n')}`)
    .join('\n\n');
}

export function insertRelease(changelog, version, date, generated) {
  const marker = '## [Unreleased]';
  const start = changelog.indexOf(marker);
  if (start === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  const bodyStart = start + marker.length;
  const next = changelog.indexOf('\n## [', bodyStart);
  const bodyEnd = next === -1 ? changelog.length : next + 1;
  const unreleased = changelog.slice(bodyStart, bodyEnd).trim();
  const body = unreleased || generated;
  if (!body) throw new Error('Nothing to release: [Unreleased] is empty and no desktop changes since the last tag');
  return (
    changelog.slice(0, start) +
    `${marker}\n\n## [${version}] - ${date} - desktop\n\n${body}\n\n` +
    changelog.slice(bodyEnd)
  );
}

function replaceOnce(text, pattern, replacement, file) {
  if (!pattern.test(text)) fail(`Could not find the version in ${file}`);
  return text.replace(pattern, replacement);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const bump = args.find((a) => !a.startsWith('--'));
  if (!bump) fail('Usage: node scripts/bump-desktop.mjs patch|minor|major|X.Y.Z [--dry-run]');
  const conf = readFileSync(paths.conf, 'utf8');
  const current = JSON.parse(conf).version;
  if (!SEMVER.test(current)) fail(`tauri.conf.json version "${current}" is not X.Y.Z`);
  if (!SEMVER.test(bump) && !['patch', 'minor', 'major'].includes(bump)) fail(`Unknown bump "${bump}"`);
  const version = nextVersion(current, bump);
  const tag = `desktop-v${version}`;
  if (git('tag', '-l', tag)) fail(`${tag} already exists`);

  const lastTag = git('tag', '-l', 'desktop-v*', '--sort=-v:refname').split('\n')[0];
  const range = lastTag ? [`${lastTag}..HEAD`] : [];
  const subjects = git('log', '--no-merges', '--format=%s', ...range, '--', 'desktop/')
    .split('\n')
    .filter((s) => s && !/^chore\(release\)/.test(s));
  const date = new Date().toISOString().slice(0, 10);
  const changelog = insertRelease(readFileSync(paths.changelog, 'utf8'), version, date, entriesFromSubjects(subjects));

  const esc = current.replace(/\./g, '\\.');
  const files = {
    [paths.conf]: replaceOnce(conf, new RegExp(`("version"\\s*:\\s*")${esc}"`), `$1${version}"`, 'tauri.conf.json'),
    [paths.cargo]: replaceOnce(readFileSync(paths.cargo, 'utf8'), new RegExp(`^version = "${esc}"`, 'm'), `version = "${version}"`, 'Cargo.toml'),
    [paths.lock]: replaceOnce(
      readFileSync(paths.lock, 'utf8'),
      new RegExp(`(name = "eavesy"\\nversion = ")${esc}"`),
      `$1${version}"`,
      'Cargo.lock',
    ),
    [paths.changelog]: changelog,
  };

  if (dryRun) {
    const section = changelog.slice(changelog.indexOf(`## [${version}]`)).split('\n## [')[0];
    console.error(`${current} → ${version} (since ${lastTag || 'the first commit'})\n\n${section}`);
  } else {
    for (const [file, text] of Object.entries(files)) writeFileSync(file, text);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
  console.log(version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
