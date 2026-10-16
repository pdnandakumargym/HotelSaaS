import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { CONNECTION_LABEL, CREDENTIAL_LABEL, CallLog, IntegrationHealth, IntegrationsApi, ProviderConfig } from '../../../core/api/integrations-api.service';
import { KpiTile } from '../../../shared/ui/kpi-tile/kpi-tile';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-zodomus-health',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, KpiTile, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Zodomus health</h1>
        <p class="ss-muted">Measured from StaySync's own calls to Zodomus over the last {{ health()?.window?.hours ?? 24 }} hours. No synthetic traffic.</p>
      </div>
      <button type="button" class="ss-btn ss-btn--ghost" (click)="load()">Refresh</button>
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (health(); as h) {
      <div class="status">
        <span>Connection</span><ss-status-pill [tone]="conn().tone">{{ conn().label }}</ss-status-pill>
        <span>Credentials</span><ss-status-pill [tone]="cred().tone">{{ cred().label }}</ss-status-pill>
        @if (config(); as c) { <span>Environment</span><ss-status-pill tone="info">{{ c.environment }}</ss-status-pill> }
      </div>
      <div class="tiles">
        <ss-kpi-tile label="Calls" [value]="h.window.calls ? '' + h.window.calls : null" [hint]="h.window.calls ? 'last ' + h.window.hours + ' h' : 'No calls yet'" />
        <ss-kpi-tile label="Error rate" [value]="h.window.errorRate !== null ? pct(h.window.errorRate) : null" [hint]="h.window.failures + ' failed'" />
        <ss-kpi-tile label="Median latency" [value]="h.window.p50Ms !== null ? h.window.p50Ms + ' ms' : null" hint="p50, incl. retries" />
        <ss-kpi-tile label="p95 latency" [value]="h.window.p95Ms !== null ? h.window.p95Ms + ' ms' : null" hint="95th percentile" />
      </div>
      <section class="ss-card">
        <h2 class="ss-card__title">Recent failures</h2>
        @if (failures().length) {
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead><tr><th scope="col">When</th><th scope="col">Call</th><th scope="col">Outcome</th><th scope="col">Message</th></tr></thead>
              <tbody>
                @for (f of failures(); track f.id) {
                  <tr>
                    <td>{{ f.createdAt | date: 'short' }}</td>
                    <td><code>{{ f.httpMethod }} {{ f.path }}</code></td>
                    <td>{{ f.outcome }}{{ f.httpStatus ? ' (' + f.httpStatus + ')' : '' }}</td>
                    <td>{{ f.errorMessage ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="ss-muted">No failed calls in the latest 100.</p>
        }
        <p class="small"><a routerLink="/admin/api-logs">All API logs</a> · <a routerLink="/admin/channel-providers">Test connection</a></p>
      </section>
    }
  `,
  styles: `
    .status { display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; font-size: 13.5px; color: var(--ss-text-muted); }
    .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .small { font-size: 13px; margin: 12px 0 0; }
    @media (max-width: 900px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `,
})
export class ZodomusHealth implements OnInit {
  private readonly api = inject(IntegrationsApi);
  protected readonly health = signal<IntegrationHealth | null>(null);
  protected readonly config = signal<ProviderConfig | null>(null);
  protected readonly calls = signal<CallLog[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly failures = computed(() => this.calls().filter((c) => c.outcome !== 'SUCCESS').slice(0, 10));
  protected readonly conn = computed(() => CONNECTION_LABEL[this.health()?.connection ?? 'not_configured']);
  protected readonly cred = computed(() => CREDENTIAL_LABEL[this.health()?.credentials ?? 'not_configured']);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.error.set(null);
    this.api.status().subscribe({
      next: (s) => {
        this.health.set(s.health);
        this.config.set(s.config);
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
    this.api.calls(100).subscribe({ next: (c) => this.calls.set(c), error: () => this.calls.set([]) });
  }

  protected pct(v: number): string {
    return `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`;
  }
}
