import type { Config } from "tailwindcss";

const rgb = (v: string) => `rgb(var(--${v}) / <alpha-value>)`;

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1rem", screens: { "2xl": "1280px" } },
    extend: {
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        kpi: ["2rem", { lineHeight: "2.25rem", letterSpacing: "-0.02em", fontWeight: "500" }],
        hero: ["2.75rem", { lineHeight: "3rem", letterSpacing: "-0.03em", fontWeight: "500" }],
      },
      colors: {
        // theme surfaces
        bg: rgb("bg"),
        "surface-1": rgb("surface-1"),
        "surface-2": rgb("surface-2"),
        "surface-3": rgb("surface-3"),
        hairline: { DEFAULT: rgb("hairline"), strong: rgb("hairline-strong") },
        fg: { DEFAULT: rgb("fg"), 2: rgb("fg-2"), 3: rgb("fg-3") },
        // semantic (meaning-carrying) colours
        protected: rgb("protected"),
        risk: rgb("risk"),
        positive: rgb("positive"),
        negative: rgb("negative"),
        info: rgb("info"),
        // shadcn aliases
        border: rgb("border"),
        input: rgb("input"),
        ring: rgb("ring"),
        background: rgb("background"),
        foreground: rgb("foreground"),
        primary: { DEFAULT: rgb("primary"), foreground: rgb("primary-foreground") },
        secondary: { DEFAULT: rgb("secondary"), foreground: rgb("secondary-foreground") },
        destructive: { DEFAULT: rgb("destructive"), foreground: rgb("destructive-foreground") },
        muted: { DEFAULT: rgb("muted"), foreground: rgb("muted-foreground") },
        accent: { DEFAULT: rgb("accent"), foreground: rgb("accent-foreground") },
        card: { DEFAULT: rgb("card"), foreground: rgb("card-foreground") },
        popover: { DEFAULT: rgb("popover"), foreground: rgb("popover-foreground") },
        success: { DEFAULT: rgb("success"), foreground: rgb("success-foreground") },
        warning: { DEFAULT: rgb("warning"), foreground: rgb("warning-foreground") },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "0.625rem",
      },
      transitionTimingFunction: { out: "var(--ease-out)", "in-out": "var(--ease-in-out)" },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "none" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        shimmer: { from: { backgroundPosition: "-200% 0" }, to: { backgroundPosition: "200% 0" } },
        pulseDot: { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0.35" } },
      },
      animation: {
        "fade-up": "fade-up 420ms var(--ease-out) both",
        "fade-in": "fade-in 320ms var(--ease-out) both",
        shimmer: "shimmer 1.6s linear infinite",
        "pulse-dot": "pulseDot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
