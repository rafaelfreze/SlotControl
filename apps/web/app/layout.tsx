import type { Metadata, Viewport } from "next";

import "./globals.css";

const appName = process.env.NEXT_PUBLIC_APP_NAME || "SlotGain Control";

export const metadata: Metadata = {
  applicationName: appName,
  title: {
    default: appName,
    template: `%s | ${appName}`
  },
  description: "Controle de slots cripto com login, dados por usuario e Supabase.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: appName,
    statusBarStyle: "black-translucent"
  },
  icons: {
    icon: "/icons/slotgain-icon.svg",
    apple: "/icons/apple-touch-icon.svg"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#070b12"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
