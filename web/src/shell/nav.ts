import { Activity, BookOpen, Workflow, CalendarDays, ChartColumn, Inbox, PhoneCall, Radar, Settings, ShieldCheck, Target, UsersRound, type LucideIcon } from 'lucide-react';

export type NavCountKey = 'approvals' | 'inbox';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  group: 'Operations' | 'Relationships' | 'Intelligence' | 'System';
  count?: NavCountKey;
  /** Shown in the phone tab bar (max 4 + "More"). */
  primaryMobile?: boolean;
}

/** Single source of truth for navigation. New modules register here; the shell adapts. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Command Center', icon: Radar, group: 'Operations', primaryMobile: true },
  { to: '/inbox', label: 'Inbox', icon: Inbox, group: 'Operations', count: 'inbox', primaryMobile: true },
  { to: '/approvals', label: 'Approvals', icon: ShieldCheck, group: 'Operations', count: 'approvals', primaryMobile: true },
  { to: '/calls', label: 'Calls', icon: PhoneCall, group: 'Operations', primaryMobile: true },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, group: 'Operations' },
  { to: '/leads', label: 'Leads', icon: Target, group: 'Relationships' },
  { to: '/customers', label: 'Customers', icon: UsersRound, group: 'Relationships' },
  { to: '/activity', label: 'Activity', icon: Activity, group: 'Intelligence' },
  { to: '/analytics', label: 'Analytics', icon: ChartColumn, group: 'Intelligence' },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen, group: 'Intelligence' },
  { to: '/agent', label: 'Agent', icon: Workflow, group: 'Intelligence' },
  { to: '/settings', label: 'Settings', icon: Settings, group: 'System' },
];

export const NAV_GROUPS = ['Operations', 'Relationships', 'Intelligence', 'System'] as const;
