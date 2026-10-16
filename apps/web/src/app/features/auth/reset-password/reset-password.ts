import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorCode, errorMessage } from '../../../core/api/error-message';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';
import { takeFragmentToken } from '../fragment-token';

@Component({
  selector: 'ss-reset-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Icon],
  template: `
    <main class="ss-auth-page">
      <section class="ss-auth-card">
        <div class="ss-auth-brand"><ss-icon name="logo" [size]="20" /> StaySync</div>
        @if (done()) {
          <h1>Password changed</h1>
          <p class="ss-muted">All sessions were signed out. Sign in with your new password.</p>
          <a class="ss-btn ss-btn--block" routerLink="/login">Sign in</a>
        } @else if (!token) {
          <h1>Link not valid</h1>
          <p class="ss-alert ss-alert--error">This reset link is missing or malformed.</p>
          <a class="ss-btn ss-btn--block" routerLink="/forgot-password">Request a new link</a>
        } @else {
          <form [formGroup]="form" (ngSubmit)="submit()" novalidate aria-labelledby="rp-title">
            <h1 id="rp-title">Choose a new password</h1>
            <p class="ss-muted">At least 12 characters.</p>
            <label class="ss-field"><span>New password</span>
              <input class="ss-input" type="password" formControlName="password" autocomplete="new-password" />
            </label>
            @if (needsCode()) {
              <p class="ss-alert ss-alert--info">Your account uses two-factor authentication. Enter a code from your app, or a recovery code.</p>
              <label class="ss-field"><span>Authenticator code or recovery code</span>
                <input class="ss-input" formControlName="second" autocomplete="one-time-code" />
              </label>
            }
            @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
            <button class="ss-btn ss-btn--block" type="submit" [disabled]="busy()">Set new password</button>
          </form>
        }
      </section>
    </main>
  `,
})
export class ResetPassword implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly fb = inject(NonNullableFormBuilder);
  protected token: string | null = null;
  protected readonly form = this.fb.group({ password: ['', [Validators.required, Validators.minLength(12)]], second: [''] });
  protected readonly needsCode = signal(false);
  protected readonly done = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.token = takeFragmentToken();
  }

  protected submit(): void {
    if (!this.token || this.form.controls.password.invalid) {
      this.error.set('Use at least 12 characters.');
      return;
    }
    const { password, second } = this.form.getRawValue();
    const s = second.trim();
    const factor = !s ? {} : /^\d{6}$/.test(s) ? { code: s } : { recoveryCode: s };
    this.busy.set(true);
    this.error.set(null);
    this.auth.resetPassword({ token: this.token, password, ...factor }).subscribe({
      next: () => {
        this.auth.markSignedOut();
        this.done.set(true);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        if (errorCode(err) === 'MFA_CODE_REQUIRED') this.needsCode.set(true);
        this.error.set(errorMessage(err));
      },
    });
  }
}
