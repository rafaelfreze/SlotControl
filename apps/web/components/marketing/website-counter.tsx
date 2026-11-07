"use client";
import { usePathname } from "next/navigation";
import { isInternalTraffic } from "@/vendor/marketing-internal-traffic-1.3.5/internal-traffic.mjs";
import { WebsiteCounter } from "@/vendor/marketing-1.3.2/website-counter.mjs";
export function PublicWebsiteCounter({
  preview = false,
}: {
  preview?: boolean;
}) {
  const pathname = usePathname();
  return <WebsiteCounter preview={preview || isInternalTraffic()} navigationKey={pathname ?? "/"} />;
}
