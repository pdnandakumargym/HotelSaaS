import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ROLE_LABELS } from '../../core/auth/auth.models';
import { AuthService } from '../../core/auth/auth.service';
import { NavItem } from '../../core/navigation/nav.model';
import { Icon } from '../../shared/ui/icon/icon';

export type Portal = 'owner' | 'admin';

@Component({
  selector: 'ss-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  readonly portal = input.required<Portal>();
  readonly nav = input.required<readonly NavItem[]>();

  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly menuOpen = signal(false);
  protected readonly userMenuOpen = signal(false);
  protected readonly roleLabels = ROLE_LABELS;

  /** Items the user may see. Planned items are shown (they carry no data). */
  protected readonly visibleNav = computed(() =>
    this.nav().filter((i) => !i.permission || this.auth.hasPlatformPermission(i.permission) || this.auth.hasOrgPermission(i.permission)),
  );
  protected readonly canSwitch = computed(() => (this.portal() === 'owner' ? this.auth.isPlatformAdmin() : this.auth.memberships().length > 0));
  protected readonly roleLabel = computed(() => {
    const org = this.auth.currentOrg();
    const platform = this.auth.user()?.platformRole;
    const platformLabel = platform === 'PLATFORM_SUPER_ADMIN' ? 'Super admin' : platform === 'PLATFORM_SUPPORT' ? 'Platform support' : '';
    if (this.portal() === 'admin') return platformLabel;
    return org ? this.roleLabels[org.role] : platformLabel;
  });
  protected readonly initials = computed(() =>
    (this.auth.user()?.displayName ?? '?')
      .split(/\s+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
  );

  constructor() {
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.menuOpen.set(false);
        this.userMenuOpen.set(false);
      });
  }

  protected toggleMenu(): void {
    this.menuOpen.update((v) => !v);
  }

  protected signOut(): void {
    this.auth.logout().subscribe(() => void this.router.navigate(['/login']));
  }
}
