import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/PwaRegistration";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./settings.css";

// Noto Sans Mono 改为自托管可变字体（public/fonts/ + globals.css @font-face），
// 取代 next/font/google —— 后者构建期必须联 fonts.googleapis.com，离线/无代理环境
// 直接构建失败。字体文件来自 @fontsource-variable/noto-sans-mono（OFL 许可，
// 许可文本见 public/fonts/LICENSE-OFL.txt）。

// GBA 产品变体（--pure 构建时注入 NEXT_PUBLIC_GBA_STUDIO=0）使用各自图标目录。
// 图标文件由 scripts/make-gba-icons.mjs 生成到 public/icons/gba/。
const GBA_STUDIO_ENABLED = process.env.NEXT_PUBLIC_GBA_STUDIO !== "0";
const ICON_DIR = GBA_STUDIO_ENABLED ? "/icons/gba" : "/icons";

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
  applicationName: "Pi Web",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: `${ICON_DIR}/favicon.ico`,
        sizes: "512x512",
        type: "image/png",
      },
      {
        url: `${ICON_DIR}/icon-192.png`,
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: `${ICON_DIR}/apple-touch-icon.png`,
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pi Web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className="notranslate" suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");var dark=t==="dark"||((t==null||t===""||t==="auto")&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(dark)document.documentElement.classList.add("dark")}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" suppressHydrationWarning>
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
