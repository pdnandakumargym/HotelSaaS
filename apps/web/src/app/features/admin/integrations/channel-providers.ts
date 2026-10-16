import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import {
  CONNECTION_LABEL,
  CREDENTIAL_LABEL,
  CallResult,
  IntegrationHealth,
  IntegrationsApi,
  ProviderConfig,
  REFERENCE_KINDS,
  ReferenceData,
  ReferenceKind,
} from '../../../core/api/integrations-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { JsonTable } from '../../../shared/ui/json-table/json-table';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-channel-providers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, StatusPill, JsonTable],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Channel providers</h1>
        <p class="ss-muted">StaySync connects to booking channels through Zodomus. Credentials live only in the server environment and are never shown here.</p>
      </div>
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }

    @if (config(); as c) {
      <section class="ss-card">
        <h2 class="ss-card__title">
          {{ c.displayName }}
          @if (health(); as hl) { <ss-status-pill [tone]="conn(hl).tone">{{ conn(hl).label }}</ss-status-pill> }
        </h2>
        <dl class="kv">
          <dt>Environment</dt><dd><ss-status-pill [tone]="c.environment === 'production' ? 'warning' : 'info'">{{ c.environment === 'production' ? 'Production' : 'Sandbox' }}</ss-status-pill></dd>
          <dt>Enabled</dt><dd>{{ c.enabled ? 'Yes' : 'No (ZODOMUS_ENABLED=false)' }}</dd>
          <dt>API endpoint</dt><dd><code>{{ c.baseUrl }}</code></dd>
          <dt>API credentials</dt>
          <dd>
            @if (health(); as hl) { <ss-status-pill [tone]="cred(hl).tone">{{ cred(hl).label }}</ss-status-pill> }
            <span class="ss-muted small">{{ c.credentialsConfigured ? 'Set in the server environment' : 'Not set: add ZODOMUS_API_USERNAME and ZODOMUS_API_PASSWORD to apps/api/.env and restart the API' }}</span>
          </dd>
          @if (health(); as hl) {
            <dt>Last successful call</dt><dd>{{ hl.lastSuccessAt ? (hl.lastSuccessAt | date: 'medium') : 'Never' }}</dd>
            @if (hl.lastFailure; as f) {
              <dt>Last failure</dt><dd>{{ f.at | date: 'medium' }} · {{ f.outcome }}{{ f.httpStatus ? ' (HTTP ' + f.httpStatus + ')' : '' }}</dd>
            }
          }
        </dl>
        <div class="actions">
          @if (canManage()) {
            <button type="button" class="ss-btn" (click)="test()" [disabled]="busy() || !ready()">{{ busy() === 'test' ? 'Testing…' : 'Test connection' }}</button>
          }
          <a class="ss-btn ss-btn--ghost" routerLink="/admin/zodomus">API health</a>
          <a class="ss-btn ss-btn--ghost" routerLink="/admin/api-logs">API logs</a>
        </div>
        @if (!ready()) { <p class="ss-muted small">Test connection is available once Zodomus is enabled and both credentials are set.</p> }
        @if (lastTest(); as t) {
          <p class="ss-alert" [class.ss-alert--success]="t.ok" [class.ss-alert--error]="!t.ok" role="status">
            @if (t.ok) { Connection verified: GET /account answered in {{ t.durationMs }} ms{{ t.providerCode !== null ? ' (Zodomus status ' + t.providerCode + (t.providerMessage ? ': ' + t.providerMessage : '') + ')' : '' }}. }
            @else { {{ t.error?.message ?? 'Connection failed.' }} ({{ t.outcome }}{{ t.attempts > 1 ? ', ' + t.attempts + ' attempts' : '' }}) }
          </p>
        }
      </section>

      <section class="ss-card">
        <h2 class="ss-card__title">Read-only reference data</h2>
        <p class="ss-muted small">Fetched from Zodomus on request and cached (sanitized). Owners see the cached channel list on their Channels page.</p>
        <div class="tabs" role="tablist" aria-label="Reference data">
          @for (k of kinds; track k.kind) {
            <button type="button" role="tab" class="tab" [class.active]="kind() === k.kind" [attr.aria-selected]="kind() === k.kind" (click)="select(k.kind)">{{ k.label }}</button>
          }
        </div>
        <div class="tabpanel" role="tabpanel">
          <div class="refhead">
            <span class="ss-muted small"><code>{{ kindPath() }}</code> ·
              @if (reference(); as r) { cached {{ r.fetchedAt | date: 'medium' }}{{ r.itemCount !== null ? ' · ' + r.itemCount + ' items' : '' }} }
              @else { not fetched yet }
            </span>
            @if (canManage()) {
              <button type="button" class="ss-btn ss-btn--ghost" (click)="refresh()" [disabled]="busy() || !ready()">{{ busy() === 'refresh' ? 'Fetching…' : 'Fetch from Zodomus' }}</button>
            }
          </div>
          @if (refreshError(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
          @if (reference(); as r) { <ss-json-table [data]="r.payload" /> }
        </div>
      </section>

      <p class="ss-alert ss-alert--info">
        Owners connect their properties to Booking.com on their Room &amp; Rate Mapping page. Availability and rate updates are then sent
        automatically; every call is listed under API Logs. Production writes stay blocked unless ZODOMUS_ALLOW_PRODUCTION_WRITES=true.
      </p>
    }
  `,
  styles: `
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px; margin: 0 0 16px; font-size: 14px; align-items: center; }
    .kv dt { color: var(--ss-text-muted); }
    .kv dd { margin: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .small { font-size: 12.5px; }
    section { margin-bottom: 16px; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--ss-border); margin: 12px 0; flex-wrap: wrap; }
    .tab { background: none; border: 0; padding: 8px 12px; cursor: pointer; font: inherit; color: var(--ss-text-muted); border-bottom: 2px solid transparent; }
    .tab.active { color: var(--ss-blue-600); border-bottom-color: var(--ss-blue-600); font-weight: 600; }
    .refhead { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  `,
})
export class ChannelProviders implements OnInit {
  private readonly api = inject(IntegrationsApi);
  private readonly auth = inject(AuthService);
  protected readonly kinds = REFERENCE_KINDS;
  protected readonly config = signal<ProviderConfig | null>(null);
  protected readonly health = signal<IntegrationHealth | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal<'test' | 'refresh' | null>(null);
  protected readonly lastTest = signal<CallResult | null>(null);
  protected readonly kind = signal<ReferenceKind>('channels');
  protected readonly reference = signal<ReferenceData | null>(null);
  protected readonly refreshError = signal<string | null>(null);
  protected readonly canManage = computed(() => this.auth.hasPlatformPermission('admin.integration.manage'));
  protected readonly ready = computed(() => !!this.config()?.enabled && !!this.config()?.credentialsConfigured);
  protected readonly kindPath = computed(() => this.kinds.find((k) => k.kind === this.kind())?.path ?? '');

  ngOnInit(): void {
    this.load();
    this.loadReference();
  }

  protected conn(h: IntegrationHealth) {
    return CONNECTION_LABEL[h.connection];
  }
  protected cred(h: IntegrationHealth) {
    return CREDENTIAL_LABEL[h.credentials];
  }

  protected select(kind: ReferenceKind): void {
    this.kind.set(kind);
    this.refreshError.set(null);
    this.loadReference();
  }

  protected test(): void {
    this.busy.set('test');
    this.api.testConnection().subscribe({
      next: (r) => {
        this.lastTest.set(r);
        this.busy.set(null);
        this.load();
      },
      error: (e: unknown) => {
        this.error.set(errorMessage(e));
        this.busy.set(null);
      },
    });
  }

  protected refresh(): void {
    this.busy.set('refresh');
    this.refreshError.set(null);
    this.api.refresh(this.kind()).subscribe({
      next: (r) => {
        this.busy.set(null);
        if (!r.ok) this.refreshError.set(`${r.error?.message ?? 'Fetch failed.'} The previous cached data (if any) was kept.`);
        this.loadReference();
        this.load();
      },
      error: (e: unknown) => {
        this.refreshError.set(errorMessage(e));
        this.busy.set(null);
      },
    });
  }

  private load(): void {
    this.api.status().subscribe({
      next: (s) => {
        this.config.set(s.config);
        this.health.set(s.health);
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }

  private loadReference(): void {
    const kind = this.kind();
    this.api.reference(kind).subscribe({
      next: (r) => {
        if (this.kind() === kind) this.reference.set(r);
      },
      error: () => this.reference.set(null),
    });
  }
}
