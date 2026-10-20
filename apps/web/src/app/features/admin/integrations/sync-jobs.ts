import { DatePipe, KeyValuePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { errorMessage } from '../../../core/api/error-message';
import { IntegrationsApi, PlatformSyncOverview } from '../../../core/api/integrations-api.service';
import { KpiTile } from '../../../shared/ui/kpi-tile/kpi-tile';

/** Platform-wide health of the update queue and reservation polling. Counts only: no tenant or guest data. */
@Component({
  selector: 'ss-sync-jobs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, KeyValuePipe, KpiTile],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Sync jobs</h1>
        <p class="ss-muted">Queue and polling health across all customers. Details of a customer's jobs and bookings need their approved support access.</p>
      </div>
      <button type="button" class="ss-btn ss-btn--ghost" (click)="load()">Refresh</button>
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (data(); as d) {
      <div class="tiles">
        <ss-kpi-tile label="Queued updates" [value]="'' + (d.jobs.pending ?? 0)" [hint]="d.jobs.oldestPendingAt ? 'oldest ' + (d.jobs.oldestPendingAt | date: 'short') : 'queue empty'" />
        <ss-kpi-tile label="Sending now" [value]="'' + (d.jobs.running ?? 0)" hint="claimed by a worker" />
        <ss-kpi-tile label="Failed (24 h)" [value]="'' + d.jobs.failed24h" hint="after retries or rejected" />
        <ss-kpi-tile label="Active connections" [value]="'' + (d.connections.active ?? 0)" [hint]="(d.connections.error ?? 0) + ' need attention'" />
        <ss-kpi-tile label="Booking polling failing" [value]="'' + d.reservationPollingFailing" hint="3+ failures in a row" />
      </div>
      <section class="ss-card">
        <h2 class="ss-card__title">Open discrepancies by type</h2>
        @for (k of d.openDiscrepancies | keyvalue; track k.key) {
          <p class="row"><span>{{ k.key }}</span><strong>{{ k.value }}</strong></p>
        } @empty {
          <p class="ss-muted">None open.</p>
        }
      </section>
    }
  `,
  styles: `
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .row { display: flex; justify-content: space-between; max-width: 360px; margin: 4px 0; font-size: 13.5px; }
  `,
})
export class SyncJobs implements OnInit {
  private readonly api = inject(IntegrationsApi);
  protected readonly data = signal<PlatformSyncOverview | null>(null);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
  }
  load(): void {
    this.api.syncOverview().subscribe({ next: (d) => this.data.set(d), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }
}
