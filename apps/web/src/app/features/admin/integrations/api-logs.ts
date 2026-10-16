import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { errorMessage } from '../../../core/api/error-message';
import { CallLog, IntegrationsApi } from '../../../core/api/integrations-api.service';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-api-logs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>API logs</h1>
        <p class="ss-muted">Outbound calls to Zodomus. Only metadata is kept: never credentials, request bodies or response bodies.</p>
      </div>
      <button type="button" class="ss-btn ss-btn--ghost" (click)="load()">Refresh</button>
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    <div class="filters">
      <label><input type="checkbox" [checked]="failedOnly()" (change)="failedOnly.set(!failedOnly())" /> Failures only</label>
    </div>
    @if (rows().length) {
      <div class="ss-table-wrap">
        <table class="ss-table">
          <thead>
            <tr><th scope="col">Time</th><th scope="col">Env</th><th scope="col">Call</th><th scope="col">Status</th><th scope="col">Duration</th><th scope="col">Attempts</th><th scope="col">Zodomus status</th><th scope="col">Message</th><th scope="col">Request ID</th></tr>
          </thead>
          <tbody>
            @for (c of rows(); track c.id) {
              <tr>
                <td>{{ c.createdAt | date: 'medium' }}</td>
                <td>{{ c.environment }}</td>
                <td><code>{{ c.httpMethod }} {{ c.path }}</code></td>
                <td><ss-status-pill [tone]="c.outcome === 'SUCCESS' ? 'success' : c.outcome === 'AUTH_ERROR' || c.outcome === 'CLIENT_ERROR' ? 'warning' : 'danger'">{{ c.outcome }}{{ c.httpStatus ? ' ' + c.httpStatus : '' }}</ss-status-pill></td>
                <td>{{ c.durationMs }} ms</td>
                <td>{{ c.attempts }}</td>
                <td>{{ c.providerCode !== null ? c.providerCode + (c.providerMessage ? ' · ' + c.providerMessage : '') : '—' }}</td>
                <td>{{ c.errorMessage ?? '—' }}</td>
                <td><code class="rid">{{ c.requestId ?? '—' }}</code></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else if (loaded()) {
      <p class="ss-muted">No calls recorded{{ failedOnly() ? ' that failed' : '' }}. Use "Test connection" on the Channel providers page to make the first call.</p>
    }
  `,
  styles: `
    .filters { margin-bottom: 12px; font-size: 13.5px; }
    .rid { font-size: 11px; }
  `,
})
export class ApiLogs implements OnInit {
  private readonly api = inject(IntegrationsApi);
  protected readonly calls = signal<CallLog[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly failedOnly = signal(false);
  protected readonly rows = computed(() => (this.failedOnly() ? this.calls().filter((c) => c.outcome !== 'SUCCESS') : this.calls()));

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.api.calls(200).subscribe({
      next: (c) => {
        this.calls.set(c);
        this.loaded.set(true);
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }
}
