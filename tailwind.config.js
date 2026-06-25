/** @type {import('tailwindcss').Config} */
// Mirrors the prototype's inline `tailwind.config` (Play CDN) so the build looks identical.
export default {
  content: ['./index.html', './src/**/*.js'],
  theme: {
    extend: {
      colors: {
        bg:     '#FAFAF8',
        card:   '#FFFFFF',
        line:   '#ECEBE7',
        ink:    '#181D1A',
        sub:    '#6E736C',
        faint:  '#A2A69F',
        accent: '#14B87C',
        asoft:  '#E8F6EF',
        aline:  '#CDEBDD',
      },
      fontFamily: { sans: ['"Plus Jakarta Sans"', '"Noto Sans JP"', 'system-ui', 'sans-serif'] },
      boxShadow: {
        card: '0 1px 2px rgba(24,29,26,0.04)',
        lift: '0 6px 20px rgba(24,29,26,0.07)',
      },
    },
  },
  plugins: [],
};
