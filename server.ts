import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Server-side route to fetch and download current server/logs content as a text file
app.get('/api/server/logs/download', (_req, res) => {
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
      content = `[${new Date().toISOString()}] [INFO] [Nebula Craft] Bedrock Dedicated Server log standby.\n`;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `bedrock-server-logs-${timestamp}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(content);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to download logs' });
  }
});

// JSON logs endpoint
app.get('/api/server/logs', (_req, res) => {
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
    res.json({ success: true, logs: content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Mount Vite middleware in development
if (process.env.NODE_ENV !== 'production') {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.resolve(__dirname, 'dist')));
  app.get('*', (_req, res) => {
    res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
  });
}

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`[Nebula Craft] Express server listening on http://0.0.0.0:${PORT}`);
});
