import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { BulkUpdate, Calendar, ChannelApi } from '../../../core/api/channel-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { Property, formatMoney } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { PropertyPicker } from '../../../shared/ui/property-picker/property-picker';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = 14;

function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

type Tri = '' | 'yes' | 'no';

@Component({
  selector: 'ss-inventory',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, RouterLink, PropertyPicker],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Inventory &amp; rates calendar</h1>
        <p class="ss-muted">Rooms to sell and prices per date. Changes are sent to connected channels automatically.</p>
      </div>
      <ss-property-picker (changed)="onProperty($event)" />
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (notice(); as n) { <p class="ss-alert ss-alert--success" role="status">{{ n }}</p> }

    @if (cal(); as c) {
      @if (!c.roomTypes.length) {
        <p class="ss-alert ss-alert--info">This property has no active room types yet. <a routerLink="/app/rooms">Add room types and rooms</a>.</p>
      } @else {
        <section class="ss-card">
          <div class="nav">
            <button type="button" class="ss-btn ss-btn--ghost" (click)="shift(-DAYS)" [disabled]="c.from <= today()" aria-label="Previous two weeks">‹</button>
            <strong>{{ c.from | date: 'd MMM' }} – {{ last(c) | date: 'd MMM y' }}</strong>
            <button type="button" class="ss-btn ss-btn--ghost" (click)="shift(DAYS)" aria-label="Next two weeks">›</button>
            <span class="ss-muted small">Prices in {{ c.currency }} · dates in {{ c.timezone }}</span>
          </div>
          <div class="ss-table-wrap">
            <table class="ss-table grid">
              <thead>
                <tr>
                  <th scope="col" class="sticky">Room type / rate plan</th>
                  @for (d of c.dates; track d) { <th scope="col" [class.weekend]="isWeekend(d)"><span class="dow">{{ dow(d) }}</span>{{ d | date: 'd' }}</th> }
                </tr>
              </thead>
              <tbody>
                @for (rt of c.roomTypes; track rt.id) {
                  <tr class="rt">
                    <th scope="row" class="sticky">{{ rt.name }} <small class="ss-muted">{{ rt.roomsInService }} in service</small></th>
                    @for (d of rt.days; track d.date) {
                      <td [class.zero]="d.available === 0" [class.override]="d.override !== null || d.stopSell" [attr.title]="d.stopSell ? 'Stop-sell' : d.override !== null ? 'Set to ' + d.override : 'Default'">
                        {{ d.stopSell ? 'Stop' : d.available }}
                      </td>
                    }
                  </tr>
                  @for (r of rt.rates; track r.ratePlanId) {
                    <tr class="rate">
                      <th scope="row" class="sticky plan">{{ planName(c, r.ratePlanId) }}</th>
                      @for (d of r.days; track d.date) {
                        <td [class.closed]="d.closed" [attr.title]="restrictionText(d)">{{ d.price !== null ? money(d.price, c.currency) : '—' }}</td>
                      }
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
          <p class="ss-muted small">"—" = no price set: nothing is sent to channels for that date. Availability is capped at the rooms in service.</p>
        </section>

        @if (canInventory() || canRates()) {
          <section class="ss-card">
            <h2 class="ss-card__title">Update dates</h2>
            <form (ngSubmit)="apply()" class="bulk">
              <fieldset>
                <legend>Dates</legend>
                <div class="row">
                  <label class="ss-field"><span>From</span><input class="ss-input" type="date" name="from" [min]="today()" [(ngModel)]="from" required /></label>
                  <label class="ss-field"><span>To (inclusive)</span><input class="ss-input" type="date" name="to" [min]="from" [(ngModel)]="to" required /></label>
                </div>
                <div class="chips" role="group" aria-label="Weekdays">
                  @for (w of weekdays; track $index) {
                    <label class="chip"><input type="checkbox" [checked]="days()[$index]" (change)="toggleDay($index)" /> {{ w }}</label>
                  }
                </div>
              </fieldset>
              <fieldset>
                <legend>Room types</legend>
                <div class="chips">
                  @for (rt of c.roomTypes; track rt.id) {
                    <label class="chip"><input type="checkbox" [checked]="rtSel().has(rt.id)" (change)="toggle(rtSel, rt.id)" /> {{ rt.name }}</label>
                  }
                </div>
              </fieldset>
              @if (canInventory()) {
                <fieldset>
                  <legend>Availability</legend>
                  <div class="row">
                    <label class="ss-field"><span>Rooms to sell</span>
                      <select class="ss-input" name="availMode" [(ngModel)]="availMode">
                        <option value="">Don't change</option>
                        <option value="set">Set a number</option>
                        <option value="default">Reset to rooms in service</option>
                      </select>
                    </label>
                    @if (availMode === 'set') { <label class="ss-field"><span>Number</span><input class="ss-input" type="number" min="0" max="9999" name="avail" [(ngModel)]="avail" required /></label> }
                    <label class="ss-field"><span>Stop-sell</span>
                      <select class="ss-input" name="stopSell" [(ngModel)]="stopSell"><option value="">Don't change</option><option value="yes">On</option><option value="no">Off</option></select>
                    </label>
                  </div>
                </fieldset>
              }
              @if (canRates()) {
                <fieldset>
                  <legend>Rates</legend>
                  @if (c.ratePlans.length) {
                    <div class="chips">
                      @for (rp of c.ratePlans; track rp.id) {
                        <label class="chip"><input type="checkbox" [checked]="rpSel().has(rp.id)" (change)="toggle(rpSel, rp.id)" /> {{ rp.name }}</label>
                      }
                    </div>
                    <div class="row">
                      <label class="ss-field"><span>Price ({{ c.currency }})</span><input class="ss-input" type="number" min="0" step="0.01" name="price" [(ngModel)]="price" placeholder="Don't change" /></label>
                      <label class="ss-field"><span>Single-guest price</span><input class="ss-input" type="number" min="0" step="0.01" name="priceSingle" [(ngModel)]="priceSingle" placeholder="Don't change" /></label>
                      <label class="ss-field"><span>Min. stay (nights)</span><input class="ss-input" type="number" min="0" max="31" name="minStay" [(ngModel)]="minStay" placeholder="Don't change" /></label>
                      <label class="ss-field"><span>Closed</span>
                        <select class="ss-input" name="closed" [(ngModel)]="closed"><option value="">Don't change</option><option value="yes">Closed</option><option value="no">Open</option></select>
                      </label>
                    </div>
                  } @else {
                    <p class="ss-muted">No rate plans yet. <a routerLink="/app/rates" [queryParams]="{ property: property()?.id }">Create a rate plan</a> to set prices.</p>
                  }
                </fieldset>
              }
              <button type="submit" class="ss-btn" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Apply' }}</button>
            </form>
          </section>
        }
      }
    }
  `,
  styles: `
    .nav { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .nav .ss-btn { height: 32px; padding: 0 12px; }
    .small { font-size: 12.5px; }
    .grid th, .grid td { text-align: center; padding: 6px 8px; font-size: 13px; white-space: nowrap; }
    .grid .sticky { text-align: left; position: sticky; left: 0; background: var(--ss-surface); z-index: 1; min-width: 180px; }
    .grid .plan { padding-left: 24px; font-weight: 500; color: var(--ss-text-muted); }
    .grid .dow { display: block; font-size: 11px; color: var(--ss-text-muted); font-weight: 500; }
    .grid .weekend { background: var(--ss-gray-50); }
    .grid tr.rt td { font-weight: 600; }
    .grid td.override { background: var(--ss-blue-50); }
    .grid td.zero { color: var(--ss-red-600); }
    .grid td.closed { text-decoration: line-through; color: var(--ss-text-muted); }
    section.ss-card { margin-bottom: 16px; }
    .bulk { display: grid; gap: 16px; }
    fieldset { border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); padding: 12px; margin: 0; }
    legend { font-weight: 600; font-size: 13.5px; padding: 0 4px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
    .row .ss-field { min-width: 150px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
    .chip { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--ss-border); border-radius: 999px; padding: 4px 10px; font-size: 13px; }
  `,
})
export class Inventory {
  private readonly api = inject(ChannelApi);
  private readonly auth = inject(AuthService);
  protected readonly DAYS = DAYS;
  protected readonly weekdays = WEEKDAYS;
  protected readonly property = signal<Property | null>(null);
  protected readonly cal = signal<Calendar | null>(null);
  protected readonly start = signal<string | null>(null);
  protected readonly today = signal<string>(new Date().toISOString().slice(0, 10));
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly days = signal<boolean[]>([true, true, true, true, true, true, true]);
  protected readonly rtSel = signal<Set<string>>(new Set());
  protected readonly rpSel = signal<Set<string>>(new Set());
  protected readonly canInventory = computed(() => this.auth.hasOrgPermission('inventory.write'));
  protected readonly canRates = computed(() => this.auth.hasOrgPermission('rate.write'));

  protected from = '';
  protected to = '';
  protected availMode: '' | 'set' | 'default' = '';
  protected avail: number | null = null;
  protected stopSell: Tri = '';
  protected price: number | null = null;
  protected priceSingle: number | null = null;
  protected minStay: number | null = null;
  protected closed: Tri = '';

  onProperty(p: Property): void {
    this.property.set(p);
    this.start.set(null);
    this.load(true);
  }

  protected shift(n: number): void {
    const c = this.cal();
    if (!c) return;
    const next = addDays(c.from, n);
    this.start.set(next < this.today() ? this.today() : next);
    this.load(false);
  }

  protected last(c: Calendar): string {
    return c.dates[c.dates.length - 1] ?? c.from;
  }
  protected dow(d: string): string {
    return WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()] ?? '';
  }
  protected isWeekend(d: string): boolean {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    return w === 0 || w === 6;
  }
  protected planName(c: Calendar, id: string): string {
    return c.ratePlans.find((p) => p.id === id)?.name ?? '';
  }
  protected money(v: number, currency: string): string {
    return formatMoney(Math.round(v * 100), currency);
  }
  protected restrictionText(d: { minStay: number | null; closed: boolean; priceSingle: number | null }): string {
    const parts = [];
    if (d.closed) parts.push('Closed');
    if (d.minStay) parts.push(`Min. stay ${d.minStay}`);
    if (d.priceSingle !== null) parts.push(`Single ${d.priceSingle}`);
    return parts.join(' · ');
  }
  protected toggleDay(i: number): void {
    this.days.update((d) => d.map((v, j) => (j === i ? !v : v)));
  }
  protected toggle(sig: typeof this.rtSel, id: string): void {
    sig.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  protected apply(): void {
    const p = this.property();
    if (!p) return;
    const body: BulkUpdate = { from: this.from, to: this.to, roomTypeIds: [...this.rtSel()] };
    const wd = this.days().flatMap((on, i) => (on ? [i] : []));
    if (wd.length < 7) body.weekdays = wd;
    if (this.canInventory() && (this.availMode || this.stopSell)) {
      body.availability = {};
      if (this.availMode === 'set') body.availability.available = Number(this.avail);
      if (this.availMode === 'default') body.availability.available = null;
      if (this.stopSell) body.availability.stopSell = this.stopSell === 'yes';
    }
    const hasNum = (v: number | null) => v !== null && (v as unknown) !== '';
    if (this.canRates() && (hasNum(this.price) || hasNum(this.priceSingle) || hasNum(this.minStay) || this.closed)) {
      body.ratePlanIds = [...this.rpSel()];
      body.rates = {};
      if (hasNum(this.price)) body.rates.price = Number(this.price);
      if (hasNum(this.priceSingle)) body.rates.priceSingle = Number(this.priceSingle);
      if (hasNum(this.minStay)) body.rates.minStay = Number(this.minStay);
      if (this.closed) body.rates.closed = this.closed === 'yes';
    }
    if (!body.availability && !body.rates) {
      this.error.set('Choose what to change: availability and/or rates.');
      return;
    }
    if (!body.roomTypeIds.length) {
      this.error.set('Choose at least one room type.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    this.api.updateCalendar(p.id, body).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.notice.set(`Updated ${r.dates} date${r.dates === 1 ? '' : 's'}.` + (r.syncJobsQueued ? ` ${r.syncJobsQueued} channel update${r.syncJobsQueued === 1 ? '' : 's'} queued.` : ' No channel is connected for these rooms yet.'));
        this.load(false);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  private load(resetForm: boolean): void {
    const p = this.property();
    if (!p) return;
    this.api.calendar(p.id, this.start(), DAYS).subscribe({
      next: (c) => {
        this.cal.set(c);
        if (resetForm) {
          this.today.set(c.from);
          this.from = c.from;
          this.to = addDays(c.from, 6);
          this.rtSel.set(new Set(c.roomTypes.map((r) => r.id)));
          this.rpSel.set(new Set(c.ratePlans.map((r) => r.id)));
        }
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }
}
