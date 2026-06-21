import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SlotGain Control",
    short_name: "SlotGain",
    description: "Controle de slots cripto com login e dados por usuario.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#070b12",
    theme_color: "#070b12",
    orientation: "portrait",
    icons: [
      {
        src: "/icons/slotgain-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any"
      },
      {
        src: "/icons/maskable-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable"
      }
    ]
  };
}
