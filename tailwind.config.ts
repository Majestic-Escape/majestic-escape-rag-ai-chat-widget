import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        poppins: ["var(--font-poppins)", "system-ui", "sans-serif"],
      },
      colors: {
        stone: "#707070",
        graphite: "#333333",
        absoluteDark: "#1E1E1E",
        primaryGreen: "#36621F",
        brightGreen: "#46921E",
        lightGreen: "#BBEEA1",
        lihgterGreen: "#CBFFB0",
        solidGray: "#888888",
        offWhite: "#fcfcfc",
        lightGray: "#CCCCCC",
      },
      keyframes: {
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      boxShadow: {
        floating: "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
      },
      animation: {
        "fade-in-up": "fade-in-up 0.25s ease-out",
        bounce: "bounce 1s infinite",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
