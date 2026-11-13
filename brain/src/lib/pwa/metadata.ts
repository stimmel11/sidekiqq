import type { Metadata } from "next";
import { APPLE_TOUCH_ICON, MANIFEST_ICONS } from "./icons";

/** Metadata for /login and /dashboard (app/(dashboard)/layout.tsx): manifest link and Home Screen tags. */
export const DASHBOARD_METADATA: Metadata = {
  title: { default: "SideKiqq", template: "%s | SideKiqq" },
  description: "SideKiqq, it goes where you go.",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  applicationName: "SideKiqq",
  // iOS "Add to Home Screen": standalone. "default" keeps content below the status bar, so its text stays
  // readable on the Paper login page and on iPad widths (black-translucent would draw white text over the page).
  appleWebApp: { capable: true, title: "SideKiqq", statusBarStyle: "default" },
  icons: {
    icon: MANIFEST_ICONS.filter((i) => i.purpose === "any").map((i) => ({ url: i.src, sizes: i.sizes, type: i.type })),
    apple: [{ url: APPLE_TOUCH_ICON, sizes: "180x180", type: "image/png" }],
  },
  formatDetection: { telephone: false, email: false, address: false },
};
