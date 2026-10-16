import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, eachDate, isIsoDate, minorToDecimal, toMinor, toSegments, todayIn, weekday } from '../../src/modules/rates/dates.js';
import { ProductionWriteBlockedError, ZodomusClient } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { normalizeRoomRates } from '../../src/modules/channels/zodomus/zodomus.mappers.js';
import { memoryLogger } from '../helpers.js';

describe('calendar dates', () => {
  it('validates, adds and counts days across month and leap-year boundaries', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-01', '2027-10-01')).toBe(365);
    expect(eachDate('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(weekday('2026-10-17')).toBe(6); // Saturday
  });

  it("uses the property's time zone for today", () => {
    const now = new Date('2026-10-16T20:00:00Z');
    expect(todayIn('Asia/Kolkata', now)).toBe('2026-10-17');
    expect(todayIn('America/New_York', now)).toBe('2026-10-16');
  });

  it('groups equal consecutive days into [from, to) segments and skips nulls', () => {
    const dates = eachDate('2026-10-01', '2026-10-08');
    const v: Record<string, number | null> = { '2026-10-01': 3, '2026-10-02': 3, '2026-10-03': 2, '2026-10-04': null, '2026-10-05': 2, '2026-10-06': 2, '2026-10-07': 3 };
    expect(toSegments(dates, (d) => v[d] ?? null, String)).toEqual([
      { dateFrom: '2026-10-01', dateTo: '2026-10-03', value: 3 },
      { dateFrom: '2026-10-03', dateTo: '2026-10-04', value: 2 },
      { dateFrom: '2026-10-05', dateTo: '2026-10-07', value: 2 },
      { dateFrom: '2026-10-07', dateTo: '2026-10-08', value: 3 },
    ]);
  });

  it('converts money with the currency’s decimals', () => {
    expect(toMinor(4500.5, 'INR')).toBe(450050);
    expect(minorToDecimal(450050, 'INR')).toBe('4500.50');
    expect(toMinor(12000, 'JPY')).toBe(12000);
    expect(minorToDecimal(12000, 'JPY')).toBe('12000');
    expect(toMinor(0.1 + 0.2, 'EUR')).toBe(30);
  });
});

describe('Zodomus writes', () => {
  const opts = { baseUrl: 'https://z.fake', username: 'u', password: 'p', timeoutMs: 1000, logger: memoryLogger().logger, backoffMs: 0 };

  it('refuses production writes unless explicitly enabled, without touching the network', async () => {
    let called = false;
    const client = new ZodomusClient({ ...opts, environment: 'production', fetch: () => ((called = true), Promise.resolve(new Response('{}'))) });
    await expect(client.call('rates', { body: {} })).rejects.toBeInstanceOf(ProductionWriteBlockedError);
    await expect(client.call('availability', { body: {} })).rejects.toBeInstanceOf(ProductionWriteBlockedError);
    expect(called).toBe(false);
    // reads are still fine
    await client.call('channels', {});
    expect(called).toBe(true);
  });

  it('allows production writes only with the explicit opt-in', async () => {
    const client = new ZodomusClient({ ...opts, environment: 'production', allowProductionWrites: true, fetch: () => Promise.resolve(new Response(JSON.stringify({ status: { returnCode: 200 } }))) });
    expect((await client.call('rates', { body: {} })).ok).toBe(true);
  });

  it('never retries non-idempotent activation calls, but retries set-value calls', async () => {
    let n = 0;
    const flaky = () => (n++, Promise.resolve(new Response('{}', { status: 503 })));
    const client = new ZodomusClient({ ...opts, environment: 'sandbox', fetch: flaky, maxRetries: 2 });
    await client.call('roomsActivation', { body: {} });
    expect(n).toBe(1);
    n = 0;
    await client.call('availability', { body: {} });
    expect(n).toBe(3);
  });

  it('sends JSON bodies with the right content type and has no card-data operation', async () => {
    let init: RequestInit | undefined;
    const client = new ZodomusClient({ ...opts, environment: 'sandbox', fetch: (_u, i) => ((init = i), Promise.resolve(new Response('{}'))) });
    await client.call('propertyCheck', { body: { channelId: 1, propertyId: '1' } });
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toContain('application/json');
    expect(init?.body).toBe('{"channelId":1,"propertyId":"1"}');
    // @ts-expect-error card data is not an allowed operation
    await expect(client.call('reservationsCc', {})).rejects.toThrow(/not allowed/);
  });

  it('normalizes GET /room-rates and rejects unexpected shapes', () => {
    expect(normalizeRoomRates({ rooms: [{ id: 5, name: 'Twin', rates: [{ id: 7, name: 'Std', active: '0', maxPersons: '2' }] }] })).toEqual([
      { id: '5', name: 'Twin', rates: [{ id: '7', name: 'Std', active: false, maxPersons: 2 }] },
    ]);
    expect(normalizeRoomRates({ rooms: 'x' })).toBeNull();
    expect(normalizeRoomRates({ rooms: [{ name: 'no id' }] })).toBeNull();
  });
});

describe('Zodomus status envelope', () => {
  it('reads property-check messages sent as an object, and string return codes', async () => {
    const { parseStatus } = await import('../../src/modules/channels/zodomus/zodomus.mappers.js');
    const s = parseStatus({
      status: {
        returnCode: '400',
        returnMessage: { 'Property status': 'Evaluation OTA', 'Channel status': 'OK', 'Room status': 'Error: Some rooms are not maped with the channel rooms. Use /rooms-activation to map room/rates' },
        channelLogId: '',
        channelOtherMessages: '',
      },
    });
    expect(s!.returnCode).toBe(400);
    expect(s!.returnMessage).toContain('Property status: Evaluation OTA');
    expect(s!.returnMessage).toContain('Room status: Error: Some rooms are not maped');
  });
});
