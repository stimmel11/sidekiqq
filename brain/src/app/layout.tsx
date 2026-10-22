export const metadata = { title: "SideKiqq Brain", description: "SideKiqq cloud brain API" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem", maxWidth: 640 }}>{children}</body>
    </html>
  );
}
