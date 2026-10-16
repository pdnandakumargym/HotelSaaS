import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry.js';

export function buildOpenApiDocument(appName: string, version: string) {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: `${appName} API`,
      version,
      description: 'Multi-tenant property & channel management API. All endpoints are under /api/v1.',
    },
    servers: [{ url: '/' }],
  });
}
