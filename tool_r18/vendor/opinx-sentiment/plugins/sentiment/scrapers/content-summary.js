import { fetchPublicSource } from "./http.js";

const REQUEST_TIMEOUT_MS = 6500;
const MIN_USEFUL_TEXT_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 360;
const MAX_BODY_EXCERPT_LENGTH = 2400;
const MAX_RAW_HTML_LENGTH = 180000;
const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const WAYBACK_AVAILABILITY_ENDPOINT = "https://archive.org/wayback/available";
const WAYBACK_CDX_ENDPOINT = "https://web.archive.org/cdx";

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&ensp;|&#8194;/g, " ")
    .replace(/&emsp;|&#8195;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaDescription(html) {
  const source = String(html || "");
  const meta = source.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*>/i);
  return stripTags(meta?.[1] || "");
}

function extractMetaContent(html, names = []) {
  const source = String(html || "");
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = source.match(new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"))
      || source.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"));
    if (direct?.[1]) return decodeHtml(direct[1]).trim();
  }
  return "";
}

function extractLinkHref(html, relNames = []) {
  const source = String(html || "");
  for (const rel of relNames) {
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = source.match(new RegExp(`<link[^>]+rel=["'][^"']*${escaped}[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>`, "i"))
      || source.match(new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*${escaped}[^"']*["'][^>]*>`, "i"));
    if (direct?.[1]) return decodeHtml(direct[1]).trim();
  }
  return "";
}

function absoluteUrl(rawUrl = "", baseUrl = "") {
  const decoded = decodeHtml(rawUrl || "").trim();
  if (!decoded || /^(?:javascript|mailto|tel):/i.test(decoded)) return "";
  try {
    return new URL(decoded, baseUrl || undefined).toString();
  } catch {
    return "";
  }
}

function extractArticleMetadata(html, pageUrl = "") {
  const canonicalUrl = extractLinkHref(html, ["canonical"]);
  const ogUrl = extractMetaContent(html, ["og:url"]);
  const imageUrl = extractMetaContent(html, ["og:image", "twitter:image"]);
  const siteName = extractMetaContent(html, ["og:site_name", "application-name"]);
  const social = extractSocialMetadata(html);
  const review = extractReviewMetadata(html);
  const mainContent = extractMainContent(html);
  const engagement = extractEngagementMetrics(html);
  const structuredEntity = extractStructuredEntityMetadata(html, pageUrl);
  const author = extractMetaContent(html, ["author", "article:author", "twitter:creator", "profile:username"]) || social.author;
  const publishedTime = extractMetaContent(html, [
    "article:published_time",
    "article:modified_time",
    "pubdate",
    "date",
    "datePublished",
  ]) || social.publishedTime;
  const keywords = extractMetaContent(html, ["keywords", "news_keywords"]);
  const baseUrl = canonicalUrl || ogUrl || pageUrl || "";
  const reviewFollowupLinks = shouldExtractReviewFollowups(baseUrl, review)
    ? extractReviewFollowupLinks(html, baseUrl)
    : [];
  const structuredFollowupLinks = extractStructuredFollowupLinks(html, baseUrl);
  const propagationFollowupLinks = mergeFollowupLinks(
    extractPropagationFollowupLinks(html, baseUrl),
    structuredFollowupLinks,
  );
  const structuredTypes = flattenJsonLdNodes(parseJsonLdBlocks(html))
    .flatMap(node => jsonLdTypes(node))
    .filter(Boolean);
  return {
    canonicalUrl,
    ogUrl,
    imageUrl,
    siteName,
    author,
    publishedTime,
    keywords,
    social,
    review,
    structuredEntity,
    mainContent,
    engagement,
    propagationFollowupLinks,
    structuredFollowupLinks,
    reviewFollowupLinks,
    jsonLdTypes: [...new Set(structuredTypes)].slice(0, 20),
  };
}

function structuredEntityMetrics(metadata = {}) {
  const structured = metadata.structuredEntity || {};
  return {
    structured_publisher_name: structured.publisherName || "",
    structured_publisher_url: structured.publisherUrl || "",
    structured_section: structured.section || "",
    structured_keywords: structured.keywords || [],
    structured_entity_mentions: structured.entities || [],
    structured_entity_mention_count: structured.entities?.length || 0,
    structured_location: structured.location || "",
    structured_language: structured.language || "",
    structured_modified_time: structured.modifiedTime || "",
    structured_published_time: structured.publishedTime || "",
    has_structured_entity_metadata: Boolean(structured.hasStructuredEntityMetadata),
  };
}

function mergeFollowupLinks(...groups) {
  const seen = new Set();
  return groups.flatMap(group => Array.isArray(group) ? group : [])
    .filter(item => {
      if (!item?.url || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.same_host) - Number(a.same_host) || a.url.localeCompare(b.url))
    .slice(0, 30);
}

function parseJsonLdBlocks(html) {
  const source = String(html || "");
  return [...source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => {
      try {
        return JSON.parse(decodeHtml(match[1]).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function flattenJsonLdNodes(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLdNodes(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  out.push(value);
  if (Array.isArray(value["@graph"])) flattenJsonLdNodes(value["@graph"], out);
  for (const key of ["review", "reviews", "aggregateRating", "itemReviewed", "mainEntity", "author", "publisher"]) {
    if (value[key]) flattenJsonLdNodes(value[key], out);
  }
  return out;
}

function firstJsonLdValue(node, keys = []) {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) {
    for (const item of node) {
      const nested = firstJsonLdValue(item, keys);
      if (nested) return nested;
    }
    return "";
  }
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const nested = firstJsonLdValue(value, keys);
      if (nested) return nested;
    }
    if (value && typeof value === "object") {
      const nested = firstJsonLdValue(value, ["name", "alternateName", "username", "text"]);
      if (nested) return nested;
    }
  }
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "hasPart"]) {
    if (node[key]) {
      const nested = firstJsonLdValue(node[key], keys);
      if (nested) return nested;
    }
  }
  return "";
}

function collectJsonLdStringValues(value, keys = [], out = []) {
  if (!value) return out;
  if (typeof value === "string") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdStringValues(item, keys, out);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key)) {
      const values = Array.isArray(item) ? item : [item];
      for (const candidate of values) {
        if (typeof candidate === "string" && candidate.trim() && !out.includes(candidate.trim())) out.push(candidate.trim());
        else if (candidate && typeof candidate === "object") collectJsonLdStringValues(candidate, ["url", "@id", "identifier", "name"], out);
      }
    }
    if (item && typeof item === "object") collectJsonLdStringValues(item, keys, out);
  }
  return out;
}

function collectJsonLdFollowupReferences(value, path = [], out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdFollowupReferences(item, path, out);
    return out;
  }
  if (typeof value !== "object") return out;
  const push = (rawUrl = "", key = "", label = "") => {
    const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!url || !/^https?:\/\//i.test(url)) return;
    const context = `${key} ${path.join(" ")}`;
    const forceKind = /correction|update|followup/i.test(context)
      ? "timeline-followup"
      : /citation|isBasedOn|source|reference|relatedLink|significantLink|archivedAt/i.test(context)
        ? "source-reference"
        : "";
    out.push({
      url,
      label: label || key || "structured data",
      source: `jsonld:${key || path.at(-1) || "url"}`,
      forceKind,
    });
  };
  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key];
    const interesting = /^(citation|isBasedOn|correctionNotice|correction|relatedLink|significantLink|archivedAt|mentions?|about)$/i.test(key);
    if (interesting) {
      if (typeof item === "string") {
        push(item, key);
      } else if (Array.isArray(item)) {
        for (const child of item) {
          if (typeof child === "string") push(child, key);
          else if (child && typeof child === "object") {
            push(child.url || child["@id"] || child.sameAs || "", key, child.name || child.headline || child.text || key);
            collectJsonLdFollowupReferences(child, nextPath, out);
          }
        }
      } else if (item && typeof item === "object") {
        push(item.url || item["@id"] || item.sameAs || "", key, item.name || item.headline || item.text || key);
        collectJsonLdFollowupReferences(item, nextPath, out);
      }
    } else if (item && typeof item === "object") {
      collectJsonLdFollowupReferences(item, nextPath, out);
    }
  }
  return out;
}

