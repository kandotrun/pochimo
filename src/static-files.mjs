import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME_TYPES = new Map([
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.css', 'text/css'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg']
]);

export async function serveStatic({ publicDir, pathname, res }) {
  const routeMap = new Map([
    ['/', '/index.html'],
    ['/viewer', '/viewer.html'],
    ['/camera', '/camera.html'],
    ['/login', '/login.html'],
    ['/settings', '/settings.html'],
    ['/lp', '/lp.html']
  ]);
  const requested = routeMap.get(pathname) || pathname;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const type = MIME_TYPES.get(path.extname(filePath)) || 'text/plain';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    throw err;
  }
}
