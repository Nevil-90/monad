import path from 'path';
import { fileURLToPath } from 'url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Don't write agent instruction files into the project on `next dev`
  agentRules: false,
  // Pin the project root (a stray lockfile in a parent folder would otherwise be picked up)
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
  // Security headers. frame-ancestors/X-Frame-Options stop the app being framed by another site, which
  // could trick users into signing a transaction they cannot see (clickjacking).
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }
      ]
    }];
  }
};

export default nextConfig;
