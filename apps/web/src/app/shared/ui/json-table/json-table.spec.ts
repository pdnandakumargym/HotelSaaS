import { TestBed } from '@angular/core/testing';
import { JsonTable, cell, columnsOf, extractRows } from './json-table';

describe('JsonTable helpers', () => {
  it('finds rows in a list or a single-list wrapper', () => {
    expect(extractRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(extractRows({ status: 'ok', items: [{ a: 1 }, 'x'] })).toEqual([{ a: 1 }, { value: 'x' }]);
    expect(extractRows({ a: [1], b: [2] })).toBeNull();
    expect(extractRows('text')).toBeNull();
  });

  it('collects columns and formats cells', () => {
    expect(columnsOf([{ id: 1, name: 'A' }, { id: 2, code: 'B' }])).toEqual(['id', 'name', 'code']);
    expect(cell(null)).toBe('—');
    expect(cell({ x: 'y'.repeat(200) }).length).toBeLessThanOrEqual(80);
  });

  it('renders text only (no HTML injection)', () => {
    const fixture = TestBed.createComponent(JsonTable);
    fixture.componentRef.setInput('data', [{ name: '<img src=x onerror=alert(1)>' }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x');
  });
});
