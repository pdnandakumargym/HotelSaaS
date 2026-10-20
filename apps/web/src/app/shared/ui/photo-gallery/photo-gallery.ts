import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../../../core/api/error-message';
import { PHOTO_MAX_BYTES, PHOTO_TYPES, Photo, PhotoApi } from '../../../core/api/photo-api.service';
import { RoomType } from '../../../core/api/org-api.service';

interface Group {
  roomTypeId: string | null;
  title: string;
  photos: Photo[];
}

/** Property and room-type photos: upload, caption, main photo, order, delete. */
@Component({
  selector: 'ss-photo-gallery',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (notice(); as n) { <p class="ss-alert ss-alert--success" role="status">{{ n }}</p> }
    @for (g of groups(); track g.roomTypeId) {
      <div class="group">
        <div class="ghead">
          <h3>{{ g.title }} <span class="ss-muted small">{{ g.photos.length }} photo{{ g.photos.length === 1 ? '' : 's' }}</span></h3>
          @if (canWrite()) {
            <label class="ss-btn ss-btn--ghost upload" [class.disabled]="busy()">
              {{ busy() && uploadingFor() === g.roomTypeId ? 'Uploading ' + progress() + '…' : 'Add photos' }}
              <input type="file" [attr.accept]="accept" multiple (change)="onFiles($event, g.roomTypeId)" [disabled]="busy()" class="ss-visually-hidden" [attr.aria-label]="'Add photos to ' + g.title" />
            </label>
          }
        </div>
        @if (g.photos.length) {
          <ul class="grid">
            @for (p of g.photos; track p.id; let i = $index) {
              <li class="card" [class.main]="p.isMain">
                <img [src]="p.url" [alt]="p.caption || g.title + ' photo ' + (i + 1)" loading="lazy" width="320" height="213" />
                @if (p.isMain) { <span class="badge">Main photo</span> }
                <div class="body">
                  @if (canWrite()) {
                    <input class="ss-input" [ngModel]="p.caption ?? ''" (change)="caption(p, $any($event.target).value)" maxlength="200" placeholder="Caption (optional)" [attr.aria-label]="'Caption for photo ' + (i + 1)" />
                    <div class="actions">
                      @if (!p.isMain) { <button type="button" class="ss-link-btn" (click)="makeMain(p)">Make main</button> }
                      @if (i > 0) { <button type="button" class="ss-link-btn" (click)="move(g, i, -1)" aria-label="Move earlier">←</button> }
                      @if (i < g.photos.length - 1) { <button type="button" class="ss-link-btn" (click)="move(g, i, 1)" aria-label="Move later">→</button> }
                      <button type="button" class="ss-link-btn danger" (click)="remove(p)">{{ confirmDelete() === p.id ? 'Click again to delete' : 'Delete' }}</button>
                    </div>
                  } @else if (p.caption) {
                    <p class="small">{{ p.caption }}</p>
                  }
                  <p class="ss-muted tiny">{{ p.width }} × {{ p.height }} px · {{ kb(p.bytes) }}</p>
                </div>
              </li>
            }
          </ul>
        } @else {
          <p class="ss-muted small">No photos yet.</p>
        }
      </div>
    }
    <p class="ss-muted small">JPEG, PNG or WebP up to 10 MB, at least 320 px on the short edge. Photos are re-saved as JPEG (max 2560 px) and their metadata, such as camera GPS position, is removed.</p>
  `,
  styles: `
    .group { margin-bottom: 20px; }
    .ghead { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    h3 { font-size: 14.5px; margin: 0; }
    .small { font-size: 12.5px; }
    .tiny { font-size: 11.5px; margin: 4px 0 0; }
    .upload { cursor: pointer; position: relative; }
    .upload.disabled { opacity: .6; pointer-events: none; }
    .grid { list-style: none; padding: 0; margin: 10px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .card { border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); overflow: hidden; position: relative; background: var(--ss-surface, #fff); }
    .card.main { border-color: var(--ss-blue-600); }
    img { display: block; width: 100%; height: 140px; object-fit: cover; background: var(--ss-gray-50); }
    .badge { position: absolute; top: 8px; left: 8px; background: var(--ss-blue-600); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 999px; }
    .body { padding: 8px; }
    .body .ss-input { height: 32px; font-size: 13px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; font-size: 12.5px; }
    .danger { color: var(--ss-red-600); }
  `,
})
export class PhotoGallery {
  private readonly api = inject(PhotoApi);
  readonly propertyId = input.required<string>();
  readonly roomTypes = input<RoomType[]>([]);
  readonly canWrite = input(false);
  protected readonly accept = PHOTO_TYPES.join(',');
  protected readonly photos = signal<Photo[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly uploadingFor = signal<string | null>(null);
  protected readonly progress = signal('');
  protected readonly confirmDelete = signal<string | null>(null);

  protected readonly groups = computed<Group[]>(() => {
    const all = this.photos();
    const sort = (a: Photo, b: Photo) => Number(b.isMain) - Number(a.isMain) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt);
    return [
      { roomTypeId: null, title: 'Property photos', photos: all.filter((p) => p.roomTypeId === null).sort(sort) },
      ...this.roomTypes().map((rt) => ({ roomTypeId: rt.id, title: rt.name, photos: all.filter((p) => p.roomTypeId === rt.id).sort(sort) })),
    ];
  });

  constructor() {
    effect(() => this.load(this.propertyId()));
  }

  load(propertyId: string): void {
    this.api.list(propertyId).subscribe({ next: (p) => this.photos.set(p), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }

  protected async onFiles(ev: Event, roomTypeId: string | null): Promise<void> {
    const inputEl = ev.target as HTMLInputElement;
    const files = Array.from(inputEl.files ?? []);
    inputEl.value = '';
    if (!files.length) return;
    this.error.set(null);
    this.notice.set(null);
    const bad = files.find((f) => !PHOTO_TYPES.includes(f.type) || f.size > PHOTO_MAX_BYTES);
    if (bad) {
      this.error.set(`${bad.name}: use a JPEG, PNG or WebP photo up to 10 MB.`);
      return;
    }
    this.busy.set(true);
    this.uploadingFor.set(roomTypeId);
    const failures: string[] = [];
    let done = 0;
    for (const f of files) {
      this.progress.set(`${done + 1}/${files.length}`);
      try {
        const p = await new Promise<Photo>((resolve, reject) => this.api.upload(this.propertyId(), f, roomTypeId).subscribe({ next: resolve, error: reject }));
        this.photos.update((list) => [...list, p]);
        done++;
      } catch (e) {
        failures.push(`${f.name}: ${errorMessage(e)}`);
      }
    }
    this.busy.set(false);
    this.uploadingFor.set(null);
    if (failures.length) this.error.set(failures.join(' · '));
    if (done) this.notice.set(`${done} photo${done === 1 ? '' : 's'} uploaded.`);
  }

  protected caption(p: Photo, value: string): void {
    this.patch(p, { caption: value.trim() || null });
  }
  protected makeMain(p: Photo): void {
    this.patch(p, { isMain: true }, () => this.load(this.propertyId()));
  }
  protected move(g: Group, i: number, dir: -1 | 1): void {
    const list = [...g.photos];
    const j = i + dir;
    [list[i], list[j]] = [list[j]!, list[i]!];
    list.forEach((p, idx) => {
      if (p.sortOrder !== idx) this.patch(p, { sortOrder: idx });
    });
    this.photos.update((all) => all.map((p) => {
      const idx = list.findIndex((x) => x.id === p.id);
      return idx >= 0 ? { ...p, sortOrder: idx } : p;
    }));
  }
  protected remove(p: Photo): void {
    if (this.confirmDelete() !== p.id) {
      this.confirmDelete.set(p.id);
      return;
    }
    this.confirmDelete.set(null);
    this.api.remove(this.propertyId(), p.id).subscribe({ next: () => this.load(this.propertyId()), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }
  protected kb(bytes: number): string {
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  }

  private patch(p: Photo, body: { caption?: string | null; isMain?: true; sortOrder?: number }, after?: () => void): void {
    this.error.set(null);
    this.api.update(this.propertyId(), p.id, body).subscribe({
      next: (u) => {
        this.photos.update((list) => list.map((x) => (x.id === u.id ? u : x)));
        after?.();
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }
}
