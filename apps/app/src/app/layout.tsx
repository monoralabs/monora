import type { Metadata } from "next";
import { Playfair_Display, Inter, Space_Mono } from "next/font/google";
import { TRPCProvider } from "@/lib/trpc/client";
import "./globals.css";

// CSS var names match what @monora/brand/theme.css expects.
const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  weight: ["400", "500", "600"],
});
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});
const spaceMono = Space_Mono({
  subsets: ["latin"],
  variable: "--font-brain-mono",
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://app.monora.ai"),
  title: {
    default: "Monora",
    template: "%s · Monora",
  },
  description: "Your company brain - one working tree per person and agent.",
  // Icons come from the App Router file convention (src/app/favicon.ico,
  // icon.svg, apple-icon.png). Next serves them at the domain root - critical
  // because browsers request /favicon.ico at the root by default and cache the
  // result aggressively; pointing only at /favicon/* (a public subfolder) left
  // root /favicon.ico 404ing, so cached tabs showed no icon.
  // The product app lives behind auth - keep it out of search indexes entirely.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${inter.variable} ${spaceMono.variable}`}
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
