import path from 'path';
import { fileURLToPath } from 'url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the project root (a stray lockfile in a parent folder would otherwise be picked up)
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) }
};

export default nextConfig;
