import { z } from 'zod';
import { registry } from '../../openapi/registry.js';
import { isPropertyAmenity, isRoomAmenity } from './amenities.js';

/** IANA zone check via ICU; accepts canonical names and aliases (Asia/Kolkata and Asia/Calcutta). */
function isTimeZone(v: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const time = z.preprocess(blankToNull, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)').nullable().optional());

export const timezone = z.string().max(64).refine(isTimeZone, 'Unknown time zone (use an IANA name such as Asia/Kolkata)');
export const currency = z
  .string()
  .transform((v) => v.toUpperCase())
  .refine((v) => CURRENCIES.has(v), 'Unknown ISO 4217 currency code');
export const countryCode = z
  .string()
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z]{2}$/.test(v) && !/^(AA|ZZ|Q[M-Z]|X[A-Z])$/.test(v) && regionNames.of(v) !== undefined, 'Unknown ISO 3166 country code');

const propertyAmenities = z
  .array(z.string())
  .max(100)
  .refine((list) => list.every(isPropertyAmenity), 'Unknown property amenity code')
  .transform((list) => [...new Set(list)]);
const roomAmenities = z
  .array(z.string())
  .max(100)
  .refine((list) => list.every(isRoomAmenity), 'Unknown room amenity code')
  .transform((list) => [...new Set(list)]);

const propertyFields = {
  name: z.string().trim().min(1).max(160),
  propertyType: z.enum(['HOTEL', 'HOMESTAY', 'VILLA', 'BUNGALOW', 'RESORT', 'APARTMENT', 'OTHER']),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']),
  timezone,
  currency,
  countryCode,
  state: optionalText(120),
  city: optionalText(120),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  postalCode: optionalText(20),
  checkInTime: time,
  checkOutTime: time,
  description: optionalText(4000),
  starRating: z.preprocess(blankToNull, z.number().int().min(1).max(5).nullable().optional()),
  contactEmail: z.preprocess(blankToNull, z.email().max(254).nullable().optional()),
  contactPhone: z.preprocess(blankToNull, z.string().trim().regex(/^[+0-9 ()-]{5,40}$/, 'Use digits, spaces, +, ( ) and -').nullable().optional()),
  latitude: z.preprocess(blankToNull, z.number().min(-90).max(90).nullable().optional()),
  longitude: z.preprocess(blankToNull, z.number().min(-180).max(180).nullable().optional()),
  cancellationPolicy: optionalText(4000),
  houseRules: optionalText(4000),
  amenities: propertyAmenities,
};

export const CreatePropertyBody = registry.register(
  'CreatePropertyRequest',
  z.object({ ...propertyFields, status: propertyFields.status.default('DRAFT'), amenities: propertyAmenities.default([]) }).strict(),
);
export const UpdatePropertyBody = registry.register('UpdatePropertyRequest', z.object(propertyFields).partial().strict());

const roomTypeBase = z.object({
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9_-]{1,20}$/, 'Use 1-20 letters, digits, - or _')),
  description: optionalText(2000),
  baseOccupancy: z.number().int().min(1).max(50),
  maxAdults: z.number().int().min(1).max(50),
  maxChildren: z.number().int().min(0).max(50),
  maxOccupancy: z.number().int().min(1).max(50),
  bedConfiguration: optionalText(200),
  sizeSqm: z.preprocess(blankToNull, z.number().positive().max(100000).nullable().optional()),
  amenities: roomAmenities,
  status: z.enum(['ACTIVE', 'INACTIVE']),
  sortOrder: z.number().int().min(0).max(10000),
});

function occupancyRule<T extends { baseOccupancy?: number; maxAdults?: number; maxChildren?: number; maxOccupancy?: number }>(v: T) {
  if (v.baseOccupancy === undefined || v.maxAdults === undefined || v.maxChildren === undefined || v.maxOccupancy === undefined) return true;
  return v.maxOccupancy >= v.baseOccupancy && v.maxOccupancy <= v.maxAdults + v.maxChildren;
}
const occupancyMessage = { message: 'Max occupancy must be at least the base occupancy and at most adults + children', path: ['maxOccupancy'] };

export const CreateRoomTypeBody = registry.register(
  'CreateRoomTypeRequest',
  roomTypeBase
    .extend({
      baseOccupancy: roomTypeBase.shape.baseOccupancy.default(2),
      maxAdults: roomTypeBase.shape.maxAdults.default(2),
      maxChildren: roomTypeBase.shape.maxChildren.default(0),
      maxOccupancy: roomTypeBase.shape.maxOccupancy.default(2),
      amenities: roomAmenities.default([]),
      status: roomTypeBase.shape.status.default('ACTIVE'),
      sortOrder: roomTypeBase.shape.sortOrder.default(0),
    })
    .strict()
    .refine(occupancyRule, occupancyMessage),
);
export const UpdateRoomTypeBody = roomTypeBase.partial().strict();

const roomName = z.string().trim().min(1).max(60);
export const CreateRoomBody = registry.register(
  'CreateRoomRequest',
  z.object({ roomTypeId: z.uuid(), name: roomName, floor: optionalText(20), status: z.enum(['AVAILABLE', 'OUT_OF_SERVICE']).default('AVAILABLE'), notes: optionalText(1000) }).strict(),
);
export const BulkCreateRoomsBody = z
  .object({ roomTypeId: z.uuid(), names: z.array(roomName).min(1).max(200), floor: optionalText(20) })
  .strict()
  .refine((v) => new Set(v.names.map((n) => n.toLowerCase())).size === v.names.length, { message: 'Room names must be unique', path: ['names'] });
export const UpdateRoomBody = z
  .object({ roomTypeId: z.uuid(), name: roomName, floor: optionalText(20), status: z.enum(['AVAILABLE', 'OUT_OF_SERVICE']), notes: optionalText(1000) })
  .partial()
  .strict();

export const ListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
  q: z.string().trim().max(100).optional(),
});
