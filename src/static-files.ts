import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8']
]);

export async function serveStaticFile(c: Context, publicDir: string, pathname: string): Promise<Response> {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    return c.text('Forbidden', 403);
  }

  try {
    const content = await fs.readFile(filePath);
    return new Response(content, {
      headers: { 'content-type': MIME_TYPES.get(path.extname(filePath)) || 'text/plain; charset=utf-8' }
    });
  } catch {
    return c.text('Not found', 404);
  }
}
