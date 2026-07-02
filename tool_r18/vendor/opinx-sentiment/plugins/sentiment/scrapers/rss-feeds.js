import { isAfterSince, isRecentDate, isTaiwanRelatedText } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem, recordSentimentSourceQualitySample } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const FEED_CONCURRENCY = 4;
const DEFAULT_MAX_ITEMS_PER_FEED = 30;

function googleNewsSiteIndexFeed({
  name,
  aliases = [],
  site,
  tags = ["zh", "news", "taiwan", "google-news-index"],
  sourceFamily = "taiwan_media",
  homeUrl = "",
  hl = "zh-TW",
  gl = "TW",
  ceid = "TW:zh-Hant",
}) {
  return {
    name: `${name} Google News 索引`,
    aliases: [name, ...aliases],
    url: `https://news.google.com/rss/search?q=site%3A${encodeURIComponent(site)}&hl=${hl}&gl=${gl}&ceid=${ceid}`,
    keywordSearchUrlTemplate: `https://news.google.com/rss/search?q=site%3A${encodeURIComponent(site)}+{query}&hl=${hl}&gl=${gl}&ceid=${ceid}`,
    requireTaiwan: false,
    tags,
    sourceFamily,
    sourceKey: "rssFeeds",
    homeUrl,
  };
}

function bingNewsSiteIndexFeed({
  name,
  aliases = [],
  site,
  tags = ["zh", "news", "taiwan", "bing-news-index"],
  sourceFamily = "taiwan_media",
  homeUrl = "",
  mkt = "zh-TW",
  setlang = "zh-TW",
}) {
  return {
    name: `${name} Bing News 索引`,
    aliases: [name, ...aliases],
    url: `https://www.bing.com/news/search?q=site%3A${encodeURIComponent(site)}&format=rss&mkt=${encodeURIComponent(mkt)}&setlang=${encodeURIComponent(setlang)}`,
    keywordSearchUrlTemplate: `https://www.bing.com/news/search?q=site%3A${encodeURIComponent(site)}+{query}&format=rss&mkt=${encodeURIComponent(mkt)}&setlang=${encodeURIComponent(setlang)}`,
    requireTaiwan: false,
    tags,
    sourceFamily,
    sourceKey: "rssFeeds",
    homeUrl,
  };
}

function prioritySiteHomeUrl(site = "") {
  const hostname = String(site || "").split("/")[0].trim();
  return hostname ? `https://${hostname}/` : "";
}

function taiwanPrioritySiteIndexTags(site = {}) {
  if (site.family === "taiwan_business_media") {
    return ["zh", "business", "news", "taiwan", "bing-news-index"];
  }
  return ["zh", "news", "taiwan", "bing-news-index"];
}

export const TAIWAN_PRIORITY_MEDIA_SITES = Object.freeze([
  { name: "ETtoday新聞雲", aliases: ["ETtoday", "東森新聞雲"], site: "ettoday.net/news", family: "taiwan_media" },
  { name: "NOWnews今日新聞", aliases: ["NOWnews", "NOWnews 今日新聞"], site: "nownews.com", family: "taiwan_media" },
  { name: "Yahoo奇摩新聞", aliases: ["Yahoo新聞", "Yahoo Taiwan News"], site: "tw.news.yahoo.com", family: "taiwan_media" },
  { name: "聯合新聞網", aliases: ["udn", "UDN", "聯合報"], site: "udn.com/news", family: "taiwan_media" },
  { name: "中時新聞網", aliases: ["中時", "中國時報", "China Times"], site: "chinatimes.com", family: "taiwan_media" },
  { name: "自由時報電子報", aliases: ["自由時報", "LTN", "Liberty Times"], site: "news.ltn.com.tw", family: "taiwan_media" },
  { name: "鏡週刊", aliases: ["Mirror Media"], site: "mirrormedia.mg", family: "taiwan_media" },
  { name: "風傳媒", aliases: ["Storm Media"], site: "storm.mg", family: "taiwan_media" },
  { name: "關鍵評論網", aliases: ["The News Lens", "TNL"], site: "thenewslens.com", family: "taiwan_media" },
  { name: "上報", aliases: ["UP Media"], site: "upmedia.mg", family: "taiwan_media" },
  { name: "商業周刊", aliases: ["商周", "Business Weekly"], site: "businessweekly.com.tw", family: "taiwan_business_media" },
  { name: "天下雜誌", aliases: ["天下", "CommonWealth"], site: "cw.com.tw", family: "taiwan_business_media" },
  { name: "今周刊", aliases: ["Business Today"], site: "businesstoday.com.tw", family: "taiwan_business_media" },
  { name: "財訊", aliases: ["Wealth Magazine"], site: "wealth.com.tw", family: "taiwan_business_media" },
  { name: "MoneyDJ理財網", aliases: ["MoneyDJ"], site: "moneydj.com", family: "taiwan_business_media" },
  { name: "鉅亨網", aliases: ["Anue", "Cnyes"], site: "news.cnyes.com", family: "taiwan_business_media" },
]);

export const TAIWAN_REQUIRED_MEDIA_COVERAGE_SITES = Object.freeze(
  TAIWAN_PRIORITY_MEDIA_SITES.map(site => Object.freeze({
    name: site.name,
    aliases: Object.freeze([...(site.aliases || [])]),
    site: site.site,
    family: site.family,
    required: true,
  }))
);

export const TAIWAN_BUSINESS_MEDIA_SITES = Object.freeze(
  TAIWAN_PRIORITY_MEDIA_SITES
    .filter(site => site.family === "taiwan_business_media")
    .map(site => Object.freeze({
      name: site.name,
      aliases: Object.freeze([...(site.aliases || [])]),
      site: site.site,
      family: site.family,
      required: true,
    }))
);

export const TAIWAN_PUBLIC_INTEREST_MEDIA_SITES = Object.freeze([
  { name: "中央社", aliases: ["CNA"], site: "cna.com.tw", family: "taiwan_public_interest_media" },
  { name: "報導者", aliases: ["The Reporter"], site: "twreporter.org", family: "taiwan_public_interest_media" },
  { name: "公視新聞網", aliases: ["PTS"], site: "news.pts.org.tw", family: "taiwan_public_interest_media" },
  { name: "上下游", aliases: ["News & Market"], site: "newsmarket.com.tw", family: "taiwan_public_interest_media" },
  { name: "苦勞網", aliases: ["Coolloud"], site: "coolloud.org.tw", family: "taiwan_public_interest_media" },
  { name: "公民行動影音紀錄資料庫", aliases: ["公庫", "CivilMedia"], site: "civilmedia.tw", family: "taiwan_public_interest_media" },
  { name: "央廣", aliases: ["RTI"], site: "rti.org.tw", family: "taiwan_public_interest_media" },
  { name: "新頭殼", aliases: ["Newtalk"], site: "newtalk.tw", family: "taiwan_public_interest_media" },
]);

export const TAIWAN_REGULATORY_INDEX_SITES = Object.freeze([
  {
    name: "台灣金管會",
    aliases: ["金融監督管理委員會", "金管會", "FSC Taiwan"],
    site: "fsc.gov.tw",
    tags: ["zh", "official", "regulatory", "finance", "taiwan"],
    sourceFamily: "regulatory",
    homeUrl: "https://www.fsc.gov.tw/",
  },
  {
    name: "台灣銀行局",
    aliases: ["銀行局"],
    site: "banking.gov.tw",
    tags: ["zh", "official", "regulatory", "finance", "banking", "taiwan"],
    sourceFamily: "regulatory",
    homeUrl: "https://www.banking.gov.tw/",
  },
  {
    name: "台灣證期局",
    aliases: ["證券期貨局", "證期局"],
    site: "sfb.gov.tw",
    tags: ["zh", "official", "regulatory", "finance", "securities", "taiwan"],
    sourceFamily: "regulatory",
    homeUrl: "https://www.sfb.gov.tw/",
  },
  {
    name: "台灣公平交易委員會",
    aliases: ["公平會", "Fair Trade Commission Taiwan"],
    site: "ftc.gov.tw",
    tags: ["zh", "official", "regulatory", "competition", "consumer", "taiwan"],
    sourceFamily: "regulatory",
    homeUrl: "https://www.ftc.gov.tw/",
  },
  {
    name: "台灣行政院消費者保護會",
    aliases: ["消保會", "Consumer Protection Committee Taiwan"],
    site: "cpc.ey.gov.tw",
    tags: ["zh", "official", "consumer-protection", "complaint", "dispute", "taiwan"],
    sourceFamily: "consumer_protection",
    homeUrl: "https://cpc.ey.gov.tw/",
  },
  {
    name: "台灣國家通訊傳播委員會",
    aliases: ["NCC", "通傳會"],
    site: "ncc.gov.tw",
    tags: ["zh", "official", "regulatory", "telecom", "media", "privacy", "taiwan"],
    sourceFamily: "regulatory",
    homeUrl: "https://www.ncc.gov.tw/",
  },
  {
    name: "台灣食品藥物管理署",
    aliases: ["食藥署", "TFDA"],
    site: "fda.gov.tw",
    tags: ["zh", "official", "regulatory", "health", "food-safety", "drug-safety", "taiwan"],
    sourceFamily: "regulatory",
    homeUrl: "https://www.fda.gov.tw/",
  },
  {
    name: "台灣數位發展部",
    aliases: ["數位部", "MODA"],
    site: "moda.gov.tw",
    tags: ["zh", "official", "regulatory", "digital", "cybersecurity", "privacy", "taiwan"],
    sourceFamily: "regulatory",
    homeUrl: "https://moda.gov.tw/",
  },
]);

export const GREATER_CHINA_MEDIA_INDEX_SITES = Object.freeze([
  {
    name: "香港01",
    aliases: ["HK01"],
    site: "hk01.com",
    tags: ["zh", "news", "hong-kong"],
    sourceFamily: "greater_china_media",
    homeUrl: "https://www.hk01.com/",
    locale: { hl: "zh-HK", gl: "HK", ceid: "HK:zh-Hant", mkt: "zh-HK", setlang: "zh-HK" },
  },
  {
    name: "明報",
    aliases: ["Ming Pao"],
    site: "news.mingpao.com",
    tags: ["zh", "news", "hong-kong"],
    sourceFamily: "greater_china_media",
    homeUrl: "https://news.mingpao.com/",
    locale: { hl: "zh-HK", gl: "HK", ceid: "HK:zh-Hant", mkt: "zh-HK", setlang: "zh-HK" },
  },
  {
    name: "星島日報",
    aliases: ["Sing Tao"],
    site: "std.stheadline.com",
    tags: ["zh", "news", "hong-kong"],
    sourceFamily: "greater_china_media",
    homeUrl: "https://std.stheadline.com/",
    locale: { hl: "zh-HK", gl: "HK", ceid: "HK:zh-Hant", mkt: "zh-HK", setlang: "zh-HK" },
  },
  {
    name: "信報財經新聞",
    aliases: ["信報", "Hong Kong Economic Journal"],
    site: "hkej.com",
    tags: ["zh", "business", "finance", "hong-kong"],
    sourceFamily: "greater_china_business_media",
    homeUrl: "https://www.hkej.com/",
    locale: { hl: "zh-HK", gl: "HK", ceid: "HK:zh-Hant", mkt: "zh-HK", setlang: "zh-HK" },
  },
  {
    name: "南華早報",
    aliases: ["SCMP", "South China Morning Post"],
    site: "scmp.com",
    tags: ["en", "news", "business", "hong-kong", "asia"],
    sourceFamily: "greater_china_media",
    homeUrl: "https://www.scmp.com/",
    locale: { hl: "en-HK", gl: "HK", ceid: "HK:en", mkt: "en-HK", setlang: "en" },
  },
  {
    name: "The Standard Hong Kong",
    aliases: ["The Standard"],
    site: "thestandard.com.hk",
    tags: ["en", "news", "hong-kong"],
    sourceFamily: "greater_china_media",
    homeUrl: "https://www.thestandard.com.hk/",
    locale: { hl: "en-HK", gl: "HK", ceid: "HK:en", mkt: "en-HK", setlang: "en" },
  },
  {
    name: "聯合早報",
    aliases: ["Zaobao", "联合早报"],
    site: "zaobao.com.sg",
    tags: ["zh", "news", "business", "singapore", "asia"],
    sourceFamily: "greater_china_media",
    homeUrl: "https://www.zaobao.com.sg/",
    locale: { hl: "zh-CN", gl: "SG", ceid: "SG:zh-Hans", mkt: "zh-SG", setlang: "zh-Hans" },
  },
  {
    name: "The Straits Times",
    aliases: ["Straits Times"],
    site: "straitstimes.com",
    tags: ["en", "news", "business", "singapore", "asia"],
    sourceFamily: "greater_china_media",
    homeUrl: "https://www.straitstimes.com/",
    locale: { hl: "en-SG", gl: "SG", ceid: "SG:en", mkt: "en-SG", setlang: "en" },
  },
]);

export const GLOBAL_MAINSTREAM_MEDIA_INDEX_SITES = Object.freeze([
  {
    name: "Reuters",
    aliases: [],
    site: "reuters.com",
    tags: ["en", "news", "business", "wire"],
    sourceFamily: "global_mainstream_media",
    homeUrl: "https://www.reuters.com/",
  },
  {
    name: "Associated Press",
    aliases: ["AP News", "AP"],
    site: "apnews.com",
    tags: ["en", "news", "wire"],
    sourceFamily: "global_mainstream_media",
    homeUrl: "https://apnews.com/",
  },
  {
    name: "Financial Times",
    aliases: ["FT"],
    site: "ft.com",
    tags: ["en", "news", "business", "finance"],
    sourceFamily: "global_business_media",
    homeUrl: "https://www.ft.com/",
  },
  {
    name: "Bloomberg",
    aliases: [],
    site: "bloomberg.com",
    tags: ["en", "news", "business", "finance", "markets"],
    sourceFamily: "global_business_media",
    homeUrl: "https://www.bloomberg.com/",
  },
  {
    name: "Wall Street Journal",
    aliases: ["WSJ"],
    site: "wsj.com",
    tags: ["en", "news", "business", "finance", "markets"],
    sourceFamily: "global_business_media",
    homeUrl: "https://www.wsj.com/",
  },
  {
    name: "The Guardian",
    aliases: [],
    site: "theguardian.com",
    tags: ["en", "news", "consumer", "technology"],
    sourceFamily: "global_mainstream_media",
    homeUrl: "https://www.theguardian.com/",
  },
  {
    name: "CNN",
    aliases: [],
    site: "cnn.com",
    tags: ["en", "news", "consumer"],
    sourceFamily: "global_mainstream_media",
    homeUrl: "https://www.cnn.com/",
  },
  {
    name: "BBC News",
    aliases: [],
    site: "bbc.com/news",
    tags: ["en", "news", "global"],
    sourceFamily: "global_mainstream_media",
    homeUrl: "https://www.bbc.com/news",
  },
]);

