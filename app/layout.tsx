import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "Nocturne Laboratory — Psychoacoustic Research Console",
    description: "A real-time auditory beat, synthesis, layering, and automation instrument for psychoacoustic experimentation.",
    openGraph: {
      title: "Nocturne Laboratory",
      description: "Psychoacoustic Research Console — a thermionic instrument for auditory beat synthesis and layered sound design.",
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: "Nocturne Laboratory",
      description: "Psychoacoustic Research Console",
      images: [image],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
