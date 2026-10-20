import { describe, expect, it } from 'vitest';
import { parseAmount, parseChannelDate, parseReservationQueue, parseReservations, parseReservationState } from '../../src/modules/channels/zodomus/zodomus.reservations.js';
import { bookingTotal, decimalToMinor } from '../../src/modules/reservations/reservation.service.js';
import { sellable } from '../../src/modules/rates/calendar.service.js';

describe('Zodomus reservation parsing', () => {
  it('maps documented queue statuses (1/2/3) and common words, nothing else', () => {
    expect(['1', '2', '3', 'new', 'Modified', 'canceled', 3].map(parseReservationState)).toEqual(['NEW', 'MODIFIED', 'CANCELLED', 'NEW', 'MODIFIED', 'CANCELLED', 'CANCELLED']);
    expect(parseReservationState('4')).toBeNull();
    expect(parseReservationState('')).toBeNull();
    expect(parseReservationState(undefined)).toBeNull();
  });

  it('accepts only real YYYY-MM-DD dates, optionally with a time', () => {
    expect(parseChannelDate('2026-10-20')).toBe('2026-10-20');
    expect(parseChannelDate('2026-10-20 14:00:00')).toBe('2026-10-20');
    expect(parseChannelDate('2026-10-20T14:00')).toBe('2026-10-20');
    for (const bad of ['20/10/2026', '2026-02-30', '2026-10-2', '2026-10-20x', '', null, 20261020]) expect(parseChannelDate(bad)).toBeNull();
  });

  it('accepts plain non-negative decimal amounts only', () => {
    expect(parseAmount('260.00')).toBe('260.00');
    expect(parseAmount(130)).toBe('130');
    for (const bad of ['-5', '1,000.00', '12.34567', 'abc', '']) expect(parseAmount(bad)).toBeNull();
  });

  it('converts amounts to minor units exactly', () => {
    expect(decimalToMinor('260.00', 'INR')).toBe(26000);
    expect(decimalToMinor('0.1', 'INR')).toBe(10);
    expect(decimalToMinor('4500', 'JPY')).toBe(4500);
    expect(decimalToMinor('12.345', 'KWD')).toBe(12345);
    expect(decimalToMinor('99999999999', 'INR')).toBeNull();
  });

  it('parses the queue and ignores entries without an id', () => {
    expect(parseReservationQueue({ status: {}, reservations: [{ id: '42', status: '2', date: '2026-10-19 10:00:00' }, { status: '1' }] })).toEqual([
      { channelReservationId: '42', state: 'MODIFIED', rawStatus: '2', changedAt: '2026-10-19 10:00:00' },
    ]);
    expect(parseReservationQueue({ status: {} })).toEqual([]);
    expect(parseReservationQueue({ reservations: 'x' })).toBeNull();
    expect(parseReservationQueue('nope')).toBeNull();
  });

  it('parses a reservation (rooms and prices as object or array) and drops card-like keys from the kept copy', () => {
    const item = {
      reservation: { id: '9001', status: '1', currencyCode: 'eur', totalPrice: '260.00', remarks: 'Late', RUID: 'x' },
      customer: { firstName: 'Ana', lastName: 'Lima', email: 'ana@example.test', countryCode: 'pt' },
      rooms: { id: 1744659101, name: 'Double', totalPrice: '260.00', numberOfGuests: '2', ArrivalDate: '2026-11-01', departureDate: '2026-11-03', prices: [{ rateId: '69920979', price: '130.00' }] },
      cardNumber: '4111111111111111',
    };
    const [r] = parseReservations({ status: {}, reservations: [item] })!;
    expect(r).toMatchObject({ channelReservationId: '9001', state: 'NEW', currency: 'EUR', totalPrice: '260.00', guest: { firstName: 'Ana', countryCode: 'PT' } });
    expect(r!.rooms).toEqual([
      { channelRoomId: '1744659101', name: 'Double', channelRateId: '69920979', checkIn: '2026-11-01', checkOut: '2026-11-03', datesPresent: true, guestCount: 2, totalPrice: '260.00', mealPlan: null, guestName: null, remarks: null },
    ]);
    expect(JSON.stringify(r!.raw)).not.toContain('4111');

    const [r2] = parseReservations({ reservations: [{ reservation: { id: '9002' }, rooms: [{ id: '5', arrivalDate: '03.11.2026', departureDate: '2026-11-04', prices: { rateId: 7 } }] }] })!;
    expect(r2!.rooms[0]).toMatchObject({ checkIn: null, checkOut: '2026-11-04', datesPresent: true, channelRateId: '7' });
    expect(parseReservations({ reservations: {} })).toBeNull();
  });
});

