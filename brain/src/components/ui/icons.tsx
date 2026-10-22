/** Minimal stroke icons for the nav (24px grid, currentColor). */
const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const icons = {
  today: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
    </svg>
  ),
  followups: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden {...p}>
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M4 4v4h4" />
      <path d="M12 8v4l3 2" />
    </svg>
  ),
  drafts: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  ),
  commitments: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden {...p}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2" />
      <circle cx="5" cy="18" r="1.2" />
    </svg>
  ),
  devices: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden {...p}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </svg>
  ),
};

export type IconName = keyof typeof icons;
