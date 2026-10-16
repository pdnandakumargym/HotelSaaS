import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { OrgApi } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { RouterLink } from '@angular/router';
import { Icon } from '../../../shared/ui/icon/icon';
import { KpiTile } from '../../../shared/ui/kpi-tile/kpi-tile';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';
import { SystemStatusCard } from '../../system/system-status/system-status';

interface OnboardingStep {
  label: string;
  milestone: number;
  done: boolean;
  link?: string;
}

@Component({
  selector: 'ss-owner-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KpiTile, StatusPill, Icon, RouterLink, SystemStatusCard],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class OwnerDashboard implements OnInit {
  private readonly api = inject(OrgApi);
  /** Real counts from the API (null until loaded). */
  protected readonly counts = signal<{ properties: number; roomTypes: number; rooms: number } | null>(null);

  ngOnInit(): void {
    if (!this.auth.currentOrg() || !this.auth.hasOrgPermission('property.read')) return;
    this.api.properties().subscribe({
      next: (list) =>
        this.counts.set({
          properties: list.length,
          roomTypes: list.reduce((n, p) => n + (p.roomTypeCount ?? 0), 0),
          rooms: list.reduce((n, p) => n + (p.roomCount ?? 0), 0),
        }),
      error: () => this.counts.set(null),
    });
  }

  protected readonly kpis = [
    { label: "Today's bookings", hint: 'Bookings sync arrives in Milestone 6' },
    { label: 'Occupancy', hint: 'Needs rooms and inventory' },
    { label: 'Revenue', hint: 'Needs bookings' },
    { label: 'Upcoming check-ins', hint: 'Needs bookings' },
    { label: 'Upcoming check-outs', hint: 'Needs bookings' },
  ];

  protected readonly auth = inject(AuthService);
  protected readonly firstName = computed(() => this.auth.user()?.displayName.split(/\s+/)[0] ?? '');

  /** Steps are marked done only from real account data; later steps light up as milestones ship. */
  protected readonly onboarding = computed<OnboardingStep[]>(() => [
    { label: 'Create your account and verify email', milestone: 2, done: !!this.auth.user() },
    { label: 'Set up your organization', milestone: 2, done: this.auth.memberships().length > 0 },
    { label: 'Turn on two-factor authentication', milestone: 2, done: !!this.auth.user()?.twoFactorEnabled, link: '/security/two-factor-setup' },
    { label: 'Add your first property', milestone: 3, done: (this.counts()?.properties ?? 0) > 0, link: '/app/properties/new' },
    { label: 'Add room types and units', milestone: 3, done: (this.counts()?.roomTypes ?? 0) > 0 && (this.counts()?.rooms ?? 0) > 0, link: '/app/rooms' },
    { label: 'Set rates and inventory', milestone: 5, done: false },
    { label: 'Connect the Zodomus sandbox', milestone: 4, done: false },
    { label: 'Map rooms and rate plans', milestone: 5, done: false },
    { label: 'Run the first synchronization', milestone: 6, done: false },
  ]);
  protected readonly doneCount = computed(() => this.onboarding().filter((s) => s.done).length);
}
