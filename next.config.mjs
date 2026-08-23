/** @type {import('next').NextConfig} */

const isProduction = process.env.NODE_ENV === "production";
// Vercel preview deployments inject the Live feedback/comments toolbar from
// vercel.live. It is not present in production, so it is allowlisted only
// where it actually runs rather than widening the production policy.
const isVercelPreview = process.env.VERCEL_ENV === "preview";

// Next.js dev mode's hot-reload runtime uses eval()-based source maps, so
// 'unsafe-eval' is required in development or the client bundle silently
// fails to execute at all (discovered via a Playwright smoke test: with it
// omitted, every onClick/onSubmit handler on the page was simply never
// attached — forms fell back to native GET submission). Production builds
// don't need it.
const scriptSrc = [
  "script-src 'self' 'unsafe-inline'",
  isProduction ? "" : "'unsafe-eval'",
  isVercelPreview ? "https://vercel.live" : "",
]
  .filter(Boolean)
  .join(" ");

const connectSrc = [
  "connect-src 'self'",
  isVercelPreview ? "https://vercel.live wss://ws-us3.pusher.com" : "",
]
  .filter(Boolean)
  .join(" ");

const contentSecurityPolicy = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${isVercelPreview ? " https://vercel.live https://vercel.com" : ""}`,
  `font-src 'self' data:${isVercelPreview ? " https://vercel.live https://assets.vercel.com" : ""}`,
  connectSrc,
  `frame-src 'self'${isVercelPreview ? " https://vercel.live" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: false,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
