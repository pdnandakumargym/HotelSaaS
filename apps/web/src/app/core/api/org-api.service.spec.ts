import { expandRoomNames, formatMoney } from './org-api.service';

describe('expandRoomNames', () => {
  it('expands ranges and keeps single names', () => {
    expect(expandRoomNames('101-104, 201')).toEqual(['101', '102', '103', '104', '201']);
  });
  it('keeps zero padding and prefixes', () => {
    expect(expandRoomNames('01-03')).toEqual(['01', '02', '03']);
    expect(expandRoomNames('V1-V3')).toEqual(['V1', 'V2', 'V3']);
  });
  it('accepts one name per line', () => {
    expect(expandRoomNames('Garden Cottage\nSea Suite')).toEqual(['Garden Cottage', 'Sea Suite']);
  });
  it('rejects reversed or huge ranges', () => {
    expect(() => expandRoomNames('110-101')).toThrow(/Invalid range/);
    expect(() => expandRoomNames('1-500')).toThrow();
  });
});

describe('formatMoney', () => {
  it('formats minor units', () => {
    expect(formatMoney(299900, 'INR')).toContain('2,999');
  });
});
