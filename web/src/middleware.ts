import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
}
if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("Missing CLERK_SECRET_KEY");
}

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/(.*)",
]);

const TENANT_PATH = /^\/s\/([^/]+)(?:\/|$)/;
const LAST_SCHOOL_COOKIE = "swp_last_school";
const LAST_SCHOOL_MAX_AGE = 60 * 60 * 24 * 365; // ~1 year

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  // Forward the resolved tenant slug to downstream server components, route
  // handlers, and server actions via a trusted request header. Server
  // actions POST back to the page URL, so the path still contains the slug
  // — middleware is the only place we can guarantee the value before
  // application code runs. `tenantAction` reads this header to resolve the
  // tenant; never trust a slug coming from the request body.
  const match = TENANT_PATH.exec(request.nextUrl.pathname);
  if (match) {
    const slug = match[1]!;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-school-slug", slug);
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    // UX hint only — the landing page reads this to short-circuit the
    // picker for users with multiple memberships. Not auth: requireTenant
    // and RLS still gate access. The slug here came from the URL the user
    // already navigated to successfully (or will get a 404 from); writing
    // it on every tenant request keeps the value fresh.
    response.cookies.set(LAST_SCHOOL_COOKIE, slug, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: LAST_SCHOOL_MAX_AGE,
    });
    return response;
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
