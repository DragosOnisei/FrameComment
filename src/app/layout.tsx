import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { AccentColorProvider } from "@/components/AccentColorProvider";
import { ServiceWorkerProvider } from "@/components/ServiceWorkerProvider";
import DisableNativeTooltips from "@/components/DisableNativeTooltips";
import { StorageConfigProvider, type StorageProvider } from "@/components/StorageConfigProvider";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";

const inter = Inter({ subsets: ["latin"] });

// Force Node.js runtime across the app to allow use of Node APIs (e.g., crypto).
export const runtime = 'nodejs';

// Prevent caching to ensure fresh appearance settings on every request
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: "FrameComment",
  description: "Professional video review and approval platform",
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/brand/icon.svg', type: 'image/svg+xml' },
      { url: '/brand/icon-192.svg', type: 'image/svg+xml', sizes: '192x192' },
      { url: '/brand/icon-512.svg', type: 'image/svg+xml', sizes: '512x512' },
    ],
    apple: [
      { url: '/brand/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
    ],
    shortcut: '/brand/icon.svg',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'FrameComment',
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover' as const,
  themeColor: '#0a0a0a',
}

// Fetch appearance settings server-side for immediate application
async function getAppearanceSettings() {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { defaultTheme: true, accentColor: true },
    })
    return {
      // 3.6.x: dark is the app default; 'auto' is treated as dark in the
      // bootstrap, but fall back to 'dark' explicitly for clarity.
      defaultTheme: settings?.defaultTheme || 'dark',
      accentColor: settings?.accentColor || 'blue',
    }
  } catch {
    return { defaultTheme: 'dark', accentColor: 'blue' }
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Fetch admin appearance settings, locale, and nonce server-side
  const appearance = await getAppearanceSettings()
  const locale = await getLocale()
  const messages = await getMessages()
  const headersList = await headers()
  const nonce = headersList.get('x-nonce') || ''
  const storageProvider = (process.env.STORAGE_PROVIDER === 's3' ? 's3' : 'local') as StorageProvider

  return (
    <html lang={locale} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/*
          Explicit viewport meta as the very first <head> child.
          Next.js `export const viewport` does emit a viewport tag, but
          we've observed Chrome on Android occasionally falling back to
          its 980px default for the first paint when the tag arrives
          later in the head order. Putting it first guarantees the
          browser sees device-width before any layout work begins.
        */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover"
        />
        {/* 1.4.x+: switched from a raw `<script>` element to
            `next/script` with strategy="beforeInteractive". Next.js 16
            warns about inline `<script>` tags inside React component
            trees ("Scripts inside React components are never executed
            when rendering on the client") — even though SSR renders
            them fine, the warning floods the dev console. `<Script>`
            with the same nonce + early-execution strategy is the
            officially supported way to keep the anti-FOUC theme +
            accent initialiser running before hydration. The body of
            the script is unchanged. */}
        <Script
          id="framecomment-bootstrap"
          strategy="beforeInteractive"
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `window.__STORAGE_PROVIDER__=${JSON.stringify(storageProvider)};(function() {
                try {
                  var serverDefaultTheme = '${appearance.defaultTheme}';
                  var serverAccentColor = '${appearance.accentColor}';

                  // 4.0.3: Light mode removed entirely — FrameComment is
                  // dark-only. Always force the dark class and migrate any
                  // legacy 'light' preference to dark so previously-light
                  // users land on dark automatically. serverDefaultTheme is
                  // intentionally ignored now.
                  document.documentElement.classList.add('dark');
                  var isDark = true;
                  try {
                    localStorage.removeItem('theme');
                    localStorage.setItem('adminDefaultTheme', 'dark');
                  } catch (e2) {}

                  // Apply accent color from cache or server default
                  var accentColors = {
                    blue: { light: '211 100% 50%', dark: '209 100% 60%' },
                    purple: { light: '262 83% 58%', dark: '262 83% 68%' },
                    green: { light: '145 63% 42%', dark: '145 63% 49%' },
                    orange: { light: '25 95% 53%', dark: '25 95% 60%' },
                    red: { light: '0 84% 60%', dark: '0 84% 65%' },
                    pink: { light: '330 81% 60%', dark: '330 81% 65%' },
                    teal: { light: '173 80% 40%', dark: '173 80% 50%' },
                    amber: { light: '38 92% 50%', dark: '38 92% 55%' },
                    stone: { light: '30 12% 50%', dark: '30 12% 62%' },
                    gold: { light: '37 56% 65%', dark: '37 56% 72%' }
                  };
                  var accentKey = localStorage.getItem('adminAccentColor') || serverAccentColor;
                  if (accentKey && accentColors[accentKey]) {
                    var color = accentColors[accentKey];
                    var hsl = isDark ? color.dark : color.light;
                    var parts = hsl.split(' ');
                    var h = parts[0], s = parts[1];
                    document.documentElement.style.setProperty('--primary', hsl);
                    document.documentElement.style.setProperty('--ring', hsl);
                    document.documentElement.style.setProperty('--accent-foreground', hsl);
                    document.documentElement.style.setProperty('--primary-visible', isDark ? h + ' ' + s + ' 20%' : h + ' ' + s + ' 95%');
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className={`${inter.className} flex flex-col min-h-dvh overflow-x-hidden`}>
        <NextIntlClientProvider messages={messages}>
          <StorageConfigProvider provider={storageProvider}>
            <AccentColorProvider />
            <ServiceWorkerProvider />
            <DisableNativeTooltips />
            <main className="flex-1 min-h-0 flex flex-col">{children}</main>
          </StorageConfigProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
