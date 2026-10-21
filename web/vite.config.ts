import { defineConfig } from 'vite';
import { assertNoPublicationFixtures } from './scripts/publication-fixtures';

assertNoPublicationFixtures();
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@mdx-js/rollup';
import rehypeSlug from 'rehype-slug';
import rehypePrettyCode from 'rehype-pretty-code';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { fileURLToPath } from 'node:url';

const useLocalTestBindings = process.env.EAVESY_LOCAL_TEST === '1';

export default defineConfig(({ command }) => ({
  // Preserve Vite 6's browser floor; keep in sync with desktop/launcher-ui/vite.config.ts.
  environments: {
    client: { build: { target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'] } },
  },
  define: {
    __EAVESY_LOCAL_TEST__: JSON.stringify(command === 'serve' && useLocalTestBindings),
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      remoteBindings: !useLocalTestBindings,
      ...(useLocalTestBindings
        ? {
            config: (config) => {
              delete (config as { ai?: unknown }).ai;
              delete (config as { vectorize?: unknown }).vectorize;
            },
          }
        : {}),
    }),
    tailwindcss(),
    {
      enforce: 'pre',
      ...mdx({
        remarkPlugins: [
          remarkFrontmatter,
          [remarkMdxFrontmatter, { name: 'frontmatter' }],
          remarkGfm,
        ],
        rehypePlugins: [
          rehypeSlug,
          [rehypePrettyCode, { theme: 'github-dark-dimmed' }],
        ],
      }),
    },
    tanstackStart(),
    viteReact(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
}));
