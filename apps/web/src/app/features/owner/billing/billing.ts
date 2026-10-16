import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { errorMessage } from '../../../core/api/error-message';
import { OrgApi, Plan, Subscription, formatMoney } from '../../../core/api/org-api.service';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-billing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Subscription &amp; billing</h1>
        <p class="ss-muted">Your plan and what it includes. Plan limits are enforced by the platform.</p>
      </div>
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error">{{ e }}</p> }
    @if (sub(); as s) {
      <div class="grid">
        <section class="ss-card">
          <h2 class="ss-card__title">Current plan <ss-status-pill [tone]="s.status === 'ACTIVE' || s.status === 'TRIALING' ? 'success' : 'warning'">{{ statusLabel(s.status) }}</ss-status-pill></h2>
          <p class="plan">{{ s.plan.name }} <span class="price">{{ money(s.plan.priceMonthlyMinor, s.plan.currency) }} / month</span></p>
          @if (s.status === 'TRIALING' && s.trialEndsAt) { <p class="ss-muted">Trial ends {{ s.trialEndsAt | date: 'mediumDate' }}.</p> }
          <p class="ss-alert ss-alert--info">Online payment is not available yet. To change plan, contact support. A platform administrator can switch it for you.</p>
        </section>
        <section class="ss-card">
          <h2 class="ss-card__title">Usage</h2>
          @for (u of usageRows(s); track u.label) {
            <div class="usage">
              <div class="usage__row"><span>{{ u.label }}</span><span>{{ u.used }} / {{ u.max }}</span></div>
              <div class="bar" role="progressbar" [attr.aria-label]="u.label" aria-valuemin="0" [attr.aria-valuemax]="u.max" [attr.aria-valuenow]="u.used">
                <span [style.width.%]="u.max ? Math.min(100, (u.used / u.max) * 100) : 0" [class.full]="u.used >= u.max"></span>
              </div>
              @if (u.note) { <small class="ss-muted">{{ u.note }}</small> }
            </div>
          }
        </section>
      </div>
      <h2 class="section-title">Plans</h2>
      <div class="plans">
        @for (p of plans(); track p.code) {
          <section class="ss-card plan-card" [class.current]="p.code === s.plan.code">
            <h3>{{ p.name }} @if (p.code === s.plan.code) { <ss-status-pill tone="info">Current</ss-status-pill> }</h3>
            <p class="price-big">{{ money(p.priceMonthlyMinor, p.currency) }}<small>/month</small></p>
            <ul>
              <li>Up to {{ p.maxChannels }} booking channels</li>
              <li>{{ p.maxProperties }} propert{{ p.maxProperties === 1 ? 'y' : 'ies' }}</li>
              <li>{{ p.maxUsers }} team members</li>
              @if (p.trialDays) { <li>{{ p.trialDays }}-day trial</li> }
            </ul>
          </section>
        }
      </div>
      <p class="ss-muted small">Invoices and payment methods arrive with online billing in a later release.</p>
    }
  `,
  styles: `
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .plan { font-size: 22px; font-weight: 700; margin: 0 0 6px; }
    .price { font-size: 14px; font-weight: 500; color: var(--ss-text-muted); margin-left: 6px; }
    .usage { margin-bottom: 12px; }
    .usage__row { display: flex; justify-content: space-between; font-size: 13.5px; margin-bottom: 4px; }
    .bar { height: 8px; border-radius: 999px; background: var(--ss-gray-50); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--ss-blue-600); }
    .bar span.full { background: var(--ss-amber-600); }
    .section-title { font-size: 17px; margin: 24px 0 12px; }
    .plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
    .plan-card.current { border-color: var(--ss-blue-500); box-shadow: 0 0 0 1px var(--ss-blue-500); }
    .plan-card h3 { display: flex; gap: 8px; align-items: center; font-size: 16px; }
    .price-big { font-size: 24px; font-weight: 700; margin: 8px 0; }
    .price-big small { font-size: 13px; color: var(--ss-text-muted); font-weight: 500; }
    ul { padding-left: 18px; margin: 0; font-size: 13.5px; }
    .small { font-size: 12.5px; margin-top: 12px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class Billing implements OnInit {
  private readonly api = inject(OrgApi);
  protected readonly Math = Math;
  protected readonly sub = signal<Subscription | null>(null);
  protected readonly plans = signal<Plan[]>([]);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    forkJoin([this.api.subscription(), this.api.plans()]).subscribe({
      next: ([s, p]) => {
        this.sub.set(s);
        this.plans.set(p);
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }

  protected money(minor: number, currency: string): string {
    return formatMoney(minor, currency);
  }
  protected statusLabel(s: string): string {
    return { TRIALING: 'Trial', ACTIVE: 'Active', PAST_DUE: 'Past due', CANCELED: 'Canceled' }[s] ?? s;
  }
  protected usageRows(s: Subscription) {
    return [
      { label: 'Properties', used: s.usage.properties, max: s.plan.maxProperties, note: '' },
      { label: 'Team members', used: s.usage.users, max: s.plan.maxUsers, note: s.usage.pendingInvitations ? `Includes ${s.usage.pendingInvitations} pending invitation(s)` : '' },
      { label: 'Booking channels', used: s.usage.channels, max: s.plan.maxChannels, note: 'Channel connections arrive in Milestone 4' },
    ];
  }
}
