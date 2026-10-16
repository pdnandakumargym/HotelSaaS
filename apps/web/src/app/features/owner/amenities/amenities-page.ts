import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { Amenity, OrgApi, Property } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { AmenityPicker } from '../../../shared/ui/amenity-picker/amenity-picker';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-amenities-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, AmenityPicker, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Photos &amp; amenities</h1>
        <p class="ss-muted">Amenities guests see on booking channels. Room-level amenities are set per room type.</p>
      </div>
      @if (properties().length > 1) {
        <select class="ss-input pick" [ngModel]="selectedId()" (ngModelChange)="select($event)" aria-label="Property">
          @for (p of properties(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
        </select>
      }
    </header>
    @if (message(); as m) {
      <p class="ss-alert" [class.ss-alert--success]="m.tone === 'success'" [class.ss-alert--error]="m.tone === 'error'" role="status">{{ m.text }}</p>
    }
    @if (selectedId()) {
      <section class="ss-card">
        <h2 class="ss-card__title">Property amenities</h2>
        <ss-amenity-picker [amenities]="amenities()" scope="property" [(selected)]="selected" [disabled]="!canWrite()" />
        @if (canWrite()) { <button type="button" class="ss-btn" (click)="save()" [disabled]="busy()">Save amenities</button> }
      </section>
      <section class="ss-card">
        <h2 class="ss-card__title">Photos <ss-status-pill tone="info">Planned · Milestone 7</ss-status-pill></h2>
        <p class="ss-muted">Photo upload needs secure object storage (size and type checks, image re-encoding, private buckets). It arrives with the deployment work in Milestone 7. No photos are stored yet.</p>
      </section>
    } @else if (loaded()) {
      <section class="ss-card"><p class="ss-muted">Add a property first. <a routerLink="/app/properties/new">Add property</a></p></section>
    }
  `,
  styles: `.pick { max-width: 260px; } section.ss-card { margin-bottom: 16px; } .ss-btn { margin-top: 8px; }`,
})
export class AmenitiesPage implements OnInit {
  private readonly api = inject(OrgApi);
  private readonly auth = inject(AuthService);
  protected readonly properties = signal<Property[]>([]);
  protected readonly amenities = signal<Amenity[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = signal<string[]>([]);
  protected readonly loaded = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<{ tone: 'success' | 'error'; text: string } | null>(null);
  protected readonly canWrite = computed(() => this.auth.hasOrgPermission('property.write'));

  ngOnInit(): void {
    this.api.amenities().subscribe((a) => this.amenities.set(a));
    this.api.properties().subscribe({
      next: (p) => {
        this.properties.set(p);
        this.loaded.set(true);
        if (p[0]) this.select(p[0].id);
      },
      error: (e: unknown) => this.message.set({ tone: 'error', text: errorMessage(e) }),
    });
  }

  protected select(id: string): void {
    this.selectedId.set(id);
    this.selected.set(this.properties().find((p) => p.id === id)?.amenities ?? []);
  }

  protected save(): void {
    const id = this.selectedId();
    if (!id) return;
    this.busy.set(true);
    this.api.updateProperty(id, { amenities: this.selected() }).subscribe({
      next: (p) => {
        this.busy.set(false);
        this.properties.update((list) => list.map((x) => (x.id === p.id ? { ...x, amenities: p.amenities } : x)));
        this.message.set({ tone: 'success', text: 'Amenities saved.' });
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.message.set({ tone: 'error', text: errorMessage(e) });
      },
    });
  }
}
