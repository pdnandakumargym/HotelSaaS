/**
 * Amenity catalog. Codes are stored on properties and room types; labels are for display.
 * Channel-specific amenity codes (Booking.com, Airbnb...) are mapped from these in later milestones.
 */
export interface Amenity {
  code: string;
  label: string;
  group: 'general' | 'wellness' | 'food' | 'family' | 'business' | 'room' | 'bathroom' | 'outdoor' | 'accessibility';
  scope: 'property' | 'room' | 'both';
}

export const AMENITIES: readonly Amenity[] = [
  { code: 'WIFI', label: 'Free Wi-Fi', group: 'general', scope: 'both' },
  { code: 'PARKING', label: 'Free parking', group: 'general', scope: 'property' },
  { code: 'AIRPORT_SHUTTLE', label: 'Airport shuttle', group: 'general', scope: 'property' },
  { code: 'RECEPTION_24H', label: '24-hour front desk', group: 'general', scope: 'property' },
  { code: 'POWER_BACKUP', label: 'Power backup', group: 'general', scope: 'property' },
  { code: 'LIFT', label: 'Lift / elevator', group: 'general', scope: 'property' },
  { code: 'PETS_ALLOWED', label: 'Pets allowed', group: 'general', scope: 'property' },
  { code: 'NON_SMOKING', label: 'Non-smoking', group: 'general', scope: 'both' },
  { code: 'POOL', label: 'Swimming pool', group: 'wellness', scope: 'property' },
  { code: 'SPA', label: 'Spa', group: 'wellness', scope: 'property' },
  { code: 'GYM', label: 'Fitness centre', group: 'wellness', scope: 'property' },
  { code: 'RESTAURANT', label: 'Restaurant', group: 'food', scope: 'property' },
  { code: 'BAR', label: 'Bar', group: 'food', scope: 'property' },
  { code: 'BREAKFAST', label: 'Breakfast available', group: 'food', scope: 'property' },
  { code: 'ROOM_SERVICE', label: 'Room service', group: 'food', scope: 'property' },
  { code: 'KITCHEN', label: 'Kitchen', group: 'food', scope: 'both' },
  { code: 'KIDS_PLAY_AREA', label: "Children's play area", group: 'family', scope: 'property' },
  { code: 'BABYSITTING', label: 'Babysitting', group: 'family', scope: 'property' },
  { code: 'MEETING_ROOM', label: 'Meeting rooms', group: 'business', scope: 'property' },
  { code: 'WORKSPACE', label: 'Work desk', group: 'business', scope: 'room' },
  { code: 'AIR_CONDITIONING', label: 'Air conditioning', group: 'room', scope: 'room' },
  { code: 'TV', label: 'Television', group: 'room', scope: 'room' },
  { code: 'MINIBAR', label: 'Minibar', group: 'room', scope: 'room' },
  { code: 'SAFE', label: 'In-room safe', group: 'room', scope: 'room' },
  { code: 'KETTLE', label: 'Tea / coffee maker', group: 'room', scope: 'room' },
  { code: 'BALCONY', label: 'Balcony', group: 'room', scope: 'room' },
  { code: 'SEA_VIEW', label: 'Sea view', group: 'room', scope: 'room' },
  { code: 'PRIVATE_BATHROOM', label: 'Private bathroom', group: 'bathroom', scope: 'room' },
  { code: 'BATHTUB', label: 'Bathtub', group: 'bathroom', scope: 'room' },
  { code: 'HOT_WATER', label: 'Hot water', group: 'bathroom', scope: 'room' },
  { code: 'GARDEN', label: 'Garden', group: 'outdoor', scope: 'property' },
  { code: 'BEACH_ACCESS', label: 'Beach access', group: 'outdoor', scope: 'property' },
  { code: 'TERRACE', label: 'Terrace', group: 'outdoor', scope: 'both' },
  { code: 'WHEELCHAIR_ACCESSIBLE', label: 'Wheelchair accessible', group: 'accessibility', scope: 'both' },
];

const PROPERTY_CODES = new Set(AMENITIES.filter((a) => a.scope !== 'room').map((a) => a.code));
const ROOM_CODES = new Set(AMENITIES.filter((a) => a.scope !== 'property').map((a) => a.code));

export const isPropertyAmenity = (code: string) => PROPERTY_CODES.has(code);
export const isRoomAmenity = (code: string) => ROOM_CODES.has(code);
