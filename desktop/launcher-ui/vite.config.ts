import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

const nm = (pkg: string) => path.resolve(dir, 'node_modules', pkg);
const sharedDeps = ['react', 'react-dom', 'lucide-react', 'clsx', 'tailwind-merge', '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu'];
const depAliases = Object.fromEntries(sharedDeps.map((p) => [p, nm(p)]));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    dedupe: sharedDeps,
    alias: {
      ...depAliases,
      '@/lib/next-compat/navigation': path.resolve(
        dir,
        'src/shims/next-navigation.ts',
      ),
      '@': path.resolve(dir, '../../web/src'),
    },
  },
  build: {
    outDir: path.resolve(dir, '../src-tauri/frontend-shell'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(dir, 'index.html'),
        hud: path.resolve(dir, 'hud.html'),
      },
    },
  },
  server: { port: 1420, strictPort: true },
  clearScreen: false,
});
