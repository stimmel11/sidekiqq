export const metadata = { title: "SideKiqq Brain", description: "SideKiqq cloud brain API" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // No body styles here: the API landing page and the owner dashboard (app/(dashboard)) style themselves.
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
