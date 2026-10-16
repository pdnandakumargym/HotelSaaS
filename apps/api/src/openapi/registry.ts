import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

/** Single registry; modules register their schemas and paths on import. */
export const registry = new OpenAPIRegistry();

export const ErrorSchema = registry.register(
  'Error',
  z.object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_FAILED' }),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  }),
);
