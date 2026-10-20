import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { OpsApi, SyncStatus, SyncStatusJob } from '../../../core/api/ops-api.service';
import { Property } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { PropertyPicker } from '../../../shared/ui/property-picker/property-picker';
import { PillTone, StatusPill } from '../../../shared/ui/status-pill/status-pill';

const HEALTH: Record<SyncStatus['health'], { label: string; tone: PillTone }> = {
  in_sync: { label: 'In sync', tone: 'success' },
  syncing: { label: 'Sending updates', tone: 'info' },
  attention: { label: 'Needs attention', tone: 'danger' },
  not_active: { label: 'Not active', tone: 'warning' },
};
const JOB: Record<SyncStatusJob['status'], { label: string; tone: PillTone }> = {
  PENDING: { label: 'Queued', tone: 'info' },
  RUNNING: { label: 'Sending', tone: 'info' },
  SUCCEEDED: { label: 'Delivered', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  CANCELLED: { label: 'Skipped', tone: 'neutral' },
};

/** Per-connection view of the update queue and reservation polling. Refreshes every 15 seconds while open. */
@Component({
  selector: 'ss-sync-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, PropertyPicker, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Synchronization status</h1>
        <p class="ss-muted">What StaySync has sent to each channel and when it last fetched bookings.</p>
      </div>
      <ss-property-picker (changed)="onProperty($event)" />
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (notice(); as n) { <p class="ss-alert ss-alert--success" role="status">{{ n }}</p> }

    @for (s of statuses(); track s.connectionId) {
      <section class="ss-card">
        <div class="head">
          <div>
            <h2 class="ss-card__title">{{ s.channelName }} <span class="ss-muted small">property {{ s.channelPropertyId }}@if (s.environment === 'sandbox') { · test mode }</span></h2>
          </div>
          <ss-status-pill [tone]="health(s).tone">{{ health(s).label }}</ss-status-pill>
        </div>

        <div class="tiles">
          <div class="tile"><span class="n">{{ s.jobs.pending + s.jobs.running }}</span><span class="l">Updates waiting</span></div>
          <div class="tile"><span class="n">{{ s.jobs.succeeded24h }}</span><span class="l">Delivered (24 h)</span></div>
          <div class="tile" [class.bad]="s.jobs.failed24h > 0"><span class="n">{{ s.jobs.failed24h }}</span><span class="l">Failed (24 h)</span></div>
          <div class="tile"><span class="n small">{{ s.jobs.lastSuccessAt ? (s.jobs.lastSuccessAt | date: 'short') : 'Never' }}</span><span class="l">Last delivered</span></div>
          <div class="tile" [class.bad]="s.reservations.consecutiveFailures > 0"><span class="n small">{{ s.reservations.lastPolledAt ? (s.reservations.lastPolledAt | date: 'short') : 'Never' }}</span><span class="l">Bookings last fetched</span></div>
          <div class="tile"><span class="n">{{ s.reservations.total }}</span><span class="l">Bookings received</span></div>
        </div>

        @if (s.reservations.pollError) { <p class="ss-alert ss-alert--error">Fetching bookings failed{{ s.reservations.consecutiveFailures > 1 ? ' ' + s.reservations.consecutiveFailures + ' times in a row' : '' }}: {{ s.reservations.pollError }}</p> }
        @if (s.connectionStatus !== 'ACTIVE') { <p class="ss-alert ss-alert--info">Nothing is sent until the connection is active. <a routerLink="/app/mapping" [queryParams]="{ property: s.propertyId }">Finish the connection</a></p> }
        @if (s.openDiscrepancies) { <p class="ss-alert ss-alert--info">{{ s.openDiscrepancies }} open discrepanc{{ s.openDiscrepancies === 1 ? 'y' : 'ies' }} for this connection. <a routerLink="/app/discrepancies">Open the Discrepancy Center</a></p> }

        <h3>Recent updates</h3>
        @if (s.recentJobs.length) {
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead><tr><th scope="col">Queued</th><th scope="col">What</th><th scope="col">Rooms / rate</th><th scope="col">Dates</th><th scope="col">Status</th><th scope="col">Calls</th><th scope="col">Details</th><th scope="col"><span class="ss-visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                @for (j of s.recentJobs; track j.id) {
                  <tr>
                    <td>{{ j.createdAt | date: 'short' }}</td>
                    <td>{{ kind(j) }}</td>
                    <td>{{ j.roomTypeName ?? '—' }}@if (j.ratePlanName) { · {{ j.ratePlanName }} }</td>
                    <td>{{ j.dateFrom }} – {{ lastDay(j.dateTo) }}</td>
                    <td><ss-status-pill [tone]="job(j).tone">{{ job(j).label }}</ss-status-pill></td>
                    <td>{{ j.callsMade }}</td>
                    <td class="err">
                      @if (j.lastError) { {{ j.lastError }} }
                      @else if (j.status === 'PENDING' && j.attempts > 0 && j.nextAttemptAt) { Retry at {{ j.nextAttemptAt | date: 'shortTime' }} (attempt {{ j.attempts + 1 }}) }
                    </td>
                    <td>@if (j.status === 'FAILED' && canManage() && s.connectionStatus === 'ACTIVE') { <button type="button" class="ss-btn ss-btn--ghost" (click)="retry(j)" [disabled]="busy()">Retry</button> }</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="ss-muted">No updates yet.</p>
        }
      </section>
    } @empty {
      @if (loaded()) { <p class="ss-alert ss-alert--info">This property is not connected to a channel yet. <a routerLink="/app/mapping">Connect Booking.com</a></p> }
    }
  `,
  styles: `
    .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .small { font-size: 12.5px; font-weight: 400; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 12px 0; }
    .tile { border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
    .tile .n { font-size: 20px; font-weight: 600; }
    .tile .n.small { font-size: 14px; }
    .tile .l { font-size: 12.5px; color: var(--ss-text-muted); }
    .tile.bad { border-color: var(--ss-red-600); }
    .tile.bad .n { color: var(--ss-red-600); }
    h3 { font-size: 14px; margin: 16px 0 8px; }
    .err { max-width: 360px; font-size: 12.5px; color: var(--ss-text-muted); }
    td button { height: 30px; }
  `,
})
export class SyncStatusPage implements OnDestroy {
  private readonly api = inject(OpsApi);
  private readonly auth = inject(AuthService);
  protected readonly statuses = signal<SyncStatus[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly canManage = computed(() => this.auth.hasOrgPermission('channel.manage'));
  private propertyId: string | null = null;
  private readonly timer = setInterval(() => this.load(), 15_000);

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  onProperty(p: Property): void {
    this.propertyId = p.id;
    this.loaded.set(false);
    this.load();
  }

  load(): void {
    if (!this.propertyId) return;
    this.api.syncStatus(this.propertyId).subscribe({
      next: (s) => {
        this.statuses.set(s);
        this.loaded.set(true);
      },
      error: (e: unknown) => {
        this.loaded.set(true);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected retry(j: SyncStatusJob): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.retryJob(j.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set('Queued again. It is sent within a few seconds.');
        this.load();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected health(s: SyncStatus) {
    return HEALTH[s.health];
  }
  protected job(j: SyncStatusJob) {
    return JOB[j.status];
  }
  protected kind(j: SyncStatusJob): string {
    return j.kind === 'AVAILABILITY' ? 'Availability' : j.kind === 'RATES' ? 'Rates' : 'Derived prices';
  }
  /** dateTo is exclusive; show the last day included. */
  protected lastDay(exclusive: string): string {
    const d = new Date(`${exclusive}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