function jsonLdTypes(node = {}) {
  const raw = node?.["@type"] || node?.type || [];
  return (Array.isArray(raw) ? raw : [raw]).map(item => String(item || "").trim()).filter(Boolean);
}

function uniqueTextList(values = [], limit = 12, maxLength = 180) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = stripTags(Array.isArray(value) ? value.join(" ") : value).slice(0, maxLength).trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function jsonLdNamedValue(value) {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return stripTags(String(value)).slice(0, 220);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = jsonLdNamedValue(item);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  return firstJsonLdValue(value, ["name", "alternateName", "headline", "title", "text", "description"]);
}

function jsonLdNamedValues(value, source = "", out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) jsonLdNamedValues(item, source, out);
    return out;
  }
  const label = jsonLdNamedValue(value);
  if (label) out.push({ label, source });
  return out;
}

function jsonLdKeywordList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return uniqueTextList(value.flatMap(item => jsonLdKeywordList(item)), 20, 120);
  if (typeof value === "string") return uniqueTextList(value.split(/[,\n;，、|]+/), 20, 120);
  if (typeof value === "object") return uniqueTextList([jsonLdNamedValue(value)], 20, 120);
  return [];
}

function extractStructuredEntityMetadata(html = "", pageUrl = "") {
  const nodes = flattenJsonLdNodes(parseJsonLdBlocks(html));
  const preferred = nodes.find(node => jsonLdTypes(node).some(type => /NewsArticle|Article|ReportageNewsArticle|BlogPosting|SocialMediaPosting|Review|VideoObject|Report/i.test(type)))
    || nodes[0]
    || {};
  const publisherNode = preferred.publisher || preferred.sourceOrganization || preferred.provider || nodes.find(node => jsonLdTypes(node).some(type => /Organization|NewsMediaOrganization|LocalBusiness|Corporation/i.test(type))) || {};
  const publisherName = jsonLdNamedValue(publisherNode);
  const publisherUrl = absoluteUrl(
    typeof publisherNode === "object" ? publisherNode.url || publisherNode["@id"] || publisherNode.sameAs || "" : "",
    pageUrl,
  );
  const section = jsonLdTextValue(preferred.articleSection || preferred.section || preferred.genre)
    || extractMetaContent(html, ["article:section", "section", "parsely-section"]);
  const keywords = uniqueTextList([
    ...jsonLdKeywordList(preferred.keywords),
    ...jsonLdKeywordList(preferred.about),
    ...jsonLdKeywordList(preferred.mentions),
    ...String(extractMetaContent(html, ["keywords", "news_keywords"]) || "").split(/[,\n;，、|]+/),
  ], 24, 120);
  const entities = [];
  for (const [key, source] of [["about", "about"], ["mentions", "mentions"], ["mainEntity", "mainEntity"], ["itemReviewed", "itemReviewed"]]) {
    jsonLdNamedValues(preferred[key], source, entities);
  }
  const entityList = [];
  const seenEntities = new Set();
  for (const entity of entities) {
    const label = stripTags(entity.label || "").slice(0, 180);
    const key = label.toLowerCase();
    if (!label || seenEntities.has(key)) continue;
    seenEntities.add(key);
    entityList.push({ label, source: entity.source });
    if (entityList.length >= 30) break;
  }
  const locationNode = preferred.contentLocation || preferred.locationCreated || preferred.spatialCoverage || preferred.areaServed || {};
  const location = jsonLdNamedValue(locationNode) || extractMetaContent(html, ["geo.placename", "place:location:latitude", "article:location"]);
  const modifiedTime = firstJsonLdValue(preferred, ["dateModified", "dateUpdated"])
    || extractMetaContent(html, ["article:modified_time", "last-modified", "dateModified"]);
  const publishedTime = firstJsonLdValue(preferred, ["datePublished", "uploadDate", "dateCreated"])
    || extractMetaContent(html, ["article:published_time", "pubdate", "date", "datePublished"]);
  const language = firstJsonLdValue(preferred, ["inLanguage"])
    || extractMetaContent(html, ["og:locale", "language", "content-language"]);
  return {
    publisherName,
    publisherUrl,
    section: stripTags(section).slice(0, 180),
    keywords,
    entities: entityList,
    location: stripTags(location).slice(0, 180),
    modifiedTime: stripTags(modifiedTime).slice(0, 120),
    publishedTime: stripTags(publishedTime).slice(0, 120),
    language: stripTags(language).slice(0, 80),
    hasStructuredEntityMetadata: Boolean(publisherName || section || keywords.length || entityList.length || location || modifiedTime || language),
  };
}

function jsonLdTextValue(value) {
  if (!value) return "";
  if (typeof value === "string") return stripTags(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.map(item => jsonLdTextValue(item)).filter(Boolean).join(" ");
  }
  if (typeof value !== "object") return "";
  const preferred = ["articleBody", "reviewBody", "text", "description", "caption", "abstract"];
  const parts = [];
  for (const key of preferred) {
    const text = jsonLdTextValue(value[key]);
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(" ");
}

function extractStructuredArticleBody(html = "") {
  const nodes = flattenJsonLdNodes(parseJsonLdBlocks(html));
  const candidates = [];
  for (const node of nodes) {
    const types = jsonLdTypes(node);
    const body = [
      jsonLdTextValue(node.articleBody),
      jsonLdTextValue(node.reviewBody),
      jsonLdTextValue(node.text),
      jsonLdTextValue(node.description),
      jsonLdTextValue(node.caption),
      jsonLdTextValue(node.abstract),
    ].filter(Boolean).join(" ");
    const text = stripTags(body).replace(/\s+/g, " ").trim();
    if (text.length < 40) continue;
    const headline = firstJsonLdValue(node, ["headline", "name"]);
    const section = jsonLdTextValue(node.articleSection);
    const keywords = jsonLdTextValue(node.keywords);
    const context = [headline, section, text, keywords].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const paragraphCount = Math.max(1, Math.min(12, (text.match(/[。！？.!?]\s+/g) || []).length + 1));
    const typeBonus = types.some(type => /NewsArticle|Article|BlogPosting|Report|SocialMediaPosting|Review|Comment/i.test(type)) ? 16 : 6;
    const score = Math.max(0, Math.min(100,
      Math.floor(text.length / 28)
      + Math.min(18, paragraphCount * 3)
      + typeBonus
    ));
    candidates.push({
      selector: "jsonld-article-body",
      text: context,
      paragraphs: [text],
      paragraphCount,
      linkCount: 0,
      score,
      jsonLdTypes: types,
    });
  }
  return candidates
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0] || null;
}

