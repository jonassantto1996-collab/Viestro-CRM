import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Viestro CRM | Gestão e conversão",
  description: "Aquisição, qualificação e conversão em uma única operação.",
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">{children}</body>
    </html>
  );
}
