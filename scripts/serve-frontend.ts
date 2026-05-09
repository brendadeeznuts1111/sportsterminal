/**
 * Static file server for the Sports Terminal frontend.
 * Serves files from frontend/public/ on a local port.
 */

const PUBLIC_DIR = import.meta.dir + '/../frontend/public';
const PORT = Number(process.env.FRONTEND_PORT) || 3001;

const server = Bun.serve({
  port: PORT,
  static: {
    '/': new Response(Bun.file(`${PUBLIC_DIR}/index.html`)),
  },
  fetch(req) {
    const url = new URL(req.url);
    const filePath = `${PUBLIC_DIR}${url.pathname}`;
    const file = Bun.file(filePath);
    return new Response(file);
  },
});

console.log(`Frontend serving at http://localhost:${PORT}`);