function extractBalancedJsonLiteral(source = "", startIndex = 0) {
  const text = String(source || "");
  let start = Math.max(0, Number(startIndex) || 0);
  while (start < text.length && /\s/.test(text[start])) start += 1;
  const opener = text[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return "";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === opener) depth += 1;
    if (ch === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function extractEmbeddedStatePayloads(html = "", limit = 8) {
  const out = [];
  const pushLiteral = (literal = "") => {
    if (!literal || out.length >= limit) return;
    try {
      out.push(JSON.parse(decodeHtml(literal).trim()));
    } catch {
      // Ignore malformed or non-JSON JavaScript literals.
    }
  };
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(String(html || ""))) !== null && out.length < limit) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const type = (attrs.match(/\btype=["']([^"']+)["']/i) || [])[1] || "";
    const id = (attrs.match(/\bid=["']([^"']+)["']/i) || [])[1] || "";
    if (/application\/ld\+json/i.test(type)) continue;
    const text = decodeHtml(body).trim();
    const knownJsonScript = /(?:application\/json|application\/x-json|text\/json)/i.test(type) || /^(?:__NEXT_DATA__|__NUXT_DATA__|__APOLLO_STATE__|__RELAY_STORE__)$/i.test(id);
    if (knownJsonScript && /^\s*[\[{]/.test(text)) pushLiteral(text);
    const knownStatePattern = /(?:window\.|self\.|globalThis\.)?(?:__INITIAL_STATE__|__NUXT__|__APOLLO_STATE__|__NEXT_DATA__|__RELAY_STORE__|__PRELOADED_STATE__|INITIAL_STATE|NUXT_DATA|APOLLO_STATE)\s*=\s*/gi;
    let stateMatch;
    while ((stateMatch = knownStatePattern.exec(text)) !== null && out.length < limit) {
      pushLiteral(extractBalancedJsonLiteral(text, stateMatch.index + stateMatch[0].length));
    }
  }
  return out.slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
}

function embeddedStateTextValue(value) {
  if (!value) return "";
  if (typeof value === "string") return stripTags(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(item => embeddedStateTextValue(item)).filter(Boolean).join(" ");
  if (typeof value !== "object") return "";
  const preferred = ["articleBody", "body", "content", "contentText", "content_text", "contentHtml", "content_html", "description", "summary", "excerpt", "dek", "subtitle", "lead", "text", "paragraph", "paragraphs", "blocks"];
  const parts = [];
  for (const key of preferred) {
    const text = embeddedStateTextValue(value[key]);
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(" ");
}

function extractEmbeddedStateArticleBody(html = "") {
  const payloads = extractEmbeddedStatePayloads(html);
  const candidates = [];
  let visited = 0;
  const visit = (value) => {
    if (!value || visited > 2500) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const title = embeddedStateTextValue(value.title || value.headline || value.name || "");
    const body = embeddedStateTextValue(value);
    const tags = embeddedStateTextValue(value.keywords || value.tags || value.categories || value.articleSection || "");
    const text = stripTags([title, body, tags].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
    const bodyOnly = stripTags(body).replace(/\s+/g, " ").trim();
    const hasArticleKey = Object.keys(value).some(key => /articleBody|body|content|contentText|content_text|contentHtml|content_html|paragraphs?|blocks?|summary|excerpt|dek|subtitle|lead|description|text/i.test(key));
    if (hasArticleKey && bodyOnly.length >= 80 && text.length >= 100) {
      const paragraphCount = Math.max(1, Math.min(12, (bodyOnly.match(/[。！？.!?]\s+/g) || []).length + 1));
      const score = Math.max(0, Math.min(100,
        Math.floor(bodyOnly.length / 26)
        + Math.min(18, paragraphCount * 3)
        + (title ? 10 : 0)
        + (tags ? 4 : 0)
      ));
      candidates.push({
        selector: "embedded-state-article-body",
        text,
        paragraphs: [bodyOnly],
        paragraphCount,
        linkCount: 0,
        score,
      });
    }
    for (const item of Object.values(value)) {
      if (item && typeof item === "object") visit(item);
    }
  };
  for (const payload of payloads) visit(payload);
  return candidates
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0] || null;
}

function numberFromValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function firstNumericJsonLdValue(node, keys = []) {
  if (!node || typeof node !== "object") return 0;
  for (const key of keys) {
    const value = node[key];
    const numeric = numberFromValue(value);
    if (numeric) return numeric;
    if (value && typeof value === "object") {
      const nested = firstNumericJsonLdValue(value, ["ratingValue", "ratingCount", "reviewCount", "bestRating", "worstRating", "value"]);
      if (nested) return nested;
    }
  }
  return 0;
}

function interactionMetricKind(interactionType = "") {
  const text = String(interactionType || "").toLowerCase();
  if (/comment|reply|discuss/.test(text)) return "comment_count";
  if (/share|repost|send/.test(text)) return "share_count";
  if (/like|agree|endorse|upvote|favorite|favourite|recommend|react/.test(text)) return "like_count";
  if (/watch|view|read|listen|play/.test(text)) return "view_count";
  return "";
}

function extractStructuredEngagementMetrics(html = "") {
  const nodes = flattenJsonLdNodes(parseJsonLdBlocks(html));
  const metrics = {
    comment_count: 0,
    share_count: 0,
    like_count: 0,
    view_count: 0,
  };
  for (const node of nodes) {
    metrics.comment_count = Math.max(metrics.comment_count, firstNumericJsonLdValue(node, ["commentCount", "comments", "replyCount", "discussionCount"]));
    metrics.share_count = Math.max(metrics.share_count, firstNumericJsonLdValue(node, ["shareCount", "shares", "repostCount"]));
    metrics.like_count = Math.max(metrics.like_count, firstNumericJsonLdValue(node, ["likeCount", "likes", "upvoteCount", "reactionCount", "favoriteCount"]));
    metrics.view_count = Math.max(metrics.view_count, firstNumericJsonLdValue(node, ["viewCount", "views", "readCount", "watchCount", "playCount"]));
    const stats = node.interactionStatistic || node.interactionStatistics || node.interactionStats || [];
    for (const stat of (Array.isArray(stats) ? stats : [stats])) {
      if (!stat || typeof stat !== "object") continue;
      const kind = interactionMetricKind(stat.interactionType || stat["@type"] || stat.name || stat.actionType || "");
      if (!kind) continue;
      metrics[kind] = Math.max(metrics[kind], numberFromValue(stat.userInteractionCount ?? stat.interactionCount ?? stat.count ?? stat.value));
    }
  }
  return {
    ...metrics,
    structured_engagement_signal: Object.values(metrics).some(value => Number(value || 0) > 0),
  };
}

function htmlAttributeValue(tag = "", names = []) {
  for (const name of names) {
    const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(tag || "").match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
    if (match?.[2]) return decodeHtml(match[2]).trim();
  }
  return "";
}

function metaEngagementKind(name = "") {
  const text = String(name || "").toLowerCase().replace(/[_-]+/g, ":");
  if (!/(count|total|number|interaction|metric|share|comment|reply|like|reaction|favorite|favourite|view|read|play|watch|repost)/i.test(text)) return "";
  if (/comment|reply|discussion|留言|評論|评论/.test(text)) return "comment_count";
  if (/share|repost|retweet|forward|轉發|转发|分享/.test(text)) return "share_count";
  if (/like|upvote|favorite|favourite|reaction|recommend|agree|点赞|點讚|讚|赞/.test(text)) return "like_count";
  if (/view|read|play|watch|impression|visit|瀏覽|浏览|閱讀|阅读|播放/.test(text)) return "view_count";
  return "";
}

function extractMetaEngagementMetrics(html = "") {
  const metrics = {
    comment_count: 0,
    share_count: 0,
    like_count: 0,
    view_count: 0,
  };
  const source = String(html || "");
  const metaRegex = /<meta\b[^>]*>/gi;
  let match;
  while ((match = metaRegex.exec(source)) !== null) {
    const tag = match[0];
    const key = htmlAttributeValue(tag, ["property", "name", "itemprop"]);
    const content = htmlAttributeValue(tag, ["content", "value"]);
    const kind = metaEngagementKind(key);
    if (!kind || !content) continue;
    metrics[kind] = Math.max(metrics[kind], parseCompactNumber(content));
  }
  return {
    ...metrics,
    meta_engagement_signal: Object.values(metrics).some(value => Number(value || 0) > 0),
  };
}

function extractReviewMetadata(html) {
  const blocks = parseJsonLdBlocks(html);
  const nodes = flattenJsonLdNodes(blocks);
  const reviewNodes = nodes.filter(node => jsonLdTypes(node).some(type => /Review|UserReview/i.test(type)));
  const aggregateNodes = nodes.filter(node => jsonLdTypes(node).some(type => /AggregateRating/i.test(type)));
  const review = reviewNodes[0] || {};
  const aggregate = aggregateNodes[0] || {};
  const reviewRating = review.reviewRating || review.rating || {};
  const aggregateRating = aggregate.ratingValue ? aggregate : (review.aggregateRating || {});
  const rating = firstNumericJsonLdValue(reviewRating, ["ratingValue", "value"])
    || firstNumericJsonLdValue(review, ["ratingValue", "rating"])
    || firstNumericJsonLdValue(aggregateRating, ["ratingValue", "value"]);
  const text = firstJsonLdValue(review, ["reviewBody", "description", "text"]);
  return {
    hasReview: reviewNodes.length > 0 || Boolean(rating || aggregateRating.ratingCount || aggregateRating.reviewCount),
    rating,
    bestRating: firstNumericJsonLdValue(reviewRating, ["bestRating"]) || firstNumericJsonLdValue(aggregateRating, ["bestRating"]),
    worstRating: firstNumericJsonLdValue(reviewRating, ["worstRating"]) || firstNumericJsonLdValue(aggregateRating, ["worstRating"]),
    ratingCount: firstNumericJsonLdValue(aggregateRating, ["ratingCount"]),
    reviewCount: firstNumericJsonLdValue(aggregateRating, ["reviewCount"]),
    text,
    author: firstJsonLdValue(review, ["author", "creator", "name"]),
    publishedTime: firstJsonLdValue(review, ["datePublished", "dateCreated", "dateModified"]),
    itemReviewed: firstJsonLdValue(review.itemReviewed || {}, ["name", "alternateName"])
      || firstJsonLdValue(nodes.find(node => jsonLdTypes(node).some(type => /Product|SoftwareApplication|Organization|LocalBusiness/i.test(type))) || {}, ["name", "headline"]),
    jsonLdReviewCount: reviewNodes.length,
    jsonLdAggregateRatingCount: aggregateNodes.length,
  };
}

function shouldExtractReviewFollowups(baseUrl = "", review = {}) {
  if (review?.hasReview) return true;
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (/(trustpilot|bbb\.org|sitejabber|complaintsboard|pissedconsumer|productreview|consumeraffairs|reviews\.io|mouthshut|hellopeter|reclameaqui|apestan|consumidor\.gov\.br|signal\.conso\.gouv\.fr|verbraucherzentrale|ocu\.org|g2\.com|capterra|trustradius|getapp|softwareadvice|sourceforge|alternativeto|appsumo|glassdoor|indeed|kununu|comparably|ambitionbox|teamblind|yelp|tripadvisor|google|foursquare|opentable|trustanalytica|yellowpages|restaurantguru)/i.test(host)) return true;
    return /\/(?:review|reviews|ratings?|complaints?|testimonials?)\b/i.test(path);
  } catch {
    return false;
  }
}

function reviewFollowupKind(url = "", label = "") {
  const text = `${url} ${label}`.toLowerCase();
  if (/page=\d+|p=\d+|sort=|filter=|pagination|next|下一頁|下一页/.test(text)) return "review-pagination";
  if (/comment|comments|discussion|reply|replies|qa|questions|answers|留言|評論|评论|回覆|回复/.test(text)) return "review-comments";
  if (/review|reviews|rating|ratings|testimonial|complaint|complaints|評價|评价|投訴|投诉/.test(text)) return "review-page";
  if (/product|company|business|store|seller|profile|brand|產品|产品|商家|店家|品牌/.test(text)) return "review-profile";
  return "";
}

function extractReviewFollowupLinks(html = "", baseUrl = "", maxLinks = 12) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const push = (url, label = "", source = "html-link") => {
    const absolute = absoluteUrl(url, baseUrl);
    if (!absolute || seen.has(absolute)) return;
    let parsed;
    let base;
    try {
      parsed = new URL(absolute);
      base = baseUrl ? new URL(baseUrl) : null;
    } catch {
      return;
    }
    if (base && absolute.replace(/#.*$/, "") === base.toString().replace(/#.*$/, "")) return;
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi)$/i.test(parsed.pathname)) return;
    if (/\/(?:login|signup|register|privacy|terms|cookie|cart|checkout)(?:\/|$)/i.test(parsed.pathname)) return;
    const sameHost = base?.hostname && parsed.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
    const kind = reviewFollowupKind(absolute, label);
    if (!kind && !sameHost) return;
    let score = sameHost ? 42 : 30;
    const reasons = [];
    if (sameHost) reasons.push("same-review-host");
    if (kind) {
      reasons.push(kind);
      score += kind === "review-comments" ? 18 : kind === "review-page" ? 16 : kind === "review-pagination" ? 12 : 10;
    }
    if (/next|more|all|see|read|全部|更多|下一頁|下一页/i.test(label)) {
      reasons.push("review-navigation");
      score += 8;
    }
    seen.add(absolute);
    out.push({
      url: absolute,
      label: stripTags(label || absolute).slice(0, 180),
      kind: "article-followup",
      review_followup_kind: kind || "same-host-related",
      score: Math.max(0, Math.min(100, Math.round(score))),
      reasons,
      same_host: Boolean(sameHost),
    });
  };
  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null) {
    const tag = match[0];
    const rel = (tag.match(/\brel=["']([^"']+)["']/i) || [])[1] || "";
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "";
    if (/next|prev|canonical/i.test(rel)) push(href, rel, `rel-${rel}`);
  }
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = anchorRegex.exec(source)) !== null) {
    push(match[1] || "", match[2] || "", "anchor");
  }
  return out
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.same_host) - Number(a.same_host) || a.url.localeCompare(b.url))
    .slice(0, Math.max(1, Math.min(30, Number(maxLinks) || 12)));
}