const PUBLIC_RSS_FEED_PACK_METADATA = {
  taiwanMedia: {
    label: "台灣重點新聞/財經媒體",
    prioritySites: TAIWAN_PRIORITY_MEDIA_SITES,
    requiredSites: TAIWAN_REQUIRED_MEDIA_COVERAGE_SITES,
  },
  taiwanBusinessMedia: {
    label: "台灣財經/商業媒體",
    prioritySites: TAIWAN_BUSINESS_MEDIA_SITES,
    requiredSites: TAIWAN_BUSINESS_MEDIA_SITES,
  },
  taiwanPublicInterest: {
    label: "台灣公共議題/獨立媒體",
    prioritySites: TAIWAN_PUBLIC_INTEREST_MEDIA_SITES,
  },
};

function newsIndexFeedsForSites(sites = [], {
  googleIndexTag = "google-news-index",
  bingIndexTag = "bing-news-index",
  defaultLocale = { hl: "en-US", gl: "US", ceid: "US:en", mkt: "en-US", setlang: "en" },
} = {}) {
  return sites.flatMap(site => {
    const locale = { ...defaultLocale, ...(site.locale || {}) };
    const tags = Array.isArray(site.tags) ? site.tags : ["zh", "news", "taiwan"];
    const sourceFamily = site.sourceFamily || site.family || "";
    return [
      googleNewsSiteIndexFeed({
        name: site.name,
        aliases: site.aliases,
        site: site.site,
        tags: [...tags, googleIndexTag],
        sourceFamily,
        homeUrl: site.homeUrl,
        hl: locale.hl,
        gl: locale.gl,
        ceid: locale.ceid,
      }),
      bingNewsSiteIndexFeed({
        name: site.name,
        aliases: site.aliases,
        site: site.site,
        tags: [...tags, bingIndexTag],
        sourceFamily,
        homeUrl: site.homeUrl,
        mkt: locale.mkt,
        setlang: locale.setlang,
      }),
    ];
  });
}

function taiwanRegulatoryIndexFeeds() {
  return TAIWAN_REGULATORY_INDEX_SITES.flatMap(site => [
    googleNewsSiteIndexFeed({
      name: site.name,
      aliases: site.aliases,
      site: site.site,
      tags: [...site.tags, "google-news-index"],
      sourceFamily: site.sourceFamily,
      homeUrl: site.homeUrl,
    }),
    bingNewsSiteIndexFeed({
      name: site.name,
      aliases: site.aliases,
      site: site.site,
      tags: [...site.tags, "bing-news-index"],
      sourceFamily: site.sourceFamily,
      homeUrl: site.homeUrl,
    }),
  ]);
}

