import type { MetadataRoute } from "next";

// 与 layout.tsx 同源开关：GBA 产品变体用 public/icons/gba/*，纯 Pi Web 用 public/icons/*。
const ICON_DIR = process.env.NEXT_PUBLIC_GBA_STUDIO !== "0" ? "/icons/gba" : "/icons";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Pi Web",
    short_name: "Pi Web",
    description: "Local web interface for the pi coding agent",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1a1a1a",
    categories: ["developer", "productivity"],
    lang: "en",
    icons: [
      {
        src: `${ICON_DIR}/icon-192.png`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${ICON_DIR}/icon-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
