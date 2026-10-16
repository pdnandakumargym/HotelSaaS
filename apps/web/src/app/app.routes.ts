import { Route, Routes } from '@angular/router';
import { adminGuard, authGuard, enrollmentGuard, guestGuard, mfaPendingGuard } from './core/auth/auth.guards';
import { ADMIN_NAV } from './core/navigation/admin-nav';
import { NavItem } from './core/navigation/nav.model';
import { OWNER_NAV } from './core/navigation/owner-nav';

/** Planned modules render an honest placeholder; route data feeds its inputs. */
function plannedRoutes(items: readonly NavItem[], titlePrefix: string): Route[] {
  return items
    .filter((i) => i.status === 'planned')
    .map((i) => ({
      path: i.path,
      title: `${i.label} · ${titlePrefix}`,
      loadComponent: () => import('./shared/ui/planned-page/planned-page').then((m) => m.PlannedPage),
      data: { title: i.label, description: i.description, milestone: i.milestone, icon: i.icon },
    }));
}

// Guards only steer navigation; the API authorizes every request.
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'app' },
  { path: 'login', title: 'Sign in · StaySync', canActivate: [guestGuard], loadComponent: () => import('./features/auth/login/login').then((m) => m.Login) },
  {
    path: 'login/2fa',
    title: 'Two-step verification · StaySync',
    canActivate: [mfaPendingGuard],
    loadComponent: () => import('./features/auth/two-factor-challenge/two-factor-challenge').then((m) => m.TwoFactorChallenge),
  },
  { path: 'register', title: 'Create account · StaySync', canActivate: [guestGuard], loadComponent: () => import('./features/auth/register/register').then((m) => m.Register) },
  { path: 'verify-email', title: 'Verify email · StaySync', loadComponent: () => import('./features/auth/verify-email/verify-email').then((m) => m.VerifyEmail) },
  { path: 'forgot-password', title: 'Reset password · StaySync', loadComponent: () => import('./features/auth/forgot-password/forgot-password').then((m) => m.ForgotPassword) },
  { path: 'reset-password', title: 'Choose a new password · StaySync', loadComponent: () => import('./features/auth/reset-password/reset-password').then((m) => m.ResetPassword) },
  { path: 'invite', title: 'Team invitation · StaySync', loadComponent: () => import('./features/auth/invite/invite').then((m) => m.Invite) },
  { path: 'confirm-email', title: 'Confirm email · StaySync', loadComponent: () => import('./features/auth/confirm-email/confirm-email').then((m) => m.ConfirmEmail) },
  {
    path: 'security/two-factor-setup',
    title: 'Two-factor authentication · StaySync',
    canActivate: [enrollmentGuard],
    loadComponent: () => import('./features/security/two-factor-setup/two-factor-setup').then((m) => m.TwoFactorSetup),
  },
  {
    path: 'app',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell/shell').then((m) => m.Shell),
    data: { portal: 'owner', nav: OWNER_NAV },
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', title: 'Dashboard · StaySync', loadComponent: () => import('./features/owner/dashboard/dashboard').then((m) => m.OwnerDashboard) },
      { path: 'team', title: 'Team · StaySync', loadComponent: () => import('./features/owner/team/team').then((m) => m.Team) },
      { path: 'properties', title: 'Properties · StaySync', loadComponent: () => import('./features/owner/properties/properties').then((m) => m.Properties) },
      { path: 'properties/new', title: 'Add property · StaySync', loadComponent: () => import('./features/owner/property-form/property-form').then((m) => m.PropertyForm) },
      { path: 'properties/:id', title: 'Property · StaySync', loadComponent: () => import('./features/owner/property-detail/property-detail').then((m) => m.PropertyDetail) },
      { path: 'properties/:id/edit', title: 'Edit property · StaySync', loadComponent: () => import('./features/owner/property-form/property-form').then((m) => m.PropertyForm) },
      { path: 'rooms', title: 'Rooms & units · StaySync', loadComponent: () => import('./features/owner/rooms/rooms-page').then((m) => m.RoomsPage) },
      { path: 'photos', title: 'Photos & amenities · StaySync', loadComponent: () => import('./features/owner/amenities/amenities-page').then((m) => m.AmenitiesPage) },
      { path: 'inventory', title: 'Inventory & rates calendar · StaySync', loadComponent: () => import('./features/owner/inventory/inventory').then((m) => m.Inventory) },
      { path: 'rates', title: 'Rates & rate plans · StaySync', loadComponent: () => import('./features/owner/rate-plans/rate-plans').then((m) => m.RatePlans) },
      { path: 'mapping', title: 'Booking.com mapping · StaySync', loadComponent: () => import('./features/owner/mapping/mapping').then((m) => m.Mapping) },
      { path: 'channels', title: 'Channel connections · StaySync', loadComponent: () => import('./features/owner/channels/channels').then((m) => m.Channels) },
      { path: 'billing', title: 'Subscription & billing · StaySync', loadComponent: () => import('./features/owner/billing/billing').then((m) => m.Billing) },
      { path: 'settings', title: 'Profile & security · StaySync', loadComponent: () => import('./features/owner/settings/settings').then((m) => m.Settings) },
      ...plannedRoutes(OWNER_NAV, 'StaySync'),
    ],
  },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () => import('./layout/shell/shell').then((m) => m.Shell),
    data: { portal: 'admin', nav: ADMIN_NAV },
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      { path: 'overview', title: 'Platform overview · StaySync Admin', loadComponent: () => import('./features/admin/overview/overview').then((m) => m.AdminOverview) },
      { path: 'customers', title: 'Customers · StaySync Admin', loadComponent: () => import('./features/admin/customers/customers').then((m) => m.AdminCustomers) },
      { path: 'customers/:id', title: 'Customer · StaySync Admin', loadComponent: () => import('./features/admin/customer-detail/customer-detail').then((m) => m.AdminCustomerDetail) },
      { path: 'properties', title: 'Properties · StaySync Admin', loadComponent: () => import('./features/admin/properties/admin-properties').then((m) => m.AdminProperties) },
      { path: 'plans', title: 'Plans & billing · StaySync Admin', loadComponent: () => import('./features/admin/plans/admin-plans').then((m) => m.AdminPlans) },
      { path: 'channel-providers', title: 'Channel providers · StaySync Admin', loadComponent: () => import('./features/admin/integrations/channel-providers').then((m) => m.ChannelProviders) },
      { path: 'zodomus', title: 'Zodomus health · StaySync Admin', loadComponent: () => import('./features/admin/integrations/zodomus-health').then((m) => m.ZodomusHealth) },
      { path: 'api-logs', title: 'API logs · StaySync Admin', loadComponent: () => import('./features/admin/integrations/api-logs').then((m) => m.ApiLogs) },
      { path: 'support', title: 'Support tools · StaySync Admin', loadComponent: () => import('./features/admin/support/admin-support').then((m) => m.AdminSupport) },
      { path: 'users', title: 'Users & roles · StaySync Admin', loadComponent: () => import('./features/admin/users/users').then((m) => m.AdminUsers) },
      { path: 'security', title: 'Security & audit · StaySync Admin', loadComponent: () => import('./features/admin/audit/audit').then((m) => m.AdminAudit) },
      ...plannedRoutes(ADMIN_NAV, 'StaySync Admin'),
    ],
  },
  { path: '**', title: 'Not found · StaySync', loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFound) },
];
