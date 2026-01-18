import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Docker 多阶段构建需要
  output: 'standalone',
};

export default nextConfig;

