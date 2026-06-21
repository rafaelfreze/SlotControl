"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/dashboard", label: "Dashboard", icon: "$" },
  { href: "/slots", label: "Slots", icon: "#" },
  { href: "/historico", label: "Historico", icon: "H" },
  { href: "/config", label: "Config", icon: "C" }
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="dashboard-tabs" aria-label="Areas do app">
      {items.map((item) => (
        <Link key={item.href} href={item.href} className={pathname === item.href ? "active" : ""}>
          <span aria-hidden="true">{item.icon}</span>
          <strong>{item.label}</strong>
        </Link>
      ))}
    </nav>
  );
}
