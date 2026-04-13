/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        plankton: {
          accent: "#ff3000",
          line: "#000000",
          muted: "#f2f2f2",
        },
      },
    },
  },
  plugins: [],
};
