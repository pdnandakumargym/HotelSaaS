import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { errorMessage } from '../../../core/api/error-message';
import { OrgApi, PROPERTY_TYPES, Property, Subscription } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';
import { JoinPresentPipe } from '../../../shared/ui/join-present.pipe';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-properties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JoinPresentPipe, RouterLink, StatusPill, Icon],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Properties</h1>
        <p class="ss-muted">Your hotels, homestays, villas and other properties.</p>
      </div>
      @if (canWrite()) {
        @if (atLimit()) {
          <a class="ss-btn ss-btn--ghost" routerLink="/app/billing">Plan limit reached · see plans</a>
        } @else {
          <a class="ss-btn" routerLink="/app/properties/new"><ss-icon name="building" [size]="16" /> Add property</a>
        }
      }
    </header>

    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }

    @if (sub(); as s) {
      <p class="ss-muted small">{{ s.usage.properties }} of {{ s.plan.maxProperties }} properties used on the {{ s.plan.name }} plan.</p>
    }

    @if (loaded() && properties().length === 0) {
      <section class="ss-card empty">
        <ss-icon name="building" [size]="28" />
        <h2>No properties yet</h2>
        <p class="ss-muted">Add your first property to set up rooms, rates and channels.</p>
        @if (canWrite()) { <a class="ss-btn" routerLink="/app/properties/new">Add property</a> }
      </section>
    } @else {
      <div class="cards">
        @for (p of properties(); track p.id) {
          <a class="ss-card card" [routerLink]="['/app/properties', p.id]">
            <div class="row">
              <h2>{{ p.name }}</h2>
              <ss-status-pill [tone]="p.status === 'ACTIVE' ? 'success' : p.status === 'DRAFT' ? 'info' : 'neutral'">{{ statusLabel(p.status) }}</ss-status-pill>
            </div>
            <p class="ss-muted">{{ typeLabel(p.propertyType) }} · {{ ([p.city, p.countryCode] | joinPresent: ', ') }}</p>
            <p class="meta">{{ p.roomTypeCount ?? 0 }} room types · {{ p.roomCount ?? 0 }} rooms/units · {{ p.timezone }}</p>
          </a>
        }
      </div>
    }
  `,
  styles: `
    .small { font-size: 12.5px; margin: -8px 0 12px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
    .card { text-decoration: none; color: inherit; display: block; transition: border-color 0.15s; }
    .card:hover { border-color: var(--ss-blue-500); }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    h2 { font-size: 16px; }
    p { margin: 6px 0 0; }
    .meta { font-size: 12.5px; color: var(--ss-text-subtle); }
    .empty { text-align: center; padding: 40px 20px; color: var(--ss-text-subtle); }
    .empty h2 { color: var(--ss-text); margin: 10px 0 4px; }
    .empty .ss-btn { margin-top: 12px; }
  `,
})
export class Properties implements OnInit {
  private readonly api = inject(OrgApi);
  private readonly auth = inject(AuthService);
  protected readonly properties = signal<Property[]>([]);
  protected readonly sub = signal<Subscription | null>(null);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly canWrite = computed(() => this.auth.hasOrgPermission('property.write'));
  protected readonly atLimit = computed(() => {
    const s = this.sub();
    return !!s && s.usage.properties >= s.plan.maxProperties;
  });

  ngOnInit(): void {
    forkJoin([this.api.properties(), this.api.subscription()]).subscribe({
      next: ([p, s]) => {
        this.properties.set(p);
        this.sub.set(s);
        this.loaded.set(true);
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }

  protected typeLabel(t: string): string {
    return PROPERTY_TYPES.find((x) => x.value === t)?.label ?? t;
  }
  protected statusLabel(s: string): string {
    return s === 'ACTIVE' ? 'Active' : s === 'DRAFT' ? 'Draft' : 'Inactive';
  }
}
