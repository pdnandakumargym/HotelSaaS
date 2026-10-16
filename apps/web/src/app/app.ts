import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { StepUpDialog } from './shared/ui/step-up-dialog/step-up-dialog';

@Component({
  selector: 'ss-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, StepUpDialog],
  template: `<router-outlet /><ss-step-up-dialog />`,
})
export class App {}
