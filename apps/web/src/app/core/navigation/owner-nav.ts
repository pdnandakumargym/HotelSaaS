import { NavItem } from './nav.model';

/** Property Owner Portal navigation (16 modules from the master prompt). */
export const OWNER_NAV: readonly NavItem[] = [
  { path: 'dashboard', label: 'Dashboard', icon: 'dashboard', status: 'available', milestone: 1, description: 'Overview of your properties, channels and onboarding.' },
  { path: 'properties', label: 'Properties', icon: 'building', status: 'available', milestone: 3, description: 'Create and manage properties, policies, address and time zone.' },
  { path: 'rooms', label: 'Rooms & Units', icon: 'bed', status: 'available', milestone: 3, description: 'Room types, units, occupancy and bed configuration.' },
  { path: 'photos', label: 'Photos & Amenities', icon: 'image', status: 'available', milestone: 3, description: 'Property and room photos, amenities and content.' },
  { path: 'inventory', label: 'Inventory Calendar', icon: 'calendar', status: 'available', milestone: 5, description: 'Availability per room type and date: available, low, sold out, blocked.' },
  { path: 'rates', label: 'Rates & Rate Plans', icon: 'tag', status: 'available', milestone: 5, description: 'Rate plans and the master rate calendar.' },
  { path: 'promotions', label: 'Discounts & Promotions', icon: 'percent', status: 'available', milestone: 7, description: 'Discounts and promotions where the channel supports them.' },
  { path: 'bookings', label: 'Bookings', icon: 'clipboard', status: 'available', milestone: 6, description: 'Unified reservations from connected channels.' },
  { path: 'channels', label: 'Channel Connections', icon: 'plug', status: 'available', milestone: 4, description: 'Zodomus connection state, credential status and connection tests.' },
  { path: 'mapping', label: 'Room & Rate Mapping', icon: 'link', status: 'available', milestone: 5, description: 'Map your rooms and rate plans to channel rooms and rates.' },
  { path: 'sync', label: 'Synchronization Status', icon: 'refresh', status: 'available', milestone: 6, description: 'Per-channel sync jobs: pending, succeeded, failed, last sync.' },
  { path: 'discrepancies', label: 'Discrepancy Center', icon: 'alert', status: 'available', milestone: 6, description: 'Overbookings, unmapped rooms, incomplete bookings and undelivered updates, with actions.' },
  { path: 'reports', label: 'Reports', icon: 'chart', status: 'available', milestone: 7, description: 'Occupancy, revenue and channel performance.' },
  { path: 'billing', label: 'Subscription & Billing', icon: 'card', status: 'available', milestone: 3, description: 'Plan, channel limits and billing history.' },
  { path: 'team', label: 'Team Members & Roles', icon: 'users', status: 'available', milestone: 2, description: 'Invite staff and assign roles.' },
  { path: 'settings', label: 'Profile & Security', icon: 'shield', status: 'available', milestone: 2, description: 'Password, two-factor authentication and active sessions.' },
];
