const URL_PATTERNS: [RegExp, number][] = [
  // Low-value patterns first (more specific, checked before general matches)
  [/\/(page|p)\/\d+/, 0],
  [/^\/(tag|tags|category|categories|archive|archives)(\/|$)/, 1],
  [/^\/(author|authors|contributor|contributors)(\/|$)/, 1],
  [/^\/(terms|privacy|legal|cookie|tos|gdpr|dmca)(\/|$)/, 1],
  // High-value patterns
  [/^\/(pricing|plans)(\/|$)/, 8],
  [/^\/(docs|documentation|guide|guides|manual)(\/|$)/, 7],
  [/^\/(api|reference|sdk|developers)(\/|$)/, 7],
  [/^\/(about|company|team|who-we-are)(\/|$)/, 6],
  [/^\/(faq|help|support|knowledge-base)(\/|$)/, 6],
  [/^\/(contact|get-started|demo|signup|sign-up)(\/|$)/, 5],
  [/^\/(features|product|products|solutions|services)(\/|$)/, 5],
  [/^\/(changelog|releases|whats-new|release-notes)(\/|$)/, 4],
  [/^\/(blog|news|updates|articles|posts)(\/|$)/, 3],
  [/^\/(integrations|marketplace|plugins|extensions)(\/|$)/, 3],
  [/^\/(security|compliance|trust)(\/|$)/, 3],
  [/^\/(customers|case-studies|testimonials|stories)(\/|$)/, 3],
];

function getUrlPatternScore(pathname: string): number {
  for (const [pattern, score] of URL_PATTERNS) {
    if (pattern.test(pathname)) return score;
  }
  return 2;
}

function getUrlDepth(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}

function isHomepage(pathname: string): boolean {
  return pathname === "/" || pathname === "";
}

export function scoreUrl(url: string): number {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 0;
  }

  let score = 0;

  if (isHomepage(pathname)) {
    score += 20;
  } else {
    score += getUrlPatternScore(pathname);
  }

  const depth = getUrlDepth(pathname);
  score += Math.max(0, 5 - depth);

  return score;
}

export function sortUrlsByScore(urls: string[]): string[] {
  return [...urls].sort((a, b) => scoreUrl(b) - scoreUrl(a));
}
