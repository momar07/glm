/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcd9ff',
          300: '#8ec2ff',
          400: '#59a1ff',
          500: '#2f7fff',
          600: '#1a63e6',
          700: '#154fbf',
          800: '#17429b',
          900: '#193a7d',
        },
        danger: { 500: '#ef4444', 600: '#dc2626' },
        ok: { 500: '#22c55e', 600: '#16a34a' },
        warn: { 500: '#f59e0b', 600: '#d97706' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        pulseRing: {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.3)', opacity: '0' },
          '100%': { transform: 'scale(0.9)', opacity: '0' },
        },
      },
      animation: { pulseRing: 'pulseRing 1.4s ease-out infinite' },
    },
  },
  plugins: [],
};
