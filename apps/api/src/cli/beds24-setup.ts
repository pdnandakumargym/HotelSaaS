/**
 * One-time Beds24 setup: exchanges an invite code for a long-life refresh token.
 *
 *   npm run beds24:setup
 *
 * 1. In Beds24: Marketplace > API > "Generate invite code" with the scopes in docs/beds24-api.md.
 * 2. Run this command and paste the invite code when asked (it is not shown on screen).
 * 3. Put the printed refresh token into apps/api/.env as BEDS24_REFRESH_TOKEN (never commit it, never paste it in chats).
 * The invite code works once. Nothing else is called and nothing is changed in Beds24.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import pino from 'pino';
import { Beds24Client } from '../modules/channels/beds24/beds24.client.js';

const baseUrl = (process.env['BEDS24_BASE_URL'] ?? 'https://beds24.com/api/v2').replace(/\/+$/, '');
const out = (s: string) => process.stdout.write(`${s}\n`);

async function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = true;
  });
}

const code = await askHidden('Beds24 invite code (input hidden): ');
if (!/^[A-Za-z0-9._~+/=-]{8,2000}$/.test(code)) {
  out('That does not look like an invite code. Nothing was sent.');
  process.exit(2);
}
const client = new Beds24Client({ baseUrl, refreshToken: 'unused', timeoutMs: 15000, logger: pino({ level: 'silent' }) });
const r = await client.setup(code, 'StaySync');
if (!r.ok || !r.refreshToken) {
  out(`Beds24 did not accept the invite code: ${r.error ?? 'unknown error'}`);
  out('Invite codes work once and expire; generate a new one in Beds24 and try again.');
  process.exit(1);
}
out('\nRefresh token created. Add this line to apps/api/.env (keep it secret, do not commit it):\n');
out(`BEDS24_REFRESH_TOKEN=${r.refreshToken}`);
out('\nThen run: npm run beds24:check -- <your Beds24 property id>');
