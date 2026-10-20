import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../../../core/api/error-message';
import { ReportSummary, ReportsApi } from '../../../core/api/ops-api.service';
import { Property } from '../../../core/api/org-api.service';
import { PropertyPicker } from '../../../shared/ui/property-picker/property-picker';

type Preset = 'next30' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (date: string, days: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));

/** Occupancy, revenue and channel performance from stored bookings (stay dates). */
@Component({
  selector: 'ss-reports',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, PropertyPicker],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Reports</h1>
        <p class="ss-muted">Occupancy, revenue and channel performance by stay date, from the bookings StaySync received.</p>
      </div>
      <ss-property-picker (changed)="onProperty($event)" />
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }

    <section class="ss-card filters" aria-label="Report period">
      <div class="presets" role="group" aria-label="Period">
        @for (p of presets; track p.value) {
          <button type="button" [class.on]="preset() === p.value" [attr.aria-pressed]="preset() === p.value" (click)="choose(p.value)">{{ p.label }}</button>
        }
      </div>
      <label class="ss-field inline"><span>From</span><input class="ss-input" type="date" [ngModel]="from()" (ngModelChange)="from.set($event); preset.set('custom')" name="from" /></label>
      <label class="ss-field inline"><span>To</span><input class="ss-input" type="date" [ngModel]="to()" (ngModelChange)="to.set($event); preset.set('custom')" name="to" /></label>
      <label class="check"><input type="checkbox" [checked]="includeTest()" (change)="includeTest.set(!includeTest())" /> Include test bookings</label>
      <button type="button" class="ss-btn" (click)="load()">Show</button>
      @if (data()) { <a class="ss-btn ss-btn--ghost" [href]="csv()" download>Download CSV</a> }
    </section>

    @if (data(); as d) {
      @if (d.includeTest && d.testBookingsInRange) { <p class="ss-alert ss-alert--info">Includes {{ d.testBookingsInRange }} test booking(s) from the Zodomus sandbox.</p> }
      @if (d.otherCurrencyBookings) { <p class="ss-alert ss-alert--info">{{ d.otherCurrencyBookings }} booking(s) in another currency are not included in revenue.</p> }
      <div class="tiles">
        <div class="tile"><span class="l">Occupancy</span><span class="n">{{ d.totals.occupancyPct !== null ? d.totals.occupancyPct + '%' : '—' }}</span><span class="h">{{ d.totals.roomNightsSold }} of {{ d.totals.roomNightsAvailable }} room nights</span></div>
        <div class="tile"><span class="l">Revenue</span><span class="n">{{ money(d.totals.revenue, d.property.currency) }}</span><span class="h">{{ d.nights }} nights</span></div>
        <div class="tile"><span class="l">ADR</span><span class="n">{{ d.totals.adr !== null ? money(d.totals.adr, d.property.currency) : '—' }}</span><span class="h">Average daily rate</span></div>
        <div class="tile"><span class="l">RevPAR</span><span class="n">{{ d.totals.revpar !== null ? money(d.totals.revpar, d.property.currency) : '—' }}</span><span class="h">Revenue per available room</span></div>
        <div class="tile"><span class="l">Bookings</span><span class="n">{{ d.totals.bookingsStaying }}</span><span class="h">{{ d.totals.cancellationsStaying }} cancelled · {{ d.totals.bookingsReceived }} received in period</span></div>
      </div>

      <section class="ss-card">
        <div class="chart-head">
          <h2 class="ss-card__title">Occupancy by night</h2>
          <button type="button" class="ss-link-btn" (click)="showTable.set(!showTable())">{{ showTable() ? 'Show chart' : 'Show as table' }}</button>
        </div>
        @if (!showTable()) {
          <div class="chart" role="img" [attr.aria-label]="'Occupancy by night from ' + d.from + ' to ' + d.to + '. Use Show as table for values.'">
            <div class="axis"><span>100%</span><span>50%</span><span>0%</span></div>
            <div class="plot">
              <div class="grid50"></div>
              @for (x of d.daily; track x.date; let i = $index) {
                <div class="col" (mouseenter)="hoverAt(x, i, d.daily.length)" (mouseleave)="hover.set(null)" (focus)="hoverAt(x, i, d.daily.length)" (blur)="hover.set(null)" tabindex="0" [attr.aria-label]="x.date + ': ' + (x.occupancyPct ?? 0) + '%'">
                  <div class="bar" [style.height.%]="x.occupancyPct ?? 0"></div>
                </div>
              }
              @if (hover(); as hv) {
                <div class="tip" role="status" [style.left.%]="tipLeft()">
                  <strong>{{ hv.date | date: 'EEE d MMM' }}</strong><br />
                  {{ hv.occupancyPct ?? 0 }}% · {{ hv.roomNightsSold }} room night{{ hv.roomNightsSold === 1 ? '' : 's' }} · {{ money(hv.revenue, d.property.currency) }}
                </div>
              }
            </div>
          </div>
          <div class="xlabels"><span>{{ d.from | date: 'd MMM' }}</span><span>{{ d.to | date: 'd MMM' }}</span></div>
        } @else {
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead><tr><th scope="col">Night</th><th scope="col" class="num">Room nights sold</th><th scope="col" class="num">Occupancy</th><th scope="col" class="num">Revenue</th></tr></thead>
              <tbody>@for (x of d.daily; track x.date) { <tr><td>{{ x.date | date: 'EEE d MMM y' }}</td><td class="num">{{ x.roomNightsSold }}</td><td class="num">{{ x.occupancyPct ?? 0 }}%</td><td class="num">{{ money(x.revenue, d.property.currency) }}</td></tr> }</tbody>
            </table>
          </div>
        }
      </section>

      <section class="ss-card">
        <h2 class="ss-card__title">By room type</h2>
        <div class="ss-table-wrap">
          <table class="ss-table">
            <thead><tr><th scope="col">Room type</th><th scope="col" class="num">Rooms</th><th scope="col" class="num">Room nights sold</th><th scope="col" class="num">Occupancy</th><th scope="col" class="num">Revenue</th><th scope="col" class="num">ADR</th></tr></thead>
            <tbody>
              @for (t of d.byRoomType; track t.name) {
                <tr><td>{{ t.name }}</td><td class="num">{{ t.roomsInService }}</td><td class="num">{{ t.roomNightsSold }}</td><td class="num">{{ t.occupancyPct !== null ? t.occupancyPct + '%' : '—' }}</td><td class="num">{{ money(t.revenue, d.property.currency) }}</td><td class="num">{{ t.adr !== null ? money(t.adr, d.property.currency) : '—' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="ss-card">
        <h2 class="ss-card__title">By channel</h2>
        @if (d.byChannel.length) {
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead><tr><th scope="col">Channel</th><th scope="col" class="num">Bookings</th><th scope="col" class="num">Cancellations</th><th scope="col" class="num">Room nights</th><th scope="col" class="num">Revenue</th><th scope="col" class="num">Share</th></tr></thead>
              <tbody>
                @for (c of d.byChannel; track c.channel) {
                  <tr><td>{{ c.channel }}</td><td class="num">{{ c.bookings }}</td><td class="num">{{ c.cancellations }}</td><td class="num">{{ c.roomNights }}</td><td class="num">{{ money(c.revenue, d.property.currency) }}</td><td class="num">{{ c.sharePct !== null ? c.sharePct + '%' : '—' }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="ss-muted">No channel bookings stay in this period.</p>
        }
        <p class="ss-muted small">Room nights available use today's rooms in service. Revenue spreads each room's total evenly over its nights. Cancelled bookings are not counted.</p>
      </section>
    }
  `,
  styles: `
    .filters { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
    .presets { display: inline-flex; border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); overflow: hidden; flex-wrap: wrap; }
    .presets button { border: 0; background: transparent; padding: 7px 12px; cursor: pointer; font: inherit; color: var(--ss-text-muted); }
    .presets button.on { background: var(--ss-blue-50); color: var(--ss-blue-600); font-weight: 600; }
    .inline { margin: 0; }
    .check { display: inline-flex; gap: 6px; align-items: center; font-size: 13.5px; height: 36px; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 16px 0; }
    .tile { background: var(--ss-surface, #fff); border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
    .tile .l { font-size: 12.5px; color: var(--ss-text-muted); }
    .tile .n { font-size: 22px; font-weight: 600; }
    .tile .h { font-size: 12px; color: var(--ss-text-muted); }
    .chart-head { display: flex; justify-content: space-between; align-items: center; }
    .chart { display: flex; gap: 8px; height: 200px; margin-top: 8px; }
    .axis { display: flex; flex-direction: column; justify-content: space-between; font-size: 11px; color: var(--ss-text-muted); width: 34px; text-align: right; }
    .plot { position: relative; flex: 1; display: flex; align-items: flex-end; gap: 2px; border-bottom: 1px solid var(--ss-border); }
    .grid50 { position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed var(--ss-border); pointer-events: none; z-index: 0; }
    .col { flex: 1; height: 100%; display: flex; align-items: flex-end; cursor: default; outline: none; position: relative; z-index: 1; }
    .col:focus-visible { box-shadow: inset 0 0 0 2px var(--ss-blue-600); }
    .bar { width: 100%; background: var(--ss-blue-600); border-radius: 4px 4px 0 0; min-height: 0; }
    .col:hover .bar, .col:focus .bar { opacity: .8; }
    .tip { position: absolute; z-index: 2; top: 4px; transform: translateX(-50%); background: var(--ss-gray-900, #111827); color: #fff; padding: 6px 10px; border-radius: 6px; font-size: 12.5px; white-space: nowrap; pointer-events: none; }
    .xlabels { display: flex; justify-content: space-between; margin-left: 42px; font-size: 11.5px; color: var(--ss-text-muted); margin-top: 4px; }
    .num { text-align: right; white-space: nowrap; }
    .small { font-size: 12.5px; }
  `,
})
export class Reports {
  private readonly api = inject(ReportsApi);
  protected readonly presets = [
    { value: 'next30' as const, label: 'Next 30 days' },
    { value: 'last30' as const, label: 'Last 30 days' },
    { value: 'thisMonth' as const, label: 'This month' },
    { value: 'lastMonth' as const, label: 'Last month' },
  ];
  protected readonly preset = signal<Preset>('next30');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly includeTest = signal(true);
  protected readonly data = signal<ReportSummary | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly showTable = signal(false);
  protected readonly hover = signal<ReportSummary['daily'][number] | null>(null);
  protected readonly tipLeft = signal(50);

  protected hoverAt(x: ReportSummary['daily'][number], i: number, n: number): void {
    this.hover.set(x);
    this.tipLeft.set(Math.min(88, Math.max(12, ((i + 0.5) / n) * 100)));
  }
  private propertyId: string | null = null;
  protected readonly csv = computed(() => (this.propertyId && this.from() && this.to() ? this.api.csvUrl({ propertyId: this.propertyId, from: this.from(), to: this.to(), includeTest: this.includeTest() }) : ''));

  constructor() {
    this.choose('next30', false);
  }

  onProperty(p: Property): void {
    this.propertyId = p.id;
    this.load();
  }

  protected choose(p: Preset, reload = true): void {
    const today = iso(new Date());
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const firstOf = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm - 1, 1)));
    const range: Record<Exclude<Preset, 'custom'>, [string, string]> = {
      next30: [today, shift(today, 29)],
      last30: [shift(today, -29), today],
      thisMonth: [firstOf(y, m), shift(firstOf(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1), -1)],
      lastMonth: [firstOf(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1), shift(firstOf(y, m), -1)],
    };
    if (p !== 'custom') {
      this.from.set(range[p][0]);
      this.to.set(range[p][1]);
    }
    this.preset.set(p);
    if (reload) this.load();
  }

  load(): void {
    if (!this.propertyId || !this.from() || !this.to()) return;
    this.error.set(null);
    this.api.summary({ propertyId: this.propertyId, from: this.from(), to: this.to(), includeTest: this.includeTest() }).subscribe({
      next: (d) => this.data.set(d),
      error: (e: unknown) => {
        this.data.set(null);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected money(v: number, currency: string): string {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
    } catch {
      return `${currency} ${v}`;
    }
  }
}
