import { z } from 'zod';
import { registry } from '../../openapi/registry.js';

export const LivenessSchema = registry.register(
  'Liveness',
  z.object({
    status: z.literal('ok'),
    service: z.string(),
    version: z.string(),
    environment: z.enum(['development', 'test', 'production']),
    uptimeSeconds: z.number().int(),
    timestamp: z.iso.datetime(),
  }),
);

export const ReadinessSchema = registry.register(
  'Readiness',
  z.object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object({
      database: z.object({ status: z.enum(['up', 'down']), latencyMs: z.number().int() }),
    }),
    timestamp: z.iso.datetime(),
  }),
);

const envelope = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

registry.registerPath({
  method: 'get',
  path: '/api/v1/health',
  tags: ['Health'],
  summary: 'Liveness probe. Does not touch dependencies.',
  responses: {
    200: { description: 'Process is alive', content: { 'application/json': { schema: envelope(LivenessSchema) } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/health/ready',
  tags: ['Health'],
  summary: 'Readiness probe. Checks PostgreSQL connectivity.',
  responses: {
    200: { description: 'Ready to serve traffic', content: { 'application/json': { schema: envelope(ReadinessSchema) } } },
    503: { description: 'A dependency is unavailable', content: { 'application/json': { schema: envelope(ReadinessSchema) } } },
  },
});
