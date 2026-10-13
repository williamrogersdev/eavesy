import { env as cfEnv } from 'cloudflare:workers';

export interface CloudflareContext<Env = typeof cfEnv> {
  env: Env;
}

export function getCloudflareContext<Env = typeof cfEnv>(): CloudflareContext<Env> {
  return { env: cfEnv as unknown as Env };
}
