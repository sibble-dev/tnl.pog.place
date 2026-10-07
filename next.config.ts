import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static site (out/): matching runs in the browser, data + icons are static files.
  output: "export",
};

export default nextConfig;
