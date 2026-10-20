import { DatePipe, KeyValuePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { errorMessage } from '../../../core/api/error-message';
import { Beds24Status, CallResult, IntegrationsApi, SystemHealth } from '../../../core/api/integrations-api.service';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

/** Services, workers, queue and configuration at a glance (no secrets). Refreshes every 30 seconds. */
@Component({
  selector: 'ss-system-health',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, KeyValuePipe, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>System health &amp; configuration</h1>
        <p class="ss-muted">Live state of the database, background workers and channel queue, and the settings in effect. Secrets are never shown.</p>
      </div>
      <button type="button" class="ss-btn ss-btn--ghost" (click)="load()">Refresh</button>
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (data(); as d) {
      <section class="ss-card">
        <h2 class="ss-card__title">Checks</h2>
        <ul class="checks">
          @for (c of d.checks; track c.name) {
            <li><ss-status-pill [tone]="c.ok ? 'success' : 'danger'">{{ c.ok ? 'OK' : 'Attention' }}</ss-status-pill> {{ c.name }}</li>
          }
        </ul>
        <p class="ss-muted small">{{ d.app.name }} {{ d.app.version }} · {{ d.app.nodeEnv }} · Node {{ d.app.node }} · API up {{ uptime(d.app.uptimeSeconds) }}</p>
      </section>

      <div class="grid">
        <section class="ss-card">
          <h2 class="ss-card__title">Database</h2>
          <dl>
            <dt>Status</dt><dd>{{ d.database.ok ? 'Reachable' : 'Not reachable' }}@if (d.database.latencyMs !== null) { ({{ d.database.latencyMs }} ms) }</dd>
            <dt>Migrations</dt><dd>{{ d.database.migrationsApplied ?? '—' }} applied</dd>
            <dt>Latest</dt><dd><code>{{ d.database.latestMigration ?? '—' }}</code></dd>
            @if (d.database.pendingMigrations?.length) { <dt>Pending</dt><dd class="bad">{{ d.database.pendingMigrations!.join(', ') }} — run <code>npm run db:deploy</code></dd> }
          </dl>
        </section>
        <section class="ss-card">
          <h2 class="ss-card__title">Channel queue</h2>
          @if (d.queue; as q) {
            <dl>
              <dt>Waiting</dt><dd>{{ q.pending }} queued · {{ q.running }} sending</dd>
              <dt>Oldest queued</dt><dd>{{ q.oldestPendingAt ? (q.oldestPendingAt | date: 'short') : '—' }}</dd>
              <dt>Failed (24 h)</dt><dd [class.bad]="q.failed24h > 0">{{ q.failed24h }}</dd>
              <dt>Polling failing</dt><dd [class.bad]="q.reservationPollingFailing > 0">{{ q.reservationPollingFailing }} connection(s)</dd>
            </dl>
          }
        </section>
        @if (d.usage; as u) {
          <section class="ss-card">
            <h2 class="ss-card__title">Usage</h2>
            <dl>
              <dt>Organizations</dt><dd>{{ u.organizations }}</dd>
              <dt>Photos</dt><dd>{{ u.photos }} ({{ mb(u.photoBytes) }})</dd>
              <dt>Open discrepancies</dt><dd>{{ u.openDiscrepancies }}</dd>
            </dl>
          </section>
        }
      </div>

      @if (beds24(); as b) {
        <section class="ss-card">
          <h2 class="ss-card__title">Beds24 (second channel manager)</h2>
          <dl>
            <dt>Status</dt><dd>{{ !b.config.enabled ? 'Disabled (BEDS24_ENABLED=false)' : !b.config.credentialsConfigured ? 'No refresh token' : b.health.connection }}</dd>
            <dt>Token</dt><dd>{{ b.health.credentials }}</dd>
            <dt>Calendar writes</dt><dd [class.bad]="b.config.enabled && !b.details?.allowWrites">{{ b.details?.allowWrites ? 'Allowed' : 'Off (BEDS24_ALLOW_WRITES)' }}</dd>
            <dt>Date-range rule</dt><dd [class.bad]="b.config.enabled && b.details?.calendarToInclusive === null">{{ b.details?.calendarToInclusive === null ? 'Not confirmed — run npm run beds24:check' : b.details?.calendarToInclusive ? '"to" included' : '"to" excluded' }}</dd>
            @if (b.details?.credits; as c) { <dt>Credits</dt><dd>{{ c.remaining ?? '?' }} of {{ c.limit ?? '?' }} left (5-minute window, seen {{ c.observedAt | date: 'mediumTime' }})</dd> }
            @if (b.health.lastFailure; as f) { <dt>Last failure</dt><dd>{{ f.at | date: 'short' }} · {{ f.message ?? f.outcome }}</dd> }
          </dl>
          @if (b.config.enabled && b.config.credentialsConfigured) {
            <p><button type="button" class="ss-btn ss-btn--ghost" (click)="testBeds24()" [disabled]="testing()">{{ testing() ? 'Testing…' : 'Test connection' }}</button>
              @if (beds24Result(); as r) { <span [class.bad]="!r.ok"> {{ r.ok ? 'Token accepted (' + r.durationMs + ' ms)' : (r.error?.message ?? r.outcome) }}</span> }</p>
          }
        </section>
      }

      <section class="ss-card">
        <h2 class="ss-card__title">Background workers</h2>
        <p class="ss-muted small">{{ d.workers.embeddedInApi ? 'This API process also runs the background loops (SYNC_WORKER_ENABLED).' : 'This API process does not run background loops; a separate worker process must be running.' }}</p>
        @if (d.workers.list.length) {
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead><tr><th scope="col">Process</th><th scope="col">Role</th><th scope="col">Version</th><th scope="col">Started</th><th scope="col">Last seen</th><th scope="col">Updates sent</th><th scope="col">Booking polls</th></tr></thead>
              <tbody>
                @for (w of d.workers.list; track w.id) {
                  <tr>
                    <td><code>{{ w.id }}</code> @if (w.stale) { <ss-status-pill tone="danger">Not responding</ss-status-pill> }</td>
                    <td>{{ w.role }}</td><td>{{ w.version }}</td>
                    <td>{{ w.startedAt | date: 'short' }}</td><td>{{ w.lastSeenAt | date: 'mediumTime' }}</td>
                    <td>{{ w.stats['sync']?.['jobsProcessed'] ?? 0 }}</td><td>{{ w.stats['reservations']?.['polls'] ?? 0 }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="ss-alert ss-alert--error">No background worker has reported in. Availability, rates and bookings are not being synchronised.</p>
        }
      </section>

      <section class="ss-card">
        <h2 class="ss-card__title">Configuration in effect</h2>
        <div class="cfg">
          @for (g of d.config | keyvalue; track g.key) {
            <div>
              <h3>{{ g.key }}</h3>
              <dl>@for (kv of g.value | keyvalue; track kv.key) { <dt>{{ kv.key }}</dt><dd><code>{{ show(kv.value) }}</code></dd> }</dl>
            </div>
          }
        </div>
      </section>
    }
  `,
  styles: `
    .checks { list-style: none; padding: 0; margin: 0 0 8px; display: grid; gap: 6px; font-size: 13.5px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    dl { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; margin: 0; font-size: 13.5px; }
    dt { color: var(--ss-text-muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    .bad { color: var(--ss-red-600); }
    .small { font-size: 12.5px; }
    .cfg { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    h3 { font-size: 13.5px; margin: 0 0 6px; text-transform: capitalize; }
    section.ss-card { margin-bottom: 16px; }
  `,
})
export class SystemHealthPage implements OnInit, OnDestroy {
  private readonly api = inject(IntegrationsApi);
  protected readonly data = signal<SystemHealth | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly beds24 = signal<Beds24Status | null>(null);
  protected readonly beds24Result = signal<CallResult | null>(null);
  protected readonly testing = signal(false);
  private readonly timer = setInterval(() => this.load(), 30_000);

  ngOnInit(): void {
    this.load();
  }
  ngOnDestroy(): void {
    clearInterval(this.timer);
  }
  load(): void {
    this.api.system().subscribe({ next: (d) => this.data.set(d), error: (e: unknown) => this.error.set(errorMessage(e)) });
    this.api.beds24().subscribe({ next: (b) => this.beds24.set(b), error: () => this.beds24.set(null) });
  }
  protected testBeds24(): void {
    this.testing.set(true);
    this.api.beds24Test().subscribe({
      next: (r) => {
        this.testing.set(false);
        this.beds24Result.set(r);
        this.load();
      },
      error: (e: unknown) => {
        this.testing.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }
  protected show(v: unknown): string {
    return Array.isArray(v) ? v.join(', ') : String(v);
  }
  protected uptime(s: number): string {
    const h = Math.floor(s / 3600);
    return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h ? `${h} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`;
  }
  protected mb(bytes: number): string {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
}
