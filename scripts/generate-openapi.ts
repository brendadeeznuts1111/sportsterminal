const routerSource = await Bun.file('backend/src/api/router.ts').text();
const routeMatches = [...routerSource.matchAll(/router\.(get|post|put|patch|delete|options|all)\('([^']+)'/g)];

type PathItem = Record<string, {
  summary: string;
  responses: Record<string, { description: string }>;
}>;

const paths: Record<string, PathItem> = {};

for (const match of routeMatches) {
  const method = match[1].toLowerCase();
  const routePath = toOpenApiPath(match[2]);
  if (routePath === '/*') continue;
  paths[routePath] ||= {};
  paths[routePath][method] = {
    summary: `${method.toUpperCase()} ${routePath}`,
    responses: {
      '200': { description: 'Success' },
      '400': { description: 'Bad request' },
      '500': { description: 'Server error' },
    },
  };
}

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Sports Terminal API',
    version: '3.0.0',
  },
  servers: [
    { url: 'http://localhost:3000' },
  ],
  paths,
};

await Bun.write('openapi.json', `${JSON.stringify(spec, null, 2)}\n`);
console.log(`OpenAPI spec generated: openapi.json (${Object.keys(paths).length} paths)`);

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
