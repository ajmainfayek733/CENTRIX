import { redirect } from "next/navigation";

export const metadata = { title: "Dashboard - C E N T R I X" };

/**
 * There is no public landing page - this is an internal tool. proxy.ts has already sent
 * anyone without a session to /login by the time this renders.
 */
export default function RootPage() {
  redirect("/overview");
}
