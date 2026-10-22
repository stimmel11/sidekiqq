export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem", maxWidth: 640 }}>
      <h1>SideKiqq Brain</h1>
      <p>API-only service for SideKiqq devices. See README.md for the endpoint contract.</p>
      <p>
        Owner dashboard: <a href="/dashboard">/dashboard</a>
      </p>
    </main>
  );
}
