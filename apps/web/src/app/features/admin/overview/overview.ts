import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { AdminApi } from '../../../core/api/admin-api.service';
import { KpiTile } from '../../../shared/ui/kpi-tile/kpi-tile';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';
import { SystemStatusCard } from '../../system/system-status/system-status';

@Component({
  selector: 'ss-admin-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KpiTile, StatusPill, SystemStatusCard],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Platform overview</h1>
        <p class="ss-muted">Health and key counts across all customers.</p>
      </div>
    </header>

    <section class="kpis" aria-label="Platform metrics">
      <ss-kpi-tile label="Customers" [value]="counts()?.organizations?.toString() ?? null" hint="Organizations" />
      <ss-kpi-tile label="Properties" [value]="counts()?.properties?.toString() ?? null" hint="All tenants" />
      <ss-kpi-tile label="Users" [value]="counts()?.users?.toString() ?? null" hint="All accounts" />
      <ss-kpi-tile label="Locked accounts" [value]="counts()?.lockedUsers?.toString() ?? null" hint="Temporary lockouts right now" />
    </section>

    <div class="grid">
      <ss-system-status />
      <section class="ss-card" aria-labelledby="sec-title">
        <h2 class="ss-card__title" id="sec-title">Security posture (this build)</h2>
        <ul class="checks">
          <li><ss-status-pill tone="success">On</ss-status-pill> Argon2id passwords, lockout with capped backoff</li>
          <li><ss-status-pill tone="success">On</ss-status-pill> HttpOnly session cookies, CSRF tokens, session revocation</li>
          <li><ss-status-pill tone="success">On</ss-status-pill> Mandatory TOTP 2FA for platform admins</li>
          <li><ss-status-pill tone="success">On</ss-status-pill> Role-based access control enforced by the API</li>
          <li><ss-status-pill tone="success">On</ss-status-pill> Tenant isolation + PostgreSQL row-level security</li>
          <li><ss-status-pill tone="success">On</ss-status-pill> Append-only audit log</li>
          <li><ss-status-pill tone="neutral">M3</ss-status-pill> Audited, time-boxed support access to guest data</li>
        </ul>
      </section>
    </div>
  `,
  styles: `
    .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .checks { list-style: none; padding: 0; margin: 0; }
    .checks li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--ss-border); }
    .checks li:last-child { border-bottom: 0; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `,
})
export class AdminOverview implements OnInit {
  private readonly api = inject(AdminApi);
  protected readonly counts = signal<{ organizations: number; properties: number; users: number; lockedUsers: number } | null>(null);

  ngOnInit(): void {
    this.api.overview().subscribe({ next: (r) => this.counts.set(r.data), error: () => this.counts.set(null) });
  }
}
