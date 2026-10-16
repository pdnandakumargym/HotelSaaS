import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { toApiError } from '../../../core/api/api-error';
import { Amenity, OrgApi, PROPERTY_TYPES, Property } from '../../../core/api/org-api.service';
import { AmenityPicker } from '../../../shared/ui/amenity-picker/amenity-picker';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

@Component({
  selector: 'ss-property-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ReactiveFormsModule, RouterLink, AmenityPicker],
  templateUrl: './property-form.html',
  styles: `
    form { max-width: 920px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
    .grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 16px; }
    .full { grid-column: 1 / -1; }
    textarea.ss-input { height: auto; min-height: 90px; padding: 10px 12px; resize: vertical; }
    select.ss-input { appearance: auto; }
    section.ss-card { margin-bottom: 16px; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    @media (max-width: 720px) { .grid, .grid3 { grid-template-columns: 1fr; } }
  `,
})
export class PropertyForm implements OnInit {
  /** Route param; absent when creating. */
  readonly id = input<string | undefined>(undefined);

  private readonly api = inject(OrgApi);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly types = PROPERTY_TYPES;
  protected readonly timezones = Intl.supportedValuesOf('timeZone');
  protected readonly amenities = signal<Amenity[]>([]);
  protected readonly selectedAmenities = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fieldErrors = signal<Record<string, string>>({});

  protected readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(160)]],
    propertyType: ['HOTEL', Validators.required],
    status: ['DRAFT', Validators.required],
    timezone: [Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata', Validators.required],
    currency: ['INR', [Validators.required, Validators.pattern(/^[A-Za-z]{3}$/)]],
    countryCode: ['IN', [Validators.required, Validators.pattern(/^[A-Za-z]{2}$/)]],
    addressLine1: [''],
    addressLine2: [''],
    city: [''],
    state: [''],
    postalCode: [''],
    contactEmail: ['', Validators.email],
    contactPhone: [''],
    checkInTime: ['14:00', Validators.pattern(TIME)],
    checkOutTime: ['11:00', Validators.pattern(TIME)],
    starRating: [''],
    description: [''],
    cancellationPolicy: [''],
    houseRules: [''],
  });

  ngOnInit(): void {
    this.api.amenities().subscribe((a) => this.amenities.set(a));
    const id = this.id();
    if (id) {
      this.api.property(id).subscribe({
        next: (p) => {
          this.form.patchValue({ ...this.toForm(p) });
          this.selectedAmenities.set(p.amenities);
        },
        error: (e: unknown) => this.error.set(toApiError(e).message),
      });
    }
  }

  private toForm(p: Property): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(this.form.controls)) {
      const v = (p as unknown as Record<string, unknown>)[key];
      out[key] = v === null || v === undefined ? '' : String(v);
    }
    return out;
  }

  protected err(name: string): string | null {
    return this.fieldErrors()[name] ?? null;
  }

  protected submit(): void {
    this.fieldErrors.set({});
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Check the highlighted fields.');
      return;
    }
    const v = this.form.getRawValue();
    const body: Record<string, unknown> = { ...v, starRating: v.starRating ? Number(v.starRating) : null, amenities: this.selectedAmenities() };
    this.busy.set(true);
    this.error.set(null);
    const id = this.id();
    const req = id ? this.api.updateProperty(id, body as Partial<Property>) : this.api.createProperty(body as Partial<Property>);
    req.subscribe({
      next: (p) => void this.router.navigate(['/app/properties', p.id]),
      error: (e: unknown) => {
        this.busy.set(false);
        const apiErr = toApiError(e);
        this.error.set(apiErr.message);
        const details = (e as { error?: { error?: { details?: { path: string; message: string }[] } } }).error?.error?.details;
        if (Array.isArray(details)) this.fieldErrors.set(Object.fromEntries(details.map((d) => [d.path, d.message])));
      },
    });
  }
}
