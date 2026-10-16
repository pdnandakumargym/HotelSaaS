import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { Amenity, OrgApi, PROPERTY_TYPES, Property } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { JoinPresentPipe } from '../../../shared/ui/join-present.pipe';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';
import { RoomsManager } from '../rooms/rooms-manager';

@Component({
  selector: 'ss-property-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JoinPresentPipe, RouterLink, StatusPill, RoomsManager],
  template: `
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (property(); as p) {
      <header class="ss-page-head">
        <div>
          <p class="crumb"><a routerLink="/app/properties">Properties</a> /</p>
          <h1>{{ p.name }} <ss-status-pill [tone]="p.status === 'ACTIVE' ? 'success' : p.status === 'DRAFT' ? 'info' : 'neutral'">{{ p.status }}</ss-status-pill></h1>
          <p class="ss-muted">{{ typeLabel(p.propertyType) }} · {{ address(p) }}</p>
        </div>
        @if (canWrite()) {
          <div class="head-actions">
            <a class="ss-btn ss-btn--ghost" [routerLink]="['/app/properties', p.id, 'edit']">Edit details</a>
            <button type="button" class="ss-btn ss-btn--ghost danger" (click)="remove(p)">Delete</button>
          </div>
        }
      </header>

      <section class="ss-card facts-card">
        <dl class="facts">
          <dt>Time zone</dt><dd>{{ p.timezone }}</dd>
          <dt>Currency</dt><dd>{{ p.currency }}</dd>
          <dt>Check-in / out</dt><dd>{{ p.checkInTime ?? '—' }} / {{ p.checkOutTime ?? '—' }}</dd>
          <dt>Contact</dt><dd>{{ ([p.contactEmail, p.contactPhone] | joinPresent: ' · ') || '—' }}</dd>
          <dt>Amenities</dt><dd>{{ amenityLabels(p.amenities) || '—' }}</dd>
        </dl>
        @if (p.description) { <p class="desc">{{ p.description }}</p> }
      </section>

      <ss-rooms-manager [propertyId]="p.id" />
    }
  `,
  styles: `
    .crumb { margin: 0 0 4px; font-size: 13px; }
    .crumb a { text-decoration: none; }
    h1 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .head-actions { display: flex; gap: 8px; }
    .danger { color: var(--ss-red-600); }
    .facts-card { margin-bottom: 16px; }
    .facts { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; margin: 0; }
    .facts dt { color: var(--ss-text-muted); }
    .facts dd { margin: 0; }
    .desc { margin: 12px 0 0; white-space: pre-line; }
  `,
})
export class PropertyDetail {
  readonly id = input.required<string>();
  private readonly api = inject(OrgApi);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  protected readonly property = signal<Property | null>(null);
  protected readonly amenities = signal<Amenity[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly canWrite = computed(() => this.auth.hasOrgPermission('property.write'));

  constructor() {
    this.api.amenities().subscribe((a) => this.amenities.set(a));
    effect(() => {
      this.api.property(this.id()).subscribe({ next: (p) => this.property.set(p), error: (e: unknown) => this.error.set(errorMessage(e)) });
    });
  }

  protected typeLabel(t: string): string {
    return PROPERTY_TYPES.find((x) => x.value === t)?.label ?? t;
  }
  protected address(p: Property): string {
    return [p.addressLine1, p.city, p.state, p.postalCode, p.countryCode].filter((v) => !!v).join(', ');
  }
  protected amenityLabels(codes: string[]): string {
    const map = new Map(this.amenities().map((a) => [a.code, a.label]));
    return codes.map((c) => map.get(c) ?? c).join(', ');
  }
  protected remove(p: Property): void {
    if (!confirm(`Delete ${p.name}? This only works when it has no room types.`)) return;
    this.api.deleteProperty(p.id).subscribe({ next: () => void this.router.navigate(['/app/properties']), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }
}
