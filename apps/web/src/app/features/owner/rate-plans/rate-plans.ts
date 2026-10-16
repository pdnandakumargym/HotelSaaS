import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ChannelApi, MEAL_PLANS, MealPlan, RatePlan } from '../../../core/api/channel-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { Property } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { PropertyPicker } from '../../../shared/ui/property-picker/property-picker';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

interface Draft {
  id: string | null;
  name: string;
  code: string;
  mealPlan: MealPlan | '';
  singleOccupancyDiscountPct: number | null;
  description: string;
  status: 'ACTIVE' | 'INACTIVE';
}
const EMPTY: Draft = { id: null, name: '', code: '', mealPlan: 'ROOM_ONLY', singleOccupancyDiscountPct: null, description: '', status: 'ACTIVE' };

@Component({
  selector: 'ss-rate-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PropertyPicker, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Rates &amp; rate plans</h1>
        <p class="ss-muted">A rate plan is a way you sell a room (for example "Standard" or "Breakfast included"). Set prices per date in the <a routerLink="/app/inventory" [queryParams]="{ property: property()?.id }">inventory calendar</a>.</p>
      </div>
      <ss-property-picker (changed)="onProperty($event)" />
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (property()) {
      <div class="grid">
        <section class="ss-card">
          <h2 class="ss-card__title">Rate plans</h2>
          @if (plans().length) {
            <div class="ss-table-wrap">
              <table class="ss-table">
                <thead><tr><th scope="col">Name</th><th scope="col">Code</th><th scope="col">Meals</th><th scope="col">Single guest</th><th scope="col">Status</th><th scope="col"><span class="ss-visually-hidden">Actions</span></th></tr></thead>
                <tbody>
                  @for (p of plans(); track p.id) {
                    <tr>
                      <td>{{ p.name }}</td>
                      <td><code>{{ p.code }}</code></td>
                      <td>{{ mealLabel(p.mealPlan) }}</td>
                      <td>{{ p.singleOccupancyDiscountPct !== null ? '−' + p.singleOccupancyDiscountPct + '%' : '—' }}</td>
                      <td><ss-status-pill [tone]="p.status === 'ACTIVE' ? 'success' : 'neutral'">{{ p.status === 'ACTIVE' ? 'Active' : 'Inactive' }}</ss-status-pill></td>
                      <td class="actions">
                        @if (canWrite()) {
                          <button type="button" class="ss-link-btn" (click)="edit(p)">Edit</button>
                          <button type="button" class="ss-link-btn danger" (click)="remove(p)">{{ confirmDelete() === p.id ? 'Click again to delete' : 'Delete' }}</button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="ss-muted">No rate plans yet. Create one to start setting prices.</p>
          }
        </section>

        @if (canWrite()) {
          <section class="ss-card">
            <h2 class="ss-card__title">{{ draft().id ? 'Edit rate plan' : 'New rate plan' }}</h2>
            <form (ngSubmit)="save()" class="form">
              <label class="ss-field"><span>Name</span><input class="ss-input" name="name" required maxlength="120" [ngModel]="draft().name" (ngModelChange)="set('name', $event)" /></label>
              <label class="ss-field"><span>Code</span><input class="ss-input" name="code" required maxlength="20" placeholder="STD" [ngModel]="draft().code" (ngModelChange)="set('code', $event)" /></label>
              <label class="ss-field"><span>Meals</span>
                <select class="ss-input" name="mealPlan" [ngModel]="draft().mealPlan" (ngModelChange)="set('mealPlan', $event)">
                  <option value="">Not specified</option>
                  @for (m of meals; track m.value) { <option [value]="m.value">{{ m.label }}</option> }
                </select>
              </label>
              <label class="ss-field"><span>Single-guest discount (%)</span>
                <input class="ss-input" type="number" min="0" max="90" name="single" [ngModel]="draft().singleOccupancyDiscountPct" (ngModelChange)="set('singleOccupancyDiscountPct', $event === '' || $event === null ? null : +$event)" />
                <small class="ss-muted">Used with Booking.com "derived" pricing: one guest pays this much less than the standard price.</small>
              </label>
              <label class="ss-field"><span>Description (optional)</span><textarea class="ss-input" name="description" rows="2" maxlength="1000" [ngModel]="draft().description" (ngModelChange)="set('description', $event)"></textarea></label>
              <label class="ss-field"><span>Status</span>
                <select class="ss-input" name="status" [ngModel]="draft().status" (ngModelChange)="set('status', $event)"><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select>
              </label>
              <div class="row">
                <button type="submit" class="ss-btn" [disabled]="busy()">{{ draft().id ? 'Save changes' : 'Create rate plan' }}</button>
                @if (draft().id) { <button type="button" class="ss-btn ss-btn--ghost" (click)="reset()">Cancel</button> }
              </div>
            </form>
          </section>
        }
      </div>
    }
  `,
  styles: `
    .grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 16px; align-items: start; }
    .form { display: grid; gap: 12px; }
    .row { display: flex; gap: 8px; }
    .actions { text-align: right; white-space: nowrap; }
    .actions button + button { margin-left: 12px; }
    .danger { color: var(--ss-red-600); }
    small { font-size: 12px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class RatePlans {
  private readonly api = inject(ChannelApi);
  private readonly auth = inject(AuthService);
  protected readonly meals = MEAL_PLANS;
  protected readonly property = signal<Property | null>(null);
  protected readonly plans = signal<RatePlan[]>([]);
  protected readonly draft = signal<Draft>({ ...EMPTY });
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly canWrite = computed(() => this.auth.hasOrgPermission('rate.write'));

  onProperty(p: Property): void {
    this.property.set(p);
    this.reset();
    this.load();
  }

  protected mealLabel(v: MealPlan | null): string {
    return MEAL_PLANS.find((m) => m.value === v)?.label ?? '—';
  }

  protected set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  protected edit(p: RatePlan): void {
    this.draft.set({ id: p.id, name: p.name, code: p.code, mealPlan: p.mealPlan ?? '', singleOccupancyDiscountPct: p.singleOccupancyDiscountPct, description: p.description ?? '', status: p.status });
  }

  protected reset(): void {
    this.draft.set({ ...EMPTY });
  }

  protected save(): void {
    const p = this.property();
    if (!p) return;
    const d = this.draft();
    const body = { name: d.name, code: d.code, mealPlan: d.mealPlan || null, singleOccupancyDiscountPct: d.singleOccupancyDiscountPct, description: d.description || null, status: d.status } as Partial<RatePlan>;
    this.busy.set(true);
    this.error.set(null);
    const req = d.id ? this.api.updateRatePlan(p.id, d.id, body) : this.api.createRatePlan(p.id, body);
    req.subscribe({
      next: () => {
        this.busy.set(false);
        this.reset();
        this.load();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected remove(plan: RatePlan): void {
    const p = this.property();
    if (!p) return;
    if (this.confirmDelete() !== plan.id) {
      this.confirmDelete.set(plan.id);
      return;
    }
    this.confirmDelete.set(null);
    this.api.deleteRatePlan(p.id, plan.id).subscribe({ next: () => this.load(), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }

  private load(): void {
    const p = this.property();
    if (!p) return;
    this.api.ratePlans(p.id).subscribe({ next: (list) => this.plans.set(list), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }
}
