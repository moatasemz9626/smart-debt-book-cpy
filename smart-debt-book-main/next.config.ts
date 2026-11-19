import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pg is a Node.js server package; keep it out of bundling.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
