import { ViewerSignOut } from "../meu-coinops/sign-out";

export default function SuspendedAccess() {
  return <main style={{ minHeight: "100dvh", display: "grid", placeContent: "center", gap: 16,
    padding: 24, background: "#07111c", color: "#eaf4fd", textAlign: "center" }}>
    <h1>Acesso indisponível</h1><p>Seu acesso ao Meu CoinOps está inativo. Fale com o administrador.</p><ViewerSignOut />
  </main>;
}
