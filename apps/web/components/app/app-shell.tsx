import { LogoutButton } from "@/components/auth/logout-button";
import type { ReactNode } from "react";
import { AppNav } from "./app-nav";
import { CoinOpsBrand } from "./coinops-brand";

type AppShellProps = {
  userEmail: string;
  children: ReactNode;
};

export function AppShell({ userEmail, children }: AppShellProps) {
  return (
    <main className="page-shell dashboard-shell">
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <CoinOpsBrand compact />
          <div>
            <p className="eyebrow">CoinOps</p>
            <h1>Operacoes por slots</h1>
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
