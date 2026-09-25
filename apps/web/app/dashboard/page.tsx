import { redirect } from "next/navigation";

// Keep old bookmarks working without rendering the retired summary dashboard.
export default function DashboardPage() {
  redirect("/automacao?view=live");
}
