/** Owner dashboard styles. Tokens come from the generated preset (design/build.mjs). */
/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require("./design/tailwind-preset.cjs")],
  content: ["./src/app/(dashboard)/**/*.{ts,tsx}", "./src/components/**/*.{ts,tsx}"],
  plugins: [],
};
