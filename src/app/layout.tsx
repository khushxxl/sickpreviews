import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "sickpreviews.com",
  description: "Create sick phone mockup previews — composite app screenshots onto device mockups and export as PNG",
  viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
  openGraph: {
    title: "sickpreviews.com",
    description: "Create sick phone mockup previews",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "sickpreviews.com",
    description: "Create sick phone mockup previews",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