function extractSocialMetadata(html) {
  const ogTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
  const ogDescription = extractMetaContent(html, ["og:description", "twitter:description"]);
  const creator = extractMetaContent(html, ["twitter:creator", "profile:username", "instapp:owner_user_id"]);
  const jsonLd = parseJsonLdBlocks(html);
  const author = creator || firstJsonLdValue(jsonLd, ["author", "creator", "accountablePerson"]);
  const text = firstJsonLdValue(jsonLd, ["articleBody", "caption", "text", "description"]) || ogDescription;
  const publishedTime = firstJsonLdValue(jsonLd, ["datePublished", "uploadDate", "dateCreated"]);
  return {
    title: ogTitle,
    description: ogDescription,
    author,
    text,
    publishedTime,
    jsonLdCount: jsonLd.length,
  };
}

function extractParagraphText(html) {
  const source = String(html || "")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  const paragraphs = [...source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => stripTags(match[1]))
    .filter(text => text.length >= 18);
  if (paragraphs.length) return paragraphs.slice(0, 4).join(" ");
  return stripTags(source).slice(0, 1000);
}

function extractBlockCandidates(html = "") {
  const source = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  const candidates = [];
  const pushMatches = (regex, selector) => {
    let match;
    while ((match = regex.exec(source)) !== null) {
      candidates.push({ selector, html: match[0], inner: match[1] || match[0] });
    }
  };
  pushMatches(/<article\b[^>]*>([\s\S]*?)<\/article>/gi, "article");
  pushMatches(/<main\b[^>]*>([\s\S]*?)<\/main>/gi, "main");
  pushMatches(/<section\b[^>]*(?:article|content|post|story|entry|正文|內容|内容)[^>]*>([\s\S]*?)<\/section>/gi, "section-content");
  pushMatches(/<div\b[^>]*(?:article|content|post|story|entry|body|正文|內容|内容)[^>]*>([\s\S]*?)<\/div>/gi, "div-content");
  if (!candidates.length) candidates.push({ selector: "body", html: source, inner: source });
  return candidates;
}

