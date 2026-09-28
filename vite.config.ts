import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = (JSON.parse(readFileSync(path.join(projectDirectory, 'package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
  },
  resolve: {
    alias: {
      '@': projectDirectory,
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    // Embedded by the Express server in development. Disable Vite's separate
    // HMR socket so /api/server/console owns the only WebSocket upgrade path.
    hmr: false,
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
});
