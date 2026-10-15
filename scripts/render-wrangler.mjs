#!/usr/bin/env node
// Fills the account-specific values in the three wrangler configs from env.
//
// The committed configs carry obviously fake placeholder IDs so the repo runs
// locally with no Cloudflare account. Wrangler reads CLOUDFLARE_ACCOUNT_ID
// itself, but D1/KV IDs and route domains cannot come from env, so deploys
// run this first. It edits the files in place after saving the originals under
// .eavesy-render/; --restore puts them back (and refuses if you edited the
// rendered files in the meantime, so it never discards unrelated changes).
//
//   EAVESY_D1_DATABASE_ID   required  D1 database UUID
//   EAVESY_KV_CACHE_ID      required  KV namespace ID for the web Worker
//   EAVESY_APP_DOMAIN       optional  custom domain for the web Worker (e.g. eavesy.com)
//   EAVESY_WWW_DOMAIN       optional  extra custom domain for the web Worker
//   EAVESY_MCP_DOMAIN       optional  custom domain for the MCP Worker
//
// Unset domains (or the value `none`) drop the route, so the Worker serves from
// *.workers.dev.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['web/wrangler.jsonc', 'workers/processing/wrangler.toml', 'workers/mcp/wrangler.toml'];

const STATE = join(root, '.eavesy-render');
const manifestPath = join(STATE, 'manifest.json');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const backupPath = (file) => join(STATE, file.replaceAll('/', '__'));
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

// A file is safe to touch if it was never rendered or is exactly what we rendered.
function edited(file) {
  return manifest[file] && sha(readFileSync(join(root, file), 'utf8')) !== manifest[file];
}

if (process.argv.includes('--restore')) {
  const blocked = FILES.filter((f) => manifest[f] && edited(f));
  if (blocked.length) {
    console.error(`render-wrangler: ${blocked.join(', ')} changed since rendering; not restoring.`);
    console.error(`Originals are in ${STATE}. Compare with diff, then copy or edit by hand.`);
    process.exit(1);
  }
  for (const f of FILES) {
    if (manifest[f]) writeFileSync(join(root, f), readFileSync(backupPath(f), 'utf8'));
    delete manifest[f];
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log('render-wrangler: restored the original configs');
  process.exit(0);
}

const PLACEHOLDER = {
  d1: '00000000-0000-0000-0000-000000000000',
  kv: '00000000000000000000000000000000',
  app: 'app.example.invalid',
  www: 'www.example.invalid',
  mcp: 'mcp.example.invalid',
  appUrl: 'http://localhost:3000',
};
const env = (k) => {
  const v = (process.env[k] ?? '').trim();
  return v.toLowerCase() === 'none' ? '' : v;
};
const d1 = env('EAVESY_D1_DATABASE_ID');
const kv = env('EAVESY_KV_CACHE_ID');
const app = env('EAVESY_APP_DOMAIN');
const www = env('EAVESY_WWW_DOMAIN');
const mcp = env('EAVESY_MCP_DOMAIN');

const missing = [!d1 && 'EAVESY_D1_DATABASE_ID', !kv && 'EAVESY_KV_CACHE_ID'].filter(Boolean);
if (missing.length) {
  console.error(`render-wrangler: set ${missing.join(' and ')} (see docs/SELF_HOSTING.md)`);
  process.exit(1);
}
if (!/^[0-9a-f-]{36}$/i.test(d1) || !/^[0-9a-f]{32}$/i.test(kv)) {
  console.error('render-wrangler: D1 ID must be a UUID and the KV ID 32 hex characters');
  process.exit(1);
}
for (const d of [app, www, mcp]) {
  if (d && !/^[a-z0-9.-]+$/i.test(d)) {
    console.error(`render-wrangler: invalid domain "${d}"`);
    process.exit(1);
  }
}

// Drop route entries whose domain is unset, then substitute the rest.
const dropRoute = (text, placeholder) =>
  text.split('\n').filter((l) => !(l.includes(placeholder) && l.includes('custom_domain'))).join('\n');

function render(file) {
  if (edited(file)) {
    console.error(`render-wrangler: ${file} changed since it was rendered; run --restore first.`);
    process.exit(1);
  }
  mkdirSync(STATE, { recursive: true });
  // Always render from the pristine original, so re-rendering with new values works.
  if (!manifest[file]) writeFileSync(backupPath(file), readFileSync(join(root, file), 'utf8'));
  let t = readFileSync(backupPath(file), 'utf8');
  t = t.replaceAll(PLACEHOLDER.d1, d1).replaceAll(PLACEHOLDER.kv, kv);
  for (const [key, value] of [['app', app], ['www', www], ['mcp', mcp]]) {
    t = value ? t.replaceAll(PLACEHOLDER[key], value) : dropRoute(t, PLACEHOLDER[key]);
  }
  if (app) t = t.replaceAll(PLACEHOLDER.appUrl, `https://${app}`);
  // An emptied routes list is invalid TOML/JSON-with-trailing-comma noise; remove it entirely.
  t = t.replace(/\nroutes = \[\s*\]\n/, '\n').replace(/\n\s*"routes": \[\s*\],?/, '');
  // Tolerate a trailing comma left behind by a removed final route entry.
  t = t.replace(/,(\s*\])/g, '$1');
  writeFileSync(join(root, file), t);
  manifest[file] = sha(t);
}

FILES.forEach(render);
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log('render-wrangler: updated', FILES.join(', '));
