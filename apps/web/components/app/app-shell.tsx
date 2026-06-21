import { LogoutButton } from "@/components/auth/logout-button";
import type { ReactNode } from "react";
import { AppNav } from "./app-nav";

type AppShellProps = {
  userEmail: string;
  children: ReactNode;
};

export function AppShell({ userEmail, children }: AppShellProps) {
  return (
    <main className="page-shell dashboard-shell">
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <span className="brand-mark" aria-hidden="true">
            SG
          </span>
          <div>
            <p className="eyebrow">SlotGain Control</p>
            <h1>Controle por slots</h1>
            <p className="muted-text">{userEmail}</p>
          </div>
        </div>
        <LogoutButton />
      </header>
      <AppNav />
      {children}
    </main>
  );
}
