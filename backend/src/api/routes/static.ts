/**
 * Static file serving for frontend
 */
export async function registerStaticRoutes(url: URL): Promise<Response | null> {
  const staticPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = `../frontend/public${staticPath}`;
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return null;

    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };
    const ext = staticPath.slice(staticPath.lastIndexOf('.'));
    const isHtml = ext === '.html';
    return new Response(file, {
      headers: {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': isHtml
          ? 'no-cache, no-store, must-revalidate'
          : 'public, max-age=3600',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Static] Failed to serve ${filePath}: ${msg}`);
    return null;
  }
}
