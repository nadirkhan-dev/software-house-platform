import type { ReactElement, SVGProps } from 'react';

/**
 * Navigation icons, keyed by route.
 *
 * One shared set of stroke attributes rather than per-icon values: a set reads
 * as a set only when weight, cap and corner radius are identical across it, and
 * that is the first thing to drift when each icon carries its own numbers.
 *
 * Stroke is `currentColor`, so an icon inherits the nav item's colour and needs
 * no separate active, hover or dark-theme variant.
 */
const S: SVGProps<SVGSVGElement> = {
  width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
  'aria-hidden': true,
};

/**
 * Sidebar toggle — a panel with its rail marked off, the glyph every tool that
 * has one uses. A bare chevron says "something moves that way"; this says which
 * panel moves, which is the part worth saying.
 */
export const SidebarIcon = (): ReactElement => (
  <svg {...S}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6.2 3v10" />
  </svg>
);

/** Light theme — a sun. */
export const SunIcon = (): ReactElement => (
  <svg {...S}>
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" />
  </svg>
);

/** Dark theme — a crescent. */
export const MoonIcon = (): ReactElement => (
  <svg {...S}>
    <path d="M13.4 9.8A5.8 5.8 0 0 1 6.2 2.6a5.9 5.9 0 1 0 7.2 7.2Z" />
  </svg>
);

/** Sign out — a door with an arrow leaving it. */
export const SignOutIcon = (): ReactElement => (
  <svg {...S}>
    <path d="M6.2 13.6H3.4a1.4 1.4 0 0 1-1.4-1.4V3.8a1.4 1.4 0 0 1 1.4-1.4h2.8" />
    <path d="M10.4 11.2 13.6 8l-3.2-3.2" />
    <path d="M13.6 8H6" />
  </svg>
);

export const NAV_ICONS: Record<string, ReactElement> = {
  /* Dashboard — the four panes of a summary screen. */
  '/': (
    <svg {...S}>
      <rect x="2" y="2" width="5" height="5" rx="1.3" />
      <rect x="9" y="2" width="5" height="5" rx="1.3" />
      <rect x="2" y="9" width="5" height="5" rx="1.3" />
      <rect x="9" y="9" width="5" height="5" rx="1.3" />
    </svg>
  ),
  /* Pipeline — a funnel, narrowing towards the won deal. */
  '/leads': (
    <svg {...S}>
      <path d="M2.2 3h11.6l-4.4 5.1v5l-2.8-1.5V8.1L2.2 3Z" />
    </svg>
  ),
  /* Quotes — a price tag. */
  '/quotes': (
    <svg {...S}>
      <path d="M8.5 2H14v5.5l-6.2 6.2a1.4 1.4 0 0 1-2 0L2.3 10.2a1.4 1.4 0 0 1 0-2L8.5 2Z" />
      <circle cx="11.1" cy="4.9" r="1" />
    </svg>
  ),
  /* Projects — a folder of work. */
  '/projects': (
    <svg {...S}>
      <path d="M2 4.3c0-.7.5-1.3 1.2-1.3h2.9l1.6 1.8h6c.7 0 1.3.6 1.3 1.3v5.9c0 .7-.6 1.3-1.3 1.3H3.2c-.7 0-1.2-.6-1.2-1.3V4.3Z" />
    </svg>
  ),
  /* Tasks — a checklist. */
  '/tasks': (
    <svg {...S}>
      <path d="m2.2 5 1.7 1.8 3-3.4" />
      <path d="m2.2 11.4 1.7 1.8 3-3.4" />
      <path d="M9.6 5.1H14M9.6 11.5H14" />
    </svg>
  ),
  /* Timesheet — hours on a clock. */
  '/time': (
    <svg {...S}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8.2l2.4 1.5" />
    </svg>
  ),
  /* Expenses — a payment card. */
  '/expenses': (
    <svg {...S}>
      <rect x="2" y="3.6" width="12" height="8.8" rx="1.6" />
      <path d="M2 6.7h12" />
      <path d="M4.6 9.9h2.2" />
    </svg>
  ),
  /* Invoices — a billed document. */
  '/invoices': (
    <svg {...S}>
      <path d="M3.6 2.2h5.6L12.4 5.4v8.4H3.6V2.2Z" />
      <path d="M9.1 2.2v3.3h3.3" />
      <path d="M6 9h4M6 11.4h2.6" />
    </svg>
  ),
  /* Documents — an attachment. */
  '/documents': (
    <svg {...S}>
      <path d="M11.9 7.3 7.5 11.7a2.6 2.6 0 1 1-3.7-3.7l5-5a1.8 1.8 0 0 1 2.6 2.6l-5 5a.9.9 0 1 1-1.3-1.3l4.4-4.4" />
    </svg>
  ),
  /* Team — the people on it. */
  '/team': (
    <svg {...S}>
      <circle cx="6.1" cy="5.4" r="2.5" />
      <path d="M1.9 13.5c0-2.3 1.9-4.2 4.2-4.2s4.2 1.9 4.2 4.2" />
      <path d="M11 3.3a2.5 2.5 0 0 1 0 4.6" />
      <path d="M11.7 9.6c1.5.5 2.4 1.9 2.4 3.9" />
    </svg>
  ),
  /* Reports — figures as bars. */
  '/reports': (
    <svg {...S}>
      <path d="M2.4 13.6h11.2" />
      <path d="M4.5 11.4V8.2" />
      <path d="M8 11.4V4.9" />
      <path d="M11.5 11.4V6.6" />
    </svg>
  ),
  /* Settings — sliders, not a gear: a gear reads as machinery, sliders as choices. */
  '/settings': (
    <svg {...S}>
      <path d="M2.4 4.9h11.2M2.4 11.1h11.2" />
      <circle cx="6" cy="4.9" r="1.8" />
      <circle cx="10.4" cy="11.1" r="1.8" />
    </svg>
  ),
};
