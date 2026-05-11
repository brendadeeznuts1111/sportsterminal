/**
 * Static file serving for frontend
 *
 * Uses Bun.file() which automatically:
 * - Detects Content-Type from file extension
 * - Generates ETags for conditional requests (304 Not Modified)
 * - Supports HTTP Range requests for large files
 * - Streams file data without loading into memory
 *
 * Bun docs: https://bun.sh/docs/api/file-io
 */
export async function registerStaticRoutes(url: URL): Promise<Response | null> {
  const staticPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = `../frontend/public${staticPath}`;
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return null;

    const ext = staticPath.slice(staticPath.lastIndexOf('.'));
    const isHtml = ext === '.html';
    const isJavaScript = ext === '.js';
    const isCss = ext === '.css';

    // Bun.file() in Response handles ETags automatically.
    // We only need to set Cache-Control; Bun will add ETag and handle 304s.
    return new Response(file, {
      headers: {
        'Cache-Control': isHtml || isJavaScript || isCss
          ? 'no-cache, no-store, must-revalidate'
          : 'public, max-age=86400, immutable',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Static] Failed to serve ${filePath}: ${msg}`);
    return null;
  }
}
