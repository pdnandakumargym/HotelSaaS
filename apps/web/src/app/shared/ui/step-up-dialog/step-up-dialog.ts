import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorMessage } from '../../../core/api/error-message';
import { StepUpService } from '../../../core/auth/step-up.service';

/** Modal "Confirm it's you" dialog driven by StepUpService. Placed once in the app root. */
@Component({
  selector: 'ss-step-up-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <dialog #dlg aria-labelledby="stepup-title" (cancel)="cancel($event)">
      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <h2 id="stepup-title">Confirm it's you</h2>
        <p class="ss-muted">For your security, enter your password{{ stepUp.needsCode ? ' and a code from your authenticator app' : '' }} to continue.</p>
        <label class="ss-field">
          <span>Password</span>
          <input class="ss-input" type="password" formControlName="password" autocomplete="current-password" />
        </label>
        @if (stepUp.needsCode) {
          <label class="ss-field">
            <span>Authenticator code</span>
            <input class="ss-input ss-input--code" formControlName="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
          </label>
        }
        @if (error(); as e) {
          <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p>
        }
        <div class="actions">
          <button type="button" class="ss-btn ss-btn--ghost" (click)="close(false)">Cancel</button>
          <button type="submit" class="ss-btn" [disabled]="busy()">{{ busy() ? 'Checking…' : 'Confirm' }}</button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog { border: 0; border-radius: var(--ss-radius-lg); padding: 24px; width: min(420px, calc(100vw - 32px)); box-shadow: 0 20px 50px rgba(10, 23, 48, 0.3); }
    dialog::backdrop { background: rgba(10, 23, 48, 0.45); }
    h2 { font-size: 18px; margin-bottom: 6px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  `,
})
export class StepUpDialog {
  protected readonly stepUp = inject(StepUpService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = this.fb.group({ password: ['', Validators.required], code: [''] });

  constructor() {
    effect(() => {
      const el = this.dlg().nativeElement;
      if (this.stepUp.open() && !el.open) {
        this.form.reset();
        this.error.set(null);
        // showModal is missing in some test DOMs
        if (typeof el.showModal === 'function') el.showModal();
        else el.setAttribute('open', '');
      } else if (!this.stepUp.open() && el.open) {
        if (typeof el.close === 'function') el.close();
        else el.removeAttribute('open');
      }
    });
  }

  protected submit(): void {
    const { password, code } = this.form.getRawValue();
    if (!password) return;
    this.busy.set(true);
    this.error.set(null);
    this.stepUp.confirm(password, this.stepUp.needsCode ? code : undefined).subscribe({
      next: () => {
        this.busy.set(false);
        this.close(true);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(err));
        this.form.controls.password.reset();
      },
    });
  }

  protected cancel(event: Event): void {
    event.preventDefault();
    this.close(false);
  }

  protected close(ok: boolean): void {
    this.stepUp.finish(ok);
  }
}
