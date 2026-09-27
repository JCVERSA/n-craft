import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { defineConfig, Plugin } from 'vite';

function logsApiPlugin(): Plugin {
  return {
    name: 'nebula-craft-logs-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const url = new URL(req.url, 'http://localhost');

        if (url.pathname === '/api/server/logs/download') {
          try {
            const logsDir = path.resolve(process.cwd(), 'server', 'logs');
            let content = '';

            if (fs.existsSync(logsDir)) {
              const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log') || f.endsWith('.txt'));
              if (files.length > 0) {
                for (const file of files) {
                  const filePath = path.join(logsDir, file);
                  content += `=== [SOURCE: server/logs/${file}] ===\n` + fs.readFileSync(filePath, 'utf-8') + '\n\n';
                }
              }
            }

            if (!content.trim()) {
              content = `[${new Date().toISOString()}] [INFO] [Nebula Craft] Initializing Bedrock server log listener.\n[INFO] No external logs found in server/logs. Server daemon standby.\n`;
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `bedrock-server-logs-${timestamp}.txt`;

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Cache-Control', 'no-cache');
            res.end(content);
            return;
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'Failed to download logs' }));
            return;
          }
        }

        if (url.pathname === '/api/server/logs') {
          try {
            const logsDir = path.resolve(process.cwd(), 'server', 'logs');
            let content = '';
            if (fs.existsSync(logsDir)) {
              const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log') || f.endsWith('.txt'));
              for (const file of files) {
                const filePath = path.join(logsDir, file);
                content += fs.readFileSync(filePath, 'utf-8') + '\n';
              }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, logs: content }));
            return;
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
        }

        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), logsApiPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
