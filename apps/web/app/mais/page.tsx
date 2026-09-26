import { redirect } from "next/navigation";

export default function MorePage() {
  redirect("/automacao?view=live");
}
