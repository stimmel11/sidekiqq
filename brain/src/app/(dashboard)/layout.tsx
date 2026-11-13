import type { Metadata, Viewport } from "next";
import { RegisterServiceWorker } from "@/components/pwa/RegisterServiceWorker";
import { DASHBOARD_METADATA } from "@/lib/pwa/metadata";
import "./dashboard.css";

export const metadata: Metadata = DASHBOARD_METADATA;

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F4EF" },
    { media: "(prefers-color-scheme: dark)", color: "#0F1420" },
  ],
  viewportFit: "cover",
};

const FONTS =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap";

/** Shared by /login and /dashboard: fonts and the token stylesheet. React 19 hoists these into <head>. */
export default function DashboardRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link rel="stylesheet" href={FONTS} precedence="default" />
      <RegisterServiceWorker />
      {children}
    </>
  );
}
