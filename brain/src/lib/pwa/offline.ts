/** The static offline page (GET /offline). See src/app/offline/route.ts. */

const MARK =
  '<svg aria-hidden="true" width="48" height="48" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0F1420"/><circle cx="16" cy="16" r="9.5" fill="none" stroke="#F6F4EF" stroke-width="2.4"/><circle cx="16" cy="16" r="4.2" fill="#E8A33D"/></svg>';

export const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0F1420">
<title>Offline | SideKiqq</title>
<style>
  :root { color-scheme: light dark; --bg: #F6F4EF; --text: #0F1420; --muted: #5B6475; --accent: #E8A33D; --accent-text: #0F1420; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0F1420; --text: #F6F4EF; --muted: #A3AAB8; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
         background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 20px 0 8px; letter-spacing: -0.01em; }
  p { margin: 0 0 24px; color: var(--muted); }
  a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 20px; border-radius: 10px;
      background: var(--accent); color: var(--accent-text); font-weight: 600; text-decoration: none; }
  a:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
</style>
</head>
<body>
<main>
${MARK}
<h1>You're offline.</h1>
<p>SideKiqq needs a connection. Nothing is sent without your tap on Send.</p>
<a href="/dashboard">Try again</a>
</main>
</body>
</html>
`;

export const OFFLINE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
