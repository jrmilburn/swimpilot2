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
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-school-slug", match[1]!);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
