import type { Metadata, Viewport } from "next";

import "./globals.css";

const appName = "CoinOps";
const description = "Operacoes inteligentes em criptomoedas";

export const metadata: Metadata = {
  applicationName: appName,
  title: {
    default: appName,
    template: `%s | ${appName}`
  },
  description,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: appName,
    statusBarStyle: "black-translucent"
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192x192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512x512.png", type: "image/png", sizes: "512x512" }
    ],
    shortcut: "/favicon.png",
    apple: "/apple-touch-icon.png"
  },
  openGraph: {
    title: appName,
    description,
    siteName: appName,
    type: "website"
  },
  twitter: {
    card: "summary",
    title: appName,
    description
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050505"
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
