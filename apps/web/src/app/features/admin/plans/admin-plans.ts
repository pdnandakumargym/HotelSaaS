import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { AdminApi, AdminPlan } from '../../../core/api/admin-api.service';
import { formatMoney } from '../../../core/api/org-api.service';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-admin-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusPill],
  template: `
    <header class="ss-page-head"><div><h1>Plans &amp; billing</h1><p class="ss-muted">Plan catalog and limits. Change a customer's plan from their customer page.</p></div></header>
    <div class="plans">
      @for (p of plans(); track p.code) {
        <section class="ss-card">
          <h2 class="ss-card__title">{{ p.name }} <ss-status-pill [tone]="p.isActive ? 'success' : 'neutral'">{{ p.isActive ? 'Active' : 'Retired' }}</ss-status-pill></h2>
          <p class="price">{{ money(p.priceMonthlyMinor, p.currency) }} <small>/ month</small></p>
          <ul>
            <li>{{ p.maxChannels }} channels</li>
            <li>{{ p.maxProperties }} properties</li>
            <li>{{ p.maxUsers }} users</li>
            <li>{{ p.trialDays ? p.trialDays + '-day trial' : 'No trial' }}</li>
          </ul>
          <p class="ss-muted code">Code: {{ p.code }}</p>
        </section>
      }
    </div>
    <p class="ss-alert ss-alert--info">Online payments, invoices and coupons are not built yet. Plan prices and limits are seeded by a database migration.</p>
  `,
  styles: `
    .plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-bottom: 16px; }
    .price { font-size: 24px; font-weight: 700; margin: 4px 0 8px; }
    .price small { font-size: 13px; color: var(--ss-text-muted); font-weight: 500; }
    ul { padding-left: 18px; margin: 0; }
    .code { font-size: 12px; margin: 8px 0 0; }
  `,
})
export class AdminPlans implements OnInit {
  private readonly api = inject(AdminApi);
  protected readonly plans = signal<AdminPlan[]>([]);
  ngOnInit(): void {
    this.api.plans().subscribe((r) => this.plans.set(r.data));
  }
  protected money(minor: number, currency: string): string {
    return formatMoney(minor, currency);
  }
}
