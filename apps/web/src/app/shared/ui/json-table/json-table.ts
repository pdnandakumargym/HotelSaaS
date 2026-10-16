import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

type Row = Record<string, unknown>;

/** Rows of a list payload, or of an object that wraps exactly one list. */
export function extractRows(data: unknown): Row[] | null {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? (() => {
          const arrays = Object.values(data as Row).filter(Array.isArray);
          return arrays.length === 1 ? (arrays[0] as unknown[]) : null;
        })()
      : null;
  if (!list) return null;
  return list.map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : { value: v }));
}

export function columnsOf(rows: Row[], max = 8): string[] {
  const cols: string[] = [];
  for (const r of rows.slice(0, 50)) {
    for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  }
  return cols.slice(0, max);
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  }
  return String(v);
}

/**
 * Renders provider data whose schema is not documented publicly: a table when it is a list,
 * key/value pairs otherwise, and the raw (already sanitized) JSON on request. Text only, no HTML.
 */
@Component({
  selector: 'ss-json-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows(); as list) {
      @if (list.length === 0) {
        <p class="ss-muted">The list is empty.</p>
      } @else {
        <div class="wrap">
          <table class="ss-table">
            <thead><tr>@for (c of columns(); track c) { <th scope="col">{{ c }}</th> }</tr></thead>
            <tbody>
              @for (r of list.slice(0, limit()); track $index) {
                <tr>@for (c of columns(); track c) { <td>{{ cell(r[c]) }}</td> }</tr>
              }
            </tbody>
          </table>
        </div>
        @if (list.length > limit()) { <p class="ss-muted small">Showing {{ limit() }} of {{ list.length }}.</p> }
      }
    } @else if (pairs(); as kv) {
      <dl class="kv">
        @for (p of kv; track p[0]) { <dt>{{ p[0] }}</dt><dd>{{ cell(p[1]) }}</dd> }
      </dl>
    } @else {
      <p class="ss-muted">{{ cell(data()) }}</p>
    }
    <button type="button" class="ss-btn ss-btn--ghost small" (click)="raw.set(!raw())" [attr.aria-expanded]="raw()">{{ raw() ? 'Hide' : 'Show' }} raw JSON</button>
    @if (raw()) { <pre class="raw">{{ json() }}</pre> }
  `,
  styles: `
    .wrap { overflow-x: auto; }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 8px; font-size: 13.5px; }
    .kv dt { color: var(--ss-text-muted); }
    .kv dd { margin: 0; word-break: break-word; }
    .raw { max-height: 360px; overflow: auto; background: var(--ss-gray-50); padding: 12px; border-radius: 8px; font-size: 12px; }
    .small { font-size: 12.5px; margin-top: 8px; }
  `,
})
export class JsonTable {
  readonly data = input<unknown>(null);
  readonly limit = input(100);
  protected readonly raw = signal(false);
  protected readonly rows = computed(() => extractRows(this.data()));
  protected readonly columns = computed(() => columnsOf(this.rows() ?? []));
  protected readonly pairs = computed(() => {
    const d = this.data();
    return d && typeof d === 'object' && !Array.isArray(d) ? Object.entries(d as Row).slice(0, 100) : null;
  });
  protected readonly json = computed(() => JSON.stringify(this.data(), null, 2));
  protected readonly cell = cell;
}
