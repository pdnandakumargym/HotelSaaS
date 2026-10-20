import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { DISCREPANCY_KIND, Discrepancy, OpsApi } from '../../../core/api/ops-api.service';
import { Property } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { PropertyPicker } from '../../../shared/ui/property-picker/property-picker';
import { PillTone, StatusPill } from '../../../shared/ui/status-pill/status-pill';

const SEVERITY: Record<Discrepancy['severity'], { label: string; tone: PillTone }> = {
  high: { label: 'High', tone: 'danger' },
  medium: { label: 'Medium', tone: 'warning' },
  low: { label: 'Low', tone: 'neutral' },
};

/** Problems StaySync detected between its data and the channels, with what to do about them. */
@Component({
  selector: 'ss-discrepancies',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, RouterLink, PropertyPicker, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Discrepancy center</h1>
        <p class="ss-muted">Overbookings, unmapped rooms, incomplete bookings and updates that could not be delivered. Items close by themselves when StaySync sees the problem is gone.</p>
      </div>
      <ss-property-picker (changed)="onProperty($event)" />
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }

    <section class="ss-card">
      <div class="filters">
        <div class="tabs" role="tablist" aria-label="Status">
          @for (t of tabs; track t.value) {
            <button type="button" role="tab" [attr.aria-selected]="status() === t.value" [class.on]="status() === t.value" (click)="setStatus(t.value)">{{ t.label }}</button>
          }
        </div>
        @if (status() === 'OPEN') {
          <span class="counts">
            <ss-status-pill tone="danger">{{ counts().high ?? 0 }} high</ss-status-pill>
            <ss-status-pill tone="warning">{{ counts().medium ?? 0 }} medium</ss-status-pill>
            <ss-status-pill tone="neutral">{{ counts().low ?? 0 }} low</ss-status-pill>
          </span>
        }
      </div>

      @for (d of items(); track d.id) {
        <article class="item" [class.high]="d.severity === 'high' && d.status === 'OPEN'">
          <div class="top">
            <div>
              <ss-status-pill [tone]="severity(d).tone">{{ severity(d).label }}</ss-status-pill>
              <strong class="kind">{{ kind(d).label }}</strong>
              @if (d.occurrences > 1) { <span class="ss-muted small">seen {{ d.occurrences }} times</span> }
            </div>
            <span class="ss-muted small">First seen {{ d.firstSeenAt | date: 'short' }}@if (d.lastSeenAt !== d.firstSeenAt) { · last {{ d.lastSeenAt | date: 'short' }} }</span>
          </div>
          <p class="msg">{{ d.message }}</p>
          @if (d.status === 'OPEN') {
            <p class="ss-muted small">What to do: {{ kind(d).action }}
              @if (d.channelReservationId) { <a routerLink="/app/bookings" [queryParams]="{ property: d.propertyId }">View bookings</a> }
              @if (d.kind === 'SYNC_FAILED' || d.kind === 'POLL_FAILED') { <a routerLink="/app/sync" [queryParams]="{ property: d.propertyId }">Synchronization status</a> }
              @if (d.kind === 'UNMAPPED_ROOM') { <a routerLink="/app/mapping" [queryParams]="{ property: d.propertyId }">Room &amp; rate mapping</a> }
              @if (d.kind === 'OVERBOOKING') { <a routerLink="/app/inventory" [queryParams]="{ property: d.propertyId }">Inventory calendar</a> }
            </p>
            @if (canManage()) {
              @if (acting() === d.id) {
                <form class="act" (ngSubmit)="decide(d, pending)">
                  <label class="ss-field"><span>Note (optional)</span><input class="ss-input" name="note" [(ngModel)]="note" maxlength="500" placeholder="What did you do?" /></label>
                  <button type="submit" class="ss-btn" [disabled]="busy()">{{ pending === 'resolve' ? 'Mark resolved' : 'Ignore' }}</button>
                  <button type="button" class="ss-btn ss-btn--ghost" (click)="acting.set(null)">Cancel</button>
                </form>
              } @else {
                <div class="act">
                  <button type="button" class="ss-btn ss-btn--ghost" (click)="start(d, 'resolve')">Mark resolved</button>
                  <button type="button" class="ss-btn ss-btn--ghost" (click)="start(d, 'ignore')">Ignore</button>
                </div>
              }
            }
          } @else {
            <p class="ss-muted small">
              {{ d.status === 'RESOLVED' ? 'Resolved' : 'Ignored' }} {{ d.resolvedAt | date: 'short' }}{{ d.autoResolved ? ' automatically' : '' }}@if (d.resolutionNote) { — {{ d.resolutionNote }} }
              @if (canManage()) { <button type="button" class="ss-link-btn" (click)="decide(d, 'reopen')" [disabled]="busy()">Reopen</button> }
            </p>
          }
        </article>
      } @empty {
        @if (loaded()) { <p class="ss-muted empty">{{ status() === 'OPEN' ? 'Nothing needs your attention.' : 'Nothing here.' }}</p> }
      }
    </section>
  `,
  styles: `
    .filters { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .tabs { display: inline-flex; border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); overflow: hidden; }
    .tabs button { border: 0; background: transparent; padding: 7px 14px; cursor: pointer; font: inherit; color: var(--ss-text-muted); }
    .tabs button.on { background: var(--ss-blue-50); color: var(--ss-blue-600); font-weight: 600; }
    .counts { display: inline-flex; gap: 6px; }
    .item { border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); padding: 12px; margin-bottom: 10px; }
    .item.high { border-left: 4px solid var(--ss-red-600); }
    .top { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; }
    .kind { margin: 0 8px; }
    .small { font-size: 12.5px; }
    .msg { margin: 8px 0 4px; }
    .act { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; margin-top: 8px; }
    .act .ss-field { margin: 0; min-width: 260px; }
    .empty { padding: 16px 0; }
  `,
})
export class Discrepancies {
  private readonly api = inject(OpsApi);
  private readonly auth = inject(AuthService);
  protected readonly tabs = [
    { value: 'OPEN' as const, label: 'Open' },
    { value: 'RESOLVED' as const, label: 'Resolved' },
    { value: 'IGNORED' as const, label: 'Ignored' },
  ];
  protected readonly items = signal<Discrepancy[]>([]);
  protected readonly counts = signal<Partial<Record<'high' | 'medium' | 'low', number>>>({});
  protected readonly status = signal<'OPEN' | 'RESOLVED' | 'IGNORED'>('OPEN');
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly acting = signal<string | null>(null);
  protected readonly canManage = computed(() => this.auth.hasOrgPermission('channel.manage'));
  protected pending: 'resolve' | 'ignore' = 'resolve';
  protected note = '';
  private propertyId: string | null = null;

  onProperty(p: Property): void {
    this.propertyId = p.id;
    this.load();
  }
  protected setStatus(s: 'OPEN' | 'RESOLVED' | 'IGNORED'): void {
    this.status.set(s);
    this.load();
  }

  load(): void {
    if (!this.propertyId) return;
    this.api.discrepancies({ propertyId: this.propertyId, status: this.status() }).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.counts.set(r.openBySeverity);
        this.loaded.set(true);
      },
      error: (e: unknown) => {
        this.loaded.set(true);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected start(d: Discrepancy, what: 'resolve' | 'ignore'): void {
    this.pending = what;
    this.note = '';
    this.acting.set(d.id);
  }

  protected decide(d: Discrepancy, decision: 'resolve' | 'ignore' | 'reopen'): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.decide(d.id, decision, decision === 'reopen' ? undefined : this.note.trim() || undefined).subscribe({
      next: () => {
        this.busy.set(false);
        this.acting.set(null);
        this.load();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected severity(d: Discrepancy) {
    return SEVERITY[d.severity];
  }
  protected kind(d: Discrepancy) {
    return DISCREPANCY_KIND[d.kind];
  }
}