function extractMainContent(html = "") {
  const structured = extractStructuredArticleBody(html);
  const embeddedState = extractEmbeddedStateArticleBody(html);
  const candidates = extractBlockCandidates(html).map(candidate => {
    const paragraphs = [...String(candidate.inner || "").matchAll(/<(?:p|li|blockquote)\b[^>]*>([\s\S]*?)<\/(?:p|li|blockquote)>/gi)]
      .map(match => stripTags(match[1]))
      .filter(text => text.length >= 12 && !/cookie|privacy policy|版权所有|版權所有|登录|註冊|注册/i.test(text));
    const headingText = [...String(candidate.inner || "").matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
      .map(match => stripTags(match[1]))
      .filter(text => text.length >= 4)
      .slice(0, 3);
    const text = [...headingText, ...paragraphs].join(" ").replace(/\s+/g, " ").trim() || stripTags(candidate.inner);
    const linkCount = (String(candidate.inner || "").match(/<a\b/gi) || []).length;
    const paragraphCount = paragraphs.length;
    const score = Math.min(70, Math.floor(text.length / 30))
      + Math.min(18, paragraphCount * 3)
      + (/article|main/.test(candidate.selector) ? 12 : 0)
      - Math.min(20, linkCount);
    return {
      selector: candidate.selector,
      text,
      paragraphs: paragraphs.slice(0, 12),
      paragraphCount,
      linkCount,
      score: Math.max(0, Math.min(100, score)),
    };
  }).filter(candidate => candidate.text.length >= 40);
  const best = candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0];
  const structuredBest = [structured, embeddedState]
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0] || null;
  if (structuredBest && (!best || best.text.length < 160 || structuredBest.score >= best.score + 8 || structuredBest.text.length > best.text.length * 1.25)) {
    return {
      text: structuredBest.text,
      excerpt: compactText(structuredBest.text, MAX_BODY_EXCERPT_LENGTH),
      selector: structuredBest.selector,
      paragraphCount: structuredBest.paragraphCount,
      linkCount: structuredBest.linkCount,
      qualityScore: structuredBest.score,
      jsonLdTypes: structuredBest.jsonLdTypes || [],
    };
  }
  if (!best) return {
    text: extractParagraphText(html),
    excerpt: compactText(extractParagraphText(html), MAX_BODY_EXCERPT_LENGTH),
    selector: "",
    paragraphCount: 0,
    linkCount: 0,
    qualityScore: 0,
  };
  return {
    text: best.text,
    excerpt: compactText(best.text, MAX_BODY_EXCERPT_LENGTH),
    selector: best.selector,
    paragraphCount: best.paragraphCount,
    linkCount: best.linkCount,
    qualityScore: best.score,
  };
}

function parseCompactNumber(value = "") {
  const source = decodeHtml(String(value || "")).replace(/,/g, "").trim();
  const match = source.match(/(\d+(?:\.\d+)?)\s*(萬|万|億|亿|k|m)?/i);
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const unit = String(match[2] || "").toLowerCase();
  if (unit === "萬" || unit === "万") return Math.round(base * 10000);
  if (unit === "億" || unit === "亿") return Math.round(base * 100000000);
  if (unit === "k") return Math.round(base * 1000);
  if (unit === "m") return Math.round(base * 1000000);
  return Math.round(base);
}

function maxMetricValue(text = "", patterns = []) {
  let max = 0;
  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    while ((match = regex.exec(text)) !== null) {
      max = Math.max(max, parseCompactNumber(match[1] || match[2] || ""));
    }
  }
  return max;
}

function extractEngagementMetrics(html = "") {
  const text = stripTags(html);
  const raw = decodeHtml(String(html || ""));
  const combined = `${raw} ${text}`;
  const structured = extractStructuredEngagementMetrics(html);
  const meta = extractMetaEngagementMetrics(html);
  const metrics = {
    comment_count: Math.max(structured.comment_count, meta.comment_count, maxMetricValue(combined, [
      /(?:commentCount|comments?|評論|评论|留言|跟帖)[^0-9萬万億亿kKmM]{0,20}(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)/gi,
      /(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)\s*(?:comments?|評論|评论|留言|跟帖)/gi,
    ])),
    share_count: Math.max(structured.share_count, meta.share_count, maxMetricValue(combined, [
      /(?:shareCount|shares?|reposts?|转发|轉發|分享)[^0-9萬万億亿kKmM]{0,20}(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)/gi,
      /(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)\s*(?:shares?|reposts?|转发|轉發|分享)/gi,
    ])),
    like_count: Math.max(structured.like_count, meta.like_count, maxMetricValue(combined, [
      /(?:likeCount|likes?|点赞|點讚|赞|讚)[^0-9萬万億亿kKmM]{0,20}(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)/gi,
      /(\d+(?:\.\d+)?\s*(?:k|m)?)\s*likes?/gi,
    ])),
    view_count: Math.max(structured.view_count, meta.view_count, maxMetricValue(combined, [
      /(?:viewCount|views?|阅读|閱讀|浏览|瀏覽|播放)[^0-9萬万億亿kKmM]{0,20}(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)/gi,
      /(\d+(?:\.\d+)?\s*(?:萬|万|億|亿|k|m)?)\s*(?:views?|阅读|閱讀|浏览|瀏覽|播放)/gi,
    ])),
  };
  return {
    ...metrics,
    structured_engagement_signal: Boolean(structured.structured_engagement_signal),
    meta_engagement_signal: Boolean(meta.meta_engagement_signal),
    has_engagement_signal: Object.values(metrics).some(value => Number(value || 0) > 0),
  };
}

