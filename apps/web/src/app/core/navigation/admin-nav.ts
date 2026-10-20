import { NavItem } from './nav.model';

/** Platform Administration Portal navigation (12 modules from the master prompt). */
export const ADMIN_NAV: readonly NavItem[] = [
  { path: 'overview', label: 'Platform Overview', icon: 'dashboard', status: 'available', milestone: 1, description: 'Platform health and key counts.' },
  { path: 'customers', label: 'Customers', icon: 'briefcase', status: 'available', milestone: 3, description: 'Organizations, plans and status.', permission: 'admin.org.read' },
  { path: 'properties', label: 'Properties', icon: 'building', status: 'available', milestone: 3, description: 'All properties across the platform.', permission: 'admin.org.read' },
  { path: 'users', label: 'Users & Roles', icon: 'users', status: 'available', milestone: 2, description: 'Platform users, roles and permissions.', permission: 'admin.user.read' },
  { path: 'plans', label: 'Plans & Billing', icon: 'card', status: 'available', milestone: 3, description: 'Subscription plans, subscriptions and invoices.' },
  { path: 'channel-providers', label: 'Channel Providers', icon: 'plug', status: 'available', milestone: 4, description: 'Channel provider configuration, Test Connection and reference data.', permission: 'admin.integration.read' },
  { path: 'zodomus', label: 'Zodomus Health', icon: 'activity', status: 'available', milestone: 4, description: 'Zodomus API health, latency and error rate.', permission: 'admin.integration.read' },
  { path: 'api-logs', label: 'API Logs', icon: 'terminal', status: 'available', milestone: 4, description: 'Sanitized external API request and error logs.', permission: 'admin.integration.read' },
  { path: 'sync-jobs', label: 'Sync Jobs', icon: 'refresh', status: 'available', milestone: 6, description: 'Synchronization job monitoring.' },
  { path: 'security', label: 'Security & Audit', icon: 'shield', status: 'available', milestone: 2, description: 'Security events and the audit log.', permission: 'admin.audit.read' },
  { path: 'support', label: 'Support Tools', icon: 'lifebuoy', status: 'available', milestone: 3, description: 'Audited, time-boxed support access.', permission: 'admin.support.request' },
  { path: 'system', label: 'System Health & Config', icon: 'settings', status: 'available', milestone: 7, description: 'Services, workers, configuration.' },
];
