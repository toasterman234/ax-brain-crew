import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ax Visual Lab",
  description: "Chat, trace, and tinker with your Ax agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased h-screen overflow-hidden">{children}</body>
    </html>
  );
}
