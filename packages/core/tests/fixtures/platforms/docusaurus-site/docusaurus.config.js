/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Test Site",
  tagline: "A test site",
  url: "https://example.com",
  baseUrl: "/",
  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",
  presets: [
    [
      "classic",
      {
        docs: { sidebarPath: false },
        blog: false,
      },
    ],
  ],
};
module.exports = config;