function propagationFollowupKind(url = "", label = "") {
  const text = `${url} ${stripTags(label)}`.toLowerCase();
  if (/(weibo|xhslink|xiaohongshu|douyin|kuaishou|bilibili|youtube|twitter|x\.com|threads|reddit|facebook|instagram|telegram|t\.me|ptt|dcard|tieba|zhihu)|\/(?:post|posts|status|statuses|video|watch|thread)\b/i.test(text)) return "social-amplification";
  if (/rss|atom|feed|xml|jsonfeed|訂閱|订阅|subscribe/.test(text)) return "feed-followup";
  if (/amphtml|\bamp\b|mobile|m\.|行動版|行动版|手機版|手机版/.test(text)) return "alternate-page";
  if (/webmention|pingback|trackback|mention-endpoint|xmlrpc|xml-rpc/.test(text)) return "mention-endpoint";
  if (/comment|comments|discussion|reply|replies|留言|評論|评论|回覆|回复|跟帖/.test(text)) return "discussion";
  if (/source|original|原文|來源|来源|首发|首發|引用|quote|via|转载|轉載/.test(text)) return "source-reference";
  if (/timeline|update|followup|follow-up|後續|后续|進展|进展|回应|回應|声明|聲明/.test(text)) return "timeline-followup";
  return "";
}

function structuredFollowupScore(kind = "", sameHost = false) {
  const base = sameHost ? 44 : 32;
  const bonus = kind === "social-amplification" ? 22
    : kind === "source-reference" ? 18
      : kind === "timeline-followup" ? 16
        : kind === "feed-followup" ? 15
          : kind === "alternate-page" ? 12
            : kind === "mention-endpoint" ? 14
              : kind === "discussion" ? 12
              : 8;
  return Math.max(0, Math.min(100, base + bonus));
}

function pushPropagationFollowup(out, seen, { rawUrl = "", label = "", baseUrl = "", source = "anchor", forceKind = "" } = {}) {
  const absolute = absoluteUrl(rawUrl || "", baseUrl);
  if (!absolute || seen.has(absolute)) return;
  let parsed;
  let base;
  try {
    parsed = new URL(absolute);
    base = new URL(baseUrl);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return;
  if (absolute.replace(/#.*$/, "") === base.toString().replace(/#.*$/, "")) return;
  if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|rar|7z|mp3|mp4|mov|avi)$/i.test(parsed.pathname)) return;
  const cleanLabel = stripTags(label || absolute).slice(0, 180);
  const kind = forceKind || propagationFollowupKind(absolute, cleanLabel);
  if (!kind) return;
  const sameHost = parsed.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
  const score = structuredFollowupScore(kind, sameHost);
  seen.add(absolute);
  out.push({
    url: absolute,
    label: cleanLabel,
    kind: "propagation-followup",
    propagation_followup_kind: kind,
    score,
    same_host: sameHost,
    source,
    reasons: [kind, sameHost ? "same-host" : "cross-host", source],
  });
}

function extractStructuredFollowupLinks(html = "", baseUrl = "", maxLinks = 20) {
  if (!baseUrl) return [];
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null) {
    const tag = match[0];
    const rel = (tag.match(/\brel=["']([^"']+)["']/i) || [])[1] || "";
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "";
    const type = (tag.match(/\btype=["']([^"']+)["']/i) || [])[1] || "";
    const title = (tag.match(/\btitle=["']([^"']+)["']/i) || [])[1] || rel || type;
    if (!href) continue;
    const relText = `${rel} ${type} ${title}`.toLowerCase();
    const forceKind = /webmention|pingback|trackback|mention-endpoint/.test(relText)
      ? "mention-endpoint"
      : /comments?|repl(?:y|ies)|discussion/.test(relText)
        ? "discussion"
        : /canonical|syndication[-\s]?source|original[-\s]?source|cite-as|citation|source|bookmark|related/.test(relText)
          ? "source-reference"
        : /rss|atom|feed|xml|json/.test(relText)
      ? "feed-followup"
      : /amphtml/.test(relText)
        ? "alternate-page"
        : "";
    if (/alternate|amphtml|canonical|syndication[-\s]?source|original[-\s]?source|cite-as|feed|next|prev|related|citation|source|bookmark|webmention|pingback|trackback|comments?|repl(?:y|ies)|discussion/i.test(relText)) {
      pushPropagationFollowup(out, seen, { rawUrl: href, label: title || rel, baseUrl, source: `link-rel:${rel || type}`, forceKind });
    }
  }
  const jsonLd = parseJsonLdBlocks(source);
  const nodes = flattenJsonLdNodes(jsonLd);
  for (const ref of collectJsonLdFollowupReferences(nodes).slice(0, 60)) {
    pushPropagationFollowup(out, seen, {
      rawUrl: ref.url,
      label: ref.label || "structured data",
      baseUrl,
      source: ref.source || "jsonld",
      forceKind: ref.forceKind || "",
    });
  }
  const jsonLdUrls = collectJsonLdStringValues(nodes, ["sameAs", "discussionUrl", "commentUrl", "url", "isPartOf", "mainEntityOfPage"], []);
  for (const url of jsonLdUrls.slice(0, 40)) {
    pushPropagationFollowup(out, seen, { rawUrl: url, label: "structured data", baseUrl, source: "jsonld" });
  }
  return out
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.same_host) - Number(a.same_host) || a.url.localeCompare(b.url))
    .slice(0, Math.max(1, Math.min(30, Number(maxLinks) || 12)));
}

function extractPropagationFollowupLinks(html = "", baseUrl = "", maxLinks = 12) {
  if (!baseUrl) return [];
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(source)) !== null) {
    const label = stripTags(match[2] || match[1] || "").slice(0, 180);
    pushPropagationFollowup(out, seen, { rawUrl: match[1] || "", label, baseUrl, source: "anchor" });
  }
  return out
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.url.localeCompare(b.url))
    .slice(0, Math.max(1, Math.min(30, Number(maxLinks) || 12)));
}

