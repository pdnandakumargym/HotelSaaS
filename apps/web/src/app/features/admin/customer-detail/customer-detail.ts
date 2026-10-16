import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminApi, AdminOrgDetail, AdminPlan } from '../../../core/api/admin-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { ROLE_LABELS, OrgRole } from '../../../core/auth/auth.models';
import { AuthService } from '../../../core/auth/auth.service';
import { StepUpService } from '../../../core/auth/step-up.service';
import { JoinPresentPipe } from '../../../shared/ui/join-present.pipe';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-admin-customer-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JoinPresentPipe, DatePipe, RouterLink, StatusPill, FormsModule, ReactiveFormsModule],
  templateUrl: './customer-detail.html',
  styles: `
    .crumb { margin: 0 0 4px; font-size: 13px; }
    h1 { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
    .wide { grid-column: 1 / -1; }
    .facts { display: grid; grid-template-columns: 150px 1fr; gap: 6px 12px; margin: 0; }
    .facts dt { color: var(--ss-text-muted); }
    .facts dd { margin: 0; }
    .row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; margin-top: 12px; }
    .row .ss-field { margin-bottom: 0; flex: 1; min-width: 180px; }
    .danger { background: var(--ss-red-600); }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class AdminCustomerDetail {
  readonly id = input.required<string>();
  private readonly api = inject(AdminApi);
  private readonly stepUp = inject(StepUpService);
  private readonly auth = inject(AuthService);
  protected readonly labels = ROLE_LABELS as Record<string, string>;
  protected readonly org = signal<AdminOrgDetail | null>(null);
  protected readonly plans = signal<AdminPlan[]>([]);
  protected readonly message = signal<{ tone: 'success' | 'error'; text: string } | null>(null);
  protected readonly canManageOrg = computed(() => this.auth.hasPlatformPermission('admin.org.manage'));
  protected readonly canManageBilling = computed(() => this.auth.hasPlatformPermission('admin.billing.manage'));
  protected readonly canRequestSupport = computed(() => this.auth.hasPlatformPermission('admin.support.request'));
  protected readonly reason = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(5)] });
  protected readonly plan = new FormControl('', { nonNullable: true });
  protected readonly supportReason = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(10)] });
  protected readonly supportMinutes = new FormControl(60, { nonNullable: true });

  constructor() {
    this.api.plans().subscribe((r) => this.plans.set(r.data));
    effect(() => this.load(this.id()));
  }

  protected role(r: string): string {
    return this.labels[r as OrgRole] ?? r;
  }

  private load(id = this.id()): void {
    this.api.organization(id).subscribe({
      next: (r) => {
        this.org.set(r.data);
        this.plan.setValue(r.data.subscription.plan.code);
      },
      error: (e: unknown) => this.message.set({ tone: 'error', text: errorMessage(e) }),
    });
  }

  private done(text: string): void {
    this.message.set({ tone: 'success', text });
    this.load();
  }
  private fail(e: unknown): void {
    this.message.set({ tone: 'error', text: errorMessage(e) });
  }

  protected setStatus(status: 'ACTIVE' | 'SUSPENDED'): void {
    if (this.reason.invalid) {
      this.message.set({ tone: 'error', text: 'Enter a reason (it is recorded in the audit log).' });
      return;
    }
    this.stepUp.run(() => this.api.setOrganizationStatus(this.id(), status, this.reason.value)).subscribe({
      next: () => {
        this.reason.reset();
        this.done(status === 'SUSPENDED' ? 'Organization suspended. Members can no longer use it.' : 'Organization reactivated.');
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected changePlan(): void {
    this.stepUp.run(() => this.api.setSubscription(this.id(), this.plan.value)).subscribe({ next: () => this.done('Plan changed.'), error: (e: unknown) => this.fail(e) });
  }

  protected requestSupport(): void {
    if (this.supportReason.invalid) {
      this.message.set({ tone: 'error', text: 'Describe why you need access (at least 10 characters).' });
      return;
    }
    this.api.requestSupport(this.id(), this.supportReason.value, Number(this.supportMinutes.value)).subscribe({
      next: () => {
        this.supportReason.reset();
        this.done('Request sent to the organization owners. Track it under Support Tools.');
      },
      error: (e: unknown) => this.fail(e),
    });
  }
}