export const DEFAULT_PUBLIC_RSS_FEEDS = [
  { name: "BBC 中文", url: "https://feeds.bbci.co.uk/zhongwen/trad/rss.xml", requireTaiwan: false },
  { name: "RFI 華語", url: "https://www.rfi.fr/tw/rss", requireTaiwan: false },
];
export const PUBLIC_RSS_FEED_PACKS = {
  chineseNews: [
    { name: "BBC 中文", url: "https://feeds.bbci.co.uk/zhongwen/trad/rss.xml", requireTaiwan: false, tags: ["zh", "news"], sourceFamily: "public_news_media", sourceKey: "rssFeeds" },
    { name: "RFI 華語", url: "https://www.rfi.fr/tw/rss", requireTaiwan: false, tags: ["zh", "news"], sourceFamily: "public_news_media", sourceKey: "rssFeeds" },
  ],
  taiwanMedia: [
    { name: "Yahoo奇摩新聞", aliases: ["Yahoo奇摩新聞"], url: "https://tw.news.yahoo.com/rss/", requireTaiwan: false, tags: ["zh", "news", "taiwan"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "聯合新聞網 即時", aliases: ["聯合新聞網"], url: "https://udn.com/rssfeed/news/2/6638?ch=news", requireTaiwan: false, tags: ["zh", "news", "taiwan"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "聯合新聞網 社會", aliases: ["聯合新聞網", "聯合報"], url: "https://udn.com/rssfeed/news/2/6639?ch=news", requireTaiwan: false, tags: ["zh", "news", "taiwan", "society"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "ETtoday 即時", aliases: ["ETtoday", "ETtoday新聞雲"], url: "https://feeds.feedburner.com/ettoday/realtime", requireTaiwan: false, tags: ["zh", "news", "taiwan"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "ETtoday 社會", aliases: ["ETtoday", "ETtoday新聞雲"], url: "https://feeds.feedburner.com/ettoday/society", requireTaiwan: false, tags: ["zh", "news", "taiwan", "society"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "自由時報 即時", aliases: ["自由時報", "自由時報電子報"], url: "https://news.ltn.com.tw/rss/all.xml", requireTaiwan: false, tags: ["zh", "news", "taiwan"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "自由時報 社會", aliases: ["自由時報", "自由時報電子報"], url: "https://news.ltn.com.tw/rss/society.xml", requireTaiwan: false, tags: ["zh", "news", "taiwan", "society"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "自由時報 生活", aliases: ["自由時報", "自由時報電子報"], url: "https://news.ltn.com.tw/rss/life.xml", requireTaiwan: false, tags: ["zh", "news", "taiwan", "life"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    {
      name: "中時新聞網 即時",
      aliases: ["中時新聞網"],
      url: "https://www.chinatimes.com/sitemaps/sitemap_todaynews.xml",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "sitemap"],
      sourceFamily: "taiwan_media",
      sourceKey: "rssFeeds",
    },
    {
      name: "風傳媒 即時",
      aliases: ["風傳媒"],
      url: "https://www.storm.mg/sitemaps/1/article-news-1.xml",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "sitemap"],
      sourceFamily: "taiwan_media",
      sourceKey: "rssFeeds",
    },
    {
      name: "NOWnews 即時",
      aliases: ["NOWnews", "NOWnews今日新聞"],
      url: "https://www.nownews.com/nn-client/api/v1/cat/breaking/",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "json"],
      sourceFamily: "taiwan_media",
      sourceKey: "rssFeeds",
      format: "json-custom",
      itemsPath: "data.newsList",
      titleFields: ["postTitle"],
      urlFields: ["postUrl", "postOnlyUrl"],
      contentFields: ["postContent"],
      publishedAtFields: ["newsDate"],
      mediaUrlFields: ["imageUrl", "imageVideoUrl"],
      baseUrl: "https://www.nownews.com/",
      homeUrl: "https://www.nownews.com/",
    },
    { name: "鏡週刊", aliases: ["鏡週刊"], url: "https://www.mirrormedia.mg/rss/rss.xml", requireTaiwan: false, tags: ["zh", "news", "taiwan", "magazine"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "鏡週刊 新聞", aliases: ["鏡週刊"], url: "https://www.mirrormedia.mg/rss/news.xml", requireTaiwan: false, tags: ["zh", "news", "taiwan", "magazine"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    { name: "關鍵評論網", aliases: ["關鍵評論網"], url: "https://www.thenewslens.com/feed/feedly", requireTaiwan: false, tags: ["zh", "news", "taiwan", "opinion"], sourceFamily: "taiwan_media", sourceKey: "rssFeeds" },
    {
      name: "上報 Google News 索引",
      aliases: ["上報"],
      url: "https://news.google.com/rss/search?q=site%3Aupmedia.mg&hl=zh-TW&gl=TW&ceid=TW:zh-Hant",
      keywordSearchUrlTemplate: "https://news.google.com/rss/search?q=site%3Aupmedia.mg+{query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "google-news-index"],
      sourceFamily: "taiwan_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.upmedia.mg/",
    },
    {
      name: "上報 全站站點地圖",
      aliases: ["上報"],
      url: "https://www.upmedia.mg/sitemap.xml",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "sitemap"],
      sourceFamily: "taiwan_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.upmedia.mg/",
    },
    {
      name: "風傳媒 全站站點地圖",
      aliases: ["風傳媒"],
      url: "https://www.storm.mg/sitemap.xml",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "sitemap"],
      sourceFamily: "taiwan_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.storm.mg/",
    },
    {
      name: "商業周刊 開放文章",
      aliases: ["商業周刊"],
      url: "http://cmsapi.businessweekly.com.tw/?CategoryId=efd99109-9e15-422e-97f0-078b21322450&TemplateId=8E19CF43-50E5-4093-B72D-70A912962D55",
      requireTaiwan: false,
      tags: ["zh", "business", "news", "taiwan"],
      sourceFamily: "taiwan_business_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.businessweekly.com.tw/",
    },
    {
      name: "商業周刊 全站站點地圖",
      aliases: ["商業周刊", "商周"],
      url: "https://www.businessweekly.com.tw/sitemap.xml",
      requireTaiwan: false,
      tags: ["zh", "business", "news", "taiwan", "sitemap"],
      sourceFamily: "taiwan_business_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.businessweekly.com.tw/",
    },
    {
      name: "今周刊 熱門文章",
      aliases: ["今周刊"],
      url: "https://www.businesstoday.com.tw/article/get_hot_article/5",
      requireTaiwan: false,
      tags: ["zh", "business", "magazine", "taiwan", "json"],
      sourceFamily: "taiwan_business_media",
      sourceKey: "rssFeeds",
      format: "json-custom",
      itemsPath: "data",
      titleFields: ["title"],
      urlFields: ["href"],
      contentFields: ["part_text", "full_text_content"],
      publishedAtFields: ["release_date"],
      categoryFields: ["category_name"],
      mediaUrlFields: ["image_list", "image_mobile", "image_thumbnail"],
      homeUrl: "https://www.businesstoday.com.tw/",
      baseUrl: "https://www.businesstoday.com.tw/",
    },
    {
      name: "今周刊 全站站點地圖",
      aliases: ["今周刊"],
      url: "https://www.businesstoday.com.tw/sitemap.xml",
      requireTaiwan: false,
      tags: ["zh", "business", "magazine", "taiwan", "sitemap"],
      sourceFamily: "taiwan_business_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.businesstoday.com.tw/",
    },
    {
      name: "天下雜誌 全站站點地圖",
      aliases: ["天下雜誌"],
      url: "https://www.cw.com.tw/sitemap.xml",
      requireTaiwan: false,
      tags: ["zh", "business", "news", "taiwan", "sitemap"],
      sourceFamily: "taiwan_business_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.cw.com.tw/",
      sitemapChildStrategy: "last",
      childSitemapLimit: 1,
    },
    { name: "財訊", aliases: ["財訊"], url: "https://www.wealth.com.tw/rss", requireTaiwan: false, tags: ["zh", "business", "finance", "taiwan"], sourceFamily: "taiwan_business_media", sourceKey: "rssFeeds" },
    {
      name: "財訊 站點地圖",
      aliases: ["財訊"],
      url: "https://www.wealth.com.tw/sitemap.xml",
      requireTaiwan: false,
      tags: ["zh", "business", "finance", "taiwan", "sitemap"],
      sourceFamily: "taiwan_business_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.wealth.com.tw/",
      sitemapChildStrategy: "first",
      childSitemapLimit: 2,
    },
    { name: "MoneyDJ 即時新聞", aliases: ["MoneyDJ", "MoneyDJ理財網"], url: "https://www.moneydj.com/kmdj/RssCenter.aspx?svc=NW&fno=1&arg=X0000000", requireTaiwan: false, tags: ["zh", "business", "finance", "markets", "taiwan"], sourceFamily: "taiwan_business_media", sourceKey: "rssFeeds" },
    {
      name: "MoneyDJ 站點地圖",
      aliases: ["MoneyDJ", "MoneyDJ理財網"],
      url: "https://www.moneydj.com/sitemap.xml",
      requireTaiwan: false,
      tags: ["zh", "business", "finance", "markets", "taiwan", "sitemap"],
      sourceFamily: "taiwan_business_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.moneydj.com/",
    },
    {
      name: "鉅亨網 頭條",
      aliases: ["鉅亨網"],
      url: "https://news.cnyes.com/api/v3/news/category/headline",
      requireTaiwan: false,
      tags: ["zh", "business", "finance", "markets", "taiwan", "json"],
      sourceFamily: "taiwan_business_media",
      sourceKey: "rssFeeds",
      format: "json-custom",
      itemsPath: "items.data",
      titleFields: ["title"],
      urlFields: ["href", "newsId"],
      urlTemplate: "https://news.cnyes.com/news/id/{value}",
      contentFields: ["summary", "content"],
      publishedAtFields: ["publishAt"],
      categoryFields: ["categoryName", "keyword"],
      mediaUrlFields: ["coverSrc.m.src", "coverSrc.l.src", "coverSrc.xs.src"],
      homeUrl: "https://news.cnyes.com/",
      baseUrl: "https://news.cnyes.com/",
    },
    googleNewsSiteIndexFeed({ name: "ETtoday新聞雲", aliases: ["ETtoday"], site: "ettoday.net/news", homeUrl: "https://www.ettoday.net/" }),
    googleNewsSiteIndexFeed({ name: "NOWnews今日新聞", aliases: ["NOWnews"], site: "nownews.com", homeUrl: "https://www.nownews.com/" }),
    googleNewsSiteIndexFeed({ name: "Yahoo奇摩新聞", site: "tw.news.yahoo.com", homeUrl: "https://tw.news.yahoo.com/" }),
    googleNewsSiteIndexFeed({ name: "聯合新聞網", aliases: ["udn"], site: "udn.com/news", homeUrl: "https://udn.com/news/" }),
    googleNewsSiteIndexFeed({ name: "中時新聞網", site: "chinatimes.com", homeUrl: "https://www.chinatimes.com/" }),
    googleNewsSiteIndexFeed({ name: "自由時報電子報", aliases: ["自由時報"], site: "news.ltn.com.tw", homeUrl: "https://news.ltn.com.tw/" }),
    googleNewsSiteIndexFeed({ name: "鏡週刊", site: "mirrormedia.mg", homeUrl: "https://www.mirrormedia.mg/" }),
    googleNewsSiteIndexFeed({ name: "風傳媒", site: "storm.mg", homeUrl: "https://www.storm.mg/" }),
    googleNewsSiteIndexFeed({ name: "關鍵評論網", site: "thenewslens.com", homeUrl: "https://www.thenewslens.com/" }),
    googleNewsSiteIndexFeed({
      name: "商業周刊",
      site: "businessweekly.com.tw",
      tags: ["zh", "business", "news", "taiwan", "google-news-index"],
      sourceFamily: "taiwan_business_media",
      homeUrl: "https://www.businessweekly.com.tw/",
    }),
    googleNewsSiteIndexFeed({
      name: "天下雜誌",
      site: "cw.com.tw",
      tags: ["zh", "business", "news", "taiwan", "google-news-index"],
      sourceFamily: "taiwan_business_media",
      homeUrl: "https://www.cw.com.tw/",
    }),
    googleNewsSiteIndexFeed({
      name: "今周刊",
      site: "businesstoday.com.tw",
      tags: ["zh", "business", "magazine", "taiwan", "google-news-index"],
      sourceFamily: "taiwan_business_media",
      homeUrl: "https://www.businesstoday.com.tw/",
    }),
    googleNewsSiteIndexFeed({
      name: "財訊",
      site: "wealth.com.tw",
      tags: ["zh", "business", "finance", "taiwan", "google-news-index"],
      sourceFamily: "taiwan_business_media",
      homeUrl: "https://www.wealth.com.tw/",
    }),
    googleNewsSiteIndexFeed({
      name: "MoneyDJ理財網",
      aliases: ["MoneyDJ"],
      site: "moneydj.com",
      tags: ["zh", "business", "finance", "markets", "taiwan", "google-news-index"],
      sourceFamily: "taiwan_business_media",
      homeUrl: "https://www.moneydj.com/",
    }),
    googleNewsSiteIndexFeed({
      name: "鉅亨網",
      site: "news.cnyes.com",
      tags: ["zh", "business", "finance", "markets", "taiwan", "google-news-index"],
      sourceFamily: "taiwan_business_media",
      homeUrl: "https://news.cnyes.com/",
    }),
    ...TAIWAN_PRIORITY_MEDIA_SITES.map(site => bingNewsSiteIndexFeed({
      name: site.name,
      aliases: site.aliases,
      site: site.site,
      tags: taiwanPrioritySiteIndexTags(site),
      sourceFamily: site.family,
      homeUrl: prioritySiteHomeUrl(site.site),
    })),
  ],
  taiwanPublicInterest: [
    {
      name: "報導者",
      aliases: ["The Reporter"],
      url: "https://public.twreporter.org/rss/twreporter-rss.xml",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "public-interest", "investigative"],
      sourceFamily: "taiwan_public_interest_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.twreporter.org/",
    },
    {
      name: "公視新聞網",
      aliases: ["PTS"],
      url: "https://news.pts.org.tw/xml/newsfeed.xml",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "public-media", "public-interest"],
      sourceFamily: "taiwan_public_interest_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://news.pts.org.tw/",
    },
    {
      name: "上下游",
      aliases: ["News & Market"],
      url: "https://www.newsmarket.com.tw/feed/",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "public-interest", "agriculture", "consumer"],
      sourceFamily: "taiwan_public_interest_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.newsmarket.com.tw/",
    },
    {
      name: "苦勞網",
      aliases: ["Coolloud"],
      url: "https://www.coolloud.org.tw/rss.xml",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "public-interest", "labor"],
      sourceFamily: "taiwan_public_interest_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.coolloud.org.tw/",
    },
    {
      name: "公民行動影音紀錄資料庫",
      aliases: ["公庫", "CivilMedia"],
      url: "https://www.civilmedia.tw/feed",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "public-interest", "civic"],
      sourceFamily: "taiwan_public_interest_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.civilmedia.tw/",
    },
    {
      name: "央廣",
      aliases: ["RTI"],
      url: "https://www.rti.org.tw/rss",
      requireTaiwan: false,
      tags: ["zh", "news", "taiwan", "public-media"],
      sourceFamily: "taiwan_public_interest_media",
      sourceKey: "rssFeeds",
      homeUrl: "https://www.rti.org.tw/",
    },
    ...newsIndexFeedsForSites(TAIWAN_PUBLIC_INTEREST_MEDIA_SITES, {
      defaultLocale: { hl: "zh-TW", gl: "TW", ceid: "TW:zh-Hant", mkt: "zh-TW", setlang: "zh-Hant" },
    }),
  ],
  greaterChinaMedia: newsIndexFeedsForSites(GREATER_CHINA_MEDIA_INDEX_SITES, {
    defaultLocale: { hl: "zh-HK", gl: "HK", ceid: "HK:zh-Hant", mkt: "zh-HK", setlang: "zh-HK" },
  }),
  globalMainstreamMedia: newsIndexFeedsForSites(GLOBAL_MAINSTREAM_MEDIA_INDEX_SITES, {
    defaultLocale: { hl: "en-US", gl: "US", ceid: "US:en", mkt: "en-US", setlang: "en" },
  }),
  globalTech: [
    { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", requireTaiwan: false, tags: ["en", "tech"], sourceFamily: "technology_media", sourceKey: "rssFeeds" },
    { name: "TechCrunch", url: "https://techcrunch.com/feed/", requireTaiwan: false, tags: ["en", "tech", "startup"], sourceFamily: "technology_media", sourceKey: "rssFeeds" },
    { name: "Wired", url: "https://www.wired.com/feed/rss", requireTaiwan: false, tags: ["en", "tech"], sourceFamily: "technology_media", sourceKey: "rssFeeds" },
    { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index/", requireTaiwan: false, tags: ["en", "tech", "security", "policy"], sourceFamily: "technology_media", sourceKey: "rssFeeds" },
    { name: "Engadget", url: "https://www.engadget.com/rss.xml", requireTaiwan: false, tags: ["en", "tech", "consumer-tech"], sourceFamily: "technology_media", sourceKey: "rssFeeds" },
    { name: "VentureBeat", url: "https://venturebeat.com/feed/", requireTaiwan: false, tags: ["en", "tech", "startup", "ai"], sourceFamily: "technology_media", sourceKey: "rssFeeds" },
    { name: "The Register", url: "https://www.theregister.com/headlines.atom", requireTaiwan: false, tags: ["en", "tech", "enterprise", "security"], sourceFamily: "technology_media", sourceKey: "rssFeeds" },
    { name: "ZDNET", url: "https://www.zdnet.com/news/rss.xml", requireTaiwan: false, tags: ["en", "tech", "enterprise"], sourceFamily: "technology_media", sourceKey: "rssFeeds" },
  ],
  security: [
    { name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/", requireTaiwan: false, tags: ["en", "security"], sourceFamily: "security_media", sourceKey: "rssFeeds" },
    { name: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", requireTaiwan: false, tags: ["en", "security"], sourceFamily: "security_media", sourceKey: "rssFeeds" },
    { name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/", requireTaiwan: false, tags: ["en", "security", "breach", "malware", "ransomware"], sourceFamily: "security_media", sourceKey: "rssFeeds" },
    { name: "SecurityWeek", url: "https://www.securityweek.com/feed/", requireTaiwan: false, tags: ["en", "security", "enterprise", "vulnerability"], sourceFamily: "security_media", sourceKey: "rssFeeds" },
    { name: "Help Net Security", url: "https://www.helpnetsecurity.com/feed/", requireTaiwan: false, tags: ["en", "security", "breach", "vulnerability"], sourceFamily: "security_media", sourceKey: "rssFeeds" },
  ],
  business: [
    { name: "Nikkei Asia", url: "https://asia.nikkei.com/rss/feed/nar", requireTaiwan: false, tags: ["en", "business", "asia"], sourceFamily: "global_business_media", sourceKey: "rssFeeds" },
    { name: "CNBC Top News", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", requireTaiwan: false, tags: ["en", "business", "markets", "finance"], sourceFamily: "global_business_media", sourceKey: "rssFeeds" },
    { name: "MarketWatch Top Stories", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", requireTaiwan: false, tags: ["en", "business", "markets", "finance"], sourceFamily: "global_business_media", sourceKey: "rssFeeds" },
    { name: "Fortune", url: "https://fortune.com/feed/", requireTaiwan: false, tags: ["en", "business", "company-news", "leadership"], sourceFamily: "global_business_media", sourceKey: "rssFeeds" },
  ],
  pressReleases: [
    { name: "PR Newswire", url: "https://www.prnewswire.com/rss/news-releases-list.rss", requireTaiwan: false, tags: ["en", "press-release", "company-news", "official-statement"], sourceFamily: "press_release", sourceKey: "rssFeeds" },
    { name: "GlobeNewswire Public Companies", url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies", requireTaiwan: false, tags: ["en", "press-release", "public-company", "investor-relations"], sourceFamily: "press_release", sourceKey: "rssFeeds" },
  ],
  consumerProtection: [
    { name: "FTC Consumer Protection Press Releases", url: "https://www.ftc.gov/feeds/press-release-consumer-protection.xml", requireTaiwan: false, tags: ["en", "official", "consumer", "complaint", "fraud", "privacy"], sourceFamily: "consumer_protection", sourceKey: "rssFeeds", regulatory: true },
    { name: "FTC Data Spotlight", url: "https://www.ftc.gov/feeds/data-spotlight.xml", requireTaiwan: false, tags: ["en", "official", "consumer", "fraud", "scam", "data"], sourceFamily: "consumer_protection", sourceKey: "rssFeeds", regulatory: true },
    { name: "FTC Consumer Blog", url: "https://www.consumer.ftc.gov/blog/gd-rss.xml", requireTaiwan: false, tags: ["en", "official", "consumer", "alert", "scam"], sourceFamily: "consumer_protection", sourceKey: "rssFeeds", regulatory: true },
    { name: "CFPB Newsroom", url: "https://www.consumerfinance.gov/about-us/newsroom/feed/", requireTaiwan: false, tags: ["en", "official", "consumer", "financial", "complaint", "enforcement"], sourceFamily: "consumer_protection", sourceKey: "rssFeeds", regulatory: true },
    { name: "Canada Consumer Product Recalls", url: "https://recalls-rappels.canada.ca/en/feed/consumer-products-alerts-recalls", requireTaiwan: false, tags: ["en", "official", "consumer", "recall", "product-safety", "canada"], sourceFamily: "consumer_protection", sourceKey: "rssFeeds", regulatory: true },
    { name: "FDA Consumer Health Information Updates", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/consumers/rss.xml", requireTaiwan: false, tags: ["en", "official", "consumer", "health", "safety", "fda"], sourceFamily: "consumer_protection", sourceKey: "rssFeeds", regulatory: true },
    { name: "FDA Health Fraud", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/health-fraud/rss.xml", requireTaiwan: false, tags: ["en", "official", "consumer", "health", "fraud", "scam", "fda"], sourceFamily: "consumer_protection", sourceKey: "rssFeeds", regulatory: true },
  ],
  taiwanRegulatory: taiwanRegulatoryIndexFeeds(),
  regulatoryNotices: [
    { name: "FTC Press Releases", url: "https://www.ftc.gov/feeds/press-release.xml", requireTaiwan: false, tags: ["en", "official", "regulatory", "enforcement", "competition", "consumer"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "CPSC Recalls", url: "https://www.cpsc.gov/Newsroom/CPSC-RSS-Feed/Recalls-RSS", requireTaiwan: false, tags: ["en", "official", "recall", "safety", "product"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "FDA Recalls", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml", requireTaiwan: false, tags: ["en", "official", "regulatory", "recall", "health", "safety"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "FDA Food Safety Recalls", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/food-safety-recalls/rss.xml", requireTaiwan: false, tags: ["en", "official", "regulatory", "recall", "food-safety", "health"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "FDA MedWatch Safety Alerts", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml", requireTaiwan: false, tags: ["en", "official", "regulatory", "safety-alert", "health", "medical"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "Canada Health Product Recalls", url: "https://recalls-rappels.canada.ca/en/feed/health-products-alerts-recalls", requireTaiwan: false, tags: ["en", "official", "regulatory", "recall", "health", "canada"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "Canada Food Recalls", url: "https://recalls-rappels.canada.ca/en/feed/food-alerts-recalls", requireTaiwan: false, tags: ["en", "official", "regulatory", "recall", "food-safety", "canada"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "UK Product Safety Alerts Reports and Recalls", url: "https://www.gov.uk/product-safety-alerts-reports-recalls.atom", requireTaiwan: false, tags: ["en", "official", "regulatory", "recall", "product-safety", "uk"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "UK Drug and Device Alerts", url: "https://www.gov.uk/drug-device-alerts.atom", requireTaiwan: false, tags: ["en", "official", "regulatory", "recall", "health", "medical", "uk"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "Product Safety Australia Recalls", url: "https://www.productsafety.gov.au/rss/recalls.xml", requireTaiwan: false, tags: ["en", "official", "regulatory", "recall", "product-safety", "australia"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "SEC Press Releases", url: "https://www.sec.gov/news/pressreleases.rss", requireTaiwan: false, tags: ["en", "official", "regulatory", "finance", "enforcement"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "SEC Litigation Releases", url: "https://www.sec.gov/enforcement-litigation/litigation-releases/rss", requireTaiwan: false, tags: ["en", "official", "regulatory", "finance", "enforcement", "litigation"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "SEC Administrative Proceedings", url: "https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss", requireTaiwan: false, tags: ["en", "official", "regulatory", "finance", "enforcement", "administrative"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "SEC Trading Suspensions", url: "https://www.sec.gov/enforcement-litigation/trading-suspensions/rss", requireTaiwan: false, tags: ["en", "official", "regulatory", "finance", "enforcement", "trading-suspension"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "FDA Criminal Investigations Press Releases", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/oci-press-releases/rss.xml", requireTaiwan: false, tags: ["en", "official", "regulatory", "health", "criminal-investigation", "enforcement", "fda"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "FDA Outbreaks", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/fda-outbreaks/rss.xml", requireTaiwan: false, tags: ["en", "official", "regulatory", "health", "food-safety", "outbreak", "safety-alert", "fda"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "HKMA Press Releases", url: "https://www.hkma.gov.hk/eng/other-information/rss/rss_press-release.xml", requireTaiwan: false, tags: ["en", "zh", "official", "regulatory", "finance", "hong-kong", "banking"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "HKMA Guidelines", url: "https://www.hkma.gov.hk/eng/other-information/rss/rss_guidelines.xml", requireTaiwan: false, tags: ["en", "zh", "official", "regulatory", "finance", "hong-kong", "guidelines"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
    { name: "HKMA Circulars", url: "https://www.hkma.gov.hk/eng/other-information/rss/rss_circulars.xml", requireTaiwan: false, tags: ["en", "zh", "official", "regulatory", "finance", "hong-kong", "circulars"], sourceFamily: "regulatory", sourceKey: "rssFeeds", regulatory: true },
  ],
};

PUBLIC_RSS_FEED_PACKS.taiwanBusinessMedia = PUBLIC_RSS_FEED_PACKS.taiwanMedia
  .filter(feed => feed.sourceFamily === "taiwan_business_media")
  .map(feed => ({ ...feed }));

function decodeHtml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(value, max = 1200) {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function tagValue(block, tag) {
  const match = String(block || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function tagRaw(block, tag) {
  const match = String(block || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : "";
}

function allTagValues(block, tag) {
  const out = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let match;
  while ((match = pattern.exec(String(block || ""))) !== null) {
    const value = stripTags(match[1], 120);
    if (value) out.push(value);
  }
  return [...new Set(out)].slice(0, 20);
}

function allRssCategoryValues(block = "") {
  const source = String(block || "");
  const values = allTagValues(source, "category");
  for (const match of source.matchAll(/<category\b[^>]*(?:\/>|>)/gi)) {
    const tag = match[0];
    const value = attrValue(tag, "term") || attrValue(tag, "label");
    if (value) values.push(stripTags(value, 120));
  }
  return [...new Set(values.filter(Boolean))].slice(0, 20);
}

function attrValue(tag = "", attr = "") {
  const match = String(tag || "").match(new RegExp(`\\b${attr}=["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]).trim() : "";
}

function linkValue(block) {
  const direct = tagValue(block, "link");
  if (direct) return direct;
  const href = String(block || "").match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return href ? decodeHtml(href[1]).trim() : "";
}

function atomAlternateLinkValue(block) {
  const links = [...String(block || "").matchAll(/<link\b[^>]*>/gi)].map(match => match[0]);
  const alternate = links.find(tag => /rel=["']alternate["']/i.test(tag)) || links[0] || "";
  return attrValue(alternate, "href");
}

function rssMediaUrl(block = "") {
  const mediaTag = String(block || "").match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*(?:\/>|>)/i)?.[0] || "";
  const url = attrValue(mediaTag, "url") || attrValue(mediaTag, "href");
  return /^https?:\/\//i.test(url) ? url : "";
}

function rssMediaAttachment(block = "") {
  const mediaTag = String(block || "").match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*(?:\/>|>)/i)?.[0] || "";
  const url = attrValue(mediaTag, "url") || attrValue(mediaTag, "href");
  if (!/^https?:\/\//i.test(url)) return {};
  return {
    url,
    type: attrValue(mediaTag, "type"),
    medium: attrValue(mediaTag, "medium"),
    length: attrValue(mediaTag, "length"),
  };
}

function rssCommentsUrl(block = "") {
  const comments = tagValue(block, "comments");
  return /^https?:\/\//i.test(comments) ? comments : "";
}

function rssCommentRssUrl(block = "") {
  const direct = tagValue(block, "wfw:commentRss") || tagValue(block, "commentRss");
  if (/^https?:\/\//i.test(direct)) return direct;
  const links = [...String(block || "").matchAll(/<(?:atom:)?link\b[^>]*(?:\/>|>)/gi)].map(match => match[0]);
  const replies = links.find(tag => {
    const rel = attrValue(tag, "rel").toLowerCase();
    const type = attrValue(tag, "type").toLowerCase();
    return rel === "replies" && /(rss|atom|xml|json)/i.test(type);
  }) || "";
  const href = attrValue(replies, "href") || attrValue(replies, "url");
  return /^https?:\/\//i.test(href) ? href : "";
}

function rssCommentCount(block = "") {
  const raw = tagValue(block, "slash:comments") || tagValue(block, "thr:total") || tagValue(block, "commentsCount");
  const count = Number(String(raw || "").replace(/,/g, "").trim());
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
}

function rssGuidInfo(block = "") {
  const guidTag = String(block || "").match(/<guid\b[^>]*>[\s\S]*?<\/guid>/i)?.[0] || "";
  const value = tagValue(guidTag || block, "guid") || tagValue(block, "id");
  const isPermalink = /ispermalink=["']?true["']?/i.test(guidTag);
  const permalink = isPermalink && /^https?:\/\//i.test(value) ? normalizeRssArticleUrl(value) : "";
  return {
    value,
    isPermalink,
    permalink,
  };
}

function sitemapImageUrl(block = "") {
  const direct = tagValue(block, "image:loc") || tagValue(block, "image");
  return /^https?:\/\//i.test(direct) ? direct : "";
}

function decodeUriText(value = "") {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function sitemapUrlDerivedTitle(rawUrl = "") {
  const cleaned = stripTags(rawUrl, 1200);
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const slug = url.searchParams.get("id") || pathParts[pathParts.length - 1] || "";
    const decoded = decodeUriText(slug)
      .replace(/\.(html?|php|aspx?)$/i, "")
      .replace(/^\d+[-_]?/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripTags(decoded, 240);
  } catch {
    return "";
  }
}

function normalizePublishedAt(value) {
  if (value == null || value === "") return new Date().toISOString();
  const raw = typeof value === "string" ? value.trim() : value;
  if (typeof raw === "number" || (/^\d{10,13}$/.test(String(raw || "")))) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      const time = new Date(ms).getTime();
      return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
    }
  }
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function normalizeRssDedupeUrl(rawUrl = "") {
  const cleaned = stripTags(rawUrl, 1200);
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    const embedded = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizeRssDedupeUrl(embedded);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "ocid",
      "cid",
      "ref",
      "ref_src",
      "source",
      "mc_cid",
      "mc_eid",
      "cmpid",
      "ito",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/amp\/?$/i, "").replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return cleaned.toLowerCase();
  }
}

function normalizeRssArticleUrl(rawUrl = "") {
  const cleaned = decodeHtml(rawUrl || "").trim();
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
    ]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return cleaned;
  }
}

function normalizeRssDirectUrls(directUrls = []) {
  const raw = Array.isArray(directUrls)
    ? directUrls
    : typeof directUrls === "string"
      ? directUrls.split(/[\n,，]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const normalized = normalizeRssArticleUrl(value);
    const dedupe = normalizeRssDedupeUrl(normalized);
    if (!normalized || !dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(normalized);
  }
  return out;
}

function rssDirectUrlDerivedTitle(rawUrl = "", keyword = "") {
  const key = stripTags(keyword, 120);
  const fallback = key ? `${key} official notice` : "Direct official notice";
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const slug = decodeUriText(parts[parts.length - 1] || parts.slice(-2).join(" ") || url.hostname)
      .replace(/\.(html?|php|aspx?|jsp)$/i, "")
      .replace(/^\d+[-_]?/, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripTags([key, slug].filter(Boolean).join(" "), 240) || fallback;
  } catch {
    return fallback;
  }
}

function directRssFeedItem(url = "", keyword = "", feed = {}) {
  const cleanedUrl = normalizeRssArticleUrl(url);
  if (!/^https?:\/\//i.test(cleanedUrl)) return null;
  return {
    title: rssDirectUrlDerivedTitle(cleanedUrl, keyword),
    url: cleanedUrl,
    content: "",
    publishedAt: new Date().toISOString(),
    author: feed.name || "Direct URL",
    guid: cleanedUrl,
    categories: [],
    media_url: "",
    comments_url: "",
    feed_item_format: "direct-url",
    metrics: {
      rss_direct_url: cleanedUrl,
      rss_direct_url_recovery: true,
      rss_collection_mode: "direct-url",
    },
  };
}

function hostFromRssUrl(rawUrl = "") {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function directRssFeedForUrl(directUrl = "", feeds = []) {
  const directHost = hostFromRssUrl(directUrl);
  if (!directHost) return feeds[0] || {};
  return (feeds || []).find(feed => {
    const candidates = [feed.url, feed.homeUrl, feed.baseUrl, feed.baseFeedUrl].map(hostFromRssUrl).filter(Boolean);
    return candidates.some(host => directHost === host || directHost.endsWith(`.${host}`) || host.endsWith(`.${directHost}`));
  }) || feeds[0] || {};
}

function isRssAggregatorNewsUrl(rawUrl = "") {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return /(^|\.)news\.google\.com$|(^|\.)bing\.com$|(^|\.)msn\.com$/.test(host);
  } catch {
    return false;
  }
}

function rssDescriptionArticleUrl(descriptionHtml = "", fallbackUrl = "") {
  const source = decodeHtml(descriptionHtml);
  const fallback = normalizeRssArticleUrl(fallbackUrl);
  const links = [...source.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
    .map(match => normalizeRssArticleUrl(match[1]))
    .filter(Boolean);
  return links.find(url => !isRssAggregatorNewsUrl(url)) || fallback;
}

function rssSourceUrl(block = "") {
  const sourceTag = String(block || "").match(/<source\b[^>]*url=["']([^"']+)["'][^>]*>/i);
  return normalizeRssArticleUrl(sourceTag?.[1] || "");
}

function rssSourceInfo(block = "") {
  const sourceBlock = String(block || "").match(/<source\b[^>]*>[\s\S]*?<\/source>/i)?.[0] || "";
  const sourceOpenTag = sourceBlock.match(/<source\b[^>]*>/i)?.[0] || String(block || "").match(/<source\b[^>]*(?:\/>|>)/i)?.[0] || "";
  const url = normalizeRssArticleUrl(
    attrValue(sourceOpenTag, "url")
    || attrValue(String(sourceBlock || "").match(/<link\b[^>]*(?:\/>|>)/i)?.[0] || "", "href")
    || ""
  );
  const name = tagValue(sourceBlock, "title") || stripTags(sourceBlock.replace(/<link\b[^>]*(?:\/>|>)/gi, ""), 180);
  return {
    url,
    name: stripTags(name, 180),
  };
}

function rssItemDedupeKey(item = {}) {
  return normalizeRssDedupeUrl(item?.url || "");
}

function normalizeRssKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function rssKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeRssKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function rssValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeRssKeywordText(value);
  return rssKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeRssKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return stripTags(value, 1200);
    if (value != null && typeof value !== "object" && String(value).trim()) return stripTags(String(value), 1200);
  }
  return "";
}

function jsonFeedAuthor(item = {}, feed = {}, feedName = "") {
  const authors = Array.isArray(item.authors) ? item.authors : [];
  const feedAuthors = Array.isArray(feed.authors) ? feed.authors : [];
  const candidates = [
    item.author?.name,
    item.author?.url,
    authors[0]?.name,
    authors[0]?.url,
    feed.author?.name,
    feed.author?.url,
    feedAuthors[0]?.name,
    feedAuthors[0]?.url,
    feedName,
  ];
  return firstText(...candidates);
}

function jsonFeedCategories(item = {}) {
  const values = [
    ...(Array.isArray(item.tags) ? item.tags : []),
    ...(Array.isArray(item._tags) ? item._tags : []),
    ...(Array.isArray(item.categories) ? item.categories : []),
  ];
  return [...new Set(values.map(value => stripTags(value, 80)).filter(Boolean))].slice(0, 20);
}

function jsonFeedMediaUrl(item = {}) {
  const direct = firstText(item.image, item.banner_image);
  if (/^https?:\/\//i.test(direct)) return direct;
  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  const media = attachments.find(attachment => /^image\//i.test(String(attachment?.mime_type || "")) && /^https?:\/\//i.test(String(attachment?.url || "")));
  return media?.url || "";
}

function jsonFeedCommentsUrl(item = {}) {
  const url = firstText(item.comments_url, item.comment_url, item._comments_url);
  return /^https?:\/\//i.test(url) ? url : "";
}

function normalizePathList(value = []) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\n]+/).map(item => item.trim()).filter(Boolean);
  return [];
}

function valueAtPath(source, path = "") {
  if (!path) return undefined;
  const parts = String(path).split(".").map(part => part.trim()).filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function firstPathValue(source = {}, paths = []) {
  for (const path of normalizePathList(paths)) {
    const value = valueAtPath(source, path);
    if (Array.isArray(value)) {
      const first = firstText(...value);
      if (first) return first;
      continue;
    }
    const text = firstText(value);
    if (text) return text;
  }
  return "";
}

function customJsonCategories(row = {}, feed = {}) {
  const values = [];
  for (const path of normalizePathList(feed.categoryFields || feed.categoryField)) {
    const value = valueAtPath(row, path);
    if (Array.isArray(value)) {
      values.push(...value);
    } else if (value != null) {
      values.push(value);
    }
  }
  return [...new Set(values
    .map(value => stripTags(typeof value === "string" ? value : JSON.stringify(value), 80))
    .filter(Boolean))]
    .slice(0, 20);
}

function configuredJsonFeedItems(text = "", feed = {}, { maxItems = DEFAULT_MAX_ITEMS_PER_FEED } = {}) {
  if (feed.format !== "json-custom" && !feed.itemsPath) return [];
  let parsed;
  try {
    parsed = JSON.parse(String(text || "").trim());
  } catch {
    return [];
  }
  const rows = valueAtPath(parsed, feed.itemsPath || "items");
  if (!Array.isArray(rows)) return [];
  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    let rawUrl = firstPathValue(row, feed.urlFields || feed.urlField);
    if (feed.urlTemplate && rawUrl) {
      rawUrl = String(feed.urlTemplate).replace(/\{value\}/g, encodeURIComponent(rawUrl));
    }
    const url = /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : rawUrl
        ? new URL(rawUrl, feed.baseUrl || feed.homeUrl || feed.url || "https://example.com/").toString()
        : "";
    const title = firstPathValue(row, feed.titleFields || feed.titleField).slice(0, 240);
    const content = firstPathValue(row, feed.contentFields || feed.contentField);
    const author = firstPathValue(row, feed.authorFields || feed.authorField) || feed.name || "";
    const publishedAt = normalizePublishedAt(firstPathValue(row, feed.publishedAtFields || feed.publishedAtField));
    const mediaUrl = firstPathValue(row, feed.mediaUrlFields || feed.mediaUrlField);
    const commentsUrl = firstPathValue(row, feed.commentsUrlFields || feed.commentsUrlField);
    const guid = firstPathValue(row, feed.guidFields || feed.guidField) || firstPathValue(row, feed.urlFields || feed.urlField) || url;
    const categories = customJsonCategories(row, feed);
    if (!title || !url) continue;
    items.push({
      title,
      url,
      content,
      publishedAt,
      author,
      guid,
      categories,
      media_url: /^https?:\/\//i.test(mediaUrl) ? mediaUrl : "",
      comments_url: /^https?:\/\//i.test(commentsUrl) ? commentsUrl : "",
      feed_item_format: "json-custom",
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

function rssFeedLinkByRel(source = "", rel = "") {
  const links = [...String(source || "").matchAll(/<(?:atom:)?link\b[^>]*(?:\/>|>)/gi)].map(match => match[0]);
  const wanted = String(rel || "").toLowerCase();
  const tag = links.find(item => attrValue(item, "rel").toLowerCase() === wanted) || "";
  const url = attrValue(tag, "href") || attrValue(tag, "url");
  return /^https?:\/\//i.test(url) ? url : "";
}

function rssFeedHubUrls(source = "") {
  const links = [...String(source || "").matchAll(/<(?:atom:)?link\b[^>]*(?:\/>|>)/gi)].map(match => match[0]);
  return [...new Set(links
    .filter(tag => attrValue(tag, "rel").toLowerCase() === "hub")
    .map(tag => attrValue(tag, "href") || attrValue(tag, "url"))
    .filter(url => /^https?:\/\//i.test(url)))].slice(0, 8);
}

function parseRssFeedMetadata(text = "", feedOrName = "") {
  const feed = typeof feedOrName === "object" && feedOrName
    ? feedOrName
    : { name: String(feedOrName || "") };
  const feedName = feed.name || "";
  const source = String(text || "");
  const trimmed = source.trim();
  if (feed.format === "json-custom" || feed.itemsPath) {
    return {
      feed_title: feedName,
      feed_home_url: feed.homeUrl || feed.baseUrl || "",
      feed_self_url: feed.url || "",
      feed_hub_urls: [],
      feed_websub_enabled: false,
      feed_ttl_minutes: null,
      feed_update_period: "",
      feed_update_frequency: null,
      feed_last_build_at: "",
      feed_generator: "custom-json-feed",
    };
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const hubs = (Array.isArray(parsed?.hubs) ? parsed.hubs : [])
        .map(hub => typeof hub === "string" ? hub : hub?.url)
        .filter(url => /^https?:\/\//i.test(String(url || "")))
        .slice(0, 8);
      return {
        feed_title: firstText(parsed.title, feedName),
        feed_home_url: /^https?:\/\//i.test(String(parsed.home_page_url || "")) ? parsed.home_page_url : "",
        feed_self_url: /^https?:\/\//i.test(String(parsed.feed_url || "")) ? parsed.feed_url : "",
        feed_hub_urls: [...new Set(hubs)],
        feed_websub_enabled: hubs.length > 0,
        feed_ttl_minutes: null,
        feed_update_period: "",
        feed_update_frequency: null,
        feed_last_build_at:
          parsed.date_modified || parsed.date_updated
            ? normalizePublishedAt(parsed.date_modified || parsed.date_updated)
            : "",
        feed_generator: firstText(parsed.generator?.name, parsed.generator, ""),
      };
    } catch {
      return {};
    }
  }
  if (/<urlset[\s>]/i.test(source) && /<news:news[\s>]/i.test(source)) {
    const publicationName = tagValue(source, "news:name") || feedName;
    return {
      feed_title: publicationName || feedName,
      feed_home_url: feed.homeUrl || feed.baseUrl || "",
      feed_self_url: feed.url || "",
      feed_hub_urls: [],
      feed_websub_enabled: false,
      feed_ttl_minutes: null,
      feed_update_period: "",
      feed_update_frequency: null,
      feed_last_build_at: normalizePublishedAt(tagValue(source, "news:publication_date") || tagValue(source, "lastmod")),
      feed_generator: "news-sitemap",
    };
  }
  if (/<urlset[\s>]/i.test(source)) {
    return {
      feed_title: feedName,
      feed_home_url: feed.homeUrl || feed.baseUrl || "",
      feed_self_url: feed.url || "",
      feed_hub_urls: [],
      feed_websub_enabled: false,
      feed_ttl_minutes: null,
      feed_update_period: "",
      feed_update_frequency: null,
      feed_last_build_at: normalizePublishedAt(tagValue(source, "lastmod")),
      feed_generator: "urlset-sitemap",
    };
  }
  if (/<sitemapindex[\s>]/i.test(source)) {
    return {
      feed_title: feedName,
      feed_home_url: feed.homeUrl || feed.baseUrl || "",
      feed_self_url: feed.url || "",
      feed_hub_urls: [],
      feed_websub_enabled: false,
      feed_ttl_minutes: null,
      feed_update_period: "",
      feed_update_frequency: null,
      feed_last_build_at: normalizePublishedAt(tagValue(source, "lastmod")),
      feed_generator: "sitemap-index",
    };
  }
  const ttl = Number(tagValue(source, "ttl"));
  const updateFrequency = Number(tagValue(source, "sy:updateFrequency"));
  const hubUrls = rssFeedHubUrls(source);
  const lastBuildRaw = tagValue(source, "lastBuildDate") || tagValue(source, "updated") || tagValue(source, "modified");
  return {
    feed_title: tagValue(source, "title") || feedName,
    feed_home_url: tagValue(source, "link"),
    feed_self_url: rssFeedLinkByRel(source, "self"),
    feed_hub_urls: hubUrls,
    feed_websub_enabled: hubUrls.length > 0,
    feed_ttl_minutes: Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    feed_update_period: tagValue(source, "sy:updatePeriod"),
    feed_update_frequency: Number.isFinite(updateFrequency) && updateFrequency > 0 ? updateFrequency : null,
    feed_last_build_at: lastBuildRaw ? normalizePublishedAt(lastBuildRaw) : "",
    feed_generator: tagValue(source, "generator"),
  };
}

function parseJsonFeedItems(text, feedName, { maxItems = DEFAULT_MAX_ITEMS_PER_FEED } = {}) {
  const source = String(text || "").trim();
  if (!source.startsWith("{")) return [];
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed?.items) ? parsed.items : [];
  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = firstText(row.id);
    const url = firstText(row.url, row.external_url, /^https?:\/\//i.test(id) ? id : "");
    const content = firstText(row.content_text, row.content_html, row.summary);
    const title = firstText(row.title, row.summary, row.content_text, row.content_html, url, id).slice(0, 240);
    if (!title || !url) continue;
    items.push({
      title,
      url,
      content,
      publishedAt: normalizePublishedAt(row.date_published || row.date_modified || row.date_updated),
      author: jsonFeedAuthor(row, parsed, feedName),
      guid: id || url,
      categories: jsonFeedCategories(row),
      media_url: jsonFeedMediaUrl(row),
      comments_url: jsonFeedCommentsUrl(row),
      feed_item_format: "json-feed",
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

function parseNewsSitemapItems(text = "", feedName = "", { maxItems = DEFAULT_MAX_ITEMS_PER_FEED } = {}) {
  const source = String(text || "");
  if (!/<urlset[\s>]/i.test(source) || !/<news:news[\s>]/i.test(source)) return [];
  const blocks = [...source.matchAll(/<url(?:\s[^>]*)?>[\s\S]*?<\/url>/gi)].map(match => match[0]);
  const items = [];
  for (const block of blocks) {
    const title = tagValue(block, "news:title") || tagValue(block, "title");
    const url = tagValue(block, "loc");
    const author = tagValue(block, "news:name") || feedName;
    const publishedAt = normalizePublishedAt(
      tagValue(block, "news:publication_date")
      || tagValue(block, "lastmod")
    );
    const categories = allTagValues(block, "news:keywords");
    const mediaUrl = sitemapImageUrl(block);
    if (!title || !url) continue;
    items.push({
      title,
      url,
      content: "",
      publishedAt,
      author,
      guid: url,
      categories,
      media_url: mediaUrl,
      comments_url: "",
      feed_item_format: "news-sitemap",
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

function parseUrlsetSitemapItems(text = "", feedName = "", { maxItems = DEFAULT_MAX_ITEMS_PER_FEED } = {}) {
  const source = String(text || "");
  if (!/<urlset[\s>]/i.test(source)) return [];
  const blocks = [...source.matchAll(/<url(?:\s[^>]*)?>[\s\S]*?<\/url>/gi)].map(match => match[0]);
  const items = [];
  for (const block of blocks) {
    const url = tagValue(block, "loc");
    const title = tagValue(block, "news:title") || tagValue(block, "title") || sitemapUrlDerivedTitle(url);
    const author = tagValue(block, "news:name") || feedName;
    const publishedAt = normalizePublishedAt(
      tagValue(block, "news:publication_date")
      || tagValue(block, "lastmod")
    );
    const categories = allTagValues(block, "news:keywords");
    const mediaUrl = sitemapImageUrl(block);
    if (!title || !url) continue;
    items.push({
      title,
      url,
      content: "",
      publishedAt,
      author,
      guid: url,
      categories,
      media_url: mediaUrl,
      comments_url: "",
      feed_item_format: /<news:news[\s>]/i.test(block) ? "news-sitemap" : "urlset-sitemap",
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

function parseSitemapIndexUrls(text = "") {
  const source = String(text || "");
  if (!/<sitemapindex[\s>]/i.test(source)) return [];
  return [...new Set(
    [...source.matchAll(/<sitemap(?:\s[^>]*)?>[\s\S]*?<\/sitemap>/gi)]
      .map(match => tagValue(match[0], "loc"))
      .filter(url => /^https?:\/\//i.test(url))
  )];
}

function normalizeFeeds(feeds = []) {
  return (Array.isArray(feeds) ? feeds : [])
    .map(feed => typeof feed === "string" ? { name: feed, url: feed } : feed)
    .map(feed => ({
      name: stripTags(feed?.name || feed?.label || feed?.url || "RSS", 160),
      url: String(feed?.url || "").trim(),
      enabled: feed?.enabled !== false && feed?.enabled !== 0,
      requireTaiwan: feed?.requireTaiwan !== false,
      tags: Array.isArray(feed?.tags) ? feed.tags.map(tag => stripTags(tag, 60)).filter(Boolean).slice(0, 16) : [],
      sourceFamily: stripTags(feed?.sourceFamily || feed?.source_family || "", 80),
      sourceKey: stripTags(feed?.sourceKey || feed?.source_key || "", 80),
      pack: stripTags(feed?.pack || feed?.feedPack || feed?.feed_pack || "", 80),
      regulatory: Boolean(feed?.regulatory),
      format: stripTags(feed?.format || "", 40).toLowerCase(),
      itemsPath: stripTags(feed?.itemsPath || feed?.items_path || "", 160),
      titleFields: normalizePathList(feed?.titleFields || feed?.title_fields || feed?.titleField || feed?.title_field),
      urlFields: normalizePathList(feed?.urlFields || feed?.url_fields || feed?.urlField || feed?.url_field),
      contentFields: normalizePathList(feed?.contentFields || feed?.content_fields || feed?.contentField || feed?.content_field),
      publishedAtFields: normalizePathList(feed?.publishedAtFields || feed?.published_at_fields || feed?.publishedAtField || feed?.published_at_field),
      authorFields: normalizePathList(feed?.authorFields || feed?.author_fields || feed?.authorField || feed?.author_field),
      categoryFields: normalizePathList(feed?.categoryFields || feed?.category_fields || feed?.categoryField || feed?.category_field),
      mediaUrlFields: normalizePathList(feed?.mediaUrlFields || feed?.media_url_fields || feed?.mediaUrlField || feed?.media_url_field),
      commentsUrlFields: normalizePathList(feed?.commentsUrlFields || feed?.comments_url_fields || feed?.commentsUrlField || feed?.comments_url_field),
      guidFields: normalizePathList(feed?.guidFields || feed?.guid_fields || feed?.guidField || feed?.guid_field),
      baseUrl: String(feed?.baseUrl || feed?.base_url || "").trim(),
      homeUrl: String(feed?.homeUrl || feed?.home_url || "").trim(),
      urlTemplate: String(feed?.urlTemplate || feed?.url_template || "").trim(),
      keywordSearchUrlTemplate: String(feed?.keywordSearchUrlTemplate || feed?.keyword_search_url_template || feed?.searchUrlTemplate || feed?.search_url_template || "").trim(),
      keywordSearchKeyword: stripTags(feed?.keywordSearchKeyword || feed?.keyword_search_keyword || "", 160),
      baseFeedUrl: String(feed?.baseFeedUrl || feed?.base_feed_url || "").trim(),
      baseFeedName: stripTags(feed?.baseFeedName || feed?.base_feed_name || "", 160),
      sitemapChildStrategy: stripTags(feed?.sitemapChildStrategy || feed?.sitemap_child_strategy || "", 40).toLowerCase(),
      childSitemapLimit: Math.max(1, Math.min(5, Number(feed?.childSitemapLimit || feed?.child_sitemap_limit || 1) || 1)),
    }))
    .filter(feed => feed.enabled !== false && /^https?:\/\//i.test(feed.url));
}

function encodeFeedSearchQuery(keyword = "") {
  return encodeURIComponent(stripTags(keyword, 160)).replace(/%20/g, "+");
}

function keywordSearchFeedUrl(template = "", keyword = "") {
  const query = encodeFeedSearchQuery(keyword);
  if (!template || !query) return "";
  return String(template)
    .replace(/\{query\}/g, query)
    .replace(/\{query_plus\}/g, query)
    .replace(/\{rawQuery\}/g, stripTags(keyword, 160));
}

const RSS_INDEX_DEEP_QUERY_TERMS = Object.freeze({
  default: ["投訴", "官方聲明", "爆料"],
  taiwan_media: ["投訴", "官方聲明", "社群擴散"],
  taiwan_business_media: ["投訴", "財報", "投資人"],
  taiwan_public_interest_media: ["投訴", "調查", "官方回應"],
  regulatory: ["裁罰", "公告", "警告"],
  consumer_protection: ["投訴", "爭議", "退款"],
  security_media: ["漏洞", "資料外洩", "資安公告"],
  global_business_media: ["lawsuit", "investor", "official statement"],
});

function isRssIndexSearchFeed(feed = {}) {
  const tags = Array.isArray(feed.tags) ? feed.tags.map(tag => String(tag || "").toLowerCase()) : [];
  const template = String(feed.keywordSearchUrlTemplate || "").toLowerCase();
  return tags.includes("google-news-index")
    || tags.includes("bing-news-index")
    || template.includes("news.google.com/rss/search")
    || template.includes("bing.com/news/search");
}

function rssIndexDeepQueryTerms(feed = {}, limit = 3) {
  if (!isRssIndexSearchFeed(feed)) return [];
  const family = String(feed.sourceFamily || feed.source_family || "").trim();
  const terms = RSS_INDEX_DEEP_QUERY_TERMS[family] || RSS_INDEX_DEEP_QUERY_TERMS.default;
  return [...new Set(terms.map(term => stripTags(term, 80)).filter(Boolean))]
    .slice(0, Math.max(0, Math.min(8, Number(limit) || 3)));
}

function rssDeepSearchKeywordsForFeed(feed = {}, keywords = [], { maxDeepQueriesPerFeed = 3 } = {}) {
  const base = (Array.isArray(keywords) ? keywords : [])
    .map(keyword => stripTags(keyword, 160))
    .filter(Boolean);
  if (!base.length || !isRssIndexSearchFeed(feed)) return [];
  const primary = base[0];
  const out = [];
  for (const term of rssIndexDeepQueryTerms(feed, maxDeepQueriesPerFeed)) {
    if (out.length >= Math.max(0, Math.min(12, Number(maxDeepQueriesPerFeed) || 3))) break;
    const lower = primary.toLowerCase();
    if (lower.includes(String(term).toLowerCase())) continue;
    const query = stripTags(`${primary} ${term}`, 180);
    if (query && !out.includes(query)) out.push(query);
  }
  return out;
}

function expandFeedsForKeywords(feeds = [], keywords = [], { maxKeywordsPerFeed = 8, maxDeepQueriesPerFeed = 3 } = {}) {
  const normalizedFeeds = normalizeFeeds(feeds);
  const normalizedKeywords = (Array.isArray(keywords) ? keywords : [])
    .map(keyword => stripTags(keyword, 160))
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(20, Number(maxKeywordsPerFeed) || 8)));
  if (!normalizedKeywords.length) return normalizedFeeds;
  const expanded = [...normalizedFeeds];
  for (const feed of normalizedFeeds) {
    if (!feed.keywordSearchUrlTemplate) continue;
    const feedKeywords = [
      ...normalizedKeywords,
      ...rssDeepSearchKeywordsForFeed(feed, normalizedKeywords, { maxDeepQueriesPerFeed }),
    ];
    for (const keyword of feedKeywords) {
      const url = keywordSearchFeedUrl(feed.keywordSearchUrlTemplate, keyword);
      if (!/^https?:\/\//i.test(url)) continue;
      const deepKeyword = !normalizedKeywords.includes(keyword);
      expanded.push({
        ...feed,
        name: `${feed.name}｜${keyword}`,
        url,
        baseFeedUrl: feed.baseFeedUrl || feed.url,
        baseFeedName: feed.baseFeedName || feed.name,
        keywordSearchKeyword: keyword,
        keywordSearchUrlTemplate: "",
        tags: [...new Set([...(feed.tags || []), "keyword-search", ...(deepKeyword ? ["deep-keyword-search"] : [])])],
      });
    }
  }
  return mergeFeeds(expanded);
}

function normalizeFeedPackKeys(feedPacks) {
  if (Array.isArray(feedPacks)) return feedPacks.map(value => String(value || "").trim()).filter(Boolean);
  const values = Array.isArray(feedPacks)
    ? feedPacks
    : typeof feedPacks === "string"
      ? feedPacks.split(/[,\s，、;；]+/)
      : ["chineseNews"];
  const keys = values.map(value => String(value || "").trim()).filter(Boolean);
  return keys.length ? keys : ["chineseNews"];
}

function feedsFromPacks(feedPacks = ["chineseNews"]) {
  const out = [];
  for (const key of normalizeFeedPackKeys(feedPacks)) {
    if (key === "all") {
      for (const [packKey, feeds] of Object.entries(PUBLIC_RSS_FEED_PACKS)) {
        out.push(...feeds.map(feed => ({ ...feed, pack: packKey })));
      }
      continue;
    }
    out.push(...(PUBLIC_RSS_FEED_PACKS[key] || []).map(feed => ({ ...feed, pack: key })));
  }
  return out;
}

export function listPublicRssFeedPacks() {
  return Object.entries(PUBLIC_RSS_FEED_PACKS).map(([key, feeds]) => ({
    key,
    ...(PUBLIC_RSS_FEED_PACK_METADATA[key] || {}),
    feeds: feeds.map(feed => ({
      name: feed.name,
      aliases: Array.isArray(feed.aliases) ? feed.aliases : [],
      url: feed.url,
      requireTaiwan: feed.requireTaiwan !== false,
      tags: Array.isArray(feed.tags) ? feed.tags : [],
      sourceFamily: feed.sourceFamily || "",
      regulatory: Boolean(feed.regulatory),
    })),
  }));
}

function mergeFeeds(feeds = []) {
  const seen = new Set();
  const out = [];
  for (const feed of normalizeFeeds(feeds)) {
    const key = feed.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(feed);
  }
  return out;
}

function budgetItemsPerFeed(budget = {}) {
  const value = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_FEED));
  return Math.max(1, Math.min(80, Number.isFinite(value) ? value : DEFAULT_MAX_ITEMS_PER_FEED));
}

function feedCursorKey(url = "") {
  return String(url || "").trim().toLowerCase();
}

function normalizeFeedCursor(cursor = {}) {
  const rows = cursor?.rssFeedCursors || cursor?.rss_feed_cursors || cursor?.feeds || {};
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) return {};
  return Object.fromEntries(Object.entries(rows)
    .map(([url, value]) => {
      const key = feedCursorKey(url);
      if (!key || !value || typeof value !== "object") return null;
      return [key, {
        etag: String(value.etag || ""),
        last_modified: String(value.last_modified || value.lastModified || ""),
        last_status: Number(value.last_status || value.lastStatus || 0) || null,
        last_checked_at: String(value.last_checked_at || value.lastCheckedAt || ""),
        last_changed_at: String(value.last_changed_at || value.lastChangedAt || ""),
        last_error: String(value.last_error || value.lastError || ""),
        feed_self_url: String(value.feed_self_url || value.feedSelfUrl || ""),
        feed_hub_urls: Array.isArray(value.feed_hub_urls) ? value.feed_hub_urls : Array.isArray(value.feedHubUrls) ? value.feedHubUrls : [],
        feed_websub_enabled: Boolean(value.feed_websub_enabled || value.feedWebsubEnabled),
        feed_ttl_minutes: Number(value.feed_ttl_minutes || value.feedTtlMinutes || 0) || null,
        feed_update_period: String(value.feed_update_period || value.feedUpdatePeriod || ""),
        feed_update_frequency: Number(value.feed_update_frequency || value.feedUpdateFrequency || 0) || null,
        feed_last_build_at: String(value.feed_last_build_at || value.feedLastBuildAt || ""),
      }];
    })
    .filter(Boolean));
}

function conditionalHeadersForFeed(feed = {}, cursor = {}) {
  const row = normalizeFeedCursor(cursor)[feedCursorKey(feed.url)] || {};
  const headers = {};
  if (row.etag) headers["If-None-Match"] = row.etag;
  if (row.last_modified) headers["If-Modified-Since"] = row.last_modified;
  return headers;
}

function feedHttpCursor(feed = {}, res = null, { status = 0, previous = {}, checkedAt = new Date().toISOString(), changed = false, feedMeta = {}, error = "" } = {}) {
  const etag = res?.headers?.get?.("etag") || previous.etag || "";
  const lastModified = res?.headers?.get?.("last-modified") || previous.last_modified || previous.lastModified || "";
  const statusCode = Number(status || res?.status || 0) || null;
  return {
    url: feed.url || "",
    name: feed.name || "",
    etag,
    last_modified: lastModified,
    last_status: statusCode,
    last_checked_at: checkedAt,
    last_changed_at: changed ? checkedAt : (previous.last_changed_at || previous.lastChangedAt || ""),
    last_error: error ? String(error).slice(0, 1000) : "",
    feed_self_url: feedMeta.feed_self_url || previous.feed_self_url || "",
    feed_hub_urls: Array.isArray(feedMeta.feed_hub_urls) && feedMeta.feed_hub_urls.length ? feedMeta.feed_hub_urls : (previous.feed_hub_urls || []),
    feed_websub_enabled: Boolean(feedMeta.feed_websub_enabled || previous.feed_websub_enabled),
    feed_ttl_minutes: feedMeta.feed_ttl_minutes || previous.feed_ttl_minutes || null,
    feed_update_period: feedMeta.feed_update_period || previous.feed_update_period || "",
    feed_update_frequency: feedMeta.feed_update_frequency || previous.feed_update_frequency || null,
    feed_last_build_at: feedMeta.feed_last_build_at || previous.feed_last_build_at || "",
  };
}

function parseRssFeedItems(xml, feedOrName, { maxItems = DEFAULT_MAX_ITEMS_PER_FEED } = {}) {
  const feed = typeof feedOrName === "object" && feedOrName
    ? feedOrName
    : { name: String(feedOrName || "") };
  const feedName = feed.name || "";
  const source = String(xml || "");
  const configuredItems = configuredJsonFeedItems(source, feed, { maxItems });
  if (configuredItems.length) return configuredItems;
  const jsonItems = parseJsonFeedItems(source, feedName, { maxItems });
  if (jsonItems.length) return jsonItems;
  const sitemapItems = parseNewsSitemapItems(source, feedName, { maxItems });
  if (sitemapItems.length) return sitemapItems;
  const genericSitemapItems = parseUrlsetSitemapItems(source, feedName, { maxItems });
  if (genericSitemapItems.length) return genericSitemapItems;
  const blocks = [
    ...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi),
    ...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi),
  ].map(match => match[0]);
  const items = [];
  for (const block of blocks) {
    const title = tagValue(block, "title");
    const feedUrl = linkValue(block) || atomAlternateLinkValue(block);
    const descriptionRaw = tagRaw(block, "description");
    const guidInfo = rssGuidInfo(block);
    const url = rssDescriptionArticleUrl(descriptionRaw, feedUrl || guidInfo.permalink);
    const aggregatorUrl = url !== feedUrl && isRssAggregatorNewsUrl(feedUrl) ? feedUrl : "";
    const sourceInfo = rssSourceInfo(block);
    const sourceUrl = sourceInfo.url || rssSourceUrl(block);
    const sourceName = sourceInfo.name || tagValue(block, "source");
    const content = stripTags(descriptionRaw)
      || tagValue(block, "summary")
      || tagValue(block, "content:encoded")
      || tagValue(block, "content");
    const guid = guidInfo.value || tagValue(block, "id");
    const author = tagValue(block, "dc:creator")
      || tagValue(block, "author")
      || tagValue(block, "name")
      || sourceName
      || feedName;
    const categories = allRssCategoryValues(block);
    const mediaAttachment = rssMediaAttachment(block);
    const mediaUrl = mediaAttachment.url || rssMediaUrl(block);
    const commentsUrl = rssCommentsUrl(block);
    const commentRssUrl = rssCommentRssUrl(block);
    const commentCount = rssCommentCount(block);
    const publishedAt = normalizePublishedAt(
      tagValue(block, "pubDate")
      || tagValue(block, "published")
      || tagValue(block, "updated")
      || tagValue(block, "dc:date")
    );
    if (!title || !url) continue;
    items.push({
      title,
      url,
      content,
      publishedAt,
      author,
      guid,
      categories,
      media_url: mediaUrl,
      comments_url: commentsUrl,
      comment_rss_url: commentRssUrl,
      comment_count: commentCount,
      source_url: sourceUrl,
      source_name: sourceName,
      media_type: mediaAttachment.type || "",
      media_medium: mediaAttachment.medium || "",
      media_length: mediaAttachment.length || "",
      metrics: {
        ...(aggregatorUrl ? { rss_aggregator_url: aggregatorUrl } : {}),
        ...(url && url !== feedUrl ? { rss_original_url: url, rss_original_url_resolved: true } : {}),
        ...(sourceUrl ? { rss_source_url: sourceUrl } : {}),
        ...(sourceName ? { rss_source_name: sourceName } : {}),
        ...(guidInfo.permalink ? { rss_guid_permalink_url: guidInfo.permalink } : {}),
        ...(commentRssUrl ? { rss_comment_rss_url: commentRssUrl } : {}),
        ...(commentCount != null ? { rss_comment_count: commentCount } : {}),
        ...(mediaAttachment.type ? { rss_media_type: mediaAttachment.type } : {}),
        ...(mediaAttachment.medium ? { rss_media_medium: mediaAttachment.medium } : {}),
      },
      feed_item_format: /<entry(?:\s[^>]*)?>/i.test(block) ? "atom" : "rss",
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

function countRssFeedRawItems(xml) {
  const source = String(xml || "").trim();
  if (source.startsWith("{")) {
    try {
      const parsed = JSON.parse(source);
      return Array.isArray(parsed?.items) ? parsed.items.length : 0;
    } catch {
      return 0;
    }
  }
  if (/<urlset[\s>]/i.test(source) && /<news:news[\s>]/i.test(source)) {
    return [...source.matchAll(/<url(?:\s[^>]*)?>[\s\S]*?<\/url>/gi)].length;
  }
  if (/<urlset[\s>]/i.test(source)) {
    return [...source.matchAll(/<url(?:\s[^>]*)?>[\s\S]*?<\/url>/gi)].length;
  }
  if (/<sitemapindex[\s>]/i.test(source)) {
    return [...source.matchAll(/<sitemap(?:\s[^>]*)?>[\s\S]*?<\/sitemap>/gi)].length;
  }
  return [
    ...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi),
    ...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi),
  ].length;
}

function countConfiguredFeedRawItems(text = "", feed = {}) {
  if (feed.format !== "json-custom" && !feed.itemsPath) return null;
  try {
    const parsed = JSON.parse(String(text || "").trim());
    const rows = valueAtPath(parsed, feed.itemsPath || "items");
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

function selectChildSitemapUrls(urls = [], feed = {}) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(5, Number(feed.childSitemapLimit || 1) || 1));
  const strategy = String(feed.sitemapChildStrategy || "").toLowerCase();
  if (strategy === "last" || strategy === "latest") return list.slice(-limit);
  return list.slice(0, limit);
}

function matchKeyword(item, keywords) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${(item.categories || []).join(" ")} ${item.url || ""}`;
  return keywords.find(keyword => {
    return rssValueMatchesKeyword(text, keyword);
  }) || "";
}

function rssKeywordMatchSource(item = {}, keyword = "") {
  if (!rssKeywordNeedles(keyword).length) return "";
  if (rssValueMatchesKeyword(item.title, keyword)) return "title";
  if (rssValueMatchesKeyword(item.content, keyword)) return "content";
  if (rssValueMatchesKeyword(item.author, keyword)) return "author";
  if ((Array.isArray(item.categories) ? item.categories : []).some(category => rssValueMatchesKeyword(category, keyword))) return "category";
  if (rssValueMatchesKeyword(item.url, keyword)) return "url";
  return "feed_search";
}

function rssTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeRssKeywordText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeRssKeywordText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function rssMediaNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${(item.categories || []).join(" ")} ${item.url || ""}`;
  const evidenceTerms = rssTermMatches(text, [
    "screenshot", "proof", "evidence", "documents", "document", "records", "record", "timeline", "investigation", "report",
    "data", "filing", "court filing", "lawsuit", "complaint", "截图", "截圖", "证据", "證據", "文件", "记录", "紀錄",
    "时间线", "時間線", "调查", "調查", "報告", "报告", "訴訟", "诉讼",
  ]);
  const impactTerms = rssTermMatches(text, [
    "refund", "complaint", "customers", "users", "consumer", "loss", "damages", "outage", "breach", "privacy",
    "recall", "safety", "fraud", "scam", "boycott", "退款", "投诉", "投訴", "客诉", "客訴", "消费者", "消費者",
    "用户", "用戶", "损失", "損失", "隐私", "隱私", "泄露", "外洩", "召回", "安全", "詐騙", "诈骗", "抵制",
  ]);
  const responseTerms = rssTermMatches(text, [
    "official response", "company response", "statement", "apology", "apologized", "spokesperson", "said", "announced",
    "pledged", "promised", "corrective action", "remediation", "investigating", "responded", "官方回应", "官方回應",
    "声明", "聲明", "道歉", "致歉", "发言人", "發言人", "表示", "宣布", "承诺", "承諾", "整改", "调查中", "調查中",
  ]);
  const propagationTerms = rssTermMatches(text, [
    "viral", "spread", "spreading", "trending", "backlash", "media coverage", "social media", "widely shared",
    "public attention", "debate", "criticism", "scrutiny", "扩散", "擴散", "发酵", "發酵", "热议", "熱議",
    "社群", "社交媒体", "社交媒體", "舆论", "輿論", "关注", "關注", "批评", "批評",
  ]);
  const crisisTerms = rssTermMatches(text, [
    "crisis", "scandal", "controversy", "lawsuit", "probe", "investigation", "regulator", "enforcement", "warning",
    "recall", "breach", "fraud", "complaint", "危机", "危機", "丑闻", "醜聞", "争议", "爭議", "诉讼", "訴訟",
    "调查", "調查", "监管", "監管", "执法", "執法", "警告", "召回", "泄露", "外洩", "投诉", "投訴",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("rss-media-evidence-language");
  if (impactTerms.length) reasons.push("rss-media-impact-language");
  if (responseTerms.length) reasons.push("rss-media-response-language");
  if (propagationTerms.length) reasons.push("rss-media-propagation-language");
  if (crisisTerms.length) reasons.push("rss-media-crisis-language");
  const semanticSignals = [
    evidenceTerms.length,
    impactTerms.length,
    responseTerms.length,
    propagationTerms.length,
    crisisTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = evidenceTerms.length > 0
    && impactTerms.length > 0
    && responseTerms.length > 0
    && propagationTerms.length > 0
    && crisisTerms.length > 0
    && semanticSignals >= 5;
  if (completeNarrative) reasons.push("rss-media-complete-crisis-narrative");
  return {
    rss_media_evidence_signal: evidenceTerms.length ? 1 : 0,
    rss_media_impact_signal: impactTerms.length ? 1 : 0,
    rss_media_official_response_signal: responseTerms.length ? 1 : 0,
    rss_media_propagation_signal: propagationTerms.length ? 1 : 0,
    rss_media_crisis_signal: crisisTerms.length ? 1 : 0,
    rss_media_semantic_signal_count: semanticSignals,
    rss_media_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    rss_media_evidence_terms: evidenceTerms,
    rss_media_impact_terms: impactTerms,
    rss_media_response_terms: responseTerms,
    rss_media_propagation_terms: propagationTerms,
    rss_media_crisis_terms: crisisTerms,
    rss_media_narrative_reasons: reasons,
  };
}

function rssItemQualityScore(item = {}) {
  let score = 35;
  const contentLength = stripTags(`${item.title || ""} ${item.content || ""}`, 5000).length;
  if (item.url) score += 10;
  if (contentLength >= 120) score += 18;
  else if (contentLength >= 50) score += 8;
  if (item.author) score += 6;
  if (Array.isArray(item.categories) && item.categories.length) score += 6;
  if (item.guid) score += 5;
  if (item.media_url) score += 5;
  if (item.source_url) score += 5;
  if (item.comments_url || item.comment_rss_url) score += 4;
  if (Number(item.comment_count || 0) > 0) score += 3;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function rssItemRelevanceScore(item = {}, keyword = "") {
  const matchSource = rssKeywordMatchSource(item, keyword);
  const narrativeSignals = rssMediaNarrativeSignals(item);
  const semanticBoost = Math.min(20, Number(narrativeSignals.rss_media_semantic_signal_count || 0) * 4);
  const base = {
    title: 76,
    content: 68,
    author: 58,
    category: 58,
    url: 52,
    feed_search: 48,
  }[matchSource] || 42;
  return Math.max(0, Math.min(100, Math.round(base + semanticBoost)));
}

function rssEvidenceDepthProfile(item = {}, { enrichmentMetrics = {}, narrativeSignals = {}, feed = {}, sourceWeightTier = "" } = {}) {
  const reasons = [];
  let score = 18;
  const contentLength = stripTags(`${item.title || ""} ${item.content || ""}`, 8000).length;
  const articleBodyLength = Number(enrichmentMetrics.article_body_text_length || 0);
  const articleBodyQuality = Number(enrichmentMetrics.article_body_quality_score || 0);
  const semanticSignalCount = Number(narrativeSignals.rss_media_semantic_signal_count || 0);
  if (contentLength >= 1200) {
    score += 28;
    reasons.push("long-content");
  } else if (contentLength >= 500) {
    score += 20;
    reasons.push("medium-content");
  } else if (contentLength >= 160) {
    score += 12;
    reasons.push("short-content");
  }
  if (articleBodyLength >= 1200 || articleBodyQuality >= 70) {
    score += 18;
    reasons.push("article-body-extracted");
  } else if (articleBodyLength >= 400 || articleBodyQuality >= 45) {
    score += 10;
    reasons.push("article-body-partial");
  }
  if (item.author) {
    score += 6;
    reasons.push("has-author");
  }
  if (Array.isArray(item.categories) && item.categories.length) {
    score += 6;
    reasons.push("has-categories");
  }
  if (item.media_url || enrichmentMetrics.has_image) {
    score += 5;
    reasons.push("has-visual-context");
  }
  if (item.comments_url || item.comment_rss_url || Number(item.comment_count || 0) > 0 || Number(enrichmentMetrics.engagement_comment_count || 0) > 0) {
    score += 6;
    reasons.push("has-comment-or-engagement-context");
  }
  if (item.source_url || item.source_name) {
    score += 5;
    reasons.push("has-feed-source-reference");
  }
  if (semanticSignalCount >= 4) {
    score += 14;
    reasons.push("multi-signal-crisis-narrative");
  } else if (semanticSignalCount >= 2) {
    score += 8;
    reasons.push("partial-crisis-narrative");
  }
  if (Number(enrichmentMetrics.propagation_followup_link_count || 0) > 0) {
    score += 6;
    reasons.push("has-propagation-followups");
  }
  const sourceFamily = String(feed.sourceFamily || feed.source_family || "").toLowerCase();
  if (
    feed.regulatory
    || sourceFamily === "consumer_protection"
    || sourceFamily === "regulatory"
    || ["official-consumer-protection", "regulatory-alert", "regulatory", "official-press-release"].includes(sourceWeightTier)
  ) {
    score += 12;
    reasons.push("trusted-official-source");
  }
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: bounded,
    bucket: bounded >= 75 ? "deep" : bounded >= 55 ? "usable" : bounded >= 35 ? "thin" : "shallow",
    reasons: [...new Set(reasons)].slice(0, 12),
  };
}

function recordRssSkippedItemQualitySample({ item = {}, feed = {}, reason = "", keyword = "", keywords = [] } = {}) {
  if (!item?.url || !reason) return;
  const text = `${item.title || ""} ${item.content || ""} ${item.url || ""}`;
  const relevanceHits = (Array.isArray(keywords) ? keywords : [])
    .filter(value => rssValueMatchesKeyword(text, value));
  recordSentimentSourceQualitySample({
    sourceKey: feed.sourceKey || "rssFeeds",
    platform: "rss_feeds",
    url: item.url,
    title: item.title || item.url,
    reason,
    relevanceScore: keyword || relevanceHits.length ? 55 : 8,
    qualityScore: rssItemQualityScore(item),
    accepted: false,
    metadata: {
      feed_name: feed.name || "",
      feed_url: feed.url || "",
      base_feed_name: feed.baseFeedName || "",
      base_feed_url: feed.baseFeedUrl || "",
      keyword_search_keyword: feed.keywordSearchKeyword || "",
      feed_pack: feed.pack || "",
      source_family: feed.sourceFamily || "news",
      feed_item_guid: item.guid || "",
      feed_item_categories: item.categories || [],
      feed_item_author: item.author || "",
      feed_item_format: item.feed_item_format || "",
      feed_item_published_at: item.publishedAt || "",
      feed_item_source_url: item.source_url || "",
      feed_item_source_name: item.source_name || "",
      feed_item_comment_rss_url: item.comment_rss_url || "",
      feed_item_comment_count: item.comment_count ?? null,
      matched_keyword: keyword || "",
      monitored_keywords: Array.isArray(keywords) ? keywords : [],
    },
  });
}

function evidenceWithFailover(evidence = {}, failoverAttribution = []) {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  if (!attribution.length) return evidence || {};
  return {
    ...(evidence || {}),
    metrics: {
      ...(evidence?.metrics || {}),
      failover_attribution: attribution,
      failover_from_sources: [...new Set(attribution.map(item => item?.fromSource).filter(Boolean))],
    },
  };
}

function rssEvidenceType(feed = {}) {
  if (feed.sourceFamily === "consumer_protection") return "consumer_protection_notice";
  if (feed.sourceFamily === "regulatory" || feed.regulatory) return "regulatory_notice";
  return "rss_article";
}

function rssSourceWeightTier(feed = {}) {
  const sourceFamily = String(feed.sourceFamily || "").toLowerCase();
  const tags = new Set(Array.isArray(feed.tags) ? feed.tags.map(tag => String(tag || "").toLowerCase()) : []);
  if (sourceFamily === "consumer_protection") return "official-consumer-protection";
  if (sourceFamily === "regulatory" || feed.regulatory) {
    if (tags.has("recall") || tags.has("safety-alert") || tags.has("product-safety") || tags.has("health")) return "regulatory-alert";
    return "regulatory";
  }
  if (sourceFamily === "taiwan_business_media") return "regional-business-media";
  if (sourceFamily === "taiwan_media") return tags.has("google-news-index") || tags.has("bing-news-index") ? "regional-media-index" : "regional-priority-media";
  if (sourceFamily === "greater_china_business_media") return "greater-china-business-media";
  if (sourceFamily === "greater_china_media") return "greater-china-priority-media";
  if (sourceFamily === "global_business_media") return "global-business-media";
  if (sourceFamily === "global_mainstream_media") return "global-mainstream-media";
  if (sourceFamily === "press_release") return "official-press-release";
  if (tags.has("security")) return "security-media";
  if (tags.has("business") || tags.has("finance") || tags.has("markets")) return "business-media";
  if (tags.has("tech")) return "technology-media";
  if (tags.has("news")) return "public-news-media";
  return "";
}

function rssEvidenceWithFeedMetadata(evidence = {}, feed = {}, item = {}, failoverAttribution = [], feedMeta = {}, { rawItemCount = 0, keyword = "", metricsEnhancer = null } = {}) {
  const sourceWeightTier = rssSourceWeightTier(feed);
  const qualityScore = rssItemQualityScore(item);
  const relevanceScore = rssItemRelevanceScore(item, keyword);
  const narrativeSignals = rssMediaNarrativeSignals(item);
  const enrichmentMetrics = evidence?.metrics || {};
  const depthProfile = rssEvidenceDepthProfile(item, { enrichmentMetrics, narrativeSignals, feed, sourceWeightTier });
  const baseMetrics = {
    ...(evidence?.metrics || {}),
    ...(item.metrics || {}),
    feed_name: feed.name || "",
    feed_url: feed.url || "",
    base_feed_name: feed.baseFeedName || "",
    base_feed_url: feed.baseFeedUrl || "",
    keyword_search_keyword: feed.keywordSearchKeyword || "",
    feed_pack: feed.pack || "",
    feed_tags: Array.isArray(feed.tags) ? feed.tags : [],
    feed_item_guid: item.guid || "",
    feed_item_author: item.author || "",
    feed_item_categories: Array.isArray(item.categories) ? item.categories : [],
    feed_item_media_url: item.media_url || "",
    feed_item_media_type: item.media_type || "",
    feed_item_media_medium: item.media_medium || "",
    feed_item_media_length: item.media_length || "",
    feed_item_comments_url: item.comments_url || "",
    feed_item_comment_rss_url: item.comment_rss_url || "",
    feed_item_comment_count: item.comment_count ?? null,
    feed_item_source_url: item.source_url || "",
    feed_item_source_name: item.source_name || "",
    feed_item_format: item.feed_item_format || "",
    feed_title: feedMeta.feed_title || "",
    feed_home_url: feedMeta.feed_home_url || "",
    feed_self_url: feedMeta.feed_self_url || "",
    feed_hub_urls: Array.isArray(feedMeta.feed_hub_urls) ? feedMeta.feed_hub_urls : [],
    feed_websub_enabled: Boolean(feedMeta.feed_websub_enabled),
    feed_ttl_minutes: feedMeta.feed_ttl_minutes || null,
    feed_update_period: feedMeta.feed_update_period || "",
    feed_update_frequency: feedMeta.feed_update_frequency || null,
    feed_last_build_at: feedMeta.feed_last_build_at || "",
    feed_generator: feedMeta.feed_generator || "",
    rss_feed_raw_item_count: rawItemCount,
    rss_matched_keyword: keyword || "",
    rss_keyword_match_source: rssKeywordMatchSource(item, keyword),
    rss_relevance_score: relevanceScore,
    rss_quality_score: qualityScore,
    rss_evidence_depth_score: depthProfile.score,
    rss_evidence_depth_bucket: depthProfile.bucket,
    rss_evidence_depth_reasons: depthProfile.reasons,
    evidence_depth_score: depthProfile.score,
    relevance_score: relevanceScore,
    quality_score: qualityScore,
    rss_canonical_dedupe_url: rssItemDedupeKey(item),
    rss_search_scan_dedupe_key: rssItemDedupeKey(item),
    source_family: feed.sourceFamily || "news",
    regulatory: Boolean(feed.regulatory),
    ...narrativeSignals,
    ...(sourceWeightTier ? { source_weight_tier: sourceWeightTier } : {}),
  };
  const enhancedMetrics = typeof metricsEnhancer === "function"
    ? metricsEnhancer({ item, feed, feedMeta, keyword, metrics: baseMetrics }) || {}
    : {};
  return evidenceWithFailover({
    ...(evidence || {}),
    source_key: feed.sourceKey || "rssFeeds",
    evidence_type: rssEvidenceType(feed),
    metrics: {
      ...baseMetrics,
      ...enhancedMetrics,
    },
  }, failoverAttribution);
}

async function insertRssItem(item, { keyword, proxyUrl, enrich, feed = {}, feedMeta = {}, rawItemCount = 0, domainControls = {}, contentControls = {}, failoverAttribution = [], metricsEnhancer = null }) {
  const fallback = item.content || "";
  const enriched = enrich
    ? await enrichSearchResultSummary(item, { proxyUrl })
    : { content: fallback, ai_summary: fallback, enriched: false };
  const content = enriched.content || fallback;
  const sentiment = analyzeSentiment(`${item.title} ${content}`);
  const result = insertSentimentItem({
    platform: "rss_feeds",
    url: item.url,
    title: item.title,
    content,
    author: enriched.author || item.author,
    sentiment,
    risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
    keyword,
    keywords: [keyword, ...(Array.isArray(feed.tags) ? feed.tags : []), ...(Array.isArray(item.categories) ? item.categories : [])].filter(Boolean),
    published_at: enriched.published_at || item.publishedAt,
    ai_summary: enriched.ai_summary,
    raw_html: enriched.raw_html || "",
    evidence: rssEvidenceWithFeedMetadata(enriched.evidence || {}, feed, { ...item, content }, failoverAttribution, feedMeta, { rawItemCount, keyword, metricsEnhancer }),
    visual_assets: [
      ...(enriched.visual_assets || []),
      ...(item.media_url ? [{
        source_key: feed.sourceKey || "rssFeeds",
        asset_type: "feed-media",
        image_url: item.media_url,
        metrics: {
          feed_url: feed.url || "",
          feed_name: feed.name || "",
          base_feed_url: feed.baseFeedUrl || "",
          base_feed_name: feed.baseFeedName || "",
          keyword_search_keyword: feed.keywordSearchKeyword || "",
          feed_item_guid: item.guid || "",
          feed_item_format: item.feed_item_format || "",
          feed_websub_enabled: Boolean(feedMeta.feed_websub_enabled),
        },
      }] : []),
    ],
    source_type: "scraper",
    domainControls,
    contentControls,
    failoverAttribution,
  });
  return result.inserted ? 1 : 0;
}

export async function scrapeRssFeeds(keywords, { proxyUrl = "", enrich = true, feeds = [], feedPacks = ["chineseNews", "consumerProtection", "regulatoryNotices"], budget = {}, since = "", cursor = {}, conditionalRequests = true, domainControls = {}, contentControls = {}, failoverAttribution = [], metricsEnhancer = null, directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeRssDirectUrls(directUrls);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const normalizedFeeds = expandFeedsForKeywords([...feedsFromPacks(feedPacks), ...feeds], normalizedKeywords);
  if (!normalizedFeeds.length && !normalizedDirectUrls.length) return scraperResult(0);
  const maxItems = budgetItemsPerFeed(budget);
  const existingFeedCursor = normalizeFeedCursor(cursor);
  const seenItemUrls = new Set();
  const directKeyword = normalizedKeywords[0] || "rss-direct-url";
  let directInserted = 0;
  const directFailures = [];
  for (const directUrl of normalizedDirectUrls) {
    try {
      const matchedFeed = directRssFeedForUrl(directUrl, normalizedFeeds);
      const directFeed = {
        ...(matchedFeed || {}),
        name: matchedFeed?.name || "Direct URL",
        url: matchedFeed?.url || directUrl,
        sourceKey: matchedFeed?.sourceKey || "rssFeeds",
        sourceFamily: matchedFeed?.sourceFamily || "news",
        regulatory: Boolean(matchedFeed?.regulatory),
        tags: [...new Set([...(matchedFeed?.tags || []), "direct-url"])],
      };
      const item = directRssFeedItem(directUrl, directKeyword, directFeed);
      if (!item) continue;
      const dedupeKey = rssItemDedupeKey(item);
      if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
      directInserted += await insertRssItem(item, {
        keyword: directKeyword,
        proxyUrl,
        enrich: true,
        feed: directFeed,
        feedMeta: {
          feed_title: directFeed.name,
          feed_home_url: directFeed.homeUrl || "",
          feed_self_url: directFeed.url || "",
          feed_generator: "direct-url",
        },
        rawItemCount: normalizedDirectUrls.length,
        domainControls,
        contentControls,
        failoverAttribution,
        metricsEnhancer,
      });
    } catch (err) {
      directFailures.push({ target: directUrl, message: formatSourceError(err, proxyUrl) });
    }
  }

  const results = await mapWithConcurrency(normalizedFeeds, FEED_CONCURRENCY, async (feed) => {
    let inserted = 0;
    const failures = [];
    const cursorRows = [];
    const cursorKey = feedCursorKey(feed.url);
    const previous = existingFeedCursor[cursorKey] || {};
    const checkedAt = new Date().toISOString();
    try {
      const conditionalHeaders = conditionalRequests === false ? {} : conditionalHeadersForFeed(feed, cursor);
      const res = await fetchPublicSource(feed.url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/feed+json, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
          ...conditionalHeaders,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (res.status === 304) {
        cursorRows.push(feedHttpCursor(feed, res, { status: 304, previous, checkedAt, changed: false }));
        return { inserted, failures, cursorRows };
      }
      if (!res.ok) {
        const message = httpFailure(res);
        failures.push({ target: feed.name, message });
        cursorRows.push(feedHttpCursor(feed, res, { status: res.status, previous, checkedAt, changed: false, error: message }));
        return { inserted, failures, cursorRows };
      }
      const xml = await res.text();
      const feedMeta = parseRssFeedMetadata(xml, feed);
      const rawItemCount = countConfiguredFeedRawItems(xml, feed) ?? countRssFeedRawItems(xml);
      cursorRows.push(feedHttpCursor(feed, res, { status: res.status, previous, checkedAt, changed: true, feedMeta }));
      let feedPayloads = [{
        feed,
        feedMeta,
        rawItemCount,
        items: parseRssFeedItems(xml, feed, { maxItems }),
      }];
      if (!feedPayloads[0].items.length) {
        const childUrls = selectChildSitemapUrls(parseSitemapIndexUrls(xml), feed);
        for (const childUrl of childUrls) {
          try {
            const childRes = await fetchPublicSource(childUrl, {
              headers: {
                "User-Agent": USER_AGENT,
                "Accept": "application/feed+json, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
                "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
              },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }, proxyUrl);
            if (!childRes.ok) {
              failures.push({ target: `${feed.name} child`, message: httpFailure(childRes) });
              continue;
            }
            const childXml = await childRes.text();
            const childFeed = { ...feed, url: childUrl };
            const childItems = parseRssFeedItems(childXml, childFeed, { maxItems });
            if (!childItems.length) continue;
            feedPayloads = [{
              feed: childFeed,
              feedMeta: parseRssFeedMetadata(childXml, childFeed),
              rawItemCount: countConfiguredFeedRawItems(childXml, childFeed) ?? countRssFeedRawItems(childXml),
              items: childItems,
            }];
            break;
          } catch (childError) {
            failures.push({ target: `${feed.name} child`, message: formatSourceError(childError, proxyUrl) });
          }
        }
      }
      let qualityDiagnostics = 0;
      for (const payload of feedPayloads) {
        for (const item of payload.items) {
          const keyword = matchKeyword(item, normalizedKeywords);
          if (!isAfterSince(item.publishedAt, since)) continue;
          if (!keyword) {
            if (qualityDiagnostics < 8) {
              recordRssSkippedItemQualitySample({ item, feed: payload.feed, reason: "rss-missing-keyword", keywords: normalizedKeywords });
              qualityDiagnostics += 1;
            }
            continue;
          }
          if (!isRecentDate(item.publishedAt)) continue;
          if (payload.feed.requireTaiwan && !isTaiwanRelatedText(item.title, item.content, item.url, item.author)) {
            if (qualityDiagnostics < 8) {
              recordRssSkippedItemQualitySample({ item, feed: payload.feed, reason: "rss-region-mismatch", keyword, keywords: normalizedKeywords });
              qualityDiagnostics += 1;
            }
            continue;
          }
          const dedupeKey = rssItemDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          inserted += await insertRssItem(item, { keyword, proxyUrl, enrich, feed: payload.feed, feedMeta: payload.feedMeta, rawItemCount: payload.rawItemCount, domainControls, contentControls, failoverAttribution, metricsEnhancer });
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ target: feed.name, message });
      cursorRows.push(feedHttpCursor(feed, null, { status: 0, previous, checkedAt, changed: false, error: message }));
      console.warn(`[CRM/RSSFeeds] 抓取失敗 target=${feed.name}: ${message}`);
    }
    return { inserted, failures, cursorRows };
  });
  const nextFeedCursors = {
    ...existingFeedCursor,
    ...Object.fromEntries(results
      .flatMap(result => result?.cursorRows || [])
      .filter(row => row?.url)
      .map(row => [feedCursorKey(row.url), row])),
  };

  return {
    ...scraperResult(
    directInserted + results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...directFailures, ...results.flatMap(result => result?.failures || [])],
    ),
    cursor: {
      rssFeedCursors: nextFeedCursors,
      rssFeedCursorCount: Object.keys(nextFeedCursors).length,
      rssFeedNotModifiedCount: results.flatMap(result => result?.cursorRows || []).filter(row => Number(row.last_status || 0) === 304).length,
    },
  };
}

export const __test__ = {
  normalizeFeeds,
  normalizeFeedPackKeys,
  feedsFromPacks,
  expandFeedsForKeywords,
  keywordSearchFeedUrl,
  listPublicRssFeedPacks,
  TAIWAN_PRIORITY_MEDIA_SITES,
  TAIWAN_REQUIRED_MEDIA_COVERAGE_SITES,
  TAIWAN_BUSINESS_MEDIA_SITES,
  TAIWAN_PUBLIC_INTEREST_MEDIA_SITES,
  TAIWAN_REGULATORY_INDEX_SITES,
  GREATER_CHINA_MEDIA_INDEX_SITES,
  GLOBAL_MAINSTREAM_MEDIA_INDEX_SITES,
  mergeFeeds,
  parseRssFeedMetadata,
  parseSitemapIndexUrls,
  configuredJsonFeedItems,
  parseJsonFeedItems,
  parseRssFeedItems,
  parseUrlsetSitemapItems,
  countRssFeedRawItems,
  countConfiguredFeedRawItems,
  matchKeyword,
  normalizeRssKeywordText,
  rssValueMatchesKeyword,
  rssKeywordMatchSource,
  rssMediaNarrativeSignals,
  rssEvidenceDepthProfile,
  normalizeRssDedupeUrl,
  normalizeRssDirectUrls,
  directRssFeedItem,
  directRssFeedForUrl,
  rssItemDedupeKey,
  budgetItemsPerFeed,
  conditionalHeadersForFeed,
  feedCursorKey,
  normalizeFeedCursor,
  rssItemQualityScore,
  rssItemRelevanceScore,
  rssSourceWeightTier,
  selectChildSitemapUrls,
  sitemapUrlDerivedTitle,
};
