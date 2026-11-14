import type { MetadataRoute } from "next";
import { MANIFEST_ICONS } from "@/lib/pwa/icons";

/**
 * Web app manifest, served by Next.js at /manifest.webmanifest (docs/WEBAPP.md §1).
 * Colours from design/tokens.json (Ink / Paper). Icons from design/icons.mjs.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/dashboard",
    name: "SideKiqq",
    short_name: "SideKiqq",
    description: "SideKiqq, it goes where you go.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0F1420",
    theme_color: "#0F1420",
    categories: ["productivity", "business"],
    icons: MANIFEST_ICONS.map((i) => ({ ...i })),
  };
}
