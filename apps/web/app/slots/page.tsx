import { redirect } from "next/navigation";

// Retired manual slot control. Historical data stays in ledger/reports.
export default function SlotsPage() {
  redirect("/automacao?view=live");
}
