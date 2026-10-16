import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { errorCode, errorMessage } from '../../../core/api/error-message';
import { homeFor } from '../../../core/auth/auth.guards';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';

@Component({
  selector: 'ss-two-factor-challenge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ReactiveFormsModule, Icon],
  template: `
    <main class="ss-auth-page">
      <form class="ss-auth-card" (ngSubmit)="submit()" novalidate aria-labelledby="mfa-title">
        <div class="ss-auth-brand"><ss-icon name="shield" [size]="20" /> Two-step verification</div>
        <h1 id="mfa-title">{{ useRecovery() ? 'Use a recovery code' : 'Enter your code' }}</h1>
        <p class="ss-muted">
          {{ useRecovery() ? 'Enter one of the recovery codes you saved when you set up two-factor authentication. Each code works once.' : 'Open your authenticator app and enter the 6-digit code for StaySync.' }}
        </p>

        @if (useRecovery()) {
          <label class="ss-field"><span>Recovery code</span>
            <input class="ss-input" [formControl]="recovery" autocomplete="off" placeholder="XXXXX-XXXXX" />
          </label>
        } @else {
          <label class="ss-field"><span>Authentication code</span>
            <input class="ss-input ss-input--code" [formControl]="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
          </label>
        }

        @if (error(); as e) {
          <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p>
        }
        <button type="submit" class="ss-btn ss-btn--block" [disabled]="busy()">{{ busy() ? 'Verifying…' : 'Verify' }}</button>
        <p class="ss-auth-foot">
          <button type="button" class="ss-link-btn" (click)="toggle()">{{ useRecovery() ? 'Use authenticator code instead' : 'Use a recovery code' }}</button>
          ·
          <button type="button" class="ss-link-btn" (click)="cancel()">Cancel</button>
        </p>
      </form>
    </main>
  `,
})
export class TwoFactorChallenge {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly code = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d{6}$/)] });
  protected readonly recovery = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(10)] });
  protected readonly useRecovery = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected toggle(): void {
    this.useRecovery.update((v) => !v);
    this.error.set(null);
  }

  protected submit(): void {
    const control = this.useRecovery() ? this.recovery : this.code;
    if (control.invalid) {
      this.error.set(this.useRecovery() ? 'Enter a recovery code.' : 'Enter the 6-digit code.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const body = this.useRecovery() ? { recoveryCode: this.recovery.value.trim() } : { code: this.code.value };
    this.auth.verifySecondFactor(body).subscribe({
      next: () => void this.router.navigateByUrl(homeFor(this.auth)),
      error: (err: unknown) => {
        this.busy.set(false);
        control.reset();
        if (errorCode(err) === 'MFA_SESSION_REVOKED') {
          this.auth.markSignedOut();
          void this.router.navigate(['/login']);
        }
        this.error.set(errorMessage(err));
      },
    });
  }

  protected cancel(): void {
    this.auth.logout().subscribe(() => void this.router.navigate(['/login']));
  }
}
