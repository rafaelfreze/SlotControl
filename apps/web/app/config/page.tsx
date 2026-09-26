import { redirect } from "next/navigation";

export default function ConfigPage() {
  redirect("/automacao?view=live");
}
