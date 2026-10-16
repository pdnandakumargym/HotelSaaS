import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { errorCode, errorMessage } from '../../../core/api/error-message';
import { homeFor } from '../../../core/auth/auth.guards';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';

@Component({
  selector: 'ss-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Icon],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
    password: ['', [Validators.required, Validators.maxLength(256)]],
  });

  protected readonly error = signal<string | null>(null);
  protected readonly unverified = signal(false);
  protected readonly busy = signal(false);
  protected readonly submitted = signal(false);

  protected submit(): void {
    this.submitted.set(true);
    this.error.set(null);
    this.unverified.set(false);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { email, password } = this.form.getRawValue();
    this.busy.set(true);
    this.auth.login(email, password).subscribe({
      next: () => {
        this.busy.set(false);
        const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
        // Only follow same-app relative return URLs (no open redirects).
        const safeReturn = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : null;
        const home = homeFor(this.auth);
        void this.router.navigateByUrl(this.auth.state() === 'authenticated' && safeReturn ? safeReturn : home);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.form.controls.password.reset();
        if (errorCode(err) === 'EMAIL_NOT_VERIFIED') this.unverified.set(true);
        this.error.set(errorMessage(err));
      },
    });
  }

  protected resend(): void {
    this.auth.resendVerification(this.form.controls.email.value).subscribe({
      next: () => this.error.set('If your address still needs verifying, a new link is on its way.'),
      error: (err: unknown) => this.error.set(errorMessage(err)),
    });
  }

  protected showError(control: 'email' | 'password'): boolean {
    const c = this.form.controls[control];
    return c.invalid && (c.touched || this.submitted());
  }
}
