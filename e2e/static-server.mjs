// Dependency-free static file server for e2e runs (stand-in for `storybook dev`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [root = '.', port = '6208'] = process.argv.slice(2);
const rootDir = path.resolve(root);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.join(rootDir, decodeURIComponent(url.pathname));
    if (!file.startsWith(rootDir)) return res.writeHead(400).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  })
  .listen(Number(port), () => console.log(`static server on http://localhost:${port}`));
