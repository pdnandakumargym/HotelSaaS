import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { OrgApi, Organization, SupportRequest } from '../../../core/api/org-api.service';
import { SessionInfo } from '../../../core/auth/auth.models';
import { AuthService } from '../../../core/auth/auth.service';
import { StepUpService } from '../../../core/auth/step-up.service';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

/** Profile & Security: password, two-factor authentication and active sessions. */
@Component({
  selector: 'ss-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ReactiveFormsModule, RouterLink, DatePipe, StatusPill],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly stepUp = inject(StepUpService);
  private readonly router = inject(Router);
  private readonly orgApi = inject(OrgApi);

  protected readonly twoFactor = signal<{ enabled: boolean; required: boolean; recoveryCodesRemaining: number } | null>(null);
  protected readonly sessions = signal<SessionInfo[]>([]);
  protected readonly newCodes = signal<string[] | null>(null);
  protected readonly message = signal<{ tone: 'success' | 'error'; text: string } | null>(null);
  protected readonly busy = signal(false);
  protected readonly org = signal<Organization | null>(null);
  protected readonly supportRequests = signal<SupportRequest[]>([]);
  protected readonly isOwner = computed(() => this.auth.hasOrgPermission('org.update'));
  protected readonly orgName = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(2)] });
  protected readonly orgCurrency = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^[A-Za-z]{3}$/)] });
  protected readonly newEmail = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] });
  protected readonly newPassword = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(12), Validators.maxLength(256)] });

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.auth.twoFactorStatus().subscribe((s) => this.twoFactor.set(s));
    this.auth.sessions().subscribe((s) => this.sessions.set(s));
    if (this.auth.currentOrg()) {
      this.orgApi.organization().subscribe((o) => {
        this.org.set(o);
        this.orgName.setValue(o.name);
        this.orgCurrency.setValue(o.defaultCurrency);
      });
    }
    if (this.auth.hasOrgPermission('org.security.manage')) {
      this.orgApi.supportRequests().subscribe((r) => this.supportRequests.set(r));
    }
  }

  protected saveOrg(): void {
    if (this.orgName.invalid || this.orgCurrency.invalid) {
      this.message.set({ tone: 'error', text: 'Enter a name and a 3-letter currency code.' });
      return;
    }
    this.busy.set(true);
    this.orgApi.updateOrganization({ name: this.orgName.value, defaultCurrency: this.orgCurrency.value }).subscribe({
      next: () => {
        this.ok('Organization updated.');
        void this.auth.refresh();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected setOrgTwoFactor(required: boolean): void {
    if (required && !this.auth.user()?.twoFactorEnabled) {
      this.message.set({ tone: 'error', text: 'Turn on two-factor authentication for your own account first.' });
      return;
    }
    this.busy.set(true);
    this.stepUp.run(() => this.orgApi.setTwoFactorPolicy(required)).subscribe({
      next: () => {
        this.ok(required ? 'All members must now use two-factor authentication.' : 'Two-factor authentication is optional for members.');
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected changeEmail(): void {
    if (this.newEmail.invalid) {
      this.message.set({ tone: 'error', text: 'Enter a valid email address.' });
      return;
    }
    this.busy.set(true);
    this.stepUp.run(() => this.auth.requestEmailChange(this.newEmail.value)).subscribe({
      next: () => {
        this.newEmail.reset();
        this.ok('Check the new address for a confirmation link. Your email changes only after you confirm it.');
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected decide(r: SupportRequest, decision: 'approve' | 'deny' | 'revoke'): void {
    const action = () => this.orgApi.decideSupport(r.id, decision);
    (decision === 'approve' ? this.stepUp.run(action) : action()).subscribe({
      next: () => {
        this.ok(decision === 'approve' ? `Support can view your data (read-only) for ${r.durationMinutes} minutes.` : decision === 'deny' ? 'Request denied.' : 'Support access revoked.');
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  private ok(text: string): void {
    this.busy.set(false);
    this.message.set({ tone: 'success', text });
  }

  private fail(err: unknown): void {
    this.busy.set(false);
    this.message.set({ tone: 'error', text: errorMessage(err) });
  }

  protected changePassword(): void {
    if (this.newPassword.invalid) {
      this.message.set({ tone: 'error', text: 'Use at least 12 characters.' });
      return;
    }
    this.busy.set(true);
    this.stepUp.run(() => this.auth.changePassword(this.newPassword.value)).subscribe({
      next: () => {
        this.newPassword.reset();
        this.ok('Password changed. Your other sessions were signed out.');
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected regenerate(): void {
    this.busy.set(true);
    this.stepUp.run(() => this.auth.regenerateRecoveryCodes()).subscribe({
      next: (codes) => {
        this.newCodes.set(codes);
        this.ok('New recovery codes created. The old ones no longer work.');
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected disable(): void {
    if (!confirm('Turn off two-factor authentication? Your account will be protected by your password only.')) return;
    this.busy.set(true);
    this.stepUp.run(() => this.auth.disableTotp()).subscribe({
      next: () => {
        this.ok('Two-factor authentication is off.');
        void this.auth.refresh();
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected revoke(s: SessionInfo): void {
    this.auth.revokeSession(s.id).subscribe({
      next: () => {
        if (s.current) {
          this.auth.markSignedOut();
          void this.router.navigate(['/login']);
        } else this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected revokeOthers(): void {
    this.auth.revokeOtherSessions().subscribe({
      next: (r) => {
        this.ok(`Signed out ${r.count} other session${r.count === 1 ? '' : 's'}.`);
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected device(ua: string | null): string {
    if (!ua) return 'Unknown device';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} on ${os}` : browser;
  }
}
