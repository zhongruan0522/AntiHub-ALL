import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker 多阶段构建需要
  output: "standalone",

  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: "http://backend:8000/:path*",
      },
    ];
  },
};

export default nextConfig;
