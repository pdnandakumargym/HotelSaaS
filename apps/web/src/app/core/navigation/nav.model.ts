import { IconName } from '../../shared/ui/icon/icons';

/**
 * available: implemented in the current build.
 * planned:   on the roadmap; the page states which milestone delivers it.
 */
export type NavItemStatus = 'available' | 'planned';

export interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  status: NavItemStatus;
  /** Milestone that delivers the feature (1-7). */
  milestone: number;
  description: string;
  /** Hide the item unless the user has this permission (UX only; the API enforces access). */
  permission?: string;
}
