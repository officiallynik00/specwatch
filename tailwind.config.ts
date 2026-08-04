import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        reel: {
          bg: "#0A0B10",
          surface: "#14161F",
          surface2: "#1C1F2C",
          border: "#2A2E3D",
          text: "#F1EDE4",
          muted: "#8B8FA3",
          amber: "#E8A548",
          amberDim: "#B9803A",
          rose: "#E8637A",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      backgroundImage: {
        grain: "radial-gradient(circle at 20% 20%, rgba(232,165,72,0.06), transparent 45%), radial-gradient(circle at 80% 60%, rgba(232,99,122,0.05), transparent 40%)",
      },
      keyframes: {
        floatUp: {
          "0%": { transform: "translateY(0) scale(0.8)", opacity: "0" },
          "10%": { opacity: "1", transform: "translateY(-10px) scale(1)" },
          "80%": { opacity: "1" },
          "100%": { transform: "translateY(-220px) scale(1.05)", opacity: "0" },
        },
        pulseGlow: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        slideUp: {
          "0%": { transform: "translateY(100%)" },
          "100%": { transform: "translateY(0)" },
        },
      },
      animation: {
        floatUp: "floatUp 2s ease-out forwards",
        pulseGlow: "pulseGlow 2s ease-in-out infinite",
        slideUp: "slideUp 0.25s ease-out forwards",
      },
    },
  },
  plugins: [],
};

export default config;
