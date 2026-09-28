import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
