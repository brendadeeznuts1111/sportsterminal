/**
 * Static file server for the Sports Terminal frontend.
 * Serves files from frontend/public/ on a local port.
 */

const PUBLIC_DIR = import.meta.dir + '/../frontend/public';
const PORT = Number(process.env.FRONTEND_PORT) || 3002;
const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';

const server = Bun.serve({
  port: PORT,
  static: {
    '/': new Response(Bun.file(`${PUBLIC_DIR}/index.html`)),
  },
  async fetch(req) {
    const url = new URL(req.url);

    // Reject WebSocket upgrade requests — client should connect directly to proxy:3001
    if (url.pathname === '/ws') {
      return new Response(JSON.stringify({ error: 'WebSocket not supported here. Connect to ws://localhost:3001/ws' }), {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Proxy API requests to backend
    if (url.pathname.startsWith('/api/')) {
      const proxyUrl = `${API_BASE}${url.pathname}${url.search}`;
      try {
        const proxyRes = await fetch(proxyUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        return new Response(proxyRes.body, {
          status: proxyRes.status,
          headers: proxyRes.headers,
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Serve static files — check existence first
    const filePath = `${PUBLIC_DIR}${url.pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // Fallback to index.html for SPA routing
    return new Response(Bun.file(`${PUBLIC_DIR}/index.html`));
  },
});

console.log(`Frontend serving at http://localhost:${PORT}`);
console.log(`API proxying to ${API_BASE}`);
