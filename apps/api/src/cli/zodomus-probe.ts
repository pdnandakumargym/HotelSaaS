/**
 * Read-only Zodomus diagnostics. Calls the four public account-level GET endpoints with the
 * credentials from apps/api/.env and prints status, timing and the STRUCTURE of each response
 * (key names and value types only, no values) plus the generic status.returnCode/returnMessage.
 * The output is safe to share.
 *
 *   npm run zodomus:probe
 *
 * It never writes to Zodomus and never prints credentials.
 */
import 'dotenv/config';
import { loadConfig } from '../config/env.js';
import { countItems, describeShape } from '../modules/channels/sanitize.js';
import { ZODOMUS_READ_OPERATIONS, ZodomusClient, type ZodomusReadOperation } from '../modules/channels/zodomus/zodomus.client.js';
import { createLogger } from '../shared/logger.js';

const config = loadConfig();
const z = config.zodomus;
const out = (s = '') => process.stdout.write(`${s}\n`);

out(`Zodomus probe: environment=${z.environment} baseUrl=${z.baseUrl} enabled=${z.enabled} credentialsConfigured=${z.credentialsConfigured}`);
if (!z.credentialsConfigured) {
  out('Set ZODOMUS_API_USERNAME and ZODOMUS_API_PASSWORD in apps/api/.env first.');
  process.exit(1);
}

const client = new ZodomusClient({
  baseUrl: z.baseUrl,
  username: z.username ?? '',
  password: z.password ?? '',
  environment: z.environment,
  timeoutMs: z.timeoutMs,
  logger: createLogger({ level: 'silent' }),
  maxRetries: 0,
});

let failures = 0;
for (const op of Object.keys(ZODOMUS_READ_OPERATIONS) as ZodomusReadOperation[]) {
  const r = await client.get(op);
  out('');
  out(`GET ${ZODOMUS_READ_OPERATIONS[op]}  ->  ${r.outcome} (HTTP ${r.httpStatus ?? '-'}) in ${r.durationMs} ms`);
  // The status envelope is a generic result code and message, not account data.
  if (r.providerCode !== null || r.providerMessage) out(`zodomus status: returnCode=${r.providerCode ?? '-'} returnMessage=${JSON.stringify(r.providerMessage?.slice(0, 120) ?? null)}`);
  if (r.ok) {
    out(`items: ${countItems(r.data) ?? 'n/a'}`);
    out(`shape: ${JSON.stringify(describeShape(r.data), null, 2)}`);
  } else {
    failures++;
    out(`error: ${r.error?.message ?? 'unknown'}`);
  }
}
out('');
out(failures === 0 ? 'All four read-only calls succeeded.' : `${failures} call(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
