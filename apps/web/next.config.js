/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the desktop shell serves the built files itself,
  // and the web dev server (`next dev`) keeps working as before.
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
};

module.exports = nextConfig;
