import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";

// Handles all Better Auth endpoints (sign-in, social callbacks, org, stripe
// webhooks at /api/auth/stripe/webhook, etc.).
export const { GET, POST } = toNextJsHandler(auth);
