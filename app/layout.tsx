import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  // Set NEXT_PUBLIC_SITE_URL to the deployed address so social previews get absolute URLs.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: 'Tunarr Lineup',
  description: 'A TV-friendly, skinnable programming desk for your Tunarr channels.',
  openGraph: {
    title: 'Tunarr Lineup',
    description: 'Your schedule, the classic way.',
    images: [{ url: '/og.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tunarr Lineup',
    description: 'Your schedule, the classic way.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // skin-init.js sets data-skin on <html> before hydration, so React leaves it be.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved skin before first paint (no flash). A same-origin file, not inline, to fit the companion's CSP. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/skin-init.js" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
