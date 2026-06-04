import { redirect } from "next/navigation";

// Overview was folded into Brains - keep the old path working for bookmarks.
export default function OverviewRedirect() {
  redirect("/brains");
}
