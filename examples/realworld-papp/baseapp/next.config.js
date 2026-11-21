/** @type {import('next').NextConfig} */

const { supportedHighlightLangs, supportedLocales } = require('./config');

const nextConfig = {
  reactStrictMode: true,
  experimental: { cpus: 2 },
  eslint: { ignoreDuringBuilds: true },
  images: {
    domains: ['s2.loli.net', 'i.imgur.com'],
  },
  webpack: (config, { webpack }) => {
    config.plugins = config.plugins || [];
    config.plugins.push(
      new webpack.ContextReplacementPlugin(
        /highlight\.js\/lib\/languages$/,
        new RegExp(`^./(${supportedHighlightLangs.join('|')})$`)
      )
    );
    config.plugins.push(
      new webpack.ContextReplacementPlugin(
        /^date-fns[/\\]locale$/,
        new RegExp(`\\.[/\\\\](${supportedLocales.join('|')})[/\\\\]index\\.js$`)
      )
    );

    return config;
  },
};

module.exports = nextConfig;
