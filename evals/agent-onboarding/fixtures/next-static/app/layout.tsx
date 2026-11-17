import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Acme Plumbing | Licensed plumbers in Springfield",
  description:
    "Acme Plumbing offers emergency repairs, water heater installs and drain cleaning in Springfield. Call 555-0142.",
  metadataBase: new URL("https://acme-plumbing.example.com"),
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Acme Plumbing",
    description: "Licensed plumbers in Springfield.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "sans-serif", margin: 0 }}>
        <header style={{ padding: "1rem 2rem", background: "#0b5fa5" }}>
          <nav style={{ display: "flex", gap: "1.5rem" }}>
            <Link href="/" style={{ color: "#fff" }}>
              Acme Plumbing
            </Link>
            <Link href="/services" style={{ color: "#fff" }}>
              Services
            </Link>
            <Link href="/contact" style={{ color: "#fff" }}>
              Contact
            </Link>
          </nav>
        </header>
        <main style={{ padding: "2rem", maxWidth: 800 }}>{children}</main>
        <footer style={{ padding: "1rem 2rem", color: "#555" }}>
          Acme Plumbing, 100 Main Street, Springfield. Licensed and insured.
        </footer>
      </body>
    </html>
  );
}