function compactText(text, max = MAX_SUMMARY_LENGTH) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}…`;
}

function chooseSummary({ title = "", currentContent = "", html = "" }) {
  const meta = extractMetaDescription(html);
  const article = extractMainContent(html).text || extractParagraphText(html);
  const social = extractSocialMetadata(html);
  const review = extractReviewMetadata(html);
  const candidates = [review.text, article, social.text, meta, social.title, currentContent, title].filter(Boolean);
  const selected = candidates.find(text => text.length >= MIN_USEFUL_TEXT_LENGTH) || candidates[0] || "";
  return compactText(selected);
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildWaybackAvailabilityUrl(pageUrl = "") {
  if (!isHttpUrl(pageUrl)) return "";
  const params = new URLSearchParams({ url: pageUrl });
  return `${WAYBACK_AVAILABILITY_ENDPOINT}?${params.toString()}`;
}

function buildWaybackCdxUrl(pageUrl = "") {
  if (!isHttpUrl(pageUrl)) return "";
  const params = new URLSearchParams({
    url: pageUrl,
    output: "json",
    fl: "timestamp,original,statuscode,mimetype,digest",
    filter: "statuscode:200",
    collapse: "digest",
    sort: "reverse",
    limit: "3",
  });
  params.append("filter", "mimetype:text/html");
  return `${WAYBACK_CDX_ENDPOINT}?${params.toString()}`;
}

function extractWaybackClosestSnapshot(payload = {}) {
  const closest = payload?.archived_snapshots?.closest;
  if (!closest || closest.available === false || !closest.url) return null;
  return {
    url: String(closest.url || ""),
    timestamp: String(closest.timestamp || ""),
    status: String(closest.status || ""),
    discovery_source: "availability",
  };
}

function extractWaybackCdxSnapshot(payload = []) {
  const rows = Array.isArray(payload) ? payload : [];
  if (rows.length < 2) return null;
  const header = Array.isArray(rows[0]) ? rows[0].map(item => String(item || "")) : [];
  const index = (name, fallback) => {
    const idx = header.indexOf(name);
    return idx >= 0 ? idx : fallback;
  };
  const timestampIndex = index("timestamp", 0);
  const originalIndex = index("original", 1);
  const statusIndex = index("statuscode", 2);
  const mimetypeIndex = index("mimetype", 3);
  const digestIndex = index("digest", 4);
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row)) continue;
    const timestamp = String(row[timestampIndex] || "");
    const original = String(row[originalIndex] || "");
    const status = String(row[statusIndex] || "");
    const mimetype = String(row[mimetypeIndex] || "");
    if (!timestamp || !original || (status && status !== "200")) continue;
    if (mimetype && !/text\/html|html/i.test(mimetype)) continue;
    return {
      url: `https://web.archive.org/web/${timestamp}/${original}`,
      timestamp,
      status: status || "200",
      mimetype,
      digest: String(row[digestIndex] || ""),
      discovery_source: "cdx",
    };
  }
  return null;
}

function normalizeWaybackSnapshotUrl(snapshotUrl = "", originalUrl = "") {
  const raw = String(snapshotUrl || "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.hostname !== "web.archive.org") return raw;
    const match = parsed.pathname.match(/^\/web\/(\d{6,14})(?:[a-z_]+)?\/(.*)$/i);
    if (!match) return raw;
    const original = match[2] || originalUrl || "";
    return `https://web.archive.org/web/${match[1]}id_/${original}`;
  } catch {
    return raw;
  }
}

function archivedEvidencePayload({ item = {}, fallback = "", html = "", snapshot = {}, snapshotUrl = "", originalStatus = 0 } = {}) {
  const summary = chooseSummary({ title: item.title, currentContent: fallback, html });
  const metadata = extractArticleMetadata(html, item.url);
  return {
    content: summary || fallback,
    ai_summary: summary || fallback,
    author: metadata.author,
    published_at: metadata.publishedTime,
    enriched: !!summary && summary !== fallback,
    archive_enriched: true,
    http: {
      status: 200,
      original_status: originalStatus,
      wayback_snapshot: true,
      wayback_snapshot_status: snapshot.status || "",
      wayback_timestamp: snapshot.timestamp || "",
    },
    raw_html: html.slice(0, MAX_RAW_HTML_LENGTH),
    evidence: {
      evidence_type: "article_archive_snapshot",
      image_url: metadata.imageUrl,
      site_name: metadata.siteName,
      canonical_url: metadata.canonicalUrl,
      og_url: metadata.ogUrl,
      author: metadata.author,
      published_time: metadata.publishedTime,
      keywords: metadata.keywords,
      metrics: {
        site_name: metadata.siteName,
        canonical_url: metadata.canonicalUrl,
        og_url: metadata.ogUrl,
        author: metadata.author,
        published_time: metadata.publishedTime,
        modified_time: metadata.structuredEntity?.modifiedTime || "",
        article_section: metadata.structuredEntity?.section || "",
        keywords: metadata.keywords,
        archive_source: "wayback",
        wayback_discovery_source: snapshot.discovery_source || "",
        wayback_original_url: item.url || "",
        wayback_availability_url: buildWaybackAvailabilityUrl(item.url || ""),
        wayback_cdx_url: buildWaybackCdxUrl(item.url || ""),
        wayback_snapshot_url: snapshotUrl || snapshot.url || "",
        wayback_timestamp: snapshot.timestamp || "",
        wayback_snapshot_status: snapshot.status || "",
        wayback_original_http_status: originalStatus,
        article_body_quality_score: metadata.mainContent?.qualityScore || 0,
        article_body_text_length: metadata.mainContent?.text?.length || 0,
        article_body_paragraph_count: metadata.mainContent?.paragraphCount || 0,
        article_body_link_count: metadata.mainContent?.linkCount || 0,
        article_body_selector: metadata.mainContent?.selector || "",
        article_body_excerpt: metadata.mainContent?.excerpt || "",
        jsonld_types: metadata.jsonLdTypes || [],
        ...structuredEntityMetrics(metadata),
        engagement_comment_count: metadata.engagement?.comment_count || 0,
        engagement_share_count: metadata.engagement?.share_count || 0,
        engagement_like_count: metadata.engagement?.like_count || 0,
        engagement_view_count: metadata.engagement?.view_count || 0,
        structured_engagement_signal: Boolean(metadata.engagement?.structured_engagement_signal),
        meta_engagement_signal: Boolean(metadata.engagement?.meta_engagement_signal),
        has_engagement_signal: Boolean(metadata.engagement?.has_engagement_signal),
        structured_followup_link_count: metadata.structuredFollowupLinks?.length || 0,
        structured_followup_links: metadata.structuredFollowupLinks || [],
        propagation_followup_link_count: metadata.propagationFollowupLinks?.length || 0,
        propagation_followup_links: metadata.propagationFollowupLinks || [],
        has_image: Boolean(metadata.imageUrl),
      },
    },
    visual_assets: metadata.imageUrl ? [{
      image_url: metadata.imageUrl,
      asset_type: "article_image",
      scene_tags: metadata.siteName ? [metadata.siteName] : [],
    }] : [],
  };
}

async function enrichFromWaybackSnapshot(item, { proxyUrl = "", fallback = "", originalStatus = 0 } = {}) {
  const availabilityUrl = buildWaybackAvailabilityUrl(item?.url || "");
  if (!availabilityUrl) return null;
  const availabilityRes = await fetchPublicSource(availabilityUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, proxyUrl);
  let snapshot = availabilityRes.ok
    ? extractWaybackClosestSnapshot(await availabilityRes.json().catch(() => ({})))
    : null;
  if (!snapshot?.url) {
    const cdxUrl = buildWaybackCdxUrl(item?.url || "");
    if (!cdxUrl) return null;
    const cdxRes = await fetchPublicSource(cdxUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!cdxRes.ok) return null;
    snapshot = extractWaybackCdxSnapshot(await cdxRes.json().catch(() => []));
  }
  if (!snapshot?.url) return null;
  const snapshotUrl = normalizeWaybackSnapshotUrl(snapshot.url, item?.url || "");
  const snapshotRes = await fetchPublicSource(snapshotUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, proxyUrl);
  if (!snapshotRes.ok) return null;
  const type = String(snapshotRes.headers?.get?.("content-type") || "");
  if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) return null;
  const html = await snapshotRes.text();
  return archivedEvidencePayload({ item, fallback, html, snapshot, snapshotUrl, originalStatus });
}

