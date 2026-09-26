import { redirect } from "next/navigation";

// The historical reports beneath this path remain available for audit.
export default function GrowthPlanPage() {
  redirect("/automacao?view=live");
}
