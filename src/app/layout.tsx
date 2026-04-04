import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "sickpreviews.com",
  description:
    "Composite app screenshots onto phone mockup images and export as PNG",
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
