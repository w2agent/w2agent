export type BotPurpose = "user" | "search" | "training";

export interface BotToken {
  vendor: string;
  token: string;
  purpose: BotPurpose;
  robotsToken: boolean;
  hasUA: boolean;
  uaString?: string;
  sourceUrl: string;
}

const OPENAI = "https://developers.openai.com/api/docs/bots";
const ANTHROPIC =
  "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler";
const GOOGLE_COMMON =
  "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers";
const GOOGLE_USER =
  "https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers";
const PERPLEXITY = "https://docs.perplexity.ai/docs/resources/perplexity-crawlers";
const APPLE = "https://support.apple.com/en-us/119829";
const AMAZON = "https://developer.amazon.com/amazonbot";
const MISTRAL = "https://docs.mistral.ai/robots";
const META = "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers";
const COMMON_CRAWL = "https://commoncrawl.org/ccbot";

export const BOT_TOKENS: readonly BotToken[] = [
  {
    vendor: "OpenAI",
    token: "OAI-SearchBot",
    purpose: "search",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot",
    sourceUrl: OPENAI,
  },
  {
    vendor: "OpenAI",
    token: "GPTBot",
    purpose: "training",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot",
    sourceUrl: OPENAI,
  },
  {
    vendor: "OpenAI",
    token: "ChatGPT-User",
    purpose: "user",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    sourceUrl: OPENAI,
  },
  {
    vendor: "Anthropic",
    token: "ClaudeBot",
    purpose: "training",
    robotsToken: true,
    hasUA: true,
    sourceUrl: ANTHROPIC,
  },
  {
    vendor: "Anthropic",
    token: "Claude-User",
    purpose: "user",
    robotsToken: true,
    hasUA: true,
    sourceUrl: ANTHROPIC,
  },
  {
    vendor: "Anthropic",
    token: "Claude-SearchBot",
    purpose: "search",
    robotsToken: true,
    hasUA: true,
    sourceUrl: ANTHROPIC,
  },
  {
    vendor: "Google",
    token: "Googlebot",
    purpose: "search",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/W.X.Y.Z Safari/537.36",
    sourceUrl: GOOGLE_COMMON,
  },
  {
    vendor: "Google",
    token: "Google-Extended",
    purpose: "training",
    robotsToken: true,
    hasUA: false,
    sourceUrl: GOOGLE_COMMON,
  },
  {
    vendor: "Google",
    token: "Google-Agent",
    purpose: "user",
    robotsToken: false,
    hasUA: true,
    uaString:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent) Chrome/W.X.Y.Z Safari/537.36",
    sourceUrl: GOOGLE_USER,
  },
  {
    vendor: "Perplexity",
    token: "PerplexityBot",
    purpose: "search",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    sourceUrl: PERPLEXITY,
  },
  {
    vendor: "Perplexity",
    token: "Perplexity-User",
    purpose: "user",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
    sourceUrl: PERPLEXITY,
  },
  {
    vendor: "Apple",
    token: "Applebot",
    purpose: "search",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
    sourceUrl: APPLE,
  },
  {
    vendor: "Apple",
    token: "Applebot-Extended",
    purpose: "training",
    robotsToken: true,
    hasUA: false,
    sourceUrl: APPLE,
  },
  {
    vendor: "Amazon",
    token: "Amazonbot",
    purpose: "training",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/W.X.Y.Z Safari/537.36",
    sourceUrl: AMAZON,
  },
  {
    vendor: "Amazon",
    token: "Amzn-SearchBot",
    purpose: "search",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-SearchBot/0.1) Chrome/W.X.Y.Z Safari/537.36",
    sourceUrl: AMAZON,
  },
  {
    vendor: "Amazon",
    token: "Amzn-User",
    purpose: "user",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-User/0.1) Chrome/W.X.Y.Z Safari/537.36",
    sourceUrl: AMAZON,
  },
  {
    vendor: "Mistral",
    token: "MistralAI-User",
    purpose: "user",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)",
    sourceUrl: MISTRAL,
  },
  {
    vendor: "Mistral",
    token: "MistralAI-Index",
    purpose: "search",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-Index/1.0; +https://docs.mistral.ai/robots)",
    sourceUrl: MISTRAL,
  },
  {
    vendor: "Mistral",
    token: "MistralAI-Training",
    purpose: "training",
    robotsToken: true,
    hasUA: true,
    uaString:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-Training/1.0; +https://docs.mistral.ai/robots)",
    sourceUrl: MISTRAL,
  },
  {
    vendor: "Meta",
    token: "Meta-WebIndexer",
    purpose: "search",
    robotsToken: true,
    hasUA: true,
    uaString: "meta-webindexer/1.1 (+/documentation/sharing/webmasters/web-crawlers)",
    sourceUrl: META,
  },
  {
    vendor: "Meta",
    token: "Meta-ExternalAgent",
    purpose: "training",
    robotsToken: true,
    hasUA: true,
    uaString: "meta-externalagent/1.1 (+/documentation/sharing/webmasters/web-crawlers)",
    sourceUrl: META,
  },
  {
    vendor: "Meta",
    token: "Meta-ExternalFetcher",
    purpose: "user",
    robotsToken: true,
    hasUA: true,
    uaString: "meta-externalfetcher/1.1 (+/documentation/sharing/webmasters/web-crawlers)",
    sourceUrl: META,
  },
  {
    vendor: "Common Crawl",
    token: "CCBot",
    purpose: "training",
    robotsToken: true,
    hasUA: true,
    uaString: "CCBot/2.0 (https://commoncrawl.org/faq/)",
    sourceUrl: COMMON_CRAWL,
  },
];

export const ROBOTS_TOKENS: readonly string[] = BOT_TOKENS.filter((b) => b.robotsToken).map(
  (b) => b.token,
);
