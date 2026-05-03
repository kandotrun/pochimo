import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME_TYPES = new Map([
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.css', 'text/css']
]);

export async function serveStatic({ publicDir, pathname, res }) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const content = await fs.readFile(filePath);
  const type = MIME_TYPES.get(path.extname(filePath)) || 'text/plain';
  res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
  res.end(content);
}
