import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans:    ["DM Sans", "system-ui", "sans-serif"],
        display: ["Space Grotesk", "system-ui", "sans-serif"],
        mono:    ["JetBrains Mono", "Menlo", "monospace"],
      },
      colors: {
        arc: {
          bg:       "#0d1b2f",
          surface:  "#122d45",
          border:   "#1e3a52",
          accent:   "#acc6e9",
          muted:    "#6b8fa9",
          success:  "#8dd89f",
          danger:   "#e86d7a",
          warn:     "#f0c987",
          text:     "#e8f0f8",
          subtext:  "#8bafc8",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
