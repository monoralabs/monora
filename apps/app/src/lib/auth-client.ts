"use client";

import { createAuthClient } from "better-auth/react";
import {
  adminClient,
  magicLinkClient,
  emailOTPClient,
  organizationClient,
} from "better-auth/client/plugins";
import { stripeClient } from "@better-auth/stripe/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  plugins: [
    organizationClient(),
    magicLinkClient(),
    emailOTPClient(),
    adminClient(),
    stripeClient({ subscription: true }),
  ],
});

export const { signIn, signOut, signUp, useSession, organization } =
  authClient;
