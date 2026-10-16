import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';

@Component({
  selector: 'ss-register',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Icon],
  template: `
    <main class="ss-auth-page">
      @if (done()) {
        <section class="ss-auth-card" aria-live="polite">
          <div class="ss-auth-brand"><ss-icon name="logo" [size]="20" /> StaySync</div>
          <h1>Check your email</h1>
          <p class="ss-muted">We sent a verification link to <strong>{{ form.controls.email.value }}</strong>. Open it to activate your account. The link expires in 24 hours.</p>
          <p class="ss-alert ss-alert--info">Running locally? Emails are captured by Mailpit at http://localhost:8025.</p>
          <a class="ss-btn ss-btn--block" routerLink="/login">Back to sign in</a>
        </section>
      } @else {
        <form class="ss-auth-card" [formGroup]="form" (ngSubmit)="submit()" novalidate aria-labelledby="reg-title">
          <div class="ss-auth-brand"><ss-icon name="logo" [size]="20" /> StaySync</div>
          <h1 id="reg-title">Create your account</h1>
          <p class="ss-muted">You will be the owner of your organization. You can invite your team later.</p>

          <label class="ss-field"><span>Your name</span>
            <input class="ss-input" formControlName="displayName" autocomplete="name" [attr.aria-invalid]="invalid('displayName')" />
            @if (invalid('displayName')) { <small class="ss-field-error">Enter your name.</small> }
          </label>
          <label class="ss-field"><span>Business or organization name</span>
            <input class="ss-input" formControlName="organizationName" autocomplete="organization" [attr.aria-invalid]="invalid('organizationName')" />
            @if (invalid('organizationName')) { <small class="ss-field-error">Enter at least 2 characters.</small> }
          </label>
          <label class="ss-field"><span>Email address</span>
            <input class="ss-input" type="email" formControlName="email" autocomplete="email" [attr.aria-invalid]="invalid('email')" />
            @if (invalid('email')) { <small class="ss-field-error">Enter a valid email address.</small> }
          </label>
          <label class="ss-field"><span>Password</span>
            <input class="ss-input" type="password" formControlName="password" autocomplete="new-password" aria-describedby="pw-hint" [attr.aria-invalid]="invalid('password')" />
            <small id="pw-hint" class="ss-muted">At least 12 characters. A few random words work well.</small>
            @if (invalid('password')) { <small class="ss-field-error">Use at least 12 characters.</small> }
          </label>

          @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
          <button type="submit" class="ss-btn ss-btn--block" [disabled]="busy()">{{ busy() ? 'Creating account…' : 'Create account' }}</button>
          <p class="ss-auth-foot">Already have an account? <a routerLink="/login">Sign in</a></p>
        </form>
      }
    </main>
  `,
})
export class Register {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly auth = inject(AuthService);
  protected readonly form = this.fb.group({
    displayName: ['', [Validators.required, Validators.maxLength(120)]],
    organizationName: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(160)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
    password: ['', [Validators.required, Validators.minLength(12), Validators.maxLength(256)]],
  });
  protected readonly busy = signal(false);
  protected readonly done = signal(false);
  protected readonly submitted = signal(false);
  protected readonly error = signal<string | null>(null);

  protected invalid(name: keyof typeof this.form.controls): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || this.submitted());
  }

  protected submit(): void {
    this.submitted.set(true);
    if (this.form.invalid) return;
    this.busy.set(true);
    this.error.set(null);
    this.auth.register(this.form.getRawValue()).subscribe({
      next: () => {
        this.busy.set(false);
        this.form.controls.password.reset();
        this.done.set(true);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }
}
