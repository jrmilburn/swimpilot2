import Link from "next/link";
import { currentUser } from "@clerk/nextjs/server";
import { SignOutButton } from "@clerk/nextjs";

export default async function Home() {
  const user = await currentUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress;

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-col items-center gap-6 p-8">
        <h1 className="text-2xl font-semibold tracking-tight">SwimPilot</h1>
        {user ? (
          <>
            <p className="text-zinc-700 dark:text-zinc-300">
              Signed in as {email}
            </p>
            <SignOutButton>
              <button className="rounded-full border px-4 py-2 text-sm">
                Sign out
              </button>
            </SignOutButton>
          </>
        ) : (
          <Link
            href="/sign-in"
            className="rounded-full bg-foreground px-5 py-2 text-background"
          >
            Sign in
          </Link>
        )}
      </main>
    </div>
  );
}
