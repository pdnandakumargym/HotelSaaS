import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

@Component({
  selector: 'ss-pager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="pager" aria-label="Pagination">
      <span class="ss-muted">{{ total() }} total · page {{ page() }} of {{ pages() }}</span>
      <button type="button" class="ss-btn ss-btn--ghost" [disabled]="page() <= 1" (click)="go.emit(page() - 1)">Previous</button>
      <button type="button" class="ss-btn ss-btn--ghost" [disabled]="page() >= pages()" (click)="go.emit(page() + 1)">Next</button>
    </nav>
  `,
  styles: `.pager { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 12px; font-size: 13px; } button { height: 32px; }`,
})
export class Pager {
  readonly page = input(1);
  readonly pageSize = input(25);
  readonly total = input(0);
  readonly go = output<number>();
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
}