export async function enrichSearchResultSummary(item, { proxyUrl = "", conditionalHeaders = {} } = {}) {
  const fallback = compactText(item?.content || item?.description || item?.summary || item?.title || "");
  if (!isHttpUrl(item?.url)) {
    return { content: fallback, ai_summary: fallback, enriched: false };
  }

  try {
    const safeConditionalHeaders = {};
    if (conditionalHeaders?.["If-None-Match"]) safeConditionalHeaders["If-None-Match"] = conditionalHeaders["If-None-Match"];
    if (conditionalHeaders?.["If-Modified-Since"]) safeConditionalHeaders["If-Modified-Since"] = conditionalHeaders["If-Modified-Since"];
    const res = await fetchPublicSource(item.url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
        ...safeConditionalHeaders,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    const etag = res.headers?.get?.("etag") || "";
    const lastModified = res.headers?.get?.("last-modified") || "";
    if (res.status === 304) {
      return {
        content: fallback,
        ai_summary: fallback,
        enriched: false,
        not_modified: true,
        http: {
          status: 304,
          etag,
          last_modified: lastModified,
        },
      };
    }
	    if (!res.ok) {
	      const archived = await enrichFromWaybackSnapshot(item, { proxyUrl, fallback, originalStatus: res.status }).catch(() => null);
	      return archived || {
	        content: fallback,
	        ai_summary: fallback,
	        enriched: false,
        http: {
          status: res.status,
          etag,
          last_modified: lastModified,
        },
      };
    }
    const type = String(res.headers?.get?.("content-type") || "");
	    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) {
	      const archived = await enrichFromWaybackSnapshot(item, { proxyUrl, fallback, originalStatus: res.status }).catch(() => null);
	      return archived || {
	        content: fallback,
	        ai_summary: fallback,
	        enriched: false,
        http: {
          status: res.status,
          etag,
          last_modified: lastModified,
        },
      };
    }
    const html = await res.text();
    const summary = chooseSummary({ title: item.title, currentContent: fallback, html });
    const metadata = extractArticleMetadata(html, item.url);
    return {
      content: summary || fallback,
      ai_summary: summary || fallback,
      author: metadata.author,
      published_at: metadata.publishedTime,
      enriched: !!summary && summary !== fallback,
      http: {
        status: res.status,
        etag,
        last_modified: lastModified,
      },
      raw_html: html.slice(0, MAX_RAW_HTML_LENGTH),
      evidence: {
        evidence_type: "article",
        image_url: metadata.imageUrl,
        site_name: metadata.siteName,
        canonical_url: metadata.canonicalUrl,
        og_url: metadata.ogUrl,
        author: metadata.author,
        published_time: metadata.publishedTime,
        keywords: metadata.keywords,
        metrics: {
          site_name: metadata.siteName,
          canonical_url: metadata.canonicalUrl,
          og_url: metadata.ogUrl,
          author: metadata.author,
          published_time: metadata.publishedTime,
          modified_time: metadata.structuredEntity?.modifiedTime || "",
          article_section: metadata.structuredEntity?.section || "",
          keywords: metadata.keywords,
          social_author: metadata.social?.author || "",
          social_text: metadata.social?.text || "",
          jsonld_blocks: metadata.social?.jsonLdCount || 0,
          jsonld_types: metadata.jsonLdTypes || [],
          ...structuredEntityMetrics(metadata),
          article_body_quality_score: metadata.mainContent?.qualityScore || 0,
          article_body_text_length: metadata.mainContent?.text?.length || 0,
          article_body_paragraph_count: metadata.mainContent?.paragraphCount || 0,
          article_body_link_count: metadata.mainContent?.linkCount || 0,
          article_body_selector: metadata.mainContent?.selector || "",
          article_body_excerpt: metadata.mainContent?.excerpt || "",
          engagement_comment_count: metadata.engagement?.comment_count || 0,
          engagement_share_count: metadata.engagement?.share_count || 0,
          engagement_like_count: metadata.engagement?.like_count || 0,
          engagement_view_count: metadata.engagement?.view_count || 0,
          structured_engagement_signal: Boolean(metadata.engagement?.structured_engagement_signal),
          meta_engagement_signal: Boolean(metadata.engagement?.meta_engagement_signal),
          has_engagement_signal: Boolean(metadata.engagement?.has_engagement_signal),
          structured_followup_link_count: metadata.structuredFollowupLinks?.length || 0,
          structured_followup_links: metadata.structuredFollowupLinks || [],
          propagation_followup_link_count: metadata.propagationFollowupLinks?.length || 0,
          propagation_followup_links: metadata.propagationFollowupLinks || [],
          jsonld_review_count: metadata.review?.jsonLdReviewCount || 0,
          jsonld_aggregate_rating_count: metadata.review?.jsonLdAggregateRatingCount || 0,
          review_rating: metadata.review?.rating || 0,
          review_best_rating: metadata.review?.bestRating || 0,
          review_worst_rating: metadata.review?.worstRating || 0,
          review_rating_count: metadata.review?.ratingCount || 0,
          review_count: metadata.review?.reviewCount || 0,
          review_author: metadata.review?.author || "",
          review_published_time: metadata.review?.publishedTime || "",
          review_item: metadata.review?.itemReviewed || "",
          review_text: metadata.review?.text || "",
          has_review_structured_data: Boolean(metadata.review?.hasReview),
          review_followup_link_count: metadata.reviewFollowupLinks?.length || 0,
          review_followup_links: metadata.reviewFollowupLinks || [],
          has_image: Boolean(metadata.imageUrl),
        },
      },
      visual_assets: metadata.imageUrl ? [{
        image_url: metadata.imageUrl,
        asset_type: "article_image",
        scene_tags: metadata.siteName ? [metadata.siteName] : [],
      }] : [],
    };
	  } catch {
	    const archived = await enrichFromWaybackSnapshot(item, { proxyUrl, fallback, originalStatus: 0 }).catch(() => null);
	    return archived || { content: fallback, ai_summary: fallback, enriched: false };
	  }
	}

export const __test__ = {
  chooseSummary,
  extractMetaContent,
  extractArticleMetadata,
  extractEngagementMetrics,
  extractMetaEngagementMetrics,
  extractStructuredEngagementMetrics,
  extractStructuredEntityMetadata,
  extractLinkHref,
  extractMainContent,
  extractStructuredArticleBody,
  extractEmbeddedStateArticleBody,
  extractEmbeddedStatePayloads,
  extractPropagationFollowupLinks,
  extractStructuredFollowupLinks,
  extractReviewFollowupLinks,
	  extractReviewMetadata,
	  shouldExtractReviewFollowups,
	  extractSocialMetadata,
	  buildWaybackAvailabilityUrl,
	  buildWaybackCdxUrl,
	  extractWaybackClosestSnapshot,
	  extractWaybackCdxSnapshot,
	  normalizeWaybackSnapshotUrl,
	};
