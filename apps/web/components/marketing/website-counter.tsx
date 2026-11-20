"use client";
import { usePathname } from "next/navigation";
import { isInternalTraffic } from "@/vendor/marketing-internal-traffic-1.3.5/internal-traffic.mjs";
import { WebsiteCounter } from "@/vendor/marketing-1.4.18/website-counter.js";
export function PublicWebsiteCounter({
  preview = false,
}: {
  preview?: boolean;
}) {
  const pathname = usePathname();
  return <WebsiteCounter version={2} preview={preview || isInternalTraffic()} navigationKey={pathname ?? "/"} />;
}