describe('sellable rooms', () => {
  it('subtracts bookings from the allotment and never goes below zero', () => {
    expect(sellable(3, null, false, 0)).toBe(3);
    expect(sellable(3, null, false, 1)).toBe(2);
    expect(sellable(3, 2, false, 1)).toBe(1);
    expect(sellable(3, 50, false, 1)).toBe(2);
    expect(sellable(1, null, false, 2)).toBe(0);
    expect(sellable(3, null, true, 0)).toBe(0);
  });
});

describe('shapes seen in the Zodomus sandbox (19 Oct 2026)', () => {
  // Structure reported by `npm run zodomus:reservations` (values here are invented).
  const sandboxItem = {
    reservation: { id: '174465912308', status: 1, currencyCode: '', totalPrice: '0', remarks: '', bookedAt: '2026-10-19 08:00:00', modifiedAt: '', source: 'booking', confirmationStatus: '1', RUID: 'x', s3_key: 'secret-ish' },
    customer: { firstName: 'Test', middleName: '', lastName: 'Guest', address: '', city: '', zipCode: '', countryCode: 'nl', email: 'test@example.test', phone: '1', phoneCountryCode: '31', phoneCityArea: '', remarks: '' },
    rooms: [
      { id: '1744659101', roomReservationId: '1', name: 'Double', totalPrice: '260', guestName: 'T G', numberOfGuests: 1, numberOfAdults: 1, numberOChildren: 0, arrivalDate: '2027-01-19', departureDate: '2027-01-20', smoking: 0, mealPlan: '', remarks: '', totalTaxes: '0', prices: [{ price: '260', date: '2027-01-19', dateend: '2027-01-20', rateId: '17446591991' }, { price: '0', date: '2027-01-19', rateId: '' }] },
    ],
  };

  it('accepts GET /reservations returning one object instead of an array, numeric statuses and lower-case arrivalDate', () => {
    const items = parseReservations({ status: { returnCode: '200' }, reservations: sandboxItem });
    expect(items).toHaveLength(1);
    const [r] = items!;
    expect(r).toMatchObject({ channelReservationId: '174465912308', state: 'NEW', rawStatus: '1', currency: null, totalPrice: '0' });
    expect(r!.rooms[0]).toMatchObject({ channelRoomId: '1744659101', channelRateId: '17446591991', checkIn: '2027-01-19', checkOut: '2027-01-20', guestCount: 1, totalPrice: '260' });
    expect(JSON.stringify(r!.raw)).not.toContain('secret-ish');
  });

  it('parses numeric queue statuses', () => {
    expect(parseReservationQueue({ reservations: [{ id: '7657347', status: 1, date: '2026-10-19' }] })).toEqual([{ channelReservationId: '7657347', state: 'NEW', rawStatus: '1', changedAt: '2026-10-19' }]);
  });

  it('uses the room totals when the booking total is 0', () => {
    expect(bookingTotal(0, [26000, 29000])).toBe(55000);
    expect(bookingTotal(null, [26000])).toBe(26000);
    expect(bookingTotal(50000, [26000])).toBe(50000);
    expect(bookingTotal(0, [null])).toBe(0);
    expect(bookingTotal(null, [])).toBeNull();
  });
});
