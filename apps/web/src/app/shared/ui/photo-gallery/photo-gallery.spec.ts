import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { PhotoGallery } from './photo-gallery';

const URL = '/api/v1/organizations/01900000-0000-7000-8000-000000000001/properties/p1/photos';
const photo = (id: string, extra: object = {}) => ({ id, propertyId: 'p1', roomTypeId: null, contentType: 'image/jpeg', width: 1200, height: 800, bytes: 200_000, caption: null, isMain: false, sortOrder: 0, createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z', url: `${URL}/${id}/file`, ...extra });

describe('PhotoGallery', () => {
  function setup(canWrite = true) {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    setAuth(OWNER_ME);
    const fixture = TestBed.createComponent(PhotoGallery);
    fixture.componentRef.setInput('propertyId', 'p1');
    fixture.componentRef.setInput('roomTypes', [{ id: 'rt1', name: 'Garden Room', status: 'ACTIVE' }]);
    fixture.componentRef.setInput('canWrite', canWrite);
    fixture.detectChanges();
    return { fixture, http: TestBed.inject(HttpTestingController), el: fixture.nativeElement as HTMLElement };
  }

  it('groups property and room-type photos and marks the main photo', async () => {
    const { fixture, http, el } = setup();
    http.expectOne(URL).flush({ data: [photo('a', { isMain: true, caption: 'Front' }), photo('b', { sortOrder: 1 }), photo('c', { roomTypeId: 'rt1', isMain: true })] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Property photos');
    expect(el.textContent).toContain('Garden Room');
    expect(el.querySelectorAll('img')).toHaveLength(3);
    expect(el.querySelectorAll('.badge')).toHaveLength(2);
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('Front');
  });

  it('uploads the raw file with its type and room type, and rejects other file types locally', async () => {
    const { fixture, http } = setup();
    http.expectOne(URL).flush({ data: [] });
    const cmp = fixture.componentInstance as unknown as { onFiles: (e: Event, rt: string | null) => Promise<void>; error: () => string | null };
    const bad = { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })], value: '' } } as unknown as Event;
    await cmp.onFiles(bad, null);
    expect(cmp.error()).toContain('JPEG, PNG or WebP');
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'room.jpg', { type: 'image/jpeg' });
    const p = cmp.onFiles({ target: { files: [file], value: '' } } as unknown as Event, 'rt1');
    const req = http.expectOne((r) => r.url === URL && r.method === 'POST');
    expect(req.request.params.get('roomTypeId')).toBe('rt1');
    expect(req.request.headers.get('Content-Type')).toBe('image/jpeg');
    expect(req.request.body).toBe(file);
    req.flush({ data: photo('n', { roomTypeId: 'rt1', isMain: true }) });
    await p;
  });

  it('shows no editing controls without write permission', async () => {
    const { fixture, http, el } = setup(false);
    http.expectOne(URL).flush({ data: [photo('a', { isMain: true })] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Add photos');
    expect(el.textContent).not.toContain('Delete');
  });
});
