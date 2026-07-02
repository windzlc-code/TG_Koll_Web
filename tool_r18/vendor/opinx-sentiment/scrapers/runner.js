/* global console, setInterval, clearInterval */

/**
 * scrapers/runner.js — 輿情掃描統一入口
 *
 * 讀取關鍵詞配置，並行執行已啟用的台灣本地公開來源，
 * 掃描完成後透過 bus 推送通知
 */

import { getDb } from "../db/db.js";
import { scrapePTT } from "./ptt.js";
import { scrapeDcard } from "./dcard.js";
import { scrapeBingNews, scrapeGoogleNews } from "./google-news.js";
import { scrapeYahooTaiwan } from "./yahoo-taiwan.js";
import { scrapeYahooJapanNews } from "./yahoo-japan-news.js";
import { scrapeNaverKoreaNews } from "./naver-korea-news.js";
import { scrapeDaumKoreaNews } from "./daum-korea-news.js";
import { scrapeBaiduNews, scrapeBaiduSearch } from "./baidu-search.js";
import { scrapeTiebaSearch } from "./tieba-search.js";
import { scrapeWechatPublicSearch } from "./wechat-public-search.js";
import { scrapeDouyinSearch } from "./douyin-search.js";
import { scrapeKuaishouSearch } from "./kuaishou-search.js";
import { scrapeToutiaoSearch } from "./toutiao-search.js";
import { scrapeSogouSearch } from "./sogou-search.js";
import { scrapeSoSearch } from "./so-search.js";
import { scrapeYandexSearch } from "./yandex-search.js";
import { scrapeDuckDuckGo, scrapeGdelt } from "./open-public-search.js";
import { scrapeInstagram, scrapeThreads } from "./social-search.js";
import { scrapeWeiboSearch } from "./weibo-search.js";
import { scrapeXiaohongshuSearch } from "./xiaohongshu-search.js";
import { scrapeZhihuSearch } from "./zhihu-search.js";
import { scrapeQuoraSearch } from "./quora-search.js";
import { scrapeSubstackSearch } from "./substack-search.js";
import { scrapeMediumSearch } from "./medium-search.js";
import { scrapeWordPressSearch } from "./wordpress-search.js";
import { scrapeBlogspotSearch } from "./blogspot-search.js";
import { scrapeTumblrSearch } from "./tumblr-search.js";
import { scrapeXSearch } from "./x-search.js";
import { scrapeFacebookSearch } from "./facebook-search.js";
import { scrapeLinkedInSearch } from "./linkedin-search.js";
import { scrapeTikTokSearch } from "./tiktok-search.js";
import { scrapeTaiwanNewsFeeds } from "./taiwan-news.js";
import { scrapeYouTube } from "./youtube.js";
import { scrapeBrowserFallback } from "./browser-fallback.js";
import { scrapeBilibiliSearch } from "./bilibili.js";
import { scrapeApplePodcastSearch } from "./apple-podcast-search.js";
import { scrapeAppStoreReviews } from "./app-store-reviews.js";
import { scrapeGooglePlayReviews } from "./google-play-reviews.js";
import { scrapePublicReviewSites, PUBLIC_REVIEW_SITE_TARGETS } from "./public-review-sites.js";
import { scrapeVerticalReviewSources, VERTICAL_REVIEW_TARGETS } from "./vertical-review-sources.js";
import { scrapeEmployerReviewSources, EMPLOYER_REVIEW_TARGETS } from "./employer-review-sources.js";
import { scrapeEcommerceReviewSources, ECOMMERCE_REVIEW_TARGETS } from "./ecommerce-review-sources.js";
import { scrapeLocalReviewSources, LOCAL_REVIEW_TARGETS } from "./local-review-sources.js";
import { scrapeRegionalComplaintSources, REGIONAL_COMPLAINT_TARGETS } from "./regional-complaint-sources.js";
import { listPublicRssFeedPacks, scrapeRssFeeds } from "./rss-feeds.js";
import { scrapeGitHubIssues, scrapeHackerNews, scrapeReddit, scrapeStackOverflow } from "./community-sources.js";
import { scrapeDiscourseForums, scrapeGitLabIssues, scrapeLemmySearch, DISCOURSE_FORUM_TARGETS } from "./federated-sources.js";
import { scrapeBlueskySearch, scrapeMastodonTags, scrapeTelegramPublicChannels } from "./social-realtime-sources.js";
import { scrapeOpenWebDiscovery } from "./open-web-discovery.js";
import { scrapeOfficialRegulatorySources } from "./official-regulatory-sources.js";
import { scrapeLegalPublicRecords } from "./legal-public-records.js";
import { scrapePublicProcurementSources } from "./public-procurement-sources.js";
import { scrapePublicSanctionsSources } from "./public-sanctions-sources.js";
import { scrapePublicProductRecallSources } from "./public-product-recall-sources.js";
import { scrapePublicEnforcementActionSources } from "./public-enforcement-action-sources.js";
import { scrapePublicAdvertisingRulingsSources } from "./public-advertising-rulings-sources.js";
import { scrapePublicRegulatoryWarningLetterSources } from "./public-regulatory-warning-letter-sources.js";
import { scrapePublicCompanyFilingsSources } from "./public-company-filings-sources.js";
import { scrapeBrandImpersonationSources } from "./brand-impersonation-sources.js";
import { scrapeSecurityAdvisorySources } from "./security-advisory-sources.js";
import { scrapeSupplyChainAdvisorySources } from "./supply-chain-advisory-sources.js";
import { scrapeInvestorDiscussionSources } from "./investor-discussion-sources.js";
import { scrapePublicStatusPageSources } from "./public-status-page-sources.js";
import { scrapeOfficialOwnedMediaSources } from "./official-owned-media-sources.js";
import {
  applySentimentPostScanEvidenceFollowupJobs,
  applySentimentSourceQualityTuning,
  buildSentimentSpreadGraph,
  createSentimentCollectionJobs,
  createSentimentScanBatch,
  executeSentimentSourceDiscoveryDeepCrawlPlan,
  finishSentimentScanBatch,
  getSentimentCommercialPolicyGovernanceReport,
  getSentimentCommercialRemediationPlan,
  getSentimentEventClusterAnalysisReport,
  getSentimentEvidenceCoverageFollowupRecoveryReport,
  getSentimentEvidenceCoverageRoutedAlternateEffectivenessReport,
  getSentimentTaiwanMediaSourceHealthReport,
  getSentimentRealtimeDiscoveryLatencyReport,
  listSentimentRealtimeAnomalyWindows,
  listSentimentRealtimeHotTopics,
  getSentimentSourceCredibilityReport,
  listAccessBarrierAlternateRecoveryEffectiveness,
  listSentimentCollectionJobRetryPlan,
  listSentimentCollectionJobs,
  listSentimentCollectionOperationsRemediationEffectiveness,
  listSentimentCollectionContributionScores,
  listSentimentMultilingualQueryQuality,
  listSentimentDeepCollectionHealthProfiles,
  listSentimentEvidenceChainGapReport,
  listSentimentEvidenceDepthReport,
  listSentimentEntityTopicRecallGaps,
  listSentimentEntityTopicSourceRecallGaps,
  listSentimentEntityTopicRecallTrend,
  listSentimentAlerts,
  listSentimentAnomalies,
  listSentimentKeywordSourceFamilyCoverage,
  listCrisisBriefs,
  listSentimentNoiseSuppressionReport,
  listSentimentEvents,
  listSentimentSourceCoverageScores,
  listSentimentSourceDiscoveryCandidates,
  listSentimentSourceQualityProfiles,
  listSentimentSourceReliabilityReport,
  listSentimentSocialFollowupSignals,
  normalizeSentimentContentControls,
  normalizeSentimentDomainControls,
  listSentimentSources,
  normalizeSentimentMonitorKeywords,
  processSentimentIntelligence,
  readSentimentSearchSettings,
  recordSentimentScanSourceLog,
  updateSentimentSourceCollectionCursor,
  updateSentimentCollectionJob,
  updateSentimentSourceScanState,
} from "../sentiment-store.js";

const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const SCAN_MODE_FULL = "full";
const SCAN_MODE_FAST = "fast";
const SCAN_MODE_WATCH = "watch";
export const DEFAULT_RSS_FEED_PACKS = ["chineseNews", "taiwanMedia", "taiwanBusinessMedia", "taiwanPublicInterest", "greaterChinaMedia", "globalMainstreamMedia", "consumerProtection", "taiwanRegulatory", "regulatoryNotices", "globalTech", "security", "business", "pressReleases"];
const FAST_SCAN_KEYWORD_LIMIT = 14;
const WORK_KEYWORD_HINTS = [
  "捐款", "募款", "公益", "客服", "客訴", "投訴", "退款", "退捐",
  "裝修", "施工", "財務", "預算", "經費", "合約", "簽約", "交付",
  "旅遊", "旅游", "行程", "專案", "项目", "項目",
];
const WORK_KEYWORD_DENYLIST = new Set(["專案", "项目", "項目"]);
const SAFE_WORK_KEYWORDS = new Set(WORK_KEYWORD_HINTS.filter(keyword => !WORK_KEYWORD_DENYLIST.has(keyword)));
const ENTITY_PRECISION_SOURCE_KEYS = new Set([
  "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "openWebDiscovery",
  "wechatPublicSearch", "toutiaoSearch",
  "reddit", "ptt", "dcard", "telegramPublic", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "tiebaSearch",
  "youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch",
  "githubIssues", "gitLabIssues", "hackerNews", "stackOverflow", "discourseForums", "lemmy", "zhihuSearch", "quoraSearch",
  "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "tumblrSearch",
]);
const RELATED_SEARCH_KEYWORDS = new Map([
  ["捐款", ["募款", "捐贈", "公益"]],
  ["募款", ["捐款", "捐贈", "公益"]],
  ["公益", ["捐款", "募款", "志工"]],
  ["客服", ["客訴", "投訴", "服務"]],
  ["客訴", ["客服", "投訴", "抱怨"]],
  ["投訴", ["客訴", "客服", "抱怨"]],
  ["退款", ["退費", "退捐", "客訴"]],
  ["退捐", ["退款", "退費", "捐款"]],
  ["裝修", ["施工", "驗收", "預算"]],
  ["施工", ["裝修", "工期", "驗收"]],
  ["財務", ["經費", "預算", "付款"]],
  ["預算", ["經費", "財務", "付款"]],
  ["經費", ["預算", "財務", "付款"]],
  ["合約", ["簽約", "付款", "交付"]],
  ["簽約", ["合約", "付款", "交付"]],
  ["交付", ["驗收", "合約", "服務"]],
  ["旅遊", ["行程", "住宿", "交通"]],
  ["旅游", ["行程", "住宿", "交通"]],
  ["行程", ["旅遊", "住宿", "交通"]],
]);
const QUERY_TEMPLATE_PACKS = {
  complaints: [
    "{term} 投訴",
    "{term} 客訴",
    "{term} 售後",
    "{term} 退款",
    "{term} 退費",
  ],
  crisis: [
    "{term} 炎上",
    "{term} 爆料",
    "{term} 危機",
    "{term} 抵制",
    "{term} 負評",
  ],
  trustSafety: [
    "{term} 詐騙",
    "{term} 個資",
    "{term} 隱私",
    "{term} 違法",
    "{term} 資安",
  ],
  socialDiscovery: [
    "{term} PTT",
    "{term} Dcard",
    "{term} Reddit",
    "{term} YouTube",
    "{term} B站",
    "{term} Bilibili",
  ],
  officialResponse: [
    "{term} 官方聲明",
    "{term} 官方声明",
    "{term} 回應",
    "{term} 回应",
    "{term} statement",
    "{term} response",
  ],
  regulatorySafety: [
    "{term} 召回",
    "{term} 安全警示",
    "{term} 通報",
    "{term} regulatory warning",
    "{term} recall",
    "{term} safety alert",
    "{term} product safety",
  ],
  legalRisk: [
    "{term} lawsuit",
    "{term} litigation",
    "{term} class action",
    "{term} court",
    "{term} docket",
    "{term} 訴訟",
    "{term} 法院",
  ],
  procurementRisk: [
    "{term} USAspending",
    "{term} contract award",
    "{term} procurement",
    "{term} government contract",
    "{term} supplier",
    "{term} vendor",
    "{term} solicitation",
    "{term} 招標",
    "{term} 中標",
    "{term} 政府採購",
  ],
  sanctionsRisk: [
    "{term} OFAC",
    "{term} SDN",
    "{term} sanctions",
    "{term} watchlist",
    "{term} blocked person",
    "{term} denied party",
    "{term} entity list",
    "{term} 制裁",
    "{term} 黑名單",
    "{term} 風險名單",
  ],
  companyFilingsRisk: [
    "{term} SEC filing",
    "{term} EDGAR",
    "{term} 8-K",
    "{term} 10-K",
    "{term} 10-Q",
    "{term} annual report",
    "{term} material event",
    "{term} cybersecurity incident",
  ],
  brandSafety: [
    "{term} phishing",
    "{term} impersonation",
    "{term} scam domain",
    "{term} fake website",
    "{term} typosquatting",
    "{term} certificate transparency",
    "{term} 釣魚",
    "{term} 仿冒",
    "{term} 假網站",
  ],
  securityAdvisory: [
    "{term} CVE",
    "{term} NVD",
    "{term} CISA KEV",
    "{term} vulnerability",
    "{term} exploit",
    "{term} ransomware",
    "{term} security advisory",
    "{term} 漏洞",
    "{term} 安全公告",
    "{term} 勒索",
  ],
  supplyChainSecurity: [
    "{term} OSV",
    "{term} GHSA",
    "{term} GitHub advisory",
    "{term} package vulnerability",
    "{term} dependency vulnerability",
    "{term} supply chain",
    "{term} npm vulnerability",
    "{term} PyPI vulnerability",
    "{term} 供應鏈",
    "{term} 依賴漏洞",
  ],
  investorMarket: [
    "{term} Stocktwits",
    "{term} Yahoo Finance",
    "{term} investor complaint",
    "{term} market sentiment",
    "{term} earnings risk",
    "{term} short seller",
    "{term} 股價",
    "{term} 投資者",
    "{term} 做空",
  ],
  propagationPath: [
    "{term} 首發",
    "{term} 首发",
    "{term} 起源",
    "{term} 來源",
    "{term} 来源",
    "{term} 擴散",
    "{term} 扩散",
    "{term} 發酵",
    "{term} 发酵",
    "{term} 搬運",
    "{term} 搬运",
    "{term} 轉傳",
    "{term} 转传",
    "{term} timeline",
    "{term} origin",
    "{term} amplification",
    "{term} repost",
  ],
  complaintEvidence: [
    "{term} 截圖",
    "{term} 截图",
    "{term} 對話紀錄",
    "{term} 对话记录",
    "{term} 客服紀錄",
    "{term} 客服记录",
    "{term} 退款紀錄",
    "{term} 退款记录",
    "{term} 訂單截圖",
    "{term} 订单截图",
    "{term} 付款證明",
    "{term} 付款证明",
    "{term} evidence",
    "{term} screenshot",
    "{term} chat log",
    "{term} receipt",
  ],
  crisisRemediation: [
    "{term} 道歉",
    "{term} 致歉",
    "{term} 澄清",
    "{term} 聲明稿",
    "{term} 声明稿",
    "{term} 補償",
    "{term} 补偿",
    "{term} 賠償",
    "{term} 赔偿",
    "{term} 退費方案",
    "{term} 退款方案",
    "{term} apology",
    "{term} clarification",
    "{term} compensation",
    "{term} refund policy",
    "{term} remediation",
  ],
  mediaAmplification: [
    "{term} 媒體報導",
    "{term} 媒体报道",
    "{term} 社群熱議",
    "{term} 社群热议",
    "{term} 網友爆料",
    "{term} 网友爆料",
    "{term} KOL",
    "{term} influencer",
    "{term} viral",
    "{term} trending",
    "{term} picked up by media",
    "{term} news coverage",
  ],
};

const MULTILINGUAL_RISK_TERM_PACKS = {
  en: ["complaint", "refund", "scam", "fraud", "negative review", "boycott", "privacy", "lawsuit", "recall", "safety alert", "chargeback", "data breach", "outage", "apology", "official statement"],
  "zh-Hans": ["投诉", "退款", "诈骗", "负评", "客诉", "爆料", "抵制", "隐私", "违法", "召回", "维权", "数据泄露", "停服", "道歉", "官方声明"],
  "zh-Hant": ["投訴", "退款", "詐騙", "負評", "客訴", "爆料", "抵制", "隱私", "違法", "召回", "維權", "個資外洩", "停服", "道歉", "官方聲明"],
  ja: ["苦情", "返金", "詐欺", "悪評", "炎上", "個人情報", "違法", "リコール", "安全警告", "集団訴訟", "情報漏えい", "障害", "謝罪"],
  ko: ["불만", "환불", "사기", "악평", "논란", "불매", "개인정보", "리콜", "안전 경고", "집단소송", "정보 유출", "장애", "사과문"],
  "zh-HK": ["投訴", "退款", "詐騙", "劣評", "私隱", "違法", "消委會", "維權", "資料外洩", "道歉聲明"],
  "zh-TW": ["投訴", "退款", "詐騙", "負評", "客訴", "消保", "個資", "召回", "維權", "個資外洩", "道歉聲明"],
  id: ["keluhan", "refund", "penipuan", "ulasan buruk", "boikot", "privasi", "kebocoran data", "gangguan layanan", "permintaan maaf"],
  ms: ["aduan", "bayaran balik", "penipuan", "ulasan buruk", "boikot", "privasi", "kebocoran data", "gangguan perkhidmatan", "permohonan maaf"],
  vi: ["khiếu nại", "hoàn tiền", "lừa đảo", "đánh giá xấu", "tẩy chay", "quyền riêng tư", "rò rỉ dữ liệu", "gián đoạn dịch vụ", "xin lỗi"],
  th: ["ร้องเรียน", "คืนเงิน", "หลอกลวง", "รีวิวเชิงลบ", "คว่ำบาตร", "ความเป็นส่วนตัว", "ข้อมูลรั่วไหล", "บริการขัดข้อง", "ขอโทษ"],
  es: ["queja", "reembolso", "estafa", "fraude", "reseña negativa", "boicot", "privacidad", "demanda", "retirada", "filtración de datos", "interrupción del servicio", "disculpa"],
  fr: ["plainte", "remboursement", "arnaque", "fraude", "avis négatif", "boycott", "confidentialité", "rappel", "fuite de données", "panne de service", "excuses"],
  de: ["Beschwerde", "Rückerstattung", "Betrug", "negative Bewertung", "Boykott", "Datenschutz", "Rückruf", "Datenleck", "Dienstausfall", "Entschuldigung"],
  pt: ["reclamação", "reembolso", "golpe", "fraude", "avaliação negativa", "boicote", "privacidade", "recall", "vazamento de dados", "queda do serviço", "pedido de desculpas"],
  ar: ["شكوى", "استرداد", "احتيال", "مقاطعة", "خصوصية", "تسريب بيانات", "تعطل الخدمة", "اعتذار"],
  hi: ["शिकायत", "रिफंड", "धोखाधड़ी", "नकारात्मक समीक्षा", "बहिष्कार", "गोपनीयता", "डेटा लीक", "सेवा बाधित", "माफी"],
};
const DEFAULT_QUERY_TEMPLATE_PACK_KEYS = ["complaints", "crisis", "trustSafety", "socialDiscovery", "officialResponse", "regulatorySafety", "legalRisk", "procurementRisk", "sanctionsRisk", "companyFilingsRisk", "brandSafety", "securityAdvisory", "supplyChainSecurity", "investorMarket", "propagationPath", "complaintEvidence", "crisisRemediation", "mediaAmplification"];
const SEARCH_KEYWORD_LIMIT = 36;
const GDELT_FAST_KEYWORD_LIMIT = 3;
const DEFAULT_COLLECTION_BUDGET = {
  fast: { maxPagesPerKeyword: 1, maxItemsPerKeyword: 10 },
  full: { maxPagesPerKeyword: 2, maxItemsPerKeyword: 20 },
};
const SOURCE_JOB_TIMEOUT_MS = {
  fast: 45 * 1000,
  full: 90 * 1000,
};
const DEFAULT_INCREMENTAL_SETTINGS = { enabled: true, overlapMinutes: 60 };
const RISK_SCAN_TERMS = [
  "投訴", "complaint", "退款", "refund", "詐騙", "scam", "負評", "negative review",
  "客訴", "爆料", "炎上", "boycott", "危機", "crisis", "個資", "privacy", "違法", "退捐",
  "fraud", "lawsuit", "recall", "safety alert", "chargeback", "data breach", "outage", "apology", "official statement",
  "投诉", "诈骗", "维权", "数据泄露", "官方声明",
  "苦情", "返金", "詐欺", "悪評", "情報漏えい", "謝罪",
  "불만", "환불", "사기", "악평", "논란", "정보 유출", "사과문",
  "keluhan", "aduan", "khiếu nại", "hoàn tiền", "ร้องเรียน", "คืนเงิน",
  "queja", "reembolso", "plainte", "remboursement", "Beschwerde", "Rückerstattung",
  "reclamação", "reembolso", "شكوى", "استرداد", "शिकायत", "रिफंड",
];
const EVENT_EXPANSION_ENTITY_RE = /[\u4e00-\u9fffA-Za-z0-9][\u4e00-\u9fffA-Za-z0-9_-]{1,23}(?:平台|公司|品牌|基金會|協會|專案|項目|產品|服務|客服|活動|計畫|計劃)/g;
const EVENT_EXPANSION_STOP_WORDS = new Set([
  "相關輿情", "目前掌握", "主要來源", "未知", "客服服務", "公開搜尋", "完整文章", "台灣新聞",
  "google", "news", "yahoo", "reddit", "youtube", "bilibili", "tiktok", "douyin", "抖音", "kuaishou", "快手", "twitter", "x", "tweet", "facebook", "fb", "toutiao", "今日头条", "今日頭條", "sogou", "搜狗", "so", "360", "好搜", "weibo", "xiaohongshu", "小紅書", "小红书", "wechat", "weixin", "微信", "公眾號", "公众号", "threads", "instagram", "telegram",
]);
const EVENT_PLATFORM_HINTS = new Map([
  ["ptt", "PTT"],
  ["dcard", "Dcard"],
  ["threads", "Threads"],
  ["instagram", "Instagram"],
  ["x", "X/Twitter"],
  ["twitter", "X/Twitter"],
  ["facebook", "Facebook"],
  ["fb", "Facebook"],
  ["weibo", "微博"],
  ["xiaohongshu", "小紅書"],
  ["douyin", "抖音"],
  ["kuaishou", "快手"],
  ["toutiao", "今日頭條"],
  ["sogou", "搜狗"],
  ["so_search", "360搜索"],
  ["360", "360搜索"],
  ["youtube", "YouTube"],
  ["bilibili", "Bilibili"],
  ["apple_podcast_search", "Apple Podcasts"],
  ["podcast", "Apple Podcasts"],
  ["reddit", "Reddit"],
  ["mastodon", "Mastodon"],
  ["bluesky", "Bluesky"],
  ["telegram", "Telegram"],
  ["hacker_news", "Hacker News"],
  ["stack_overflow", "Stack Overflow"],
  ["legal_public_records", "Legal public records"],
  ["courtlistener", "CourtListener"],
  ["justia", "Justia"],
  ["lawsuit", "Lawsuit"],
  ["litigation", "Litigation"],
  ["public_procurement_sources", "Public procurement"],
  ["procurement", "Procurement"],
  ["usaspending", "USAspending"],
  ["contract_award", "Contract award"],
  ["public_sanctions_sources", "Public sanctions"],
  ["sanctions", "Sanctions"],
  ["ofac", "OFAC"],
  ["sdn", "SDN"],
  ["public_product_recall_sources", "Public product recalls"],
  ["cpsc", "CPSC"],
  ["openfda", "openFDA"],
  ["fda_recalls", "FDA recalls"],
  ["public_enforcement_action_sources", "Public enforcement actions"],
  ["cfpb", "CFPB"],
  ["cfpb_complaints", "CFPB complaints"],
  ["sec_enforcement", "SEC enforcement"],
  ["public_advertising_rulings_sources", "Public advertising rulings"],
  ["asa", "ASA"],
  ["asa_rulings", "ASA rulings"],
  ["advertising_rulings", "Advertising rulings"],
  ["public_regulatory_warning_letter_sources", "Public regulatory warning letters"],
  ["fda_warning_letters", "FDA warning letters"],
  ["warning_letters", "Warning letters"],
  ["regulatory_warning_letters", "Regulatory warning letters"],
  ["public_company_filings_sources", "SEC EDGAR public filings"],
  ["sec", "SEC"],
  ["edgar", "EDGAR"],
  ["8-k", "8-K"],
  ["10-k", "10-K"],
  ["10-q", "10-Q"],
  ["brand_impersonation_sources", "Brand impersonation"],
  ["certificate_transparency", "Certificate transparency"],
  ["crtsh", "crt.sh"],
  ["phishing", "Phishing"],
  ["impersonation", "Impersonation"],
]);
const EVENT_RISK_RANK = new Map([["low", 1], ["medium", 2], ["high", 3], ["critical", 4]]);
const ENTITY_TOPIC_RECALL_FAMILY_SOURCES = new Map([
  ["news", ["googleNews", "bingNews", "baiduNews", "taiwanNews", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "rssFeeds", "gdelt", "officialRegulatory", "toutiaoSearch", "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch"]],
  ["search", ["duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "toutiaoSearch", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "gdelt"]],
  ["community", ["reddit", "githubIssues", "gitLabIssues", "hackerNews", "stackOverflow", "discourseForums", "lemmy", "wechatPublicSearch"]],
  ["knowledge", ["zhihuSearch", "quoraSearch", "stackOverflow", "discourseForums", "lemmy"]],
  ["forum", ["ptt", "dcard", "tiebaSearch"]],
  ["social", ["threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "telegramPublic", "tumblrSearch"]],
  ["video", ["youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch"]],
  ["audio", ["applePodcastSearch"]],
  ["review", ["appStoreReviews", "googlePlayReviews", "publicReviewSites", "verticalReviewSources", "ecommerceReviewSources", "localReviewSources", "regionalComplaintSources"]],
  ["legal", ["legalPublicRecords", "officialRegulatory", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery"]],
  ["procurement", ["publicProcurementSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "linkedinSearch"]],
  ["compliance", ["publicSanctionsSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "linkedinSearch"]],
  ["security", ["securityAdvisorySources", "supplyChainAdvisorySources", "brandImpersonationSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "reddit", "telegramPublic"]],
  ["finance", ["publicCompanyFilingsSources", "investorDiscussionSources", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "reddit", "xSearch", "linkedinSearch"]],
]);
const BURST_PLATFORM_SOURCE_HINTS = new Map([
  ["news", ["googleNews", "bingNews", "baiduNews", "rssFeeds", "gdelt", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews"]],
  ["google_news", ["googleNews"]],
  ["bing_news", ["bingNews"]],
  ["baidu_news", ["baiduNews"]],
  ["yahoo_taiwan", ["yahooTaiwan"]],
  ["yahoo_japan_news", ["yahooJapanNews"]],
  ["yahoo_japan", ["yahooJapanNews"]],
  ["naver_korea_news", ["naverKoreaNews"]],
  ["naver_news", ["naverKoreaNews"]],
  ["naver", ["naverKoreaNews"]],
  ["daum_korea_news", ["daumKoreaNews"]],
  ["daum_news", ["daumKoreaNews"]],
  ["daum", ["daumKoreaNews"]],
  ["kakao_news", ["daumKoreaNews"]],
  ["taiwan_news", ["taiwanNews"]],
  ["rss_feeds", ["rssFeeds"]],
  ["official_regulatory", ["officialRegulatory"]],
  ["legal_public_records", ["legalPublicRecords"]],
  ["courtlistener", ["legalPublicRecords"]],
  ["justia", ["legalPublicRecords"]],
  ["lawsuit", ["legalPublicRecords"]],
  ["litigation", ["legalPublicRecords"]],
  ["public_procurement_sources", ["publicProcurementSources"]],
  ["procurement", ["publicProcurementSources"]],
  ["usaspending", ["publicProcurementSources"]],
  ["government_contract", ["publicProcurementSources"]],
  ["contract_award", ["publicProcurementSources"]],
  ["supplier", ["publicProcurementSources"]],
  ["vendor", ["publicProcurementSources"]],
  ["public_sanctions_sources", ["publicSanctionsSources"]],
  ["sanctions", ["publicSanctionsSources"]],
  ["ofac", ["publicSanctionsSources"]],
  ["sdn", ["publicSanctionsSources"]],
  ["watchlist", ["publicSanctionsSources"]],
  ["blacklist", ["publicSanctionsSources"]],
  ["public_product_recall_sources", ["publicProductRecallSources"]],
  ["product_recalls", ["publicProductRecallSources"]],
  ["recalls", ["publicProductRecallSources"]],
  ["cpsc", ["publicProductRecallSources"]],
  ["openfda", ["publicProductRecallSources"]],
  ["fda_recalls", ["publicProductRecallSources"]],
  ["product_safety", ["publicProductRecallSources"]],
  ["public_enforcement_action_sources", ["publicEnforcementActionSources"]],
  ["enforcement_actions", ["publicEnforcementActionSources"]],
  ["regulatory_enforcement", ["publicEnforcementActionSources"]],
  ["cfpb", ["publicEnforcementActionSources"]],
  ["cfpb_complaints", ["publicEnforcementActionSources"]],
  ["sec_enforcement", ["publicEnforcementActionSources"]],
  ["public_advertising_rulings_sources", ["publicAdvertisingRulingsSources"]],
  ["advertising_rulings", ["publicAdvertisingRulingsSources"]],
  ["ad_rulings", ["publicAdvertisingRulingsSources"]],
  ["asa", ["publicAdvertisingRulingsSources"]],
  ["asa_rulings", ["publicAdvertisingRulingsSources"]],
  ["public_regulatory_warning_letter_sources", ["publicRegulatoryWarningLetterSources"]],
  ["regulatory_warning_letters", ["publicRegulatoryWarningLetterSources"]],
  ["warning_letters", ["publicRegulatoryWarningLetterSources"]],
  ["fda_warning_letters", ["publicRegulatoryWarningLetterSources"]],
  ["fda_letters", ["publicRegulatoryWarningLetterSources"]],
  ["public_company_filings_sources", ["publicCompanyFilingsSources"]],
  ["company_filings", ["publicCompanyFilingsSources"]],
  ["sec_filings", ["publicCompanyFilingsSources"]],
  ["sec_edgar", ["publicCompanyFilingsSources"]],
  ["edgar", ["publicCompanyFilingsSources"]],
  ["8k", ["publicCompanyFilingsSources"]],
  ["10k", ["publicCompanyFilingsSources"]],
  ["10q", ["publicCompanyFilingsSources"]],
  ["brand_impersonation_sources", ["brandImpersonationSources"]],
  ["certificate_transparency", ["brandImpersonationSources"]],
  ["crtsh", ["brandImpersonationSources"]],
  ["phishing", ["brandImpersonationSources"]],
  ["impersonation", ["brandImpersonationSources"]],
  ["typosquatting", ["brandImpersonationSources"]],
  ["security_advisory_sources", ["securityAdvisorySources"]],
  ["security_advisory", ["securityAdvisorySources"]],
  ["vulnerability", ["securityAdvisorySources"]],
  ["cve", ["securityAdvisorySources"]],
  ["nvd", ["securityAdvisorySources"]],
  ["cisa_kev", ["securityAdvisorySources"]],
  ["kev", ["securityAdvisorySources"]],
  ["supply_chain_advisory_sources", ["supplyChainAdvisorySources"]],
  ["supply_chain", ["supplyChainAdvisorySources"]],
  ["osv", ["supplyChainAdvisorySources"]],
  ["ghsa", ["supplyChainAdvisorySources"]],
  ["github_advisory", ["supplyChainAdvisorySources"]],
  ["package_vulnerability", ["supplyChainAdvisorySources"]],
  ["stocktwits", ["investorDiscussionSources"]],
  ["yahoo_finance", ["investorDiscussionSources"]],
  ["market_sentiment", ["investorDiscussionSources"]],
  ["investor", ["investorDiscussionSources"]],
  ["ticker", ["investorDiscussionSources"]],
  ["public_status_page_sources", ["publicStatusPageSources"]],
  ["public_status_pages", ["publicStatusPageSources"]],
  ["status_pages", ["publicStatusPageSources"]],
  ["statuspage", ["publicStatusPageSources"]],
  ["outage", ["publicStatusPageSources"]],
  ["incident_status", ["publicStatusPageSources"]],
  ["official_owned_media_sources", ["officialOwnedMediaSources"]],
  ["official_owned_media", ["officialOwnedMediaSources"]],
  ["owned_media", ["officialOwnedMediaSources"]],
  ["company_newsroom", ["officialOwnedMediaSources"]],
  ["official_newsroom", ["officialOwnedMediaSources"]],
  ["company_statement", ["officialOwnedMediaSources"]],
  ["open_web", ["openWebDiscovery"]],
  ["duckduckgo", ["duckDuckGo"]],
  ["baidu_search", ["baiduSearch"]],
  ["sogou_search", ["sogouSearch"]],
  ["so_search", ["soSearch"]],
  ["yandex_search", ["yandexSearch"]],
  ["yandex", ["yandexSearch"]],
  ["wechat_public", ["wechatPublicSearch"]],
  ["toutiao", ["toutiaoSearch"]],
  ["tiktok", ["tiktokSearch"]],
  ["douyin", ["douyinSearch"]],
  ["kuaishou", ["kuaishouSearch"]],
  ["gdelt", ["gdelt"]],
  ["ptt", ["ptt"]],
  ["dcard", ["dcard"]],
  ["tieba", ["tiebaSearch"]],
  ["threads", ["threads"]],
  ["instagram", ["instagram"]],
  ["x", ["xSearch"]],
  ["twitter", ["xSearch"]],
  ["x_search", ["xSearch"]],
  ["twitter_search", ["xSearch"]],
  ["facebook", ["facebookSearch"]],
  ["fb", ["facebookSearch"]],
  ["facebook_search", ["facebookSearch"]],
  ["linkedin", ["linkedinSearch"]],
  ["linkedin_search", ["linkedinSearch"]],
  ["linked_in", ["linkedinSearch"]],
  ["weibo", ["weiboSearch"]],
  ["xiaohongshu", ["xiaohongshuSearch"]],
  ["zhihu", ["zhihuSearch"]],
  ["quora", ["quoraSearch"]],
  ["substack", ["substackSearch"]],
  ["medium", ["mediumSearch"]],
  ["wordpress", ["wordpressSearch"]],
  ["blogspot", ["blogspotSearch"]],
  ["blogger", ["blogspotSearch"]],
  ["tumblr", ["tumblrSearch"]],
  ["youtube", ["youtube"]],
  ["bilibili", ["bilibili"]],
  ["apple_podcast_search", ["applePodcastSearch"]],
  ["apple_podcasts", ["applePodcastSearch"]],
  ["podcast", ["applePodcastSearch"]],
  ["app_store", ["appStoreReviews"]],
  ["google_play", ["googlePlayReviews"]],
  ["public_review_sites", ["publicReviewSites"]],
  ["vertical_review_sources", ["verticalReviewSources"]],
  ["ecommerce_review_sources", ["ecommerceReviewSources"]],
  ["local_review_sources", ["localReviewSources"]],
  ["local_reviews", ["localReviewSources"]],
  ["regional_complaint_sources", ["regionalComplaintSources"]],
  ["mastodon", ["mastodon"]],
  ["bluesky", ["bluesky"]],
  ["telegram", ["telegramPublic"]],
  ["reddit", ["reddit"]],
  ["github_issues", ["githubIssues"]],
  ["gitlab_issues", ["gitLabIssues"]],
  ["hacker_news", ["hackerNews"]],
  ["stack_overflow", ["stackOverflow"]],
  ["discourse", ["discourseForums"]],
  ["lemmy", ["lemmy"]],
]);
const BURST_WATCH_SOURCE_KEYS = ["ptt", "dcard", "tiebaSearch", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "telegramPublic", "youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch", "appStoreReviews", "googlePlayReviews", "publicReviewSites", "verticalReviewSources", "employerReviewSources", "ecommerceReviewSources", "localReviewSources", "regionalComplaintSources"];
const BURST_NEWS_SOURCE_KEYS = ["googleNews", "bingNews", "baiduNews", "rssFeeds", "gdelt", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"];
const URGENCY_CORE_SOURCE_KEYS = ["googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "rssFeeds", "gdelt", "officialRegulatory", "legalPublicRecords", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "brandImpersonationSources", "securityAdvisorySources", "supplyChainAdvisorySources", "investorDiscussionSources", "publicStatusPageSources", "officialOwnedMediaSources"];
const URGENCY_WATCH_SOURCE_KEYS = ["ptt", "dcard", "tiebaSearch", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "telegramPublic", "youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch"];
const EVIDENCE_GAP_SOURCE_GROUPS = [
  { pattern: /正文|页面|頁面|文章|頭條|头条|公眾號|公众号|article|body/i, sources: ["googleNews", "bingNews", "baiduNews", "rssFeeds", "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "tumblrSearch", "openWebDiscovery", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "wechatPublicSearch", "toutiaoSearch", "zhihuSearch", "quoraSearch", "gdelt", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"], reason: "missing-body-evidence" },
  { pattern: /评论|評論|回复|回覆|跟帖|回帖|弹幕|彈幕|转发|轉發|comment|reply|tweet|retweet|facebook|臉書|脸书|linkedin|領英|领英/i, sources: ["youtube", "bilibili", "tiktokSearch", "xSearch", "facebookSearch", "linkedinSearch", "ptt", "dcard", "tiebaSearch", "reddit", "githubIssues", "gitLabIssues", "hackerNews", "stackOverflow", "quoraSearch", "discourseForums", "lemmy"], reason: "missing-comment-evidence" },
  { pattern: /首发|首發|来源|來源|origin|first/i, sources: ["googleNews", "bingNews", "baiduNews", "rssFeeds", "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "tumblrSearch", "officialRegulatory", "openWebDiscovery", "gdelt", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "wechatPublicSearch", "toutiaoSearch", "ptt", "dcard", "tiebaSearch", "threads", "xSearch", "facebookSearch", "linkedinSearch", "youtube"], reason: "missing-origin-evidence" },
  { pattern: /跨平台|传播|傳播|扩散|擴散|微博|抖音|快手|小紅書|小红书|TikTok|Twitter|X\/Twitter|推特|Facebook|FB|臉書|脸书|LinkedIn|領英|领英|貼吧|贴吧|platform/i, sources: ["ptt", "dcard", "tiebaSearch", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "tiktokSearch", "douyinSearch", "kuaishouSearch", "mastodon", "bluesky", "telegramPublic", "tumblrSearch", "youtube", "bilibili", "googleNews", "bingNews", "baiduNews", "rssFeeds"], reason: "missing-cross-platform-evidence" },
  { pattern: /事实|事實|矛盾|声明|聲明|claim|contradiction/i, sources: ["officialOwnedMediaSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "baiduNews", "rssFeeds", "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "tumblrSearch", "openWebDiscovery", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "wechatPublicSearch", "toutiaoSearch", "zhihuSearch", "quoraSearch", "reddit", "githubIssues", "gitLabIssues", "discourseForums", "lemmy"], reason: "missing-fact-claim-evidence" },
  { pattern: /引用|转述|轉述|quoted|quote|repost|retweet/i, sources: ["bluesky", "threads", "xSearch", "instagram", "mastodon"], reason: "missing-quoted-context" },
  { pattern: /视频|影片|短视频|短影音|抖音|快手|TikTok|弹幕|彈幕|video|YouTube|B站|bilibili|哔哩|嗶哩|后续|後續/i, sources: ["youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch"], reason: "missing-video-followup-evidence" },
  { pattern: /应用|應用|app|App Store|Google Play|Android|評論|评论|評價|评价|星級|评分|評分/i, sources: ["appStoreReviews", "googlePlayReviews", "publicReviewSites", "verticalReviewSources", "ecommerceReviewSources", "regionalComplaintSources"], reason: "missing-app-review-evidence" },
  { pattern: /投訴|投诉|客訴|客诉|complaint|review|rating|評價|评价|負評|负评|退款|退貨|物流|delivery|refund|消保|消委會|爭議|employee|workplace|layoff|culture|雇主|員工|员工|職場|职场|裁員|裁员|門店|门店|餐廳|餐厅|hotel|restaurant|local service|in-store/i, sources: ["publicReviewSites", "verticalReviewSources", "employerReviewSources", "ecommerceReviewSources", "localReviewSources", "regionalComplaintSources", "appStoreReviews", "googlePlayReviews", "reddit", "dcard"], reason: "missing-public-review-complaint-evidence" },
  { pattern: /訴訟|诉讼|法院|起訴|起诉|集體訴訟|集体诉讼|判決|判决|lawsuit|litigation|class action|court|docket|settlement/i, sources: ["legalPublicRecords", "officialRegulatory", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds"], reason: "missing-legal-record-evidence" },
  { pattern: /recall|product safety|safety alert|cpsc|openfda|fda enforcement|dangerous product|class i|class ii|召回|產品安全|产品安全|安全警示|危險產品|危险产品/i, sources: ["publicProductRecallSources", "officialRegulatory", "regionalComplaintSources", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds"], reason: "missing-product-recall-evidence" },
  { pattern: /enforcement action|administrative action|regulatory action|consumer complaint|cfpb|sec enforcement|market conduct|cease-and-desist|執法|执法|行政處罰|行政处罚|監管處罰|监管处罚|消費者投訴|消费者投诉|投诉数据库|投訴資料庫/i, sources: ["publicEnforcementActionSources", "officialRegulatory", "legalPublicRecords", "regionalComplaintSources", "publicReviewSites", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds"], reason: "missing-enforcement-action-evidence" },
  { pattern: /advertising ruling|ad ruling|advertising standards|asa ruling|misleading ad|misleading advertising|greenwashing|influencer disclosure|marketing claim|廣告裁決|广告裁决|廣告監管|广告监管|誤導廣告|误导广告|虛假宣傳|虚假宣传|綠色洗白|绿色洗白/i, sources: ["publicAdvertisingRulingsSources", "officialRegulatory", "publicEnforcementActionSources", "legalPublicRecords", "regionalComplaintSources", "publicReviewSites", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds"], reason: "missing-advertising-ruling-evidence" },
  { pattern: /warning letter|fda warning|regulatory warning|untitled letter|cgmp|qsr|adulterated|misbranded|unapproved drug|insanitary|警告信|監管警告|监管警告|未批准|摻假|掺假|標示不實|标示不实/i, sources: ["publicRegulatoryWarningLetterSources", "publicProductRecallSources", "publicEnforcementActionSources", "officialRegulatory", "legalPublicRecords", "regionalComplaintSources", "publicReviewSites", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds"], reason: "missing-regulatory-warning-letter-evidence" },
  { pattern: /procurement|contract award|government contract|usaspending|vendor|supplier|grant|solicitation|招標|招标|投標|投标|中標|中标|政府採購|政府采购|供應商|供应商|合同|合約/i, sources: ["publicProcurementSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds", "linkedinSearch"], reason: "missing-procurement-record-evidence" },
  { pattern: /sanction|ofac|sdn|watchlist|blacklist|blocked person|denied party|entity list|制裁|風險名單|风险名单|黑名單|黑名单|禁運|禁运|合規|合规/i, sources: ["publicSanctionsSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds", "linkedinSearch"], reason: "missing-sanctions-watchlist-evidence" },
  { pattern: /sec|edgar|filing|8-k|10-k|10-q|20-f|6-k|annual report|quarterly report|material event|cybersecurity incident|上市公司|公開披露|公开披露|年報|年报|季報|季报|重大事項|重大事项/i, sources: ["publicCompanyFilingsSources", "investorDiscussionSources", "officialRegulatory", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds", "linkedinSearch"], reason: "missing-company-filing-evidence" },
  { pattern: /phishing|impersonation|typosquat|certificate transparency|crt\.?sh|scam domain|fake website|釣魚|钓鱼|仿冒|冒牌|假網站|假网站|域名|證書|证书/i, sources: ["brandImpersonationSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "reddit", "telegramPublic", "xSearch"], reason: "missing-brand-impersonation-evidence" },
  { pattern: /cve|nvd|cisa|kev|cvss|vulnerability|exploit|ransomware|security advisory|zero-?day|漏洞|安全公告|已利用漏洞|勒索|漏洞利用|零日/i, sources: ["securityAdvisorySources", "officialRegulatory", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "reddit", "githubIssues"], reason: "missing-security-advisory-evidence" },
  { pattern: /osv|ghsa|github advisory|github security advisory|package vulnerability|supply chain|dependency|npm|pypi|maven|rubygems|nuget|packagist|crates\.io|供應鏈|供应链|依賴|依赖|開源漏洞|开源漏洞/i, sources: ["supplyChainAdvisorySources", "securityAdvisorySources", "githubIssues", "gitLabIssues", "googleNews", "bingNews", "rssFeeds", "reddit", "openWebDiscovery"], reason: "missing-supply-chain-advisory-evidence" },
  { pattern: /stocktwits|yahoo finance|investor|market sentiment|ticker|cashtag|stock|shares|earnings|short seller|股價|股价|股票|投資者|投资者|投資人|投资人|財報|财报|做空/i, sources: ["investorDiscussionSources", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "reddit", "xSearch", "linkedinSearch"], reason: "missing-investor-market-evidence" },
  { pattern: /statuspage|status page|service status|outage|incident|degraded|partial outage|major outage|scheduled maintenance|downtime|服務中斷|服务中断|宕機|宕机|故障|延遲|延迟|維護|维护/i, sources: ["publicStatusPageSources", "officialOwnedMediaSources", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery", "reddit", "xSearch"], reason: "missing-service-status-evidence" },
];
const EVIDENCE_DEPTH_SOURCE_GROUPS = [
  { pattern: /正文|原文|页面|頁面|文章|頭條|头条|公眾號|公众号|上下文|canonical|OG|结构化|結構化/i, sources: ["googleNews", "bingNews", "baiduNews", "rssFeeds", "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "tumblrSearch", "openWebDiscovery", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "wechatPublicSearch", "toutiaoSearch", "zhihuSearch", "quoraSearch", "gdelt", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"], reason: "thin-body-or-page-metadata" },
  { pattern: /作者|频道|頻道|发布时间|發佈時間|发布|published/i, sources: ["officialOwnedMediaSources", "officialRegulatory", "googleNews", "bingNews", "baiduNews", "rssFeeds", "openWebDiscovery", "duckDuckGo", "gdelt", "youtube", "reddit", "ptt", "dcard"], reason: "missing-author-or-timestamp" },
  { pattern: /评论|評論|回复|回覆|跟帖|回帖|互动|互動|转发|轉發|弹幕|彈幕|engagement|retweet/i, sources: ["youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch", "ptt", "dcard", "tiebaSearch", "reddit", "githubIssues", "gitLabIssues", "hackerNews", "stackOverflow", "zhihuSearch", "quoraSearch", "discourseForums", "lemmy", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "telegramPublic", "tumblrSearch"], reason: "missing-comments-or-engagement" },
  { pattern: /来源权重|來源權重|质量|品質|source tier|source weight/i, sources: ["googleNews", "bingNews", "baiduNews", "rssFeeds", "gdelt", "regionalComplaintSources", "publicReviewSites", "verticalReviewSources", "ecommerceReviewSources", "localReviewSources"], reason: "missing-source-weight-or-quality" },
  { pattern: /訴訟|诉讼|法院|起訴|起诉|集體訴訟|集体诉讼|判決|判决|lawsuit|litigation|class action|court|docket|settlement/i, sources: ["legalPublicRecords", "officialRegulatory", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery"], reason: "missing-legal-record-context" },
  { pattern: /recall|product safety|safety alert|cpsc|openfda|fda enforcement|dangerous product|class i|class ii|召回|產品安全|产品安全|安全警示|危險產品|危险产品/i, sources: ["publicProductRecallSources", "officialRegulatory", "regionalComplaintSources", "googleNews", "bingNews", "rssFeeds", "gdelt"], reason: "missing-product-recall-context" },
  { pattern: /enforcement action|administrative action|regulatory action|consumer complaint|cfpb|sec enforcement|market conduct|cease-and-desist|執法|执法|行政處罰|行政处罚|監管處罰|监管处罚|消費者投訴|消费者投诉|投诉数据库|投訴資料庫/i, sources: ["publicEnforcementActionSources", "officialRegulatory", "legalPublicRecords", "regionalComplaintSources", "publicReviewSites", "googleNews", "bingNews", "rssFeeds", "gdelt"], reason: "missing-enforcement-action-context" },
  { pattern: /advertising ruling|ad ruling|advertising standards|asa ruling|misleading ad|misleading advertising|greenwashing|influencer disclosure|marketing claim|廣告裁決|广告裁决|廣告監管|广告监管|誤導廣告|误导广告|虛假宣傳|虚假宣传|綠色洗白|绿色洗白/i, sources: ["publicAdvertisingRulingsSources", "officialRegulatory", "publicEnforcementActionSources", "legalPublicRecords", "regionalComplaintSources", "publicReviewSites", "googleNews", "bingNews", "rssFeeds", "gdelt"], reason: "missing-advertising-ruling-context" },
  { pattern: /warning letter|fda warning|regulatory warning|untitled letter|cgmp|qsr|adulterated|misbranded|unapproved drug|insanitary|警告信|監管警告|监管警告|未批准|摻假|掺假|標示不實|标示不实/i, sources: ["publicRegulatoryWarningLetterSources", "publicProductRecallSources", "publicEnforcementActionSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "rssFeeds", "gdelt"], reason: "missing-regulatory-warning-letter-context" },
  { pattern: /procurement|contract award|government contract|usaspending|vendor|supplier|grant|solicitation|招標|招标|投標|投标|中標|中标|政府採購|政府采购|供應商|供应商|合同|合約/i, sources: ["publicProcurementSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt"], reason: "missing-procurement-record-context" },
  { pattern: /sanction|ofac|sdn|watchlist|blacklist|blocked person|denied party|entity list|制裁|風險名單|风险名单|黑名單|黑名单|禁運|禁运|合規|合规/i, sources: ["publicSanctionsSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt"], reason: "missing-sanctions-watchlist-context" },
  { pattern: /sec|edgar|filing|8-k|10-k|10-q|20-f|6-k|annual report|quarterly report|material event|cybersecurity incident|上市公司|公開披露|公开披露|年報|年报|季報|季报|重大事項|重大事项/i, sources: ["publicCompanyFilingsSources", "investorDiscussionSources", "googleNews", "bingNews", "rssFeeds", "gdelt"], reason: "missing-company-filing-context" },
  { pattern: /phishing|impersonation|typosquat|certificate transparency|crt\.?sh|scam domain|fake website|釣魚|钓鱼|仿冒|冒牌|假網站|假网站|域名|證書|证书/i, sources: ["brandImpersonationSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews"], reason: "missing-brand-impersonation-context" },
  { pattern: /cve|nvd|cisa|kev|cvss|vulnerability|exploit|ransomware|security advisory|zero-?day|漏洞|安全公告|已利用漏洞|勒索|漏洞利用|零日/i, sources: ["securityAdvisorySources", "officialRegulatory", "googleNews", "bingNews", "rssFeeds", "gdelt"], reason: "missing-security-advisory-context" },
  { pattern: /osv|ghsa|github advisory|github security advisory|package vulnerability|supply chain|dependency|npm|pypi|maven|rubygems|nuget|packagist|crates\.io|供應鏈|供应链|依賴|依赖|開源漏洞|开源漏洞/i, sources: ["supplyChainAdvisorySources", "securityAdvisorySources", "githubIssues", "googleNews", "bingNews", "rssFeeds"], reason: "missing-supply-chain-advisory-context" },
  { pattern: /stocktwits|yahoo finance|investor|market sentiment|ticker|cashtag|stock|shares|earnings|short seller|股價|股价|股票|投資者|投资者|投資人|投资人|財報|财报|做空/i, sources: ["investorDiscussionSources", "googleNews", "bingNews", "rssFeeds", "gdelt"], reason: "missing-investor-market-context" },
  { pattern: /statuspage|status page|service status|outage|incident|degraded|partial outage|major outage|scheduled maintenance|downtime|服務中斷|服务中断|宕機|宕机|故障|延遲|延迟|維護|维护/i, sources: ["publicStatusPageSources", "officialOwnedMediaSources", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery"], reason: "missing-service-status-context" },
];
const SOURCE_TOPIC_KEYWORD_HINTS = new Map([
  ["youtube", ["YouTube", "影片", "視頻", "视频"]],
  ["bilibili", ["B站", "Bilibili", "哔哩哔哩", "嗶哩嗶哩", "弹幕", "彈幕"]],
  ["applePodcastSearch", ["Apple Podcasts", "podcast", "播客", "音频", "音頻", "访谈", "訪談"]],
  ["tiktokSearch", ["TikTok", "short video", "短视频", "短視頻", "video", "爆料"]],
  ["douyinSearch", ["抖音", "Douyin", "短视频", "短視頻", "短影音", "视频爆料", "視頻爆料"]],
  ["kuaishouSearch", ["快手", "Kuaishou", "短视频", "短視頻", "短影音", "视频爆料", "視頻爆料"]],
  ["appStoreReviews", ["App Store", "iOS", "評論", "評價"]],
  ["googlePlayReviews", ["Google Play", "Android", "評論", "評價"]],
  ["publicReviewSites", ["Trustpilot", "BBB", "Sitejabber", "ComplaintsBoard", "PissedConsumer", "評論", "投訴"]],
  ["verticalReviewSources", ["Chrome Web Store", "Product Hunt", "Steam", "G2", "Capterra", "TrustRadius", "Microsoft Store", "評論", "評價"]],
  ["ecommerceReviewSources", ["Amazon", "eBay", "Etsy", "Walmart", "Best Buy", "Shopee", "PChome", "momo", "退款", "物流"]],
  ["localReviewSources", ["Yelp", "Tripadvisor", "Google Maps", "Foursquare", "OpenTable", "門店", "餐廳", "本地服務"]],
  ["regionalComplaintSources", ["消保", "消委會", "CASE", "ACCC", "Scamwatch", "投訴", "爭議", "refund"]],
  ["legalPublicRecords", ["CourtListener", "Justia", "lawsuit", "litigation", "class action", "court", "docket", "settlement", "訴訟", "法院"]],
  ["publicProductRecallSources", ["CPSC", "openFDA", "FDA enforcement", "EU Safety Gate", "RAPEX", "NHTSA", "vehicle recall", "vehicle complaint", "ODI complaint", "defect complaint", "unintended acceleration", "defect recall", "fire risk", "do not drive", "recall", "product safety", "safety alert", "dangerous product", "Class I", "Class II", "召回", "產品安全", "車輛召回", "車輛投訴", "安全警示", "危險產品"]],
  ["publicEnforcementActionSources", ["CFPB", "SEC enforcement", "SEC litigation release", "SEC administrative proceeding", "SEC trading suspension", "FTC", "Federal Trade Commission", "consumer protection", "consumer complaint", "enforcement action", "administrative action", "market conduct", "cease-and-desist", "penalty", "deceptive", "unfair", "privacy", "data security", "regulatory action", "執法", "行政處罰", "監管處罰", "消費者投訴", "投诉数据库"]],
  ["publicAdvertisingRulingsSources", ["ASA", "advertising ruling", "misleading ad", "advertising standards", "greenwashing", "influencer disclosure", "marketing claim", "ad complaint", "廣告裁決", "廣告監管", "誤導廣告", "虛假宣傳", "綠色洗白"]],
  ["publicRegulatoryWarningLetterSources", ["FDA Warning Letters", "warning letter", "regulatory warning", "CGMP", "QSR", "adulterated", "misbranded", "unapproved drug", "insanitary", "untitled letter", "警告信", "監管警告", "未批准", "摻假", "標示不實"]],
  ["publicProcurementSources", ["USAspending", "procurement", "contract award", "government contract", "vendor", "supplier", "grant", "solicitation", "招標", "中標", "政府採購", "供應商", "合同"]],
  ["publicSanctionsSources", ["OFAC", "SDN", "UK Sanctions List", "OFSI", "EU sanctions", "EU consolidated sanctions", "UN Security Council", "UN consolidated list", "financial sanctions", "asset freeze", "funds freeze", "travel ban", "Interpol notice", "sanctions", "watchlist", "blocked person", "denied party", "entity list", "blacklist", "制裁", "風險名單", "黑名單", "禁運", "合規"]],
  ["publicCompanyFilingsSources", ["SEC", "EDGAR", "8-K", "10-K", "10-Q", "20-F", "6-K", "The Gazette", "company notice", "insolvency", "liquidation", "winding up", "administration", "strike off", "public filing", "annual report", "quarterly report", "material event", "cybersecurity incident", "上市公司", "公開披露", "破產", "清算", "註銷", "年報", "季報", "重大事項"]],
  ["brandImpersonationSources", ["crt.sh", "certificate transparency", "phishing", "impersonation", "typosquatting", "fake website", "釣魚", "仿冒", "假網站", "域名"]],
  ["securityAdvisorySources", ["CISA KEV", "CISA advisory", "CISA alert", "NVD", "CVE", "CVSS", "known exploited vulnerability", "active exploitation", "emergency directive", "vulnerability", "exploit", "ransomware", "security advisory", "漏洞", "安全公告", "已利用漏洞", "勒索"]],
  ["supplyChainAdvisorySources", ["OSV", "GHSA", "GitHub Security Advisory", "npm", "PyPI", "Maven", "Go", "package vulnerability", "dependency vulnerability", "supply chain", "供應鏈", "依賴漏洞"]],
  ["investorDiscussionSources", ["Stocktwits", "Yahoo Finance", "investor", "market sentiment", "ticker", "cashtag", "earnings", "short seller", "股價", "投資者", "財報", "做空"]],
  ["publicStatusPageSources", ["Statuspage", "status page", "service status", "outage", "incident", "degraded", "maintenance", "服務中斷", "故障", "宕機"]],
  ["officialOwnedMediaSources", ["official newsroom", "official blog", "press release", "company statement", "official statement", "公告", "聲明", "回應", "官网", "官網"]],
  ["dcard", ["Dcard"]],
  ["ptt", ["PTT"]],
  ["tiebaSearch", ["百度貼吧", "百度贴吧", "貼吧", "贴吧", "Tieba"]],
  ["wechatPublicSearch", ["微信", "WeChat", "公眾號", "公众号", "微信文章", "微信公眾號", "微信公众号"]],
  ["toutiaoSearch", ["今日頭條", "今日头条", "Toutiao", "頭條文章", "头条文章"]],
  ["threads", ["Threads"]],
  ["instagram", ["Instagram", "INS"]],
  ["xSearch", ["X", "Twitter", "tweet", "retweet", "quote post"]],
  ["facebookSearch", ["Facebook", "FB", "public post", "repost", "community page"]],
  ["linkedinSearch", ["LinkedIn", "B2B", "company page", "public post", "professional network"]],
  ["weiboSearch", ["微博", "Weibo", "新浪微博"]],
  ["xiaohongshuSearch", ["小紅書", "小红书", "Xiaohongshu", "RedNote", "避雷筆記", "避雷笔记"]],
  ["zhihuSearch", ["知乎", "知乎問答", "知乎问答", "如何看待"]],
  ["quoraSearch", ["Quora", "question", "answer", "discussion"]],
  ["substackSearch", ["Substack", "newsletter", "essay", "analysis", "long-form"]],
  ["mediumSearch", ["Medium", "essay", "analysis", "long-form", "blog"]],
  ["wordpressSearch", ["WordPress", "blog", "personal blog", "long-form"]],
  ["blogspotSearch", ["Blogspot", "Blogger", "blog", "personal blog", "long-form"]],
  ["tumblrSearch", ["Tumblr", "blog", "post", "reblog", "fandom"]],
  ["bluesky", ["Bluesky"]],
  ["telegramPublic", ["Telegram", "TG"]],
  ["mastodon", ["Mastodon"]],
  ["reddit", ["Reddit"]],
  ["githubIssues", ["GitHub"]],
  ["gitLabIssues", ["GitLab"]],
  ["hackerNews", ["Hacker News"]],
  ["stackOverflow", ["Stack Overflow"]],
  ["discourseForums", ["Discourse"]],
  ["lemmy", ["Lemmy", "Fediverse forum", "federated community", "ActivityPub discussion", "去中心化社群", "聯邦論壇"]],
  ["googleNews", ["Google News"]],
  ["bingNews", ["Bing News", "Bing 新聞", "Bing 新闻"]],
  ["yahooTaiwan", ["Yahoo"]],
  ["yahooJapanNews", ["Yahoo Japan", "日本 Yahoo", "日本新聞", "日文新聞"]],
  ["naverKoreaNews", ["Naver", "韓國新聞", "韩国新闻", "Korean news", "Naver 뉴스"]],
  ["daumKoreaNews", ["Daum", "Kakao", "韓國新聞", "韩国新闻", "Korean news", "Daum 뉴스"]],
  ["rssFeeds", ["RSS"]],
  ["officialRegulatory", ["官方公告", "監管", "recall", "warning"]],
  ["openWebDiscovery", ["Open Web", "site search", "公開網頁"]],
  ["gdelt", ["GDELT"]],
  ["duckDuckGo", ["DuckDuckGo"]],
  ["baiduSearch", ["百度", "百度搜索", "百度新闻", "Baidu"]],
  ["baiduNews", ["百度新聞", "百度新闻", "Baidu News"]],
  ["sogouSearch", ["搜狗", "Sogou", "搜狗搜索", "中文搜索"]],
  ["soSearch", ["360搜索", "好搜", "So.com", "中文搜索"]],
  ["yandexSearch", ["Yandex", "俄語搜索", "俄语搜索", "Russian search", "CIS open web"]],
]);
const REALTIME_SOURCE_KEYS = new Set(["ptt", "dcard", "tiebaSearch", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "telegramPublic", "youtube", "bilibili", "applePodcastSearch", "tiktokSearch", "douyinSearch", "kuaishouSearch", "appStoreReviews", "googlePlayReviews", "publicReviewSites", "verticalReviewSources", "employerReviewSources", "ecommerceReviewSources", "localReviewSources", "regionalComplaintSources"]);
const SOCIAL_SOURCE_KEYS = new Set(["ptt", "dcard", "tiebaSearch", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "telegramPublic", "tumblrSearch", "youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch", "reddit"]);
const DEEP_COVERAGE_SOURCE_KEYS = new Set(["taiwanNews", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "wechatPublicSearch", "toutiaoSearch", "zhihuSearch", "quoraSearch", "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "tumblrSearch", "xSearch", "facebookSearch", "linkedinSearch", "tiktokSearch", "openWebDiscovery", "gdelt", "rssFeeds", "officialRegulatory", "legalPublicRecords", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "brandImpersonationSources", "securityAdvisorySources", "supplyChainAdvisorySources", "investorDiscussionSources", "publicStatusPageSources", "officialOwnedMediaSources", "githubIssues", "gitLabIssues", "reddit", "hackerNews", "stackOverflow", "discourseForums", "lemmy", "youtube", "bilibili", "applePodcastSearch", "publicReviewSites", "verticalReviewSources", "employerReviewSources", "ecommerceReviewSources", "localReviewSources", "regionalComplaintSources"]);
const REALTIME_COVERAGE_FAMILY_SOURCES = new Map([
  ["news", ["googleNews", "bingNews", "baiduNews", "rssFeeds", "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "officialRegulatory", "gdelt", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"]],
  ["search", ["duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "wechatPublicSearch", "toutiaoSearch", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "gdelt"]],
  ["social", ["threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "telegramPublic", "tumblrSearch"]],
  ["forum", ["ptt", "dcard", "tiebaSearch", "reddit"]],
  ["community", ["reddit", "hackerNews", "githubIssues", "gitLabIssues", "stackOverflow", "discourseForums", "lemmy"]],
  ["knowledge", ["zhihuSearch", "quoraSearch", "stackOverflow", "discourseForums", "lemmy"]],
  ["video", ["youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch"]],
  ["audio", ["applePodcastSearch"]],
  ["review", ["publicReviewSites", "verticalReviewSources", "ecommerceReviewSources", "localReviewSources", "appStoreReviews", "googlePlayReviews"]],
  ["complaint", ["regionalComplaintSources", "publicReviewSites", "reddit", "dcard"]],
  ["legal", ["legalPublicRecords", "officialRegulatory", "googleNews", "bingNews", "duckDuckGo"]],
  ["official-regulatory", ["publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "officialRegulatory", "regionalComplaintSources", "googleNews", "bingNews", "rssFeeds", "gdelt"]],
  ["procurement", ["publicProcurementSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "duckDuckGo", "gdelt"]],
  ["compliance", ["publicSanctionsSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "duckDuckGo", "gdelt"]],
  ["security", ["securityAdvisorySources", "supplyChainAdvisorySources", "brandImpersonationSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews"]],
  ["finance", ["publicCompanyFilingsSources", "investorDiscussionSources", "googleNews", "bingNews", "rssFeeds", "gdelt"]],
  ["operations", ["publicStatusPageSources", "officialOwnedMediaSources", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery"]],
  ["official", ["officialOwnedMediaSources", "officialRegulatory", "rssFeeds", "googleNews", "bingNews", "openWebDiscovery"]],
]);
const REALTIME_COVERAGE_SOURCE_FAMILIES = new Map(
  [...REALTIME_COVERAGE_FAMILY_SOURCES.entries()].flatMap(([family, sources]) => sources.map(source => [source, family]))
);
const FREE_SOURCE_TARGET_CATALOGS = {
  applePodcastSearch: [],
  appStoreReviews: [],
  googlePlayReviews: [],
  publicReviewSites: PUBLIC_REVIEW_SITE_TARGETS,
  verticalReviewSources: VERTICAL_REVIEW_TARGETS,
  ecommerceReviewSources: ECOMMERCE_REVIEW_TARGETS,
  localReviewSources: LOCAL_REVIEW_TARGETS,
  regionalComplaintSources: REGIONAL_COMPLAINT_TARGETS,
  discourseForums: DISCOURSE_FORUM_TARGETS,
  reddit: [],
  ptt: [],
  dcard: [],
  telegramPublic: [],
  threads: [],
  instagram: [],
  publicStatusPageSources: [],
  officialOwnedMediaSources: [],
  publicCompanyFilingsSources: [],
  brandImpersonationSources: [],
  securityAdvisorySources: [],
  supplyChainAdvisorySources: [],
  investorDiscussionSources: [],
};
const FREE_SOURCE_TARGET_EXPECTATIONS = [
  { profile: "official", label: "official/regulatory public sources", sources: ["regionalComplaintSources"], terms: ["official complaint", "consumer protection", "regulatory warning"], weight: 12 },
  { profile: "regulatory", label: "regulatory and safety alerts", sources: ["regionalComplaintSources"], terms: ["regulatory warning", "recall", "safety alert"], weight: 12 },
  { profile: "consumer-protection", label: "consumer protection bodies", sources: ["regionalComplaintSources"], terms: ["consumer protection", "complaint", "refund dispute"], weight: 10 },
  { profile: "complaint", label: "public complaint boards", sources: ["publicReviewSites", "regionalComplaintSources"], terms: ["complaint", "refund", "customer service"], weight: 10 },
  { profile: "review", label: "public review platforms", sources: ["publicReviewSites", "verticalReviewSources", "ecommerceReviewSources"], terms: ["review", "rating", "negative review"], weight: 8 },
  { profile: "b2b", label: "B2B SaaS review sites", sources: ["verticalReviewSources"], terms: ["G2", "Capterra", "software review"], weight: 8 },
  { profile: "app", label: "app and extension marketplaces", sources: ["verticalReviewSources", "appStoreReviews", "googlePlayReviews"], terms: ["app review", "extension review", "store rating"], weight: 8 },
  { profile: "marketplace", label: "marketplace and ecommerce reviews", sources: ["ecommerceReviewSources"], terms: ["marketplace review", "seller complaint", "delivery refund"], weight: 8 },
  { profile: "taiwan", label: "Taiwan local public sources", sources: ["regionalComplaintSources", "ecommerceReviewSources"], terms: ["台灣 投訴", "消保", "退款"], weight: 7 },
  { profile: "us", label: "US public sources", sources: ["regionalComplaintSources", "publicReviewSites", "ecommerceReviewSources"], terms: ["US complaint", "BBB", "FTC"], weight: 6 },
  { profile: "uk", label: "UK public sources", sources: ["regionalComplaintSources"], terms: ["UK consumer complaint", "trading standards"], weight: 6 },
  { profile: "eu", label: "EU public sources", sources: ["regionalComplaintSources"], terms: ["EU safety gate", "recall", "consumer"], weight: 6 },
  { profile: "japan", label: "Japan public sources", sources: ["regionalComplaintSources", "ecommerceReviewSources"], terms: ["Japan consumer complaint", "recall"], weight: 6 },
  { profile: "korea", label: "Korea public sources", sources: ["regionalComplaintSources"], terms: ["Korea consumer complaint", "recall"], weight: 6 },
  { profile: "india", label: "India public sources", sources: ["regionalComplaintSources", "publicReviewSites"], terms: ["India consumer complaint", "refund"], weight: 6 },
  { profile: "southeast-asia", label: "Southeast Asia ecommerce/review sources", sources: ["ecommerceReviewSources"], terms: ["Southeast Asia review", "Shopee complaint", "Lazada refund"], weight: 6 },
  { profile: "community", label: "public product/community forums", sources: ["discourseForums"], terms: ["community complaint", "support forum", "product discussion"], weight: 8 },
  { profile: "federated", label: "federated community discussion", sources: ["lemmy"], terms: ["fediverse complaint", "lemmy discussion", "community incident"], weight: 7 },
  { profile: "developer", label: "developer support communities", sources: ["discourseForums"], terms: ["developer support", "bug report", "incident"], weight: 7 },
  { profile: "opensource", label: "open-source community forums", sources: ["discourseForums"], terms: ["open source issue", "release problem", "support forum"], weight: 6 },
  { profile: "consumer", label: "consumer product forums", sources: ["discourseForums"], terms: ["consumer support", "privacy complaint", "product issue"], weight: 6 },
  { profile: "podcast-show", label: "tracked podcast shows", sources: ["applePodcastSearch"], terms: ["podcast", "podcast episode", "audio interview", "播客", "音频", "訪談"], weight: 8 },
  { profile: "audio", label: "audio and podcast monitoring", sources: ["applePodcastSearch"], terms: ["audio crisis", "podcast complaint", "interview follow-up", "音频 投訴", "播客 後續"], weight: 7 },
  { profile: "mobile-app", label: "tracked mobile app review targets", sources: ["appStoreReviews", "googlePlayReviews"], terms: ["app review", "mobile app complaint", "rating", "refund", "crash"], weight: 8 },
  { profile: "ios-app", label: "tracked iOS App Store targets", sources: ["appStoreReviews"], terms: ["App Store review", "iOS app complaint", "iPhone app rating"], weight: 8 },
  { profile: "android-app", label: "tracked Android Google Play targets", sources: ["googlePlayReviews"], terms: ["Google Play review", "Android app complaint", "Play Store rating"], weight: 8 },
  { profile: "community-target", label: "tracked public community targets", sources: ["reddit", "ptt", "dcard"], terms: ["community complaint", "forum discussion", "public thread", "社群 投訴", "論壇 爆料"], weight: 8 },
  { profile: "subreddit", label: "tracked Reddit communities", sources: ["reddit"], terms: ["subreddit complaint", "reddit discussion", "brand subreddit"], weight: 8 },
  { profile: "ptt-board", label: "tracked PTT boards", sources: ["ptt"], terms: ["PTT board", "PTT 爆料", "PTT 投訴"], weight: 8 },
  { profile: "dcard-forum", label: "tracked Dcard forums", sources: ["dcard"], terms: ["Dcard forum", "Dcard 爆料", "Dcard 投訴"], weight: 8 },
  { profile: "public-channel", label: "tracked public messaging channels", sources: ["telegramPublic"], terms: ["Telegram channel", "public channel complaint", "爆料 頻道"], weight: 8 },
  { profile: "social-profile", label: "tracked public social profiles", sources: ["threads", "instagram"], terms: ["public profile complaint", "brand profile", "social post"], weight: 8 },
  { profile: "threads-profile", label: "tracked Threads profiles", sources: ["threads"], terms: ["Threads profile", "Threads post", "Threads complaint"], weight: 8 },
  { profile: "instagram-profile", label: "tracked Instagram profiles", sources: ["instagram"], terms: ["Instagram profile", "Instagram post", "Instagram complaint"], weight: 8 },
  { profile: "status-page", label: "tracked public status pages", sources: ["publicStatusPageSources"], terms: ["status page", "service status", "outage", "incident"], weight: 10 },
  { profile: "operations", label: "operations and availability signals", sources: ["publicStatusPageSources"], terms: ["major outage", "degraded service", "incident update", "maintenance"], weight: 8 },
  { profile: "owned-media", label: "tracked official owned media", sources: ["officialOwnedMediaSources"], terms: ["official statement", "newsroom", "press release", "company blog"], weight: 10 },
  { profile: "official-response", label: "official response and statement channels", sources: ["officialOwnedMediaSources"], terms: ["official response", "company statement", "apology", "incident response"], weight: 8 },
  { profile: "company-filing", label: "tracked public company filings", sources: ["publicCompanyFilingsSources"], terms: ["SEC filing", "EDGAR", "8-K", "10-K", "material event"], weight: 10 },
  { profile: "brand-domain", label: "tracked brand domains for impersonation", sources: ["brandImpersonationSources"], terms: ["certificate transparency", "phishing", "impersonation", "fake domain"], weight: 10 },
  { profile: "security-advisory-target", label: "tracked security advisory targets", sources: ["securityAdvisorySources"], terms: ["CVE", "CISA advisory", "vulnerability", "exploit"], weight: 10 },
  { profile: "supply-chain-package", label: "tracked supply-chain packages", sources: ["supplyChainAdvisorySources"], terms: ["OSV", "GHSA", "package vulnerability", "dependency vulnerability"], weight: 10 },
  { profile: "investor-market", label: "tracked investor and market discussion targets", sources: ["investorDiscussionSources"], terms: ["Stocktwits", "investor", "ticker", "market sentiment"], weight: 8 },
];
const OFFICIAL_REGULATORY_FOLLOWUP_SOURCES = new Map([
  ["officialRegulatory", 36],
  ["googleNews", 32],
  ["bingNews", 30],
  ["baiduNews", 29],
  ["openWebDiscovery", 31],
  ["duckDuckGo", 30],
  ["gdelt", 28],
  ["rssFeeds", 26],
  ["reddit", 20],
  ["youtube", 20],
  ["ptt", 18],
  ["dcard", 18],
  ["threads", 16],
  ["mastodon", 14],
  ["bluesky", 14],
  ["telegramPublic", 13],
]);
const OFFICIAL_REGULATORY_TIERS = new Set(["regulatory", "official-consumer-protection", "regulatory-alert"]);
const OFFICIAL_REGULATORY_KEYWORD_STOPWORDS = new Set([
  "and", "the", "for", "with", "from", "that", "this", "into", "onto", "across", "media", "public", "should", "reported",
  "customers", "issues", "says", "safety", "official", "alerts", "alert", "recalls", "example", "https", "www", "com", "test",
]);
const OFFICIAL_REGULATORY_BUSINESS_TERMS = new Set([
  "refund", "complaint", "recall", "statement", "response", "timeline", "notice", "warning", "fraud", "scam", "privacy",
  "security", "breach", "leak", "boycott", "enforcement", "investigation", "lawsuit", "settlement", "chargeback",
  "safety-alert", "product-safety", "consumer", "financial",
]);
const SOURCE_COOLDOWN_MIN_MS = 60 * 1000;
const SOURCE_COOLDOWN_RULES = [
  { pattern: /HTTP\s+403/i, ms: 30 * 60 * 1000, reason: "HTTP 403 Forbidden" },
  { pattern: /HTTP\s+429/i, ms: 15 * 60 * 1000, reason: "HTTP 429 Too Many Requests" },
  { pattern: /HTTP\s+500/i, ms: 5 * 60 * 1000, reason: "HTTP 500" },
  { pattern: /timeout|超時|aborted/i, ms: 3 * 60 * 1000, reason: "請求超時" },
  { pattern: /ECONNRESET|socket disconnected|連線被中斷/i, ms: 3 * 60 * 1000, reason: "連線被中斷" },
];
const SOURCE_THROTTLE_POLICIES = {
  taiwanNews: { domain: "rss-news", minIntervalMs: 20 * 1000 },
  yahooTaiwan: { domain: "tw.news.yahoo.com", minIntervalMs: 45 * 1000 },
  yahooJapanNews: { domain: "search.yahoo.co.jp", minIntervalMs: 60 * 1000 },
  naverKoreaNews: { domain: "search.naver.com", minIntervalMs: 60 * 1000 },
  daumKoreaNews: { domain: "search.daum.net", minIntervalMs: 60 * 1000 },
  googleNews: { domain: "news.google.com", minIntervalMs: 45 * 1000 },
  bingNews: { domain: "www.bing.com", minIntervalMs: 45 * 1000 },
  baiduNews: { domain: "www.baidu.com", minIntervalMs: 60 * 1000 },
  duckDuckGo: { domain: "duckduckgo.com", minIntervalMs: 60 * 1000 },
  openWebDiscovery: { domain: "duckduckgo.com", minIntervalMs: 75 * 1000 },
  sogouSearch: { domain: "www.sogou.com", minIntervalMs: 60 * 1000 },
  soSearch: { domain: "www.so.com", minIntervalMs: 60 * 1000 },
  yandexSearch: { domain: "yandex.com", minIntervalMs: 75 * 1000 },
  toutiaoSearch: { domain: "www.baidu.com", minIntervalMs: 60 * 1000 },
  gdelt: { domain: "api.gdeltproject.org", minIntervalMs: 20 * 1000 },
  rssFeeds: { domain: "rss-public-feeds", minIntervalMs: 15 * 1000 },
  officialRegulatory: { domain: "official-regulatory-feeds", minIntervalMs: 15 * 1000 },
  legalPublicRecords: { domain: "legal-public-records", minIntervalMs: 45 * 1000 },
  publicProcurementSources: { domain: "public-procurement-records", minIntervalMs: 45 * 1000 },
  publicSanctionsSources: { domain: "public-sanctions-records", minIntervalMs: 45 * 1000 },
  publicProductRecallSources: { domain: "public-product-recall-records", minIntervalMs: 45 * 1000 },
  publicEnforcementActionSources: { domain: "public-enforcement-action-records", minIntervalMs: 45 * 1000 },
  publicAdvertisingRulingsSources: { domain: "public-advertising-rulings", minIntervalMs: 45 * 1000 },
  publicRegulatoryWarningLetterSources: { domain: "public-regulatory-warning-letters", minIntervalMs: 45 * 1000 },
  publicCompanyFilingsSources: { domain: "sec-edgar-public", minIntervalMs: 45 * 1000 },
  brandImpersonationSources: { domain: "crt.sh", minIntervalMs: 60 * 1000 },
  securityAdvisorySources: { domain: "security-advisory-public", minIntervalMs: 45 * 1000 },
  supplyChainAdvisorySources: { domain: "supply-chain-advisory-public", minIntervalMs: 45 * 1000 },
  investorDiscussionSources: { domain: "public-investor-discussion", minIntervalMs: 45 * 1000 },
  publicStatusPageSources: { domain: "public-status-pages", minIntervalMs: 45 * 1000 },
  officialOwnedMediaSources: { domain: "official-owned-media", minIntervalMs: 45 * 1000 },
  githubIssues: { domain: "api.github.com", minIntervalMs: 30 * 1000 },
  gitLabIssues: { domain: "gitlab.com", minIntervalMs: 30 * 1000 },
  reddit: { domain: "www.reddit.com", minIntervalMs: 45 * 1000 },
  hackerNews: { domain: "hn.algolia.com", minIntervalMs: 20 * 1000 },
  stackOverflow: { domain: "api.stackexchange.com", minIntervalMs: 30 * 1000 },
  quoraSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  substackSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  mediumSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  wordpressSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  blogspotSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  tumblrSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  xSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  facebookSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  linkedinSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  tiktokSearch: { domain: "tw.search.yahoo.com", minIntervalMs: 60 * 1000 },
  discourseForums: { domain: "discourse-public", minIntervalMs: 30 * 1000 },
  lemmy: { domain: "lemmy-public", minIntervalMs: 30 * 1000 },
  mastodon: { domain: "mastodon-public", minIntervalMs: 30 * 1000 },
  bluesky: { domain: "public.api.bsky.app", minIntervalMs: 30 * 1000 },
  ptt: { domain: "www.ptt.cc", minIntervalMs: 45 * 1000 },
  dcard: { domain: "www.dcard.tw", minIntervalMs: 45 * 1000 },
  threads: { domain: "www.threads.net", minIntervalMs: 90 * 1000 },
  instagram: { domain: "www.instagram.com", minIntervalMs: 90 * 1000 },
  youtube: { domain: "www.youtube.com", minIntervalMs: 45 * 1000 },
  douyinSearch: { domain: "www.baidu.com", minIntervalMs: 60 * 1000 },
  kuaishouSearch: { domain: "www.baidu.com", minIntervalMs: 60 * 1000 },
  appStoreReviews: { domain: "itunes.apple.com", minIntervalMs: 45 * 1000 },
  googlePlayReviews: { domain: "play.google.com", minIntervalMs: 60 * 1000 },
  publicReviewSites: { domain: "public-review-search", minIntervalMs: 60 * 1000 },
  verticalReviewSources: { domain: "vertical-review-search", minIntervalMs: 60 * 1000 },
  employerReviewSources: { domain: "employer-review-search", minIntervalMs: 60 * 1000 },
  ecommerceReviewSources: { domain: "ecommerce-review-search", minIntervalMs: 60 * 1000 },
  localReviewSources: { domain: "local-review-search", minIntervalMs: 60 * 1000 },
  regionalComplaintSources: { domain: "regional-complaint-search", minIntervalMs: 60 * 1000 },
};
const THROTTLE_FAILURE_MULTIPLIER = 1.8;
const THROTTLE_MAX_BACKOFF_MS = 60 * 60 * 1000;

let activeRunner = null;
let schedulerTimer = null;
let watchSchedulerTimer = null;
let inFlight = null;
let lastScanResult = null;
const sourceHealth = new Map();
const domainThrottle = new Map();
let monitorState = {
  enabled: false,
  running: false,
  intervalMs: DEFAULT_SCAN_INTERVAL_MS,
  lastRun: null,
  nextRunAt: null,
  mode: SCAN_MODE_FAST,
  sources: null,
  watchEnabled: false,
  watchIntervalMs: 0,
  watchSources: null,
  nextWatchRunAt: null,
  lastError: null,
};

function schedulerSearchSettingsWithSources(sources = null) {
  const base = typeof activeRunner?.searchSettings === "function"
    ? activeRunner.searchSettings()
    : activeRunner?.searchSettings || null;
  if (!Array.isArray(sources) || !sources.length) return base;
  return {
    ...(base || {}),
    sources: [...new Set(sources.map(source => String(source || "").trim()).filter(Boolean))],
  };
}

function mergeDomainControls(...values) {
  const merged = { allowDomains: [], denyDomains: [] };
  for (const value of values) {
    const normalized = normalizeSentimentDomainControls(value || {});
    merged.allowDomains.push(...normalized.allowDomains);
    merged.denyDomains.push(...normalized.denyDomains);
  }
  return {
    allowDomains: [...new Set(merged.allowDomains)],
    denyDomains: [...new Set(merged.denyDomains)],
  };
}

function fallbackLog() {
  return {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

function safeBus(bus) {
  return bus && typeof bus.emit === "function" ? bus : { emit: () => {} };
}

function normalizeSourceResult(value) {
  if (typeof value === "number") return { count: value, failures: [] };
  if (!value || typeof value !== "object") return { count: 0, failures: [] };
  const count = Number(value.inserted ?? value.count ?? value.total ?? 0);
  return {
    count: Number.isFinite(count) ? count : 0,
    failures: Array.isArray(value.failures) ? value.failures : [],
    cursor: value.cursor && typeof value.cursor === "object" ? value.cursor : null,
    diagnostics: value.diagnostics && typeof value.diagnostics === "object" ? value.diagnostics : null,
  };
}

function formatSourceFailure(item) {
  const parts = [];
  if (item?.keyword) parts.push(`keyword=${item.keyword}`);
  if (item?.target) parts.push(`target=${item.target}`);
  const message = String(item?.message || item || "unknown error");
  return parts.length ? `${parts.join(" ")}: ${message}` : message;
}

function isExecutableCollectionJob(job = {}) {
  const reason = String(job.reason || "");
  return reason.includes("retry")
    || reason.startsWith("recoverable-")
    || job.metadata?.recoverable_followup === true
    || job.metadata?.evidence_coverage_followup === true
    || job.metadata?.task_type === "evidence-coverage-gap"
    || reason === "evidence-coverage-gap";
}

function collectionJobExecutionKeywords(job = {}) {
  const query = Array.isArray(job.query) ? job.query : [];
  if (!["rss-priority-site-gap", "rss-native-entry-discovery"].includes(job.metadata?.task_type)) return normalizeSentimentMonitorKeywords(query);
  const cleaned = query.map(item => String(item || "")
    .replace(/\bsite:[^\s]+\s*/gi, " ")
    .replace(/\b(?:rss|feed|sitemap|atom|json)\b/gi, " ")
    .replace(/\{keyword\}/g, " ")
    .replace(/\s+/g, " ")
    .trim());
  return normalizeSentimentMonitorKeywords(cleaned.length ? cleaned : [job.entity?.site_name || job.entity?.site || ""]);
}

function collectionJobExecutionMetadata(job = {}, query = []) {
  return {
    retry_job_id: job.id,
    retry_consumer: true,
    retryQuery: query,
    taskType: job.metadata?.task_type || "",
    followupQuery: job.metadata?.followup_query || "",
    followupSearchTerms: job.metadata?.followup_search_terms || job.entity?.followup_search_terms || [],
    evidenceCoverageFollowup: job.metadata?.evidence_coverage_followup === true,
    evidenceCoverageAction: job.metadata?.action || job.entity?.action || "",
    lowDepthSourceKeys: job.metadata?.low_depth_source_keys || [],
    lowDepthDomains: job.metadata?.low_depth_domains || job.entity?.low_depth_domains || [],
    lowDepthUrls: job.metadata?.low_depth_urls || job.entity?.low_depth_urls || [],
    lowDepthCommentUrls: job.metadata?.low_depth_comment_urls || job.entity?.low_depth_comment_urls || [],
    lowDepthFeedNames: job.metadata?.low_depth_feed_names || job.entity?.low_depth_feed_names || [],
    targetType: job.metadata?.target_type || job.entity?.target_type || "",
    target: job.metadata?.target || job.entity?.target || "",
    rssSourceFamilyRefresh: job.metadata?.task_type === "rss-source-family-refresh" || job.metadata?.commercial_family_refresh === true,
    rssSourceFamily: job.metadata?.source_family || job.entity?.source_family || "",
    rssSourceFamilyLabel: job.metadata?.source_family_label || job.entity?.source_family_label || "",
    rssRefreshPackKeys: job.metadata?.pack_keys || job.entity?.pack_keys || [],
  };
}

function evidenceCoverageFollowupDiagnostics(job = {}, query = [], result = {}, sourceFailures = []) {
  if (job.metadata?.task_type !== "evidence-coverage-gap" && job.metadata?.evidence_coverage_followup !== true) return null;
  const metadata = job.metadata || {};
  const entity = job.entity || {};
  const followupSearchTerms = Array.isArray(metadata.followup_search_terms)
    ? metadata.followup_search_terms
    : Array.isArray(entity.followup_search_terms)
      ? entity.followup_search_terms
      : [];
  return {
    evidence_coverage_followup: {
      target_type: metadata.target_type || entity.target_type || "",
      target: metadata.target || entity.target || "",
      action: metadata.action || entity.action || "",
      coverage_level: metadata.coverage_level || entity.coverage_level || "",
      evidence_query: metadata.evidence_query || entity.query || "",
      followup_query: metadata.followup_query || "",
      followup_search_terms: followupSearchTerms,
      low_depth_source_keys: Array.isArray(metadata.low_depth_source_keys) ? metadata.low_depth_source_keys : [],
      low_depth_domains: Array.isArray(metadata.low_depth_domains) ? metadata.low_depth_domains : Array.isArray(entity.low_depth_domains) ? entity.low_depth_domains : [],
      low_depth_urls: Array.isArray(metadata.low_depth_urls) ? metadata.low_depth_urls : Array.isArray(entity.low_depth_urls) ? entity.low_depth_urls : [],
      low_depth_comment_urls: Array.isArray(metadata.low_depth_comment_urls) ? metadata.low_depth_comment_urls : Array.isArray(entity.low_depth_comment_urls) ? entity.low_depth_comment_urls : [],
      low_depth_feed_names: Array.isArray(metadata.low_depth_feed_names) ? metadata.low_depth_feed_names : Array.isArray(entity.low_depth_feed_names) ? entity.low_depth_feed_names : [],
      missing_doc_types: Array.isArray(metadata.missing_doc_types) ? metadata.missing_doc_types : [],
      missing_source_families: Array.isArray(metadata.missing_source_families) ? metadata.missing_source_families : [],
      min_evidence_depth_score: Number(metadata.min_evidence_depth_score || 0) || 0,
      average_evidence_depth_score: Number(metadata.average_evidence_depth_score || 0) || 0,
      thin_evidence_depth_count: Math.max(0, Number(metadata.thin_evidence_depth_count || 0) || 0),
      evidence_count: Math.max(0, Number(metadata.evidence_count || 0) || 0),
      source_rank: Math.max(0, Number(metadata.source_rank || 0) || 0),
      requested_query_count: Array.isArray(query) ? query.length : 0,
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
      failure_count: Array.isArray(sourceFailures) ? sourceFailures.length : 0,
      failed_targets: Array.isArray(sourceFailures) ? sourceFailures.slice(0, 8) : [],
    },
  };
}

function freeSourceTargetCoverageExecutionDiagnostics(sourceKey = "", signal = null, sourceKeywords = [], result = {}, sourceFailures = []) {
  if (!signal) return null;
  return {
    free_source_target_coverage: {
      source_key: sourceKey,
      recommendation: signal.recommendation || "",
      coverage_score: Number(signal.coverageScore || 0) || 0,
      target_count: Math.max(0, Number(signal.targetCount || 0) || 0),
      missing_profile_count: Math.max(0, Number(signal.missingProfileCount || 0) || 0),
      missing_profiles: Array.isArray(signal.missingProfiles) ? signal.missingProfiles : [],
      suggested_terms: Array.isArray(signal.suggestedTerms) ? signal.suggestedTerms : [],
      requested_query_count: Array.isArray(sourceKeywords) ? sourceKeywords.length : 0,
      requested_queries: Array.isArray(sourceKeywords) ? sourceKeywords.slice(0, 12) : [],
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
      failure_count: Array.isArray(sourceFailures) ? sourceFailures.length : 0,
      failed_targets: Array.isArray(sourceFailures) ? sourceFailures.slice(0, 8) : [],
    },
  };
}

function freeSourceTargetCoverageFollowupDiagnostics(job = {}, query = [], result = {}, sourceFailures = []) {
  if (job.metadata?.task_type !== "free-source-target-coverage") return null;
  const coverage = job.metadata?.free_source_target_coverage || {};
  return {
    free_source_target_coverage: {
      source_key: job.source_key || coverage.source_key || "",
      recommendation: coverage.recommendation || "expand-target-profile-coverage",
      coverage_score: Number(coverage.coverage_score || 0) || 0,
      target_count: Math.max(0, Number(coverage.target_count || 0) || 0),
      missing_profile_count: Math.max(0, Number(coverage.missing_profile_count || 0) || 0),
      missing_profiles: Array.isArray(coverage.missing_profiles) ? coverage.missing_profiles : [],
      suggested_terms: Array.isArray(coverage.suggested_terms) ? coverage.suggested_terms : [],
      requested_query_count: Array.isArray(query) ? query.length : 0,
      requested_queries: Array.isArray(query) ? query.slice(0, 12) : [],
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
      failure_count: Array.isArray(sourceFailures) ? sourceFailures.length : 0,
      failed_targets: Array.isArray(sourceFailures) ? sourceFailures.slice(0, 8) : [],
    },
  };
}

function keywordSourceFamilyCoverageExecutionDiagnostics(sourceKey = "", signal = null, sourceKeywords = [], result = {}, sourceFailures = []) {
  if (!signal) return null;
  return {
    keyword_source_family_coverage: {
      source_key: sourceKey,
      score: Number(signal.score || 0) || 0,
      priority_boost: Number(signal.priorityBoost || 0) || 0,
      gap_count: Math.max(0, Number(signal.gapCount || 0) || 0),
      keywords: Array.isArray(signal.keywords) ? signal.keywords : [],
      families: Array.isArray(signal.families) ? signal.families : [],
      statuses: Array.isArray(signal.statuses) ? signal.statuses : [],
      suggested_keywords: Array.isArray(signal.suggestedKeywords) ? signal.suggestedKeywords : [],
      requested_query_count: Array.isArray(sourceKeywords) ? sourceKeywords.length : 0,
      requested_queries: Array.isArray(sourceKeywords) ? sourceKeywords.slice(0, 12) : [],
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
      failure_count: Array.isArray(sourceFailures) ? sourceFailures.length : 0,
      failed_targets: Array.isArray(sourceFailures) ? sourceFailures.slice(0, 8) : [],
    },
  };
}

function keywordSourceFamilyCoverageDiscoverySignal(report = {}) {
  const gaps = Array.isArray(report.gaps) ? report.gaps : [];
  if (!gaps.length) return null;
  return {
    sourceKey: "openWebDiscovery",
    score: Math.min(26, Math.max(1, gaps.length * 3)),
    priorityBoost: Math.min(26, Math.max(1, gaps.length * 3)),
    gapCount: gaps.length,
    keywords: uniqueExpansionTerms(gaps.map(gap => gap.keyword).filter(Boolean), 20),
    families: uniqueExpansionTerms(gaps.map(gap => gap.source_family).filter(Boolean), 20),
    statuses: uniqueExpansionTerms(gaps.map(gap => gap.status).filter(Boolean), 12),
    suggestedKeywords: normalizeSentimentMonitorKeywords(gaps.flatMap(gap => gap.suggested_keywords || [])).slice(0, 24),
  };
}

function multilingualQueryQualityExecutionDiagnostics(sourceKey = "", signal = null, sourceKeywords = [], result = {}, sourceFailures = []) {
  if (!signal) return null;
  return {
    multilingual_query_quality: {
      source_key: sourceKey,
      score: Number(signal.score || 0) || 0,
      priority_boost: Number(signal.priorityBoost || 0) || 0,
      query_count: Math.max(0, Number(signal.queryCount || 0) || 0),
      evidence_count: Math.max(0, Number(signal.evidenceCount || 0) || 0),
      high_risk_count: Math.max(0, Number(signal.highRiskCount || 0) || 0),
      locales: Array.isArray(signal.locales) ? signal.locales : [],
      recommendations: Array.isArray(signal.recommendations) ? signal.recommendations : [],
      suggested_keywords: Array.isArray(signal.suggestedKeywords) ? signal.suggestedKeywords : [],
      suppressed_keywords: Array.isArray(signal.suppressedKeywords) ? signal.suppressedKeywords : [],
      max_zero_result_rate: Number(signal.maxZeroResultRate || 0) || 0,
      max_failure_rate: Number(signal.maxFailureRate || 0) || 0,
      requested_query_count: Array.isArray(sourceKeywords) ? sourceKeywords.length : 0,
      requested_queries: Array.isArray(sourceKeywords) ? sourceKeywords.slice(0, 12) : [],
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
      failure_count: Array.isArray(sourceFailures) ? sourceFailures.length : 0,
      failed_targets: Array.isArray(sourceFailures) ? sourceFailures.slice(0, 8) : [],
    },
  };
}

function eventClusterFollowupExecutionDiagnostics(sourceKey = "", signal = null, sourceKeywords = [], result = {}, sourceFailures = []) {
  if (!signal) return null;
  return {
    event_cluster_followup: {
      source_key: sourceKey,
      score: Number(signal.score || 0) || 0,
      priority_boost: Number(signal.priorityBoost || 0) || 0,
      cluster_count: Math.max(0, Number(signal.clusterCount || 0) || 0),
      max_propagation_path_score: Number(signal.maxPropagationPathScore || 0) || 0,
      max_independent_confirmation_score: Number(signal.maxIndependentConfirmationScore || 0) || 0,
      min_independent_confirmation_score: Number(signal.minIndependentConfirmationScore || 0) || 0,
      confirmed_cluster_count: Math.max(0, Number(signal.confirmedClusterCount || 0) || 0),
      gaps: Array.isArray(signal.gaps) ? signal.gaps : [],
      cluster_labels: Array.isArray(signal.clusterLabels) ? signal.clusterLabels : [],
      suggested_keywords: Array.isArray(signal.suggestedKeywords) ? signal.suggestedKeywords : [],
      independent_confirmation_labels: Array.isArray(signal.independentConfirmationLabels) ? signal.independentConfirmationLabels : [],
      independent_source_families: Array.isArray(signal.independentSourceFamilies) ? signal.independentSourceFamilies : [],
      two_hop_collection: Boolean(signal.twoHopCollection),
      two_hop_reasons: Array.isArray(signal.twoHopReasons) ? signal.twoHopReasons : [],
      explicit_reference_chain: Boolean(signal.explicitReferenceChain),
      explicit_reference_edge_count: Math.max(0, Number(signal.explicitReferenceEdgeCount || 0) || 0),
      explicit_reference_reasons: Array.isArray(signal.explicitReferenceReasons) ? signal.explicitReferenceReasons : [],
      followup_targets: Array.isArray(signal.followupTargets) ? signal.followupTargets.slice(0, 20) : [],
      origin_urls: Array.isArray(signal.originUrls) ? signal.originUrls : [],
      amplifier_platforms: Array.isArray(signal.amplifierPlatforms) ? signal.amplifierPlatforms : [],
      independent_confirmation_needed: Boolean(signal.independentConfirmationNeeded),
      requested_query_count: Array.isArray(sourceKeywords) ? sourceKeywords.length : 0,
      requested_queries: Array.isArray(sourceKeywords) ? sourceKeywords.slice(0, 12) : [],
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
      failure_count: Array.isArray(sourceFailures) ? sourceFailures.length : 0,
      failed_targets: Array.isArray(sourceFailures) ? sourceFailures.slice(0, 8) : [],
    },
  };
}

function rssPrioritySiteGapContext(job = {}) {
  const entity = job.entity && typeof job.entity === "object" ? job.entity : {};
  const metadata = job.metadata && typeof job.metadata === "object" ? job.metadata : {};
  const gap = metadata.gap && typeof metadata.gap === "object" ? metadata.gap : {};
  return {
    ...entity,
    gap_type: entity.gap_type || metadata.gap_type || gap.gap_type || "empty-priority-site",
    recovery_index_engines: entity.recovery_index_engines || metadata.recovery_index_engines || ["google-news", "bing-news"],
    runtime_feeds: Array.isArray(entity.runtime_feeds)
      ? entity.runtime_feeds
      : Array.isArray(metadata.runtime_feeds)
        ? metadata.runtime_feeds
        : Array.isArray(gap.runtime_feeds)
          ? gap.runtime_feeds
          : [],
  };
}

function rssPrioritySiteGapFeeds(entity = {}) {
  const site = String(entity.site || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  if (!site) return [];
  const siteName = String(entity.site_name || site).trim();
  const encodedSite = encodeURIComponent(site);
  const runtimeRecovery = String(entity.gap_type || "") === "runtime-unhealthy-feed";
  const recoveryTags = runtimeRecovery
    ? ["rss-priority-site-gap", "rss-runtime-feed-recovery"]
    : ["rss-priority-site-gap"];
  const base = {
    aliases: [siteName],
    requireTaiwan: false,
    sourceFamily: entity.family || "priority_media_recovery",
    sourceKey: "rssFeeds",
    pack: entity.pack_key || "",
    homeUrl: `https://${site.split("/")[0]}/`,
  };
  return [
    {
      ...base,
      name: `${siteName} Google News 补采`,
      url: `https://news.google.com/rss/search?q=site%3A${encodedSite}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`,
      keywordSearchUrlTemplate: `https://news.google.com/rss/search?q=site%3A${encodedSite}+{query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`,
      tags: ["zh", "news", ...recoveryTags, "google-news-index"],
    },
    {
      ...base,
      name: `${siteName} Bing News 补采`,
      url: `https://www.bing.com/news/search?q=site%3A${encodedSite}&format=rss&mkt=zh-TW&setlang=zh-TW`,
      keywordSearchUrlTemplate: `https://www.bing.com/news/search?q=site%3A${encodedSite}+{query}&format=rss&mkt=zh-TW&setlang=zh-TW`,
      tags: ["zh", "news", ...recoveryTags, "bing-news-index"],
    },
  ];
}

function rssPrioritySiteGapDiagnostics(entity = {}, feeds = [], result = {}) {
  const engineForFeed = (feed = {}) => {
    const tags = Array.isArray(feed.tags) ? feed.tags : [];
    if (tags.includes("google-news-index")) return "google-news";
    if (tags.includes("bing-news-index")) return "bing-news";
    return "";
  };
  const engineByFeedName = new Map(feeds.map(feed => [String(feed.name || ""), engineForFeed(feed)]));
  const failedEngines = new Set();
  for (const failure of Array.isArray(result.failures) ? result.failures : []) {
    const target = String(failure?.target || failure || "");
    for (const [feedName, engine] of engineByFeedName.entries()) {
      if (engine && feedName && target.includes(feedName)) failedEngines.add(engine);
    }
  }
  const engines = [...new Set(feeds.map(engineForFeed).filter(Boolean))];
  const runtimeFeeds = Array.isArray(entity.runtime_feeds) ? entity.runtime_feeds : [];
  const runtimeRecovery = String(entity.gap_type || "") === "runtime-unhealthy-feed";
  return {
    rss_priority_site_recovery: {
      pack_key: entity.pack_key || "",
      site_name: entity.site_name || entity.site || "",
      site: entity.site || "",
      gap_type: entity.gap_type || "empty-priority-site",
      runtime_recovery: runtimeRecovery,
      fallback_strategy: runtimeRecovery ? "site-index-dual-engine" : "",
      runtime_unhealthy_feed_count: runtimeFeeds.length,
      runtime_feeds: runtimeFeeds.slice(0, 8).map(feed => ({
        name: feed?.name || "",
        url: feed?.url || "",
        type: feed?.type || "",
        last_status: feed?.last_status ?? null,
        last_error: feed?.last_error || "",
        last_checked_at: feed?.last_checked_at || "",
      })),
      requested_index_engines: engines,
      requested_index_feed_count: feeds.length,
      failed_index_engines: [...failedEngines],
      failed_index_feed_count: failedEngines.size,
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
    },
  };
}

function rssNativeEntryDiscoveryFeeds(entity = {}) {
  const site = String(entity.site || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  if (!site) return [];
  const hostname = site.split("/")[0];
  const siteName = String(entity.site_name || site).trim();
  const homeUrl = `https://${hostname}/`;
  const base = {
    aliases: [siteName],
    requireTaiwan: false,
    sourceFamily: entity.family || "priority_media_native_discovery",
    sourceKey: "rssFeeds",
    pack: entity.pack_key || "",
    homeUrl,
  };
  const directCandidates = [
    ["RSS", `${homeUrl}rss`],
    ["Feed", `${homeUrl}feed`],
    ["RSS XML", `${homeUrl}rss.xml`],
    ["Feed XML", `${homeUrl}feed.xml`],
    ["Atom", `${homeUrl}atom.xml`],
    ["Sitemap", `${homeUrl}sitemap.xml`],
  ];
  const encodedSite = encodeURIComponent(site);
  return [
    ...directCandidates.map(([label, url]) => ({
      ...base,
      name: `${siteName} ${label} 原生入口候选`,
      url,
      tags: ["zh", "news", "rss-native-entry-discovery", label.toLowerCase().includes("sitemap") ? "sitemap" : "native-feed"],
    })),
    {
      ...base,
      name: `${siteName} Google News 原生入口发现`,
      url: `https://news.google.com/rss/search?q=site%3A${encodedSite}+rss+OR+feed+OR+sitemap&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`,
      keywordSearchUrlTemplate: `https://news.google.com/rss/search?q=site%3A${encodedSite}+rss+OR+feed+OR+sitemap+{query}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`,
      tags: ["zh", "news", "rss-native-entry-discovery", "google-news-index"],
    },
    {
      ...base,
      name: `${siteName} Bing News 原生入口发现`,
      url: `https://www.bing.com/news/search?q=site%3A${encodedSite}+rss+OR+feed+OR+sitemap&format=rss&mkt=zh-TW&setlang=zh-TW`,
      keywordSearchUrlTemplate: `https://www.bing.com/news/search?q=site%3A${encodedSite}+rss+OR+feed+OR+sitemap+{query}&format=rss&mkt=zh-TW&setlang=zh-TW`,
      tags: ["zh", "news", "rss-native-entry-discovery", "bing-news-index"],
    },
  ];
}

function rssNativeEntryDiscoveryDiagnostics(entity = {}, feeds = [], result = {}) {
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const failedTargets = failures.map(failure => String(failure?.target || failure || "")).filter(Boolean);
  return {
    rss_native_entry_discovery: {
      pack_key: entity.pack_key || "",
      site_name: entity.site_name || entity.site || "",
      site: entity.site || "",
      discovery_target: entity.discovery_target || "native-rss-json-sitemap",
      requested_candidate_count: feeds.length,
      failed_candidate_count: failedTargets.length,
      failed_targets: failedTargets.slice(0, 12),
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
    },
  };
}

function rssSourceFamilyRefreshDiagnostics(entity = {}, metadata = {}, packKeys = [], result = {}) {
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const failedTargets = failures.map(failure => String(failure?.target || failure || "")).filter(Boolean);
  return {
    rss_source_family_refresh: {
      mode: entity.mode || metadata.mode || "",
      source_family: entity.source_family || metadata.source_family || "",
      source_family_label: entity.source_family_label || metadata.source_family_label || "",
      refresh_target: entity.refresh_target || metadata.refresh_target || "configured-source-family-without-recent-evidence",
      pack_keys: packKeys,
      configured_score: Number(entity.configured_score ?? metadata.configured_score ?? 0),
      observed_score: Number(entity.observed_score ?? metadata.observed_score ?? 0),
      requested_pack_count: packKeys.length,
      inserted_count: Number(result.inserted ?? result.count ?? 0) || 0,
      failure_count: failedTargets.length,
      failed_targets: failedTargets.slice(0, 12),
    },
  };
}

async function runSingleCollectionSource(sourceKey, keywords = [], {
  search = {},
  source = null,
  mode = SCAN_MODE_FAST,
  proxyUrl = "",
  budget = {},
  deepBudget = {},
  job = null,
} = {}) {
  const sourceConfig = source?.config || {};
  const enrich = mode === SCAN_MODE_FULL;
  const domainControls = mergeDomainControls(search?.domainControls, sourceConfig.domainControls || sourceConfig.domain_controls);
  const contentControls = search?.contentControls || {};
  const normalizedKeywords = normalizeSentimentMonitorKeywords(keywords);
  if (!normalizedKeywords.length) return { count: 0, failures: [] };
  const common = { proxyUrl, budget, deepBudget, domainControls, contentControls };
  switch (sourceKey) {
    case "taiwanNews":
      return normalizeSourceResult(await scrapeTaiwanNewsFeeds(normalizedKeywords, { ...common, enrich }));
    case "yahooTaiwan":
      return normalizeSourceResult(await scrapeYahooTaiwan(normalizedKeywords, { ...common, enrich }));
    case "yahooJapanNews":
      return normalizeSourceResult(await scrapeYahooJapanNews(normalizedKeywords, { ...common, enrich }));
    case "naverKoreaNews":
      return normalizeSourceResult(await scrapeNaverKoreaNews(normalizedKeywords, { ...common, enrich }));
    case "daumKoreaNews":
      return normalizeSourceResult(await scrapeDaumKoreaNews(normalizedKeywords, { ...common, enrich }));
    case "baiduSearch":
      return normalizeSourceResult(await scrapeBaiduSearch(normalizedKeywords, { ...common, enrich }));
    case "baiduNews":
      return normalizeSourceResult(await scrapeBaiduNews(normalizedKeywords, { ...common, enrich }));
    case "sogouSearch":
      return normalizeSourceResult(await scrapeSogouSearch(normalizedKeywords, { ...common, enrich }));
    case "soSearch":
      return normalizeSourceResult(await scrapeSoSearch(normalizedKeywords, { ...common, enrich }));
    case "yandexSearch":
      return normalizeSourceResult(await scrapeYandexSearch(normalizedKeywords, { ...common, enrich }));
    case "wechatPublicSearch":
      return normalizeSourceResult(await scrapeWechatPublicSearch(normalizedKeywords, { ...common, enrich }));
    case "toutiaoSearch":
      return normalizeSourceResult(await scrapeToutiaoSearch(normalizedKeywords, { ...common, enrich }));
    case "googleNews":
      return normalizeSourceResult(await scrapeGoogleNews(normalizedKeywords, { ...common, enrich, newsEngines: sourceConfig.newsEngines || sourceConfig.news_engines || undefined, newsMarkets: sourceConfig.newsMarkets || sourceConfig.news_markets || undefined }));
    case "bingNews":
      return normalizeSourceResult(await scrapeBingNews(normalizedKeywords, { ...common, enrich, newsEngines: sourceConfig.newsEngines || sourceConfig.news_engines || undefined, newsMarkets: sourceConfig.newsMarkets || sourceConfig.news_markets || undefined }));
    case "duckDuckGo":
      return normalizeSourceResult(await scrapeDuckDuckGo(normalizedKeywords, { ...common, enrich, searchEngines: sourceConfig.searchEngines || sourceConfig.search_engines || undefined, publicSearchProfiles: sourceConfig.publicSearchProfiles || sourceConfig.public_search_profiles || sourceConfig.searchProfiles || sourceConfig.search_profiles || undefined }));
    case "openWebDiscovery":
      return normalizeSourceResult(await scrapeOpenWebDiscovery(normalizedKeywords, {
        ...common,
        enrich,
        targets: openWebDiscoveryTargetsForSource(sourceConfig),
      }));
    case "gdelt":
      return normalizeSourceResult(await scrapeGdelt(normalizedKeywords, { ...common, enrich, gdeltProfiles: sourceConfig.gdeltProfiles || sourceConfig.gdelt_profiles || sourceConfig.profiles || undefined }));
    case "rssFeeds":
      if (job?.metadata?.task_type === "rss-priority-site-gap") {
        const gapContext = rssPrioritySiteGapContext(job);
        const gapFeeds = rssPrioritySiteGapFeeds(gapContext);
        const result = await scrapeRssFeeds(normalizedKeywords, {
          ...common,
          enrich,
          feeds: gapFeeds,
          feedPacks: [],
        });
        return normalizeSourceResult({
          ...result,
          diagnostics: {
            ...(result?.diagnostics || {}),
            ...rssPrioritySiteGapDiagnostics(gapContext, gapFeeds, result),
          },
        });
      }
      if (job?.metadata?.task_type === "rss-native-entry-discovery") {
        const discoveryFeeds = rssNativeEntryDiscoveryFeeds(job.entity || {});
        const result = await scrapeRssFeeds(normalizedKeywords, {
          ...common,
          enrich,
          feeds: discoveryFeeds,
          feedPacks: [],
        });
        return normalizeSourceResult({
          ...result,
          diagnostics: {
            ...(result?.diagnostics || {}),
            ...rssNativeEntryDiscoveryDiagnostics(job.entity || {}, discoveryFeeds, result),
          },
        });
      }
      if (job?.metadata?.task_type === "rss-source-family-refresh") {
        const packKeys = normalizeRssFeedPackList(job.entity?.pack_keys || job.metadata?.pack_keys || []);
        const result = await scrapeRssFeeds(normalizedKeywords, {
          ...common,
          enrich,
          feeds: [],
          feedPacks: packKeys,
        });
        return normalizeSourceResult({
          ...result,
          diagnostics: {
            ...(result?.diagnostics || {}),
            ...rssSourceFamilyRefreshDiagnostics(job.entity || {}, job.metadata || {}, packKeys, result),
          },
        });
      }
      return normalizeSourceResult(await scrapeRssFeeds(normalizedKeywords, {
        ...common,
        enrich,
        feeds: sourceConfig.feeds || [],
        feedPacks: rssFeedPacksForScanMode(search, mode, sourceConfig),
      }));
    case "officialRegulatory":
      return normalizeSourceResult(await scrapeOfficialRegulatorySources(normalizedKeywords, {
        ...common,
        enrich,
        feeds: sourceConfig.feeds || [],
        feedPacks: sourceConfig.feedPacks || sourceConfig.feed_packs || [],
      }));
    case "legalPublicRecords":
      return normalizeSourceResult(await scrapeLegalPublicRecords(normalizedKeywords, { ...common, enrich }));
    case "publicProcurementSources":
      return normalizeSourceResult(await scrapePublicProcurementSources(normalizedKeywords, common));
    case "publicSanctionsSources":
      return normalizeSourceResult(await scrapePublicSanctionsSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.sanctionsTargets || sourceConfig.sanctions_targets || undefined,
      }));
    case "publicProductRecallSources":
      return normalizeSourceResult(await scrapePublicProductRecallSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.recallTargets || sourceConfig.recall_targets || undefined,
      }));
    case "publicEnforcementActionSources":
      return normalizeSourceResult(await scrapePublicEnforcementActionSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.enforcementTargets || sourceConfig.enforcement_targets || undefined,
      }));
    case "publicAdvertisingRulingsSources":
      return normalizeSourceResult(await scrapePublicAdvertisingRulingsSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.advertisingTargets || sourceConfig.advertising_targets || undefined,
      }));
    case "publicRegulatoryWarningLetterSources":
      return normalizeSourceResult(await scrapePublicRegulatoryWarningLetterSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.warningLetterTargets || sourceConfig.warning_letter_targets || undefined,
      }));
    case "publicCompanyFilingsSources":
      return normalizeSourceResult(await scrapePublicCompanyFilingsSources(normalizedKeywords, common));
    case "brandImpersonationSources":
      return normalizeSourceResult(await scrapeBrandImpersonationSources(normalizedKeywords, common));
    case "securityAdvisorySources":
      return normalizeSourceResult(await scrapeSecurityAdvisorySources(normalizedKeywords, common));
    case "supplyChainAdvisorySources":
      return normalizeSourceResult(await scrapeSupplyChainAdvisorySources(normalizedKeywords, common));
    case "investorDiscussionSources":
      return normalizeSourceResult(await scrapeInvestorDiscussionSources(normalizedKeywords, common));
    case "publicStatusPageSources":
      return normalizeSourceResult(await scrapePublicStatusPageSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.statusPageTargets || sourceConfig.status_page_targets || [],
      }));
    case "officialOwnedMediaSources":
      return normalizeSourceResult(await scrapeOfficialOwnedMediaSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.ownedMediaTargets || sourceConfig.owned_media_targets || sourceConfig.officialTargets || sourceConfig.official_targets || [],
      }));
    case "githubIssues":
      return normalizeSourceResult(await scrapeGitHubIssues(normalizedKeywords, {
        ...common,
        repositories: sourceConfig.repositories || sourceConfig.repos || sourceConfig.repository || [],
      }));
    case "gitLabIssues":
      return normalizeSourceResult(await scrapeGitLabIssues(normalizedKeywords, {
        ...common,
        projects: sourceConfig.projects || sourceConfig.projectIds || sourceConfig.project_ids || [],
      }));
    case "reddit":
      return normalizeSourceResult(await scrapeReddit(normalizedKeywords, {
        ...common,
        subreddits: sourceConfig.subreddits || sourceConfig.subreddit || sourceConfig.communities || [],
      }));
    case "hackerNews":
      return normalizeSourceResult(await scrapeHackerNews(normalizedKeywords, {
        ...common,
        authors: sourceConfig.authors || sourceConfig.author || sourceConfig.usernames || sourceConfig.users || [],
      }));
    case "stackOverflow":
      return normalizeSourceResult(await scrapeStackOverflow(normalizedKeywords, {
        ...common,
        tags: sourceConfig.tags || sourceConfig.tag || sourceConfig.stackTags || sourceConfig.stack_tags || [],
      }));
    case "zhihuSearch":
      return normalizeSourceResult(await scrapeZhihuSearch(normalizedKeywords, { ...common, enrich }));
    case "quoraSearch":
      return normalizeSourceResult(await scrapeQuoraSearch(normalizedKeywords, { ...common, enrich }));
    case "substackSearch":
      return normalizeSourceResult(await scrapeSubstackSearch(normalizedKeywords, { ...common, enrich }));
    case "mediumSearch":
      return normalizeSourceResult(await scrapeMediumSearch(normalizedKeywords, { ...common, enrich }));
    case "wordpressSearch":
      return normalizeSourceResult(await scrapeWordPressSearch(normalizedKeywords, { ...common, enrich }));
    case "blogspotSearch":
      return normalizeSourceResult(await scrapeBlogspotSearch(normalizedKeywords, { ...common, enrich }));
    case "tumblrSearch":
      return normalizeSourceResult(await scrapeTumblrSearch(normalizedKeywords, { ...common, enrich }));
    case "xSearch":
      return normalizeSourceResult(await scrapeXSearch(normalizedKeywords, { ...common, enrich }));
    case "facebookSearch":
      return normalizeSourceResult(await scrapeFacebookSearch(normalizedKeywords, { ...common, enrich }));
    case "linkedinSearch":
      return normalizeSourceResult(await scrapeLinkedInSearch(normalizedKeywords, { ...common, enrich }));
    case "tiktokSearch":
      return normalizeSourceResult(await scrapeTikTokSearch(normalizedKeywords, { ...common, enrich }));
    case "discourseForums":
      return normalizeSourceResult(await scrapeDiscourseForums(normalizedKeywords, {
        ...common,
        sites: sourceConfig.sites || [],
        targetProfiles: sourceConfig.targetProfiles || sourceConfig.target_profiles || sourceConfig.profiles || [],
      }));
    case "lemmy":
      return normalizeSourceResult(await scrapeLemmySearch(normalizedKeywords, {
        ...common,
        instances: sourceConfig.instances || sourceConfig.instance || [],
      }));
    case "mastodon":
      return normalizeSourceResult(await scrapeMastodonTags(normalizedKeywords, {
        ...common,
        instances: sourceConfig.instances || [],
      }));
    case "bluesky":
      return normalizeSourceResult(await scrapeBlueskySearch(normalizedKeywords, common));
    case "telegramPublic":
      return normalizeSourceResult(await scrapeTelegramPublicChannels(normalizedKeywords, {
        ...common,
        channels: sourceConfig.channels || sourceConfig.channel || sourceConfig.publicChannels || sourceConfig.public_channels || [],
      }));
    case "ptt":
      return normalizeSourceResult(await scrapePTT(normalizedKeywords, {
        proxyUrl,
        budget,
        boards: sourceConfig.boards || sourceConfig.board || [],
      }));
    case "dcard":
      return normalizeSourceResult(await scrapeDcard(normalizedKeywords, {
        proxyUrl,
        budget,
        forums: sourceConfig.forums || sourceConfig.forum || sourceConfig.forumAliases || sourceConfig.forum_aliases || [],
      }));
    case "tiebaSearch":
      return normalizeSourceResult(await scrapeTiebaSearch(normalizedKeywords, { ...common, enrich }));
    case "threads":
      return normalizeSourceResult(await scrapeThreads(normalizedKeywords, {
        ...common,
        enrich,
        profiles: sourceConfig.profiles || sourceConfig.profile || sourceConfig.accounts || sourceConfig.account || sourceConfig.handles || sourceConfig.handle || [],
      }));
    case "instagram":
      return normalizeSourceResult(await scrapeInstagram(normalizedKeywords, {
        ...common,
        enrich,
        profiles: sourceConfig.profiles || sourceConfig.profile || sourceConfig.accounts || sourceConfig.account || sourceConfig.handles || sourceConfig.handle || [],
      }));
    case "weiboSearch":
      return normalizeSourceResult(await scrapeWeiboSearch(normalizedKeywords, { ...common, enrich }));
    case "xiaohongshuSearch":
      return normalizeSourceResult(await scrapeXiaohongshuSearch(normalizedKeywords, { ...common, enrich }));
    case "douyinSearch":
      return normalizeSourceResult(await scrapeDouyinSearch(normalizedKeywords, { ...common, enrich }));
    case "kuaishouSearch":
      return normalizeSourceResult(await scrapeKuaishouSearch(normalizedKeywords, { ...common, enrich }));
    case "youtube":
      return normalizeSourceResult(await scrapeYouTube(normalizedKeywords, common));
    case "browserFallback":
      return normalizeSourceResult(await scrapeBrowserFallback(normalizedKeywords, {
        ...common,
        browserSettings: search?.browserFallback || {},
        sourceConfig,
      }));
    case "bilibili":
      return normalizeSourceResult(await scrapeBilibiliSearch(normalizedKeywords, common));
    case "applePodcastSearch":
      return normalizeSourceResult(await scrapeApplePodcastSearch(normalizedKeywords, {
        ...common,
        country: sourceConfig.country || "us",
        language: sourceConfig.language || sourceConfig.lang || "en_us",
      }));
    case "appStoreReviews":
      return normalizeSourceResult(await scrapeAppStoreReviews(normalizedKeywords, {
        ...common,
        countries: sourceConfig.countries || [],
        appIds: sourceConfig.appIds || sourceConfig.app_ids || [],
      }));
    case "googlePlayReviews":
      return normalizeSourceResult(await scrapeGooglePlayReviews(normalizedKeywords, {
        ...common,
        countries: sourceConfig.countries || [],
        languages: sourceConfig.languages || sourceConfig.langs || [],
        packageIds: sourceConfig.packageIds || sourceConfig.package_ids || sourceConfig.appIds || sourceConfig.app_ids || [],
      }));
    case "publicReviewSites":
      return normalizeSourceResult(await scrapePublicReviewSites(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.sites || [],
        targetProfiles: sourceConfig.targetProfiles || sourceConfig.target_profiles || sourceConfig.profiles || [],
      }));
    case "verticalReviewSources":
      return normalizeSourceResult(await scrapeVerticalReviewSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.sites || [],
        targetProfiles: sourceConfig.targetProfiles || sourceConfig.target_profiles || sourceConfig.profiles || [],
      }));
    case "employerReviewSources":
      return normalizeSourceResult(await scrapeEmployerReviewSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.sites || [],
        targetProfiles: sourceConfig.targetProfiles || sourceConfig.target_profiles || sourceConfig.profiles || [],
      }));
    case "ecommerceReviewSources":
      return normalizeSourceResult(await scrapeEcommerceReviewSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.sites || [],
        targetProfiles: sourceConfig.targetProfiles || sourceConfig.target_profiles || sourceConfig.profiles || [],
      }));
    case "localReviewSources":
      return normalizeSourceResult(await scrapeLocalReviewSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.sites || [],
        targetProfiles: sourceConfig.targetProfiles || sourceConfig.target_profiles || sourceConfig.profiles || [],
      }));
    case "regionalComplaintSources":
      return normalizeSourceResult(await scrapeRegionalComplaintSources(normalizedKeywords, {
        ...common,
        targets: sourceConfig.targets || sourceConfig.sites || [],
        targetProfiles: sourceConfig.targetProfiles || sourceConfig.target_profiles || sourceConfig.profiles || [],
      }));
    default:
      return { count: 0, failures: [{ target: sourceKey, message: "unsupported collection source" }] };
  }
}

function compactFailureReason(message) {
  const text = String(message || "unknown error")
    .replace(/^(?:keyword|target)=[^:]+:\s*/i, "");
  if (/^來源暫停中/i.test(text)) return text.length > 140 ? `${text.slice(0, 140)}...` : text;
  if (/HTTP\s+429/i.test(text)) return "HTTP 429 Too Many Requests";
  if (/HTTP\s+403/i.test(text)) return "HTTP 403 Forbidden";
  if (/HTTP\s+500/i.test(text)) return "HTTP 500";
  if (/HTTP\s+404/i.test(text)) return "HTTP 404 Not Found";
  if (/代理.*(連線被中斷|请求失败|請求失敗|无法连接|無法連接|连接超时|連接超時)/i.test(text)) {
    const proxyMatch = text.match(/https?:\/\/[^\s。]+/);
    return proxyMatch ? `代理連線異常：${proxyMatch[0]}` : "代理連線異常";
  }
  if (/timeout|超時|aborted/i.test(text)) return "請求超時";
  if (/ECONNRESET|socket disconnected|TLS connection was established/i.test(text)) return "連線被中斷";
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function compactFailureExample(message) {
  const text = String(message || "");
  const keyword = text.match(/keyword=([^\s:]+)/)?.[1];
  const target = text.match(/target=([^\s:]+)/)?.[1];
  const parts = [];
  if (keyword) parts.push(`keyword=${keyword}`);
  if (target) parts.push(`target=${target}`);
  return parts.join(" ");
}

function isRecoverableExternalAccessBarrier(message = "", sourceKey = "") {
  const text = String(message || "");
  const key = String(sourceKey || "");
  return /HTTP\s+(?:403|412|429)\b/i.test(text)
    || (key === "youtube" && /HTTP\s+400\s+Bad Request/i.test(text))
    || (key === "rssFeeds" && /HTTP\s+404\s+Not Found/i.test(text))
    || /HTTP\s+500\s+INKApi Error/i.test(text)
    || /(?:timeout|超時|请求超时|請求超時|aborted|ETIMEDOUT|ECONNRESET|socket disconnected|連線被中斷|连接被中断|來源連線被中斷)/i.test(text)
    || /封鎖此代理\/IP|Too Many Requests|Precondition Failed/i.test(text);
}

function allFailuresAreRecoverableExternalAccessBarriers(messages = [], sourceKey = "") {
  const normalized = (Array.isArray(messages) ? messages : [messages])
    .map(message => String(message || "").trim())
    .filter(Boolean);
  return normalized.length > 0 && normalized.every(message => isRecoverableExternalAccessBarrier(message, sourceKey));
}

function recoverableExternalAccessBarrierMessage(messages = []) {
  const normalized = (Array.isArray(messages) ? messages : [messages])
    .map(message => String(message || "").trim())
    .filter(Boolean);
  const reason = normalized.map(compactFailureReason).filter(Boolean)[0] || "外部來源暫時不可用";
  return `外部來源訪問受限或限流：${reason}；已進入冷卻並交由替代來源補償`;
}

function sourceJobTimeoutMs(mode = SCAN_MODE_FAST) {
  return normalizeSentimentScanMode(mode) === SCAN_MODE_FULL
    ? SOURCE_JOB_TIMEOUT_MS.full
    : SOURCE_JOB_TIMEOUT_MS.fast;
}

function normalizeRssFeedPackList(value = []) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s，、;；]+/)
      : [];
  const out = [];
  for (const item of raw) {
    const key = String(item || "").trim();
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

function rssFeedPacksForScanMode(search = {}, mode = SCAN_MODE_FAST, sourceConfig = {}) {
  const configuredByMode = search?.rssFeedPacks || search?.rss_feed_packs || {};
  const normalizedMode = normalizeSentimentScanMode(mode);
  const modePacks = normalizeRssFeedPackList(
    configuredByMode[normalizedMode]
    || (normalizedMode === SCAN_MODE_FULL
      ? configuredByMode.full || configuredByMode.deep
      : normalizedMode === SCAN_MODE_WATCH
        ? configuredByMode.watch || configuredByMode.crisis || configuredByMode.warning
        : configuredByMode.fast || configuredByMode.quick)
    || []
  );
  const sourcePacks = normalizeRssFeedPackList(sourceConfig.feedPacks || sourceConfig.feed_packs || []);
  const merged = [...modePacks, ...sourcePacks].filter((pack, index, list) => list.indexOf(pack) === index);
  return merged.length ? merged : DEFAULT_RSS_FEED_PACKS;
}

function withSourceJobTimeout(promise, { sourceKey = "", mode = SCAN_MODE_FAST } = {}) {
  const timeoutMs = sourceJobTimeoutMs(mode);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`source job timeout after ${timeoutMs}ms: ${sourceKey || "unknown"}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function browserFallbackProfileSourceKeys(profile = {}) {
  const raw = [
    profile.sourceKey,
    profile.source_key,
    profile.key,
    profile.platform,
    ...(Array.isArray(profile.sourceKeys) ? profile.sourceKeys : []),
    ...(Array.isArray(profile.source_keys) ? profile.source_keys : []),
  ];
  return uniqueExpansionTerms(raw, 16);
}

export function browserFallbackConfiguredSourceKeys(search = {}, sourceConfig = {}) {
  return uniqueExpansionTerms([
    ...uniqueExpansionTerms(search?.browserFallback?.sourceKeys || [], 64),
    ...uniqueExpansionTerms(search?.browserFallback?.source_keys || [], 64),
    ...uniqueExpansionTerms(sourceConfig?.sourceKeys || [], 64),
    ...uniqueExpansionTerms(sourceConfig?.source_keys || [], 64),
  ], 64);
}

export function browserFallbackProfilesForScan(search = {}, sourceConfig = {}) {
  const sourceProfiles = Array.isArray(sourceConfig?.profiles) ? sourceConfig.profiles : [];
  const settingProfiles = Array.isArray(search?.browserFallback?.profiles) ? search.browserFallback.profiles : [];
  const seen = new Set();
  return [...settingProfiles, ...sourceProfiles].filter((profile) => {
    const key = String(profile?.key || profile?.sourceKey || profile?.source_key || profile?.domain || "").trim();
    if (!key) return false;
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function browserFallbackMatchingSourceKeys(search = {}, selectedSourceKeys = [], sourceConfig = {}) {
  const configuredKeys = browserFallbackConfiguredSourceKeys(search, sourceConfig);
  if (configuredKeys.length) return configuredKeys;

  const selected = uniqueExpansionTerms(selectedSourceKeys, 128)
    .filter(key => key !== "browserFallback");
  if (!selected.length) return [];

  const selectedSet = new Set(selected.map(key => key.toLowerCase()));
  const matched = [];
  for (const profile of browserFallbackProfilesForScan(search, sourceConfig)) {
    const profileKeys = browserFallbackProfileSourceKeys(profile);
    for (const key of profileKeys) {
      if (selectedSet.has(String(key || "").toLowerCase()) && !matched.includes(key)) {
        matched.push(key);
      }
    }
  }
  return matched;
}

export function browserFallbackSettingsForScan(search = {}, selectedSourceKeys = [], sourceConfig = {}) {
  const browserSettings = search?.browserFallback || {};
  if (selectedSourceKeys.includes("browserFallback")) {
    return { browserSettings, sourceConfig: { ...sourceConfig, profiles: browserFallbackProfilesForScan(search, sourceConfig) } };
  }
  const configuredKeys = browserFallbackConfiguredSourceKeys(search, sourceConfig);
  if (configuredKeys.length) {
    return { browserSettings, sourceConfig: { ...sourceConfig, profiles: browserFallbackProfilesForScan(search, sourceConfig) } };
  }
  const sourceKeys = browserFallbackMatchingSourceKeys(search, selectedSourceKeys, sourceConfig);
  if (!sourceKeys.length) return { browserSettings, sourceConfig: { ...sourceConfig, profiles: browserFallbackProfilesForScan(search, sourceConfig) } };
  return {
    browserSettings: { ...browserSettings, sourceKeys },
    sourceConfig: { ...sourceConfig, profiles: browserFallbackProfilesForScan(search, sourceConfig) },
  };
}

export function browserFallbackAutoEnabled(search = {}, sourceRecord = null, selectedSourceKeys = [], sourceConfig = {}) {
  if (sourceRecord?.enabled === false) return false;
  const browserSettings = search?.browserFallback || {};
  if (browserSettings.enabled === false) return false;
  if (!browserFallbackProfilesForScan(search, sourceConfig).length) return false;
  if (selectedSourceKeys.includes("browserFallback")) return true;
  if (browserFallbackConfiguredSourceKeys(search, sourceConfig).length) return true;
  return browserFallbackMatchingSourceKeys(search, selectedSourceKeys, sourceConfig).length > 0;
}

function browserFallbackRecoveryDiagnostics(search = {}, degradedSourceKey = "", sourceConfig = {}) {
  const sourceKey = String(degradedSourceKey || "").trim();
  const profiles = browserFallbackProfilesForScan(search, sourceConfig);
  const matchingProfiles = profiles.filter(profile => browserFallbackProfileSourceKeys(profile)
    .some(key => String(key || "").trim().toLowerCase() === sourceKey.toLowerCase()));
  const configuredSourceKeys = browserFallbackConfiguredSourceKeys(search, sourceConfig);
  return {
    degraded_source_key: sourceKey,
    matched_profile_count: matchingProfiles.length,
    matched_profile_keys: matchingProfiles.map(profile => profile.key || profile.sourceKey || profile.source_key || profile.platform || "").filter(Boolean).slice(0, 20),
    configured_source_keys: configuredSourceKeys,
    profile_count: profiles.length,
    status: matchingProfiles.length || configuredSourceKeys.includes(sourceKey) ? "matched-profile" : "no-matching-profile",
  };
}

function countFailures(failures = []) {
  return failures.reduce((sum, failure) => sum + Number(failure?.count || 1), 0);
}

function formatDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const minutes = Math.ceil(safeMs / 60000);
  if (minutes <= 1) return "1 分鐘";
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小時 ${rest} 分鐘` : `${hours} 小時`;
}

function sourceIntervalCooldown(source = {}, now = Date.now()) {
  const intervalMinutes = Math.max(1, Number(source.scan_interval_minutes || source.scanIntervalMinutes || 0) || 0);
  const lastScanAt = new Date(source.last_scan_at || "").getTime();
  if (!intervalMinutes || Number.isNaN(lastScanAt)) return null;
  const nextAt = lastScanAt + intervalMinutes * 60 * 1000;
  return nextAt > now ? { until: nextAt, intervalMinutes } : null;
}

export function sourceIncrementalSince(source = {}, { reason = "manual", incremental = DEFAULT_INCREMENTAL_SETTINGS } = {}) {
  if (!["schedule", "watch"].includes(String(reason || "")) || incremental?.enabled === false) return "";
  const cursor = source.config?.incrementalCursor || source.config?.incremental_cursor || {};
  const lastSuccessAt = new Date(cursor.lastSuccessfulAt || cursor.last_successful_at || source.last_success_at || "").getTime();
  if (Number.isNaN(lastSuccessAt)) return "";
  const overlapMinutes = Math.max(0, Number(incremental?.overlapMinutes || incremental?.overlap_minutes || 0) || 0);
  return new Date(lastSuccessAt - overlapMinutes * 60 * 1000).toISOString();
}

function cooldownForFailure(message) {
  const text = String(message || "");
  for (const rule of SOURCE_COOLDOWN_RULES) {
    if (rule.pattern.test(text)) return { ms: rule.ms, reason: rule.reason };
  }
  return { ms: SOURCE_COOLDOWN_MIN_MS, reason: compactFailureReason(text) };
}

function throttlePolicyForSource(sourceKey, source = {}) {
  const configured = source?.config?.throttle || source?.config?.crawlThrottle || {};
  const fallback = SOURCE_THROTTLE_POLICIES[sourceKey] || { domain: sourceKey || "unknown", minIntervalMs: 30 * 1000 };
  const configuredIntervalMs = configured.minIntervalMs ?? configured.min_interval_ms;
  const configuredIntervalSeconds = configured.minIntervalSeconds ?? configured.min_interval_seconds;
  const rawIntervalMs = configuredIntervalMs !== undefined
    ? configuredIntervalMs
    : configuredIntervalSeconds !== undefined
      ? Number(configuredIntervalSeconds || 0) * 1000
      : fallback.minIntervalMs;
  const minIntervalMs = Math.max(0, Number(rawIntervalMs || 0) || 0);
  return {
    sourceKey,
    domain: String(configured.domain || fallback.domain || sourceKey || "unknown"),
    minIntervalMs,
    adaptive: configured.adaptive !== false,
  };
}

function getDomainThrottleState(domain) {
  return domainThrottle.get(domain) || {
    domain,
    nextAllowedAt: 0,
    consecutiveFailures: 0,
    lastReason: "",
    lastRequestAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
}

function activeDomainThrottle(policy, now = Date.now()) {
  if (!policy?.domain || !policy.minIntervalMs) return null;
  const state = getDomainThrottleState(policy.domain);
  return Number(state.nextAllowedAt || 0) > now
    ? {
      domain: policy.domain,
      until: Number(state.nextAllowedAt || 0),
      reason: state.lastReason || "來源域名節流中",
      consecutiveFailures: Number(state.consecutiveFailures || 0),
    }
    : null;
}

function recordDomainThrottleStart(policy, now = Date.now()) {
  if (!policy?.domain || !policy.minIntervalMs) return null;
  const state = getDomainThrottleState(policy.domain);
  const nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + Number(policy.minIntervalMs || 0));
  const next = {
    ...state,
    lastRequestAt: new Date(now).toISOString(),
    nextAllowedAt,
    lastReason: state.lastReason || "固定請求窗口",
  };
  domainThrottle.set(policy.domain, next);
  return next;
}

function recordDomainThrottleSuccess(policy, now = Date.now()) {
  if (!policy?.domain || !policy.minIntervalMs) return null;
  const state = getDomainThrottleState(policy.domain);
  const next = {
    ...state,
    consecutiveFailures: 0,
    lastSuccessAt: new Date(now).toISOString(),
    lastReason: "固定請求窗口",
    nextAllowedAt: Math.max(Number(state.nextAllowedAt || 0), now + Number(policy.minIntervalMs || 0)),
  };
  domainThrottle.set(policy.domain, next);
  return next;
}

function recordDomainThrottleFailure(policy, messages = [], now = Date.now()) {
  if (!policy?.domain || !policy.minIntervalMs) return null;
  const normalizedMessages = (Array.isArray(messages) ? messages : [messages])
    .map(message => String(message || "unknown error"))
    .filter(Boolean);
  const worst = normalizedMessages
    .map(message => cooldownForFailure(message))
    .sort((a, b) => b.ms - a.ms)[0] || cooldownForFailure("unknown error");
  const state = getDomainThrottleState(policy.domain);
  const consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
  const adaptiveMs = policy.adaptive
    ? Math.min(THROTTLE_MAX_BACKOFF_MS, Math.max(Number(policy.minIntervalMs || 0), Math.round(worst.ms * (consecutiveFailures >= 2 ? THROTTLE_FAILURE_MULTIPLIER : 1))))
    : Number(policy.minIntervalMs || 0);
  const next = {
    ...state,
    consecutiveFailures,
    lastFailureAt: new Date(now).toISOString(),
    lastReason: worst.reason,
    nextAllowedAt: Math.max(Number(state.nextAllowedAt || 0), now + adaptiveMs),
  };
  domainThrottle.set(policy.domain, next);
  return next;
}

function throttleSnapshotForSource(sourceKey, source = {}, now = Date.now()) {
  const policy = throttlePolicyForSource(sourceKey, source);
  const state = getDomainThrottleState(policy.domain);
  const active = Number(state.nextAllowedAt || 0) > now;
  return {
    source_key: sourceKey,
    domain: policy.domain,
    min_interval_ms: policy.minIntervalMs,
    adaptive: policy.adaptive,
    status: active ? "throttled" : "ready",
    next_allowed_at: active ? new Date(state.nextAllowedAt).toISOString() : null,
    remaining_ms: active ? Math.max(0, Number(state.nextAllowedAt || 0) - now) : 0,
    consecutive_failures: Number(state.consecutiveFailures || 0),
    last_reason: state.lastReason || "",
    last_request_at: state.lastRequestAt || null,
    last_success_at: state.lastSuccessAt || null,
    last_failure_at: state.lastFailureAt || null,
  };
}

function getSourceState(source) {
  return sourceHealth.get(source) || {
    source,
    consecutiveFailures: 0,
    failureCount: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    lastReason: "",
    coolingUntil: 0,
  };
}

function activeSourceCooldown(source, now = Date.now()) {
  const state = getSourceState(source);
  return state.coolingUntil > now
    ? { until: state.coolingUntil, reason: state.lastReason || "來源暫停中" }
    : null;
}

function recordSourceSuccess(source, now = Date.now()) {
  const state = getSourceState(source);
  sourceHealth.set(source, {
    ...state,
    consecutiveFailures: 0,
    lastSuccessAt: new Date(now).toISOString(),
    coolingUntil: 0,
  });
}

function recordSourceFailure(source, messages = [], now = Date.now()) {
  const normalizedMessages = (Array.isArray(messages) ? messages : [messages])
    .map(message => String(message || "unknown error"))
    .filter(Boolean);
  const worst = normalizedMessages
    .map(message => cooldownForFailure(message))
    .sort((a, b) => b.ms - a.ms)[0] || cooldownForFailure("unknown error");
  const state = getSourceState(source);
  const consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
  const cooldownMs = Math.max(worst.ms, consecutiveFailures >= 3 ? worst.ms * 2 : worst.ms);
  sourceHealth.set(source, {
    ...state,
    consecutiveFailures,
    failureCount: Number(state.failureCount || 0) + normalizedMessages.length,
    lastFailureAt: new Date(now).toISOString(),
    lastReason: worst.reason,
    coolingUntil: now + cooldownMs,
  });
}

export function getSentimentSourceHealth(now = Date.now()) {
  return [...sourceHealth.values()]
    .sort((a, b) => String(a.source).localeCompare(String(b.source)))
    .map(state => {
      const cooling = Number(state.coolingUntil || 0) > now;
      return {
        source: state.source,
        status: cooling ? "cooldown" : state.consecutiveFailures > 0 ? "degraded" : "healthy",
        consecutiveFailures: Number(state.consecutiveFailures || 0),
        failureCount: Number(state.failureCount || 0),
        lastFailureAt: state.lastFailureAt || null,
        lastSuccessAt: state.lastSuccessAt || null,
        lastReason: state.lastReason || "",
        coolingUntil: cooling ? new Date(state.coolingUntil).toISOString() : null,
        remainingMs: cooling ? Math.max(0, state.coolingUntil - now) : 0,
      };
    });
}

export function listSentimentSourceThrottleState({ now = Date.now(), sources = null } = {}) {
  const sourceRows = Array.isArray(sources) ? sources : listSentimentSources();
  return sourceRows
    .map(source => throttleSnapshotForSource(String(source.source_key || source.sourceKey || ""), source, now))
    .sort((a, b) => {
      const rank = { throttled: 0, ready: 1 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
        || b.consecutive_failures - a.consecutive_failures
        || a.source_key.localeCompare(b.source_key);
    });
}

export function listSentimentSourceSchedule({ now = Date.now(), sources = null } = {}) {
  const sourceRows = Array.isArray(sources) ? sources : listSentimentSources();
  return sourceRows.map(source => {
    const key = String(source.source_key || source.sourceKey || "");
    const intervalMinutes = Math.max(1, Number(source.scan_interval_minutes || source.scanIntervalMinutes || 0) || 1);
    const lastScanMs = new Date(source.last_scan_at || "").getTime();
    const nextScanMs = Number.isNaN(lastScanMs) ? now : lastScanMs + intervalMinutes * 60 * 1000;
    const cooldown = activeSourceCooldown(key, now);
    const throttle = activeDomainThrottle(throttlePolicyForSource(key, source), now);
    const enabled = source.enabled !== false && source.enabled !== 0;
    const waitingMs = Math.max(0, nextScanMs - now);
    const due = enabled && !cooldown && !throttle && waitingMs <= 0;
    const health = getSourceState(key);
    return {
      source_key: key,
      label: source.label || key,
      source_type: source.source_type || source.sourceType || "public",
      enabled,
      priority: Number(source.priority || 0),
      scan_interval_minutes: intervalMinutes,
      realtime: REALTIME_SOURCE_KEYS.has(key),
      last_scan_at: source.last_scan_at || null,
      last_success_at: source.last_success_at || null,
      last_error: source.last_error || "",
      next_scan_at: enabled ? new Date(nextScanMs).toISOString() : null,
      due,
      status: !enabled
        ? "disabled"
        : cooldown
          ? "cooldown"
          : throttle
            ? "throttled"
            : due
              ? "due"
              : "waiting",
      waiting_ms: enabled && !cooldown && !throttle ? waitingMs : 0,
      cooling_until: cooldown ? new Date(cooldown.until).toISOString() : null,
      cooldown_reason: cooldown?.reason || "",
      throttle_domain: throttle?.domain || throttlePolicyForSource(key, source).domain,
      throttle_until: throttle ? new Date(throttle.until).toISOString() : null,
      throttle_reason: throttle?.reason || "",
      consecutive_failures: Number(health.consecutiveFailures || 0),
      failure_count: Number(health.failureCount || 0),
    };
  }).sort((a, b) => {
    const statusRank = { due: 0, cooldown: 1, throttled: 2, waiting: 3, disabled: 4 };
    return (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9)
      || b.priority - a.priority
      || a.source_key.localeCompare(b.source_key);
  });
}

function continuousCollectionAction(item = {}) {
  const evidenceChainBoost = Number(item.evidence_chain_gap_signal?.priorityBoost || 0);
  const realtimeCoverageBoost = Number(item.realtime_source_coverage_signal?.priorityBoost || 0);
  const realtimeHotTopicBoost = Number(item.realtime_hot_topic_signal?.priorityBoost || 0);
  const evidenceChainTypes = new Set(Array.isArray(item.evidence_chain_gap_signal?.gapTypes) ? item.evidence_chain_gap_signal.gapTypes : []);
  const escalatedEvidenceChainGap = evidenceChainBoost >= 22 && (
    evidenceChainTypes.has("origin-propagation")
    || evidenceChainTypes.has("official-regulatory")
    || evidenceChainTypes.has("fact-claim")
    || evidenceChainTypes.has("quoted-context")
    || evidenceChainTypes.has("video-followup")
    || (Number(item.evidence_chain_gap_signal?.chainCount || 0) > 1 && Number(item.evidence_chain_gap_signal?.maxGapScore || 0) >= 75)
  );
  if (item.enabled === false || item.status === "disabled") return "disabled";
  if (item.status === "cooldown") return "wait-source-cooldown";
  if (item.status === "throttled") return "wait-domain-throttle";
  if (item.source_quality_signal?.action === "repair-source") return "wait-source-quality-repair";
  if (item.source_quality_signal?.action === "tighten-filters") return "wait-source-quality-backoff";
  if (item.noise_suppression_signal?.action === "repair-or-suppress-source") return "wait-noise-suppression-repair";
  if (item.noise_suppression_signal?.action === "tighten-source") return "wait-noise-suppression-backoff";
  if (item.due) return "scan-due-source";
  const realtimeAnomalyWindowBoost = Number(item.realtime_anomaly_window_signal?.priorityBoost || 0);
  if (Number(item.alert_event_signal?.priorityBoost || 0) >= 30) return "scan-alert-event-source";
  if (Number(item.anomaly_signal?.priorityBoost || 0) >= 28) return "scan-burst-source";
  if (Number(item.official_regulatory_followup_signal?.priorityBoost || 0) >= 26) return "scan-official-regulatory-followup-source";
  if (Number(item.realtime_latency_signal?.priorityBoost || 0) >= 28) return "scan-realtime-latency-source";
  if (Number(item.social_followup_signal?.priorityBoost || 0) >= 26) return "scan-social-followup-source";
  if (realtimeHotTopicBoost >= 30 && realtimeHotTopicBoost > realtimeCoverageBoost) return "scan-realtime-hot-topic-source";
  if (escalatedEvidenceChainGap && evidenceChainBoost >= realtimeCoverageBoost - 4) return "scan-evidence-chain-source";
  if (realtimeCoverageBoost >= 22) return "scan-realtime-coverage-source";
  if (realtimeAnomalyWindowBoost >= 32) return "scan-realtime-anomaly-window-source";
  if (Number(item.multilingual_query_signal?.priorityBoost || 0) >= 16) return "scan-multilingual-query-source";
  if (Number(item.evidence_coverage_recovery_signal?.priorityBoost || 0) >= 18) return "scan-evidence-coverage-recovery-source";
  if (Number(item.evidence_coverage_routed_alternate_signal?.priorityBoost || 0) >= 14) return "scan-evidence-coverage-routed-alternate-source";
  if (Number(item.free_source_target_coverage_signal?.priorityBoost || 0) >= 18) return "scan-free-source-target-coverage-source";
  if (Number(item.collection_operations_remediation_signal?.priorityBoost || 0) >= 14) return "scan-collection-operations-remediation-source";
  if (Number(item.access_barrier_alternate_signal?.priorityBoost || 0) >= 14) return "scan-access-barrier-alternate-source";
  if (Number(item.event_cluster_signal?.priorityBoost || 0) >= 28) return "scan-event-cluster-source";
  if (Number(item.propagation_confidence_signal?.priorityBoost || 0) >= 24) return "scan-propagation-confidence-source";
  if (realtimeHotTopicBoost >= 30) return "scan-realtime-hot-topic-source";
  if (Number(item.keyword_family_coverage_signal?.priorityBoost || 0) >= 20) return "scan-keyword-family-coverage-source";
  if (Number(item.taiwan_priority_site_health_signal?.priorityBoost || 0) >= 16) return "scan-taiwan-priority-site-health-source";
  if (Number(item.evidence_depth_signal?.priorityBoost || 0) >= 20) return "scan-evidence-depth-source";
  if (evidenceChainBoost >= 22) return "scan-evidence-chain-source";
  if (Number(item.commercial_governance_signal?.priorityBoost || 0) >= 28) return "scan-commercial-governance-source";
  if (Number(item.commercial_signal?.priorityBoost || 0) >= 28) return "scan-commercial-benchmark-source";
  if (Number(item.credibility_signal?.priorityBoost || 0) >= 16 && (["high-trust", "trusted"].includes(String(item.credibility_signal?.label || "")) || Number(item.credibility_signal?.sourceTierScore || 0) >= 80)) return "scan-trusted-source";
  if (Number(item.retry_due_count || 0) > 0) return "consume-retry-jobs";
  if (item.coverage_signal?.recommendation === "increase-coverage") return "wait-source-interval-with-under-covered-source";
  if (item.coverage_signal?.recommendation === "refresh-schedule") return "wait-source-interval-with-stale-coverage";
  return "wait-source-interval";
}

function continuousCollectionPriority(item = {}) {
  let score = Number(item.priority || 0);
  const reasons = [];
  const add = (value, reason, extra = {}) => {
    if (!value) return;
    score += Number(value || 0);
    reasons.push({ reason, weight: Number(value || 0), ...extra });
  };
  add(item.due ? 50 : 0, "source-scan-due");
  add(item.realtime ? 10 : 0, "realtime-source");
  add(Math.min(30, Number(item.retry_highest_priority_score || 0) / 4), "retry-jobs-due", { due_count: item.retry_due_count });
  add(Math.min(35, Number(item.tracking_signal?.score || 0) / 2), "propagation-tracking", {
    event_count: item.tracking_signal?.eventCount || 0,
    max_propagation_path_score: item.tracking_signal?.maxPropagationPathScore || 0,
  });
  add(Number(item.alert_event_signal?.priorityBoost || 0), "alert-event-urgency", {
    alert_count: item.alert_event_signal?.alertCount || 0,
    event_count: item.alert_event_signal?.eventCount || 0,
    max_severity: item.alert_event_signal?.maxSeverity || "",
    risk_levels: item.alert_event_signal?.riskLevels || [],
    suggested_keywords: item.alert_event_signal?.suggestedKeywords || [],
  });
  add(Number(item.anomaly_signal?.priorityBoost || 0), "anomaly-burst", {
    anomaly_count: item.anomaly_signal?.anomalyCount || 0,
    max_anomaly_score: item.anomaly_signal?.maxAnomalyScore || 0,
    max_severity: item.anomaly_signal?.maxSeverity || "",
    anomaly_types: item.anomaly_signal?.anomalyTypes || [],
  });
  add(Number(item.realtime_hot_topic_signal?.priorityBoost || 0), "realtime-hot-topic", {
    topic_count: item.realtime_hot_topic_signal?.topicCount || 0,
    max_hot_score: item.realtime_hot_topic_signal?.maxHotScore || 0,
    max_label: item.realtime_hot_topic_signal?.maxLabel || "",
    keywords: item.realtime_hot_topic_signal?.keywords || [],
    source_families: item.realtime_hot_topic_signal?.sourceFamilies || [],
    gaps: item.realtime_hot_topic_signal?.gaps || [],
    suggested_keywords: item.realtime_hot_topic_signal?.suggestedKeywords || [],
  });
  add(Number(item.realtime_anomaly_window_signal?.priorityBoost || 0), "realtime-anomaly-window", {
    signal_count: item.realtime_anomaly_window_signal?.signalCount || 0,
    max_score: item.realtime_anomaly_window_signal?.maxScore || 0,
    severities: item.realtime_anomaly_window_signal?.severities || [],
    windows: item.realtime_anomaly_window_signal?.windows || [],
    reasons: item.realtime_anomaly_window_signal?.reasons || [],
    suggested_keywords: item.realtime_anomaly_window_signal?.suggestedKeywords || [],
  });
  add(Number(item.keyword_family_coverage_signal?.priorityBoost || 0), "keyword-source-family-coverage-gap", {
    gap_count: item.keyword_family_coverage_signal?.gapCount || 0,
    keywords: item.keyword_family_coverage_signal?.keywords || [],
    families: item.keyword_family_coverage_signal?.families || [],
    statuses: item.keyword_family_coverage_signal?.statuses || [],
    suggested_keywords: item.keyword_family_coverage_signal?.suggestedKeywords || [],
  });
  add(Number(item.taiwan_priority_site_health_signal?.priorityBoost || 0), "taiwan-priority-site-health-gap", {
    site_count: item.taiwan_priority_site_health_signal?.siteCount || 0,
    runtime_warning_site_count: item.taiwan_priority_site_health_signal?.runtimeWarningSiteCount || 0,
    indexed_only_site_count: item.taiwan_priority_site_health_signal?.indexedOnlySiteCount || 0,
    partial_site_count: item.taiwan_priority_site_health_signal?.partialSiteCount || 0,
    missing_site_count: item.taiwan_priority_site_health_signal?.missingSiteCount || 0,
    site_names: item.taiwan_priority_site_health_signal?.siteNames || [],
    domains: item.taiwan_priority_site_health_signal?.domains || [],
    recommended_actions: item.taiwan_priority_site_health_signal?.recommendedActions || [],
    suggested_keywords: item.taiwan_priority_site_health_signal?.suggestedKeywords || [],
  });
  add(Number(item.official_regulatory_followup_signal?.priorityBoost || 0), "official-regulatory-followup", {
    evidence_count: item.official_regulatory_followup_signal?.evidenceCount || 0,
    tiers: item.official_regulatory_followup_signal?.tiers || [],
    reasons: item.official_regulatory_followup_signal?.reasons || [],
    suggested_keywords: item.official_regulatory_followup_signal?.suggestedKeywords || [],
  });
  add(Number(item.coverage_signal?.priorityBoost || 0), "coverage-gap");
  add(Number(item.entity_topic_signal?.priorityBoost || 0), "entity-topic-gap");
  add(Number(item.evidence_gap_signal?.priorityBoost || 0), "evidence-completeness-gap", {
    brief_count: item.evidence_gap_signal?.briefCount || 0,
    min_completeness_score: item.evidence_gap_signal?.minCompletenessScore ?? null,
    reasons: item.evidence_gap_signal?.reasons || [],
  });
  add(Number(item.evidence_depth_signal?.priorityBoost || 0), "evidence-depth-gap", {
    evidence_count: item.evidence_depth_signal?.evidenceCount || 0,
    min_depth_score: item.evidence_depth_signal?.minDepthScore ?? null,
    reasons: item.evidence_depth_signal?.reasons || [],
    levels: item.evidence_depth_signal?.levels || [],
  });
  add(Number(item.evidence_coverage_recovery_signal?.priorityBoost || 0), "evidence-coverage-recovery", {
    job_count: item.evidence_coverage_recovery_signal?.jobCount || 0,
    recovery_statuses: item.evidence_coverage_recovery_signal?.recoveryStatuses || [],
    target_types: item.evidence_coverage_recovery_signal?.targetTypes || [],
    actions: item.evidence_coverage_recovery_signal?.actions || [],
    low_depth_domains: item.evidence_coverage_recovery_signal?.lowDepthDomains || [],
    low_depth_urls: item.evidence_coverage_recovery_signal?.lowDepthUrls || [],
    low_depth_comment_urls: item.evidence_coverage_recovery_signal?.lowDepthCommentUrls || [],
    low_depth_feed_names: item.evidence_coverage_recovery_signal?.lowDepthFeedNames || [],
    suggested_keywords: item.evidence_coverage_recovery_signal?.suggestedKeywords || [],
    recommended_alternate_sources: item.evidence_coverage_recovery_signal?.recommendedAlternateSources || [],
    failure_reasons: item.evidence_coverage_recovery_signal?.failureReasons || [],
    routed_from_sources: item.evidence_coverage_recovery_signal?.routedFromSources || [],
    routed_alternate: Boolean(item.evidence_coverage_recovery_signal?.routedAlternate),
  });
  add(Number(item.evidence_coverage_routed_alternate_signal?.priorityBoost || 0), "evidence-coverage-routed-alternate-effective", {
    route_count: item.evidence_coverage_routed_alternate_signal?.routeCount || 0,
    original_sources: item.evidence_coverage_routed_alternate_signal?.originalSources || [],
    evidence_count: item.evidence_coverage_routed_alternate_signal?.evidenceCount || 0,
    best_quality_score: item.evidence_coverage_routed_alternate_signal?.bestQualityScore ?? null,
    average_quality_score: item.evidence_coverage_routed_alternate_signal?.averageQualityScore ?? null,
    strong_evidence_count: item.evidence_coverage_routed_alternate_signal?.strongEvidenceCount || 0,
    trusted_evidence_count: item.evidence_coverage_routed_alternate_signal?.trustedEvidenceCount || 0,
    high_risk_evidence_count: item.evidence_coverage_routed_alternate_signal?.highRiskEvidenceCount || 0,
    quality_reasons: item.evidence_coverage_routed_alternate_signal?.qualityReasons || [],
    failure_reasons: item.evidence_coverage_routed_alternate_signal?.failureReasons || [],
    low_depth_urls: item.evidence_coverage_routed_alternate_signal?.lowDepthUrls || [],
    low_depth_comment_urls: item.evidence_coverage_routed_alternate_signal?.lowDepthCommentUrls || [],
    routed_keywords: item.evidence_coverage_routed_alternate_signal?.routedKeywords || [],
    recommendation: item.evidence_coverage_routed_alternate_signal?.recommendation || "",
  });
  add(Number(item.evidence_chain_gap_signal?.priorityBoost || 0), "evidence-chain-gap", {
    chain_count: item.evidence_chain_gap_signal?.chainCount || 0,
    max_gap_score: item.evidence_chain_gap_signal?.maxGapScore ?? null,
    gap_levels: item.evidence_chain_gap_signal?.gapLevels || [],
    gap_types: item.evidence_chain_gap_signal?.gapTypes || [],
    missing: item.evidence_chain_gap_signal?.missing || [],
    suggested_keywords: item.evidence_chain_gap_signal?.suggestedKeywords || [],
  });
  add(Number(item.realtime_latency_signal?.priorityBoost || 0), "realtime-discovery-latency", {
    p90_latency_minutes: item.realtime_latency_signal?.p90LatencyMinutes ?? null,
    target_minutes: item.realtime_latency_signal?.targetMinutes ?? null,
    slow_rate: item.realtime_latency_signal?.slowRate ?? null,
    recommendation: item.realtime_latency_signal?.recommendation || "",
  });
  add(Number(item.realtime_source_coverage_signal?.priorityBoost || 0), "realtime-source-family-coverage", {
    gap_count: item.realtime_source_coverage_signal?.gapCount || 0,
    keywords: item.realtime_source_coverage_signal?.keywords || [],
    families: item.realtime_source_coverage_signal?.families || [],
    statuses: item.realtime_source_coverage_signal?.statuses || [],
    suggested_keywords: item.realtime_source_coverage_signal?.suggestedKeywords || [],
  });
  add(Number(item.social_followup_signal?.priorityBoost || 0), "social-followup-signal", {
    signal_count: item.social_followup_signal?.signalCount || 0,
    reasons: item.social_followup_signal?.reasons || [],
    suggested_keywords: item.social_followup_signal?.suggestedKeywords || [],
  });
  add(Number(item.multilingual_query_signal?.priorityBoost || 0), "multilingual-query-quality", {
    query_count: item.multilingual_query_signal?.queryCount || 0,
    evidence_count: item.multilingual_query_signal?.evidenceCount || 0,
    high_risk_count: item.multilingual_query_signal?.highRiskCount || 0,
    locales: item.multilingual_query_signal?.locales || [],
    recommendations: item.multilingual_query_signal?.recommendations || [],
    suggested_keywords: item.multilingual_query_signal?.suggestedKeywords || [],
    suppressed_keywords: item.multilingual_query_signal?.suppressedKeywords || [],
  });
  add(Number(item.free_source_target_coverage_signal?.priorityBoost || 0), "free-source-target-coverage", {
    coverage_score: item.free_source_target_coverage_signal?.coverageScore ?? null,
    missing_profile_count: item.free_source_target_coverage_signal?.missingProfileCount || 0,
    missing_profiles: item.free_source_target_coverage_signal?.missingProfiles || [],
    suggested_terms: item.free_source_target_coverage_signal?.suggestedTerms || [],
  });
  add(Number(item.event_cluster_signal?.priorityBoost || 0), "event-cluster-gap", {
    cluster_count: item.event_cluster_signal?.clusterCount || 0,
    max_propagation_path_score: item.event_cluster_signal?.maxPropagationPathScore || 0,
    max_independent_confirmation_score: item.event_cluster_signal?.maxIndependentConfirmationScore ?? null,
    min_independent_confirmation_score: item.event_cluster_signal?.minIndependentConfirmationScore ?? null,
    independent_confirmation_labels: item.event_cluster_signal?.independentConfirmationLabels || [],
    independent_source_families: item.event_cluster_signal?.independentSourceFamilies || [],
    confirmed_cluster_count: item.event_cluster_signal?.confirmedClusterCount || 0,
    gaps: item.event_cluster_signal?.gaps || [],
    two_hop_collection: Boolean(item.event_cluster_signal?.twoHopCollection),
    explicit_reference_chain: Boolean(item.event_cluster_signal?.explicitReferenceChain),
    explicit_reference_edge_count: item.event_cluster_signal?.explicitReferenceEdgeCount || 0,
    explicit_reference_reasons: item.event_cluster_signal?.explicitReferenceReasons || [],
    suggested_keywords: item.event_cluster_signal?.suggestedKeywords || [],
    followup_targets: item.event_cluster_signal?.followupTargets || [],
    origin_urls: item.event_cluster_signal?.originUrls || [],
    amplifier_platforms: item.event_cluster_signal?.amplifierPlatforms || [],
    independent_confirmation_needed: Boolean(item.event_cluster_signal?.independentConfirmationNeeded),
  });
  add(Number(item.propagation_confidence_signal?.priorityBoost || 0), "propagation-confidence-gap", {
    event_count: item.propagation_confidence_signal?.eventCount || 0,
    min_confidence_score: item.propagation_confidence_signal?.minConfidenceScore ?? null,
    max_propagation_path_score: item.propagation_confidence_signal?.maxPropagationPathScore || 0,
    gaps: item.propagation_confidence_signal?.gaps || [],
    suggested_keywords: item.propagation_confidence_signal?.suggestedKeywords || [],
  });
  add(Number(item.commercial_signal?.priorityBoost || 0), "commercial-readiness-gap", {
    readiness_level: item.commercial_signal?.readinessLevel || "",
    overall_score: item.commercial_signal?.overallScore ?? null,
    action_count: item.commercial_signal?.actionCount || 0,
    areas: item.commercial_signal?.areas || [],
    actions: item.commercial_signal?.actions || [],
  });
  add(Number(item.commercial_governance_signal?.priorityBoost || 0), "commercial-policy-governance", {
    decision_count: item.commercial_governance_signal?.decisionCount || 0,
    decisions: item.commercial_governance_signal?.decisions || [],
    actions: item.commercial_governance_signal?.actions || [],
  });
  add(Number(item.credibility_signal?.priorityBoost || 0), "source-credibility", {
    credibility_score: item.credibility_signal?.score ?? null,
    credibility_label: item.credibility_signal?.label || "",
    source_tier_score: item.credibility_signal?.sourceTierScore ?? null,
    reasons: item.credibility_signal?.reasons || [],
  });
  add(Number(item.source_quality_signal?.priorityBoost || 0), "source-quality-health", {
    action: item.source_quality_signal?.action || "",
    recommendation: item.source_quality_signal?.recommendation || "",
    health_score: item.source_quality_signal?.healthScore ?? null,
    effective_rate: item.source_quality_signal?.effectiveRate ?? null,
    low_quality_rate: item.source_quality_signal?.lowQualityRate ?? null,
    duplicate_rate: item.source_quality_signal?.duplicateRate ?? null,
    failure_rate: item.source_quality_signal?.failureRate ?? null,
    sample_count: item.source_quality_signal?.sampleCount || 0,
    scan_count: item.source_quality_signal?.scanCount || 0,
  });
  add(Number(item.noise_suppression_signal?.priorityBoost || 0), "noise-suppression", {
    action: item.noise_suppression_signal?.action || "",
    recommendation: item.noise_suppression_signal?.recommendation || "",
    noise_score: item.noise_suppression_signal?.noiseScore ?? null,
    issues: item.noise_suppression_signal?.issues || [],
    low_quality_rate: item.noise_suppression_signal?.lowQualityRate ?? null,
    duplicate_rate: item.noise_suppression_signal?.duplicateRate ?? null,
    failure_rate: item.noise_suppression_signal?.failureRate ?? null,
    suppressed_keywords: item.noise_suppression_signal?.suppressedKeywords || [],
    tightened_keywords: item.noise_suppression_signal?.tightenedKeywords || [],
  });
  add(Number(item.access_barrier_alternate_signal?.priorityBoost || 0), "access-barrier-alternate-effective", {
    recovered_targets: item.access_barrier_alternate_signal?.recoveredTargets || 0,
    evidence_count: item.access_barrier_alternate_signal?.evidenceCount || 0,
    best_quality_score: item.access_barrier_alternate_signal?.bestQualityScore ?? null,
    average_quality_score: item.access_barrier_alternate_signal?.averageQualityScore ?? null,
    strong_evidence_count: item.access_barrier_alternate_signal?.strongEvidenceCount || 0,
    trusted_evidence_count: item.access_barrier_alternate_signal?.trustedEvidenceCount || 0,
    high_risk_evidence_count: item.access_barrier_alternate_signal?.highRiskEvidenceCount || 0,
    quality_labels: item.access_barrier_alternate_signal?.qualityLabels || [],
    quality_reasons: item.access_barrier_alternate_signal?.qualityReasons || [],
    blocked_domains: item.access_barrier_alternate_signal?.blockedDomains || [],
    recommendation: item.access_barrier_alternate_signal?.recommendation || "",
  });
  add(Number(item.collection_operations_remediation_signal?.priorityBoost || 0), "collection-operations-remediation-effective", {
    compensated_sources: item.collection_operations_remediation_signal?.compensatedSources || [],
    evidence_count: item.collection_operations_remediation_signal?.evidenceCount || 0,
    best_quality_score: item.collection_operations_remediation_signal?.bestQualityScore ?? null,
    average_quality_score: item.collection_operations_remediation_signal?.averageQualityScore ?? null,
    strong_evidence_count: item.collection_operations_remediation_signal?.strongEvidenceCount || 0,
    trusted_evidence_count: item.collection_operations_remediation_signal?.trustedEvidenceCount || 0,
    high_risk_evidence_count: item.collection_operations_remediation_signal?.highRiskEvidenceCount || 0,
    quality_reasons: item.collection_operations_remediation_signal?.qualityReasons || [],
    recommendation: item.collection_operations_remediation_signal?.recommendation || "",
  });
  const reliabilityStatus = String(item.reliability?.status || "");
  if (reliabilityStatus === "no-data") add(8, "seed-reliability-baseline");
  if (reliabilityStatus === "watch") add(4, "watch-reliability");
  if (reliabilityStatus === "unstable") add(-12, "unstable-source-backoff");
  if (reliabilityStatus === "rate-limited") add(-10, "rate-limited-backoff");
  if (item.status === "cooldown" || item.status === "throttled") add(-25, "active-backoff");
  if (item.enabled === false || item.status === "disabled") add(-100, "disabled-source");
  return {
    priority_score: Math.max(0, Math.min(250, Math.round(score))),
    priority_reasons: reasons,
  };
}

export function deriveAccessBarrierAlternateSourceSignals(effectiveness = {}) {
  const out = {};
  for (const target of Array.isArray(effectiveness.targets) ? effectiveness.targets : []) {
    const evidenceCount = Number(target.evidence_count || 0);
    if (evidenceCount <= 0) continue;
    const bestQualityScore = Number(target.best_quality_score || 0);
    const averageQualityScore = Number(target.average_quality_score || 0);
    if (bestQualityScore < 35 && averageQualityScore < 35) continue;
    for (const sourceKey of Array.isArray(target.effective_sources) ? target.effective_sources : []) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const current = out[key] || {
        sourceKey: key,
        recoveredTargets: 0,
        evidenceCount: 0,
        blockedDomains: [],
        queryTerms: [],
        sampleEvidenceUrls: [],
        qualityLabels: [],
        qualityReasons: [],
        bestQualityScore: 0,
        averageQualityScore: 0,
        qualityScoreSum: 0,
        qualityScoreCount: 0,
        highQualityEvidenceCount: 0,
        strongEvidenceCount: 0,
        trustedEvidenceCount: 0,
        highRiskEvidenceCount: 0,
        originalEvidenceCount: 0,
        priorityBoost: 0,
        budgetBoost: 0,
        recommendation: "promote-effective-alternate-source",
      };
      current.recoveredTargets += 1;
      current.evidenceCount += evidenceCount;
      current.qualityScoreSum += Number(target.quality_score_sum || 0);
      current.qualityScoreCount += Number(target.quality_score_count || 0);
      current.bestQualityScore = Math.max(Number(current.bestQualityScore || 0), bestQualityScore);
      current.averageQualityScore = current.qualityScoreCount
        ? Math.round((current.qualityScoreSum / current.qualityScoreCount) * 10) / 10
        : Math.max(Number(current.averageQualityScore || 0), averageQualityScore);
      current.highQualityEvidenceCount += Number(target.high_quality_evidence_count || 0);
      current.strongEvidenceCount += Number(target.strong_evidence_count || 0);
      current.trustedEvidenceCount += Number(target.trusted_evidence_count || 0);
      current.highRiskEvidenceCount += Number(target.high_risk_evidence_count || 0);
      current.originalEvidenceCount += Number(target.original_evidence_count || 0);
      if (target.best_quality_label && !current.qualityLabels.includes(target.best_quality_label)) current.qualityLabels.push(target.best_quality_label);
      current.qualityReasons = [...new Set([
        ...current.qualityReasons,
        ...(target.quality_reasons || []),
      ])].slice(0, 16);
      if (target.blocked_domain && !current.blockedDomains.includes(target.blocked_domain)) current.blockedDomains.push(target.blocked_domain);
      current.queryTerms = [...new Set([
        ...current.queryTerms,
        ...(target.query_terms || []),
      ])].slice(0, 16);
      current.sampleEvidenceUrls = [...new Set([
        ...current.sampleEvidenceUrls,
        ...(target.sample_evidence_urls || []),
      ])].slice(0, 8);
      const qualityBoost = current.bestQualityScore >= 75 ? 10 : current.bestQualityScore >= 55 ? 6 : 2;
      const trustBoost = Math.min(4, current.trustedEvidenceCount * 2);
      const riskBoost = Math.min(4, current.highRiskEvidenceCount * 2);
      current.priorityBoost = Math.min(30, 8 + current.recoveredTargets * 4 + Math.min(8, current.evidenceCount * 2) + qualityBoost + trustBoost + riskBoost);
      current.budgetBoost = Math.min(0.35, 0.08 + current.recoveredTargets * 0.04 + (current.bestQualityScore >= 75 ? 0.12 : current.bestQualityScore >= 55 ? 0.08 : 0.03));
      if (current.bestQualityScore >= 75 || current.strongEvidenceCount > 0) current.recommendation = "promote-high-quality-alternate-source";
      out[key] = current;
    }
  }
  return out;
}

export function deriveEvidenceCoverageRoutedAlternateSourceSignals(effectiveness = {}) {
  const out = {};
  for (const route of Array.isArray(effectiveness.routes) ? effectiveness.routes : []) {
    const sourceKey = String(route.alternate_source_key || "").trim();
    if (!sourceKey || Number(route.evidence_count || 0) <= 0) continue;
    const bestQualityScore = Number(route.best_quality_score || 0);
    const averageQualityScore = Number(route.average_quality_score || 0);
    if (bestQualityScore < 35 && averageQualityScore < 35) continue;
    const current = out[sourceKey] || {
      sourceKey,
      routeCount: 0,
      originalSources: [],
      targets: [],
      evidenceCount: 0,
      sampleEvidenceUrls: [],
      qualityReasons: [],
      failureReasons: [],
      lowDepthUrls: [],
      lowDepthCommentUrls: [],
      routedKeywords: [],
      bestQualityScore: 0,
      averageQualityScore: 0,
      qualityScoreSum: 0,
      qualityScoreCount: 0,
      highQualityEvidenceCount: 0,
      strongEvidenceCount: 0,
      trustedEvidenceCount: 0,
      highRiskEvidenceCount: 0,
      priorityBoost: 0,
      budgetBoost: 0,
      recommendation: "keep-routed-alternate-source",
    };
    current.routeCount += 1;
    if (route.original_source_key && !current.originalSources.includes(route.original_source_key)) current.originalSources.push(route.original_source_key);
    if (route.target && !current.targets.includes(route.target)) current.targets.push(route.target);
    current.evidenceCount += Number(route.evidence_count || 0);
    current.qualityScoreSum += Number(route.quality_score_sum || 0);
    current.qualityScoreCount += Number(route.quality_score_count || 0);
    current.bestQualityScore = Math.max(Number(current.bestQualityScore || 0), bestQualityScore);
    current.averageQualityScore = current.qualityScoreCount
      ? Math.round((current.qualityScoreSum / current.qualityScoreCount) * 10) / 10
      : Math.max(Number(current.averageQualityScore || 0), averageQualityScore);
    current.highQualityEvidenceCount += Number(route.high_quality_evidence_count || 0);
    current.strongEvidenceCount += Number(route.strong_evidence_count || 0);
    current.trustedEvidenceCount += Number(route.trusted_evidence_count || 0);
    current.highRiskEvidenceCount += Number(route.high_risk_evidence_count || 0);
    current.qualityReasons = [...new Set([
      ...current.qualityReasons,
      ...(route.quality_reasons || []),
    ])].slice(0, 16);
    current.failureReasons = [...new Set([
      ...current.failureReasons,
      ...(route.failure_reasons || []),
    ])].slice(0, 16);
    current.lowDepthUrls = [...new Set([
      ...current.lowDepthUrls,
      ...(route.low_depth_urls || []),
    ])].slice(0, 12);
    current.lowDepthCommentUrls = [...new Set([
      ...current.lowDepthCommentUrls,
      ...(route.low_depth_comment_urls || []),
    ])].slice(0, 12);
    current.routedKeywords = [...new Set([
      ...current.routedKeywords,
      ...(route.routed_keywords || []),
    ])].slice(0, 16);
    current.sampleEvidenceUrls = [...new Set([
      ...current.sampleEvidenceUrls,
      ...(route.sample_evidence_urls || []),
    ])].slice(0, 8);
    const qualityBoost = current.bestQualityScore >= 75 ? 10 : current.bestQualityScore >= 55 ? 6 : 2;
    const trustBoost = Math.min(4, current.trustedEvidenceCount * 2);
    const riskBoost = Math.min(4, current.highRiskEvidenceCount * 2);
    current.priorityBoost = Math.min(30, 8 + current.routeCount * 3 + Math.min(8, current.evidenceCount * 2) + qualityBoost + trustBoost + riskBoost);
    current.budgetBoost = Math.min(0.3, 0.06 + current.routeCount * 0.03 + (current.bestQualityScore >= 75 ? 0.12 : current.bestQualityScore >= 55 ? 0.08 : 0.02));
    if (current.bestQualityScore >= 75 || current.strongEvidenceCount > 0 || route.recommendation === "promote-routed-alternate-source") {
      current.recommendation = "promote-routed-alternate-source";
    }
    out[sourceKey] = current;
  }
  return out;
}

export function deriveCollectionOperationsRemediationSourceSignals(effectiveness = {}) {
  const out = {};
  for (const target of Array.isArray(effectiveness.targets) ? effectiveness.targets : []) {
    const sourceKey = String(target.target_source_key || "").trim();
    if (!sourceKey || Number(target.evidence_count || 0) <= 0) continue;
    const bestQualityScore = Number(target.best_quality_score || 0);
    const averageQualityScore = Number(target.average_quality_score || 0);
    if (bestQualityScore < 35 && averageQualityScore < 35) continue;
    const current = out[sourceKey] || {
      sourceKey,
      compensatedSources: [],
      evidenceCount: 0,
      queryTerms: [],
      sampleEvidenceUrls: [],
      qualityReasons: [],
      bestQualityScore: 0,
      averageQualityScore: 0,
      qualityScoreSum: 0,
      qualityScoreCount: 0,
      highQualityEvidenceCount: 0,
      strongEvidenceCount: 0,
      trustedEvidenceCount: 0,
      highRiskEvidenceCount: 0,
      originalEvidenceCount: 0,
      priorityBoost: 0,
      budgetBoost: 0,
      recommendation: "keep-remediation-source",
    };
    if (target.original_source_key && !current.compensatedSources.includes(target.original_source_key)) {
      current.compensatedSources.push(target.original_source_key);
    }
    current.evidenceCount += Number(target.evidence_count || 0);
    current.qualityScoreSum += Number(target.quality_score_sum || 0);
    current.qualityScoreCount += Number(target.quality_score_count || 0);
    current.bestQualityScore = Math.max(Number(current.bestQualityScore || 0), bestQualityScore);
    current.averageQualityScore = current.qualityScoreCount
      ? Math.round((current.qualityScoreSum / current.qualityScoreCount) * 10) / 10
      : Math.max(Number(current.averageQualityScore || 0), averageQualityScore);
    current.highQualityEvidenceCount += Number(target.high_quality_evidence_count || 0);
    current.strongEvidenceCount += Number(target.strong_evidence_count || 0);
    current.trustedEvidenceCount += Number(target.trusted_evidence_count || 0);
    current.highRiskEvidenceCount += Number(target.high_risk_evidence_count || 0);
    current.originalEvidenceCount += Number(target.original_evidence_count || 0);
    current.qualityReasons = [...new Set([
      ...current.qualityReasons,
      ...(target.quality_reasons || []),
    ])].slice(0, 16);
    current.queryTerms = [...new Set([
      ...current.queryTerms,
      ...(target.query_terms || []),
    ])].slice(0, 16);
    current.sampleEvidenceUrls = [...new Set([
      ...current.sampleEvidenceUrls,
      ...(target.sample_evidence_urls || []),
    ])].slice(0, 8);
    const qualityBoost = current.bestQualityScore >= 75 ? 10 : current.bestQualityScore >= 55 ? 6 : 2;
    const trustBoost = Math.min(4, current.trustedEvidenceCount * 2);
    const riskBoost = Math.min(4, current.highRiskEvidenceCount * 2);
    current.priorityBoost = Math.min(30, 8 + current.compensatedSources.length * 3 + Math.min(8, current.evidenceCount * 2) + qualityBoost + trustBoost + riskBoost);
    current.budgetBoost = Math.min(0.3, 0.06 + current.compensatedSources.length * 0.03 + (current.bestQualityScore >= 75 ? 0.12 : current.bestQualityScore >= 55 ? 0.08 : 0.02));
    if (current.bestQualityScore >= 75 || current.strongEvidenceCount > 0) current.recommendation = "promote-remediation-source";
    out[sourceKey] = current;
  }
  return out;
}

export function deriveMultilingualQuerySourceSignals(report = {}) {
  const signals = new Map();
  for (const query of Array.isArray(report.queries) ? report.queries : []) {
    const recommendation = String(query.recommendation || "");
    const score = Number(query.score || 0);
    const evidenceCount = Number(query.evidence_count || 0);
    const highRiskCount = Number(query.high_risk_count || 0);
    const zeroRate = Number(query.zero_result_rate || 0);
    const failureRate = Number(query.failure_rate || 0);
    if (score < 35 && highRiskCount <= 0 && recommendation !== "suppress-or-tighten-multilingual-query") continue;
    for (const sourceKey of uniqueExpansionTerms(query.source_keys || [], 20)) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const current = signals.get(key) || {
        sourceKey: key,
        score: 0,
        priorityBoost: 0,
        queryCount: 0,
        evidenceCount: 0,
        highRiskCount: 0,
        locales: [],
        suggestedKeywords: [],
        suppressedKeywords: [],
        recommendations: [],
        maxZeroResultRate: 0,
        maxFailureRate: 0,
      };
      const shouldPromote = recommendation === "promote-multilingual-query" || highRiskCount > 0 || (score >= 68 && evidenceCount > 0);
      const shouldSuppress = recommendation === "suppress-or-tighten-multilingual-query" || zeroRate >= 70 || failureRate >= 45;
      let boost = 0;
      if (shouldPromote) boost = Math.min(22, 10 + Math.min(8, evidenceCount * 2) + Math.min(8, highRiskCount * 4));
      else if (recommendation === "keep-multilingual-query") boost = Math.min(12, 4 + Math.min(8, evidenceCount * 2));
      else if (shouldSuppress) boost = -Math.min(14, 6 + Math.max(zeroRate, failureRate) / 12);
      current.score = Math.max(Number(current.score || 0), score);
      current.priorityBoost += boost;
      current.queryCount += 1;
      current.evidenceCount += evidenceCount;
      current.highRiskCount += highRiskCount;
      current.maxZeroResultRate = Math.max(Number(current.maxZeroResultRate || 0), zeroRate);
      current.maxFailureRate = Math.max(Number(current.maxFailureRate || 0), failureRate);
      if (query.locale && !current.locales.includes(query.locale)) current.locales.push(query.locale);
      if (recommendation && !current.recommendations.includes(recommendation)) current.recommendations.push(recommendation);
      if (shouldPromote && query.keyword && !current.suggestedKeywords.includes(query.keyword)) current.suggestedKeywords.push(query.keyword);
      if (shouldSuppress && query.keyword && !current.suppressedKeywords.includes(query.keyword)) current.suppressedKeywords.push(query.keyword);
      current.suggestedKeywords = current.suggestedKeywords.slice(0, 12);
      current.suppressedKeywords = current.suppressedKeywords.slice(0, 12);
      signals.set(key, current);
    }
  }
  return Object.fromEntries([...signals.entries()]
    .map(([key, signal]) => [key, {
      ...signal,
      priorityBoost: Math.max(-18, Math.min(28, Math.round(Number(signal.priorityBoost || 0)))),
      locales: signal.locales.slice(0, 8),
      recommendations: signal.recommendations.slice(0, 8),
    }])
    .sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function deriveDiscoveryDeepCrawlPlanSignal({ minScore = 65, targetLimit = 3 } = {}) {
  const discovery = listSentimentSourceDiscoveryCandidates({ days: 14, limit: 80 });
  const candidates = (discovery.candidates || [])
    .filter(candidate => ["rss-feed", "sitemap", "robots-sitemap", "author-profile"].includes(candidate.candidate_type))
    .filter(candidate => Number(candidate.score || 0) >= Math.max(0, Math.min(100, Number(minScore) || 65)));
  const eventClusterReport = getSentimentEventClusterAnalysisReport({ limit: 80 });
  const eventClusterCandidates = (eventClusterReport.clusters || [])
    .filter(cluster => cluster.likely_origin?.url)
    .filter(cluster => Number(cluster.event_count || 0) >= 2
      || Number(cluster.edge_count || 0) > 0
      || Number(cluster.item_count || 0) >= 2
      || (cluster.platforms || []).length >= 2
      || Number(cluster.propagation_path_score || 0) >= 35
      || Number(cluster.explicit_reference_edge_count || cluster.explicit_reference_profile?.explicit_reference_edge_count || 0) > 0
      || (cluster.evidence_gaps || []).includes("explicit-reference-needs-independent-confirmation"))
    .slice(0, 8);
  const officialTierCandidates = candidates.filter(candidate => (candidate.source_weight_tiers || [])
    .some(tier => ["regulatory", "official-consumer-protection", "regulatory-alert"].includes(String(tier || "").toLowerCase())));
  const regulatoryAlertCandidates = candidates.filter(candidate => (candidate.source_weight_tiers || [])
    .some(tier => String(tier || "").toLowerCase() === "regulatory-alert"));
  const suggestedKeywords = normalizeSentimentMonitorKeywords([
    ...candidates.flatMap(candidate => {
    const text = [
      candidate.label,
      ...(candidate.example_titles || []),
      candidate.host,
    ].join(" ");
    return [
      ...text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g),
      ...text.matchAll(/[\u4e00-\u9fff]{2,12}/g),
    ].map(match => match[0]);
    }),
    ...eventClusterCandidates.flatMap(cluster => [cluster.keyword, cluster.label, cluster.likely_origin?.title]),
  ]).slice(0, 20);
  const byType = candidates.reduce((acc, candidate) => {
    const key = candidate.candidate_type || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  if (eventClusterCandidates.length) byType["event-cluster-followup"] = eventClusterCandidates.length;
  const highestScore = Math.max(
    candidates.reduce((max, candidate) => Math.max(max, Number(candidate.score || 0)), 0),
    eventClusterCandidates.reduce((max, cluster) => Math.max(max, Number(cluster.propagation_path_score || 0), Number(cluster.tracking_priority || 0)), 0),
  );
  const recommendedFollowupLimit = regulatoryAlertCandidates.length ? 2 : officialTierCandidates.length ? 1 : 0;
  return {
    should_execute: candidates.length > 0 || eventClusterCandidates.length > 0,
    candidate_count: candidates.length + eventClusterCandidates.length,
    official_or_regulatory_candidate_count: officialTierCandidates.length,
    regulatory_alert_candidate_count: regulatoryAlertCandidates.length,
    event_cluster_candidate_count: eventClusterCandidates.length,
    highest_score: highestScore,
    candidate_types: byType,
    target_limit: Math.max(1, Math.min(10, Number(targetLimit) || 3)),
    recommended_followup_limit: recommendedFollowupLimit,
    followup_recommendation_reason: recommendedFollowupLimit
      ? regulatoryAlertCandidates.length
        ? "regulatory-alert-source-tier"
        : "official-or-regulatory-source-tier"
      : eventClusterCandidates.length
        ? "event-cluster-followup"
        : "no-official-regulatory-tier",
    min_score: Math.max(0, Math.min(100, Number(minScore) || 65)),
    suggested_keywords: suggestedKeywords,
    top_candidates: candidates.slice(0, 5).map(candidate => ({
      candidate_type: candidate.candidate_type,
      url: candidate.url,
      score: candidate.score,
      evidence_count: candidate.evidence_count,
      source_weight_tiers: candidate.source_weight_tiers || [],
      example_titles: candidate.example_titles || [],
      recommendation: candidate.recommendation,
    })),
    top_event_clusters: eventClusterCandidates.slice(0, 5).map(cluster => ({
      cluster_id: cluster.cluster_id,
      label: cluster.label,
      keyword: cluster.keyword,
      origin_url: cluster.likely_origin?.url || "",
      propagation_path_score: cluster.propagation_path_score,
      explicit_reference_edge_count: cluster.explicit_reference_edge_count || 0,
      evidence_gaps: cluster.evidence_gaps || [],
    })),
  };
}

export function deriveCredibilitySourceSignals(report = {}) {
  const out = {};
  for (const item of report.sources || []) {
    const sourceKey = String(item.source_key || "");
    if (!sourceKey) continue;
    const score = Number(item.credibility_score || 0);
    const tierScore = Number(item.source_tier_score || 0);
    const label = String(item.credibility_label || "");
    const originProfile = item.content_origin_profile || {};
    const originalityRate = Number(originProfile.originality_rate || 0);
    const repostRate = Number(originProfile.repost_rate || 0);
    const crossPlatformReposts = Number(originProfile.cross_platform_repost_count || 0);
    const contentOriginLabel = String(originProfile.label || "");
    let priorityBoost = 0;
    if (label === "high-trust" || score >= 82) priorityBoost += 18;
    else if (label === "trusted" || score >= 68) priorityBoost += 12;
    else if (label === "low-trust" || score < 38) priorityBoost -= 14;
    else if (label === "weak" || score < 52) priorityBoost -= 8;
    if (tierScore >= 80) priorityBoost += 16;
    else if (tierScore >= 68) priorityBoost += 4;
    if (contentOriginLabel === "origin-heavy-source" || (originalityRate >= 70 && Number(originProfile.raw_count || 0) >= 3)) priorityBoost += 8;
    if (contentOriginLabel === "repost-heavy-source" || repostRate >= 50) priorityBoost -= 12;
    if (crossPlatformReposts > 0) priorityBoost -= Math.min(8, crossPlatformReposts * 2);
    if (Number(item.unsupported_high_risk_claims || 0) > 0) priorityBoost -= Math.min(12, Number(item.unsupported_high_risk_claims || 0) * 4);
    if (Number(item.coordinated_signal_count || 0) > 0) priorityBoost -= Math.min(10, Number(item.coordinated_max_score || 0) / 10);
    out[sourceKey] = {
      sourceKey,
      score,
      label,
      sourceTierScore: tierScore,
      priorityBoost: Math.max(-25, Math.min(30, Math.round(priorityBoost))),
      reasons: item.reasons || [],
      recommendation: item.recommendation || "",
      sourceWeightTiers: item.source_weight_tiers || [],
      targetProfiles: item.target_profiles || [],
      unsupportedHighRiskClaims: Number(item.unsupported_high_risk_claims || 0),
      coordinatedSignalCount: Number(item.coordinated_signal_count || 0),
      contentOriginProfile: {
        rawCount: Number(originProfile.raw_count || 0),
        originCount: Number(originProfile.origin_count || 0),
        repostCount: Number(originProfile.repost_count || 0),
        originalityRate,
        repostRate,
        crossPlatformRepostCount: crossPlatformReposts,
        label: contentOriginLabel,
        originalityBonus: Number(originProfile.originality_bonus || 0),
        repostPenalty: Number(originProfile.repost_penalty || 0),
      },
    };
  }
  return out;
}

export function deriveCredibilityPrecisionPolicy(signal = {}) {
  if (!signal || !Object.keys(signal).length) {
    return { queryStrategy: "", contentControls: {}, reason: "" };
  }
  const score = Number(signal.score || 0);
  const tierScore = Number(signal.sourceTierScore || 0);
  const label = String(signal.label || "");
  const unsupported = Number(signal.unsupportedHighRiskClaims || 0);
  const coordinated = Number(signal.coordinatedSignalCount || 0);
  const originProfile = signal.contentOriginProfile || {};
  const repostRate = Number(originProfile.repostRate || 0);
  const crossPlatformReposts = Number(originProfile.crossPlatformRepostCount || 0);
  const originHeavy = originProfile.label === "origin-heavy-source" || Number(originProfile.originalityRate || 0) >= 70;
  const reasons = new Set(Array.isArray(signal.reasons) ? signal.reasons : []);

  if (unsupported > 0 || (!originHeavy && coordinated > 0) || repostRate >= 55 || crossPlatformReposts >= 2 || label === "low-trust" || score < 45) {
    return {
      queryStrategy: "require-entity-and-risk-term",
      contentControls: {
        minRelevanceScore: 50,
        minQualityScore: 45,
      },
      reason: unsupported > 0
        ? "unsupported-high-risk-claims"
        : repostRate >= 55 || crossPlatformReposts >= 2
            ? "repost-heavy-source"
            : coordinated > 0
              ? "coordinated-amplification-risk"
              : "low-source-credibility",
    };
  }
  if (tierScore >= 80 || reasons.has("high-authority-source-tier") || originHeavy || reasons.has("origin-heavy-source")) {
    return {
      queryStrategy: "expand-pages",
      contentControls: {},
      reason: reasons.has("origin-heavy-source") && tierScore < 80 ? "origin-heavy-source" : "high-authority-source-tier",
    };
  }
  if (label === "weak" || score < 55) {
    return {
      queryStrategy: "thin-risk-first",
      contentControls: {
        minRelevanceScore: 42,
        minQualityScore: 38,
      },
      reason: "weak-source-credibility",
    };
  }
  if (label === "high-trust" || label === "trusted" || score >= 68) {
    return {
      queryStrategy: "normal",
      contentControls: {},
      reason: "trusted-source-credibility",
    };
  }
  return { queryStrategy: "", contentControls: {}, reason: "" };
}

export function planSentimentContinuousCollection({
  mode = SCAN_MODE_FAST,
  searchSettings = null,
  maxSources = 8,
  retryLimit = 20,
  now = Date.now(),
} = {}) {
  const search = readSentimentSearchSettings(
    typeof searchSettings === "function" ? searchSettings() : searchSettings
  );
  const qualityDays = search?.collectionQualityFeedback?.days || 14;
  const configuredSources = new Set(search.sources || []);
  const sources = listSentimentSources()
    .filter(source => !configuredSources.size || configuredSources.has(source.source_key));
  const schedule = listSentimentSourceSchedule({ now, sources });
  const coverageSignals = deriveCoverageSourceSignals(listSentimentSourceCoverageScores({ days: 7, limit: 300, now }));
  const spreadGraph = buildSentimentSpreadGraph({ limit: 100 });
  const trackingSignals = deriveTrackingSourceSignals(spreadGraph.nodes || []);
  const propagationConfidenceSignals = derivePropagationConfidenceSourceSignals(spreadGraph.nodes || []);
  const alertEventSignals = deriveAlertEventUrgencySourceSignals({
    alerts: listSentimentAlerts({ status: "open", limit: 50 }),
    events: listSentimentEvents({ status: "open", limit: 50 }),
  });
  const anomalySignals = deriveAnomalyBurstSourceSignals(listSentimentAnomalies({ status: "open", limit: 50 }), { now });
  const realtimeAnomalyWindowReport = listSentimentRealtimeAnomalyWindows({
    windows: [0.083, 0.25, 1, 6, 24],
    limit: 80,
    minScore: 35,
    now,
  });
  const realtimeAnomalyWindowSignals = deriveRealtimeAnomalyWindowSourceSignals(realtimeAnomalyWindowReport);
  const realtimeHotTopicReport = listSentimentRealtimeHotTopics({ lookbackHours: 6, limit: 50, now });
  const realtimeHotTopicSignals = deriveRealtimeHotTopicSourceSignals(realtimeHotTopicReport);
  const officialRegulatoryFollowupSignals = deriveOfficialRegulatoryFollowupSourceSignals({ days: 14, limit: 120 });
  const evidenceGapSignals = deriveEvidenceCompletenessSourceSignals(listCrisisBriefs({ limit: 20 }));
  const evidenceDepthReport = listSentimentEvidenceDepthReport({ days: 14, limit: 200 });
  const evidenceDepthSignals = deriveEvidenceDepthSourceSignals(evidenceDepthReport);
  const evidenceCoverageRecoveryReport = getSentimentEvidenceCoverageFollowupRecoveryReport({ days: qualityDays, limit: 100 });
  const evidenceCoverageRecoverySignals = deriveEvidenceCoverageRecoverySourceSignals(evidenceCoverageRecoveryReport);
  const taiwanPrioritySiteHealthReport = getSentimentTaiwanMediaSourceHealthReport({
    configuredPacks: listPublicRssFeedPacks(),
    limit: 100,
  });
  const taiwanPrioritySiteHealthSignals = deriveTaiwanPrioritySiteHealthSourceSignals(taiwanPrioritySiteHealthReport);
  const evidenceChainGapReport = listSentimentEvidenceChainGapReport({ days: qualityDays, limit: 100, minGapScore: 20 });
  const evidenceChainGapSignals = deriveEvidenceChainGapSourceSignals(evidenceChainGapReport);
  const retryPlan = listSentimentCollectionJobRetryPlan({ limit: retryLimit, now });
  const reliability = new Map(
    (listSentimentSourceReliabilityReport({ days: 14, limit: 300 }).sources || [])
      .map(item => [item.source_key, item])
  );
  const sourceQualitySignals = deriveSourceQualitySignals(listSentimentSourceQualityProfiles({
    days: qualityDays,
    limit: 300,
  }));
  const noiseSuppressionReport = listSentimentNoiseSuppressionReport({
    days: qualityDays,
    limit: 100,
    minSamples: 2,
  });
  const noiseSuppressionSignals = deriveNoiseSuppressionSourceSignals(noiseSuppressionReport);
  const credibilitySignals = deriveCredibilitySourceSignals(getSentimentSourceCredibilityReport({ days: 30, limit: 300 }));
  const retryBySource = new Map();
  for (const item of retryPlan.jobs || []) {
    const key = item.job?.source_key;
    if (!key) continue;
    const entry = retryBySource.get(key) || { total: 0, due: 0, highest: 0 };
    entry.total += 1;
    if (item.due) entry.due += 1;
    entry.highest = Math.max(entry.highest, Number(item.priority_score || 0));
    retryBySource.set(key, entry);
  }
  const entityTopicRecall = search?.monitoredEntities?.enabled === false
    ? { topics: [] }
    : listSentimentEntityTopicRecallGaps({ search, days: qualityDays, limit: 100 });
  const entityTopicTrend = search?.monitoredEntities?.enabled === false
    ? { topics: [] }
    : listSentimentEntityTopicRecallTrend({
      search,
      days: Math.max(30, Number(qualityDays) || 14),
      bucketDays: 7,
      limit: 100,
    });
  const entityTopicSourceRecall = search?.monitoredEntities?.enabled === false
    ? { sources: [] }
    : listSentimentEntityTopicSourceRecallGaps({
      search,
      days: qualityDays,
      limit: 300,
    });
  const entityTopicSignals = mergeEntityTopicSourceRecallSignals(
    deriveEntityTopicSourceSignals(mergeEntityTopicRecallSignals(entityTopicRecall, entityTopicTrend)),
    entityTopicSourceRecall,
  );
  const keywordFamilyCoverage = listSentimentKeywordSourceFamilyCoverage({
    days: qualityDays,
    limit: 100,
    minTotal: 1,
    search,
  });
  const keywordFamilyCoverageSignals = deriveKeywordSourceFamilyCoverageSignals(keywordFamilyCoverage);
  const commercialPlan = getSentimentCommercialRemediationPlan({ days: qualityDays, limit: 100, now });
  const commercialSignals = deriveCommercialReadinessSourceSignals(commercialPlan);
  const commercialGovernance = getSentimentCommercialPolicyGovernanceReport({ limit: 100 });
  const commercialGovernanceSignals = deriveCommercialPostScanGovernanceSourceSignals(commercialGovernance);
  const realtimeLatencyReport = getSentimentRealtimeDiscoveryLatencyReport({ searchSettings: search, days: 7, limit: 500, now });
  const realtimeLatencySignals = deriveRealtimeDiscoveryLatencySourceSignals(realtimeLatencyReport);
  const realtimeCoverageReport = getSentimentRealtimeSourceCoverageReport({
    lookbackHours: 6,
    limit: 80,
    minScore: 38,
    now,
    searchSettings: search,
  });
  const realtimeCoverageSignals = deriveRealtimeSourceCoverageSignals(realtimeCoverageReport);
  const socialFollowupSignals = deriveSocialFollowupSourceSignals(listSentimentSocialFollowupSignals({
    days: qualityDays,
    limit: 100,
    minScore: 25,
  }));
  const eventClusterReport = getSentimentEventClusterAnalysisReport({ limit: 100 });
  const eventClusterSignals = deriveEventClusterSourceSignals(eventClusterReport);
  const accessBarrierAlternateSignals = deriveAccessBarrierAlternateSourceSignals(listAccessBarrierAlternateRecoveryEffectiveness({
    days: qualityDays,
    limit: 100,
  }));
  const evidenceCoverageRoutedAlternateSignals = deriveEvidenceCoverageRoutedAlternateSourceSignals(getSentimentEvidenceCoverageRoutedAlternateEffectivenessReport({
    days: qualityDays,
    limit: 100,
  }));
  const collectionOperationsRemediationSignals = deriveCollectionOperationsRemediationSourceSignals(listSentimentCollectionOperationsRemediationEffectiveness({
    days: qualityDays,
    limit: 100,
  }));
  const multilingualQueryQuality = listSentimentMultilingualQueryQuality({
    days: qualityDays,
    limit: 100,
    minSamples: 1,
  });
  const multilingualQuerySignals = deriveMultilingualQuerySourceSignals(multilingualQueryQuality);
  const freeSourceTargetCoverage = getSentimentFreeSourceTargetCoverageReport({ searchSettings: search, limit: 100 });
  const freeSourceTargetCoverageSignals = deriveFreeSourceTargetCoverageSignals(freeSourceTargetCoverage);
  const discoveryDeepCrawl = deriveDiscoveryDeepCrawlPlanSignal({ minScore: 65, targetLimit: mode === SCAN_MODE_FULL ? 5 : 3 });
  const sourcesPlan = schedule.map(item => {
    const retryStats = retryBySource.get(item.source_key) || { total: 0, due: 0, highest: 0 };
    const planned = {
      ...item,
      mode: normalizeSentimentScanMode(mode),
      retry_job_count: retryStats.total,
      retry_due_count: retryStats.due,
      retry_highest_priority_score: retryStats.highest,
      tracking_signal: trackingSignals[item.source_key] || null,
      propagation_confidence_signal: propagationConfidenceSignals[item.source_key] || null,
      alert_event_signal: alertEventSignals[item.source_key] || null,
      anomaly_signal: anomalySignals[item.source_key] || null,
      realtime_anomaly_window_signal: realtimeAnomalyWindowSignals[item.source_key] || null,
      realtime_hot_topic_signal: realtimeHotTopicSignals[item.source_key] || null,
      official_regulatory_followup_signal: officialRegulatoryFollowupSignals[item.source_key] || null,
      evidence_gap_signal: evidenceGapSignals[item.source_key] || null,
      evidence_depth_signal: evidenceDepthSignals[item.source_key] || null,
      evidence_coverage_recovery_signal: evidenceCoverageRecoverySignals[item.source_key] || null,
      taiwan_priority_site_health_signal: taiwanPrioritySiteHealthSignals[item.source_key] || null,
      evidence_chain_gap_signal: evidenceChainGapSignals[item.source_key] || null,
      realtime_latency_signal: realtimeLatencySignals[item.source_key] || null,
      realtime_source_coverage_signal: realtimeCoverageSignals[item.source_key] || null,
      social_followup_signal: socialFollowupSignals[item.source_key] || null,
      event_cluster_signal: eventClusterSignals[item.source_key] || null,
      access_barrier_alternate_signal: accessBarrierAlternateSignals[item.source_key] || null,
      evidence_coverage_routed_alternate_signal: evidenceCoverageRoutedAlternateSignals[item.source_key] || null,
      collection_operations_remediation_signal: collectionOperationsRemediationSignals[item.source_key] || null,
      multilingual_query_signal: multilingualQuerySignals[item.source_key] || null,
      free_source_target_coverage_signal: freeSourceTargetCoverageSignals[item.source_key] || null,
      commercial_signal: commercialSignals[item.source_key] || null,
      commercial_governance_signal: commercialGovernanceSignals[item.source_key] || null,
      credibility_signal: credibilitySignals[item.source_key] || null,
      source_quality_signal: sourceQualitySignals[item.source_key] || null,
      noise_suppression_signal: noiseSuppressionSignals[item.source_key] || null,
      coverage_signal: coverageSignals[item.source_key] || null,
      entity_topic_signal: entityTopicSignals[item.source_key] || null,
      keyword_family_coverage_signal: keywordFamilyCoverageSignals[item.source_key] || null,
      reliability: reliability.get(item.source_key) || null,
    };
    const priority = continuousCollectionPriority(planned);
    const action = continuousCollectionAction(planned);
    return {
      ...planned,
      action,
      should_scan: action === "scan-due-source" || action === "scan-alert-event-source" || action === "scan-realtime-anomaly-window-source" || action === "scan-realtime-hot-topic-source" || action === "scan-burst-source" || action === "scan-official-regulatory-followup-source" || action === "scan-realtime-latency-source" || action === "scan-realtime-coverage-source" || action === "scan-social-followup-source" || action === "scan-multilingual-query-source" || action === "scan-free-source-target-coverage-source" || action === "scan-collection-operations-remediation-source" || action === "scan-access-barrier-alternate-source" || action === "scan-evidence-coverage-routed-alternate-source" || action === "scan-event-cluster-source" || action === "scan-propagation-confidence-source" || action === "scan-keyword-family-coverage-source" || action === "scan-taiwan-priority-site-health-source" || action === "scan-evidence-chain-source" || action === "scan-evidence-depth-source" || action === "scan-evidence-coverage-recovery-source" || action === "scan-commercial-benchmark-source" || action === "scan-commercial-governance-source" || action === "scan-trusted-source",
      ...priority,
    };
  }).sort((a, b) => b.priority_score - a.priority_score
    || (a.waiting_ms || 0) - (b.waiting_ms || 0)
    || a.source_key.localeCompare(b.source_key));
  const readyScanSources = sourcesPlan
    .filter(item => item.should_scan && item.enabled !== false && !["disabled", "cooldown", "throttled"].includes(item.status))
    .slice(0, Math.max(1, Math.min(50, Number(maxSources) || 8)))
    .map(item => item.source_key);
  return {
    ok: true,
    mode: normalizeSentimentScanMode(mode),
    generated_at: new Date(now).toISOString(),
    max_sources: Math.max(1, Math.min(50, Number(maxSources) || 8)),
    summary: {
      total_sources: sourcesPlan.length,
      ready_scan_sources: readyScanSources.length,
      retry_due_jobs: Number(retryPlan.summary?.due || 0),
      waiting_sources: sourcesPlan.filter(item => item.status === "waiting").length,
      cooldown_sources: sourcesPlan.filter(item => item.status === "cooldown").length,
      throttled_sources: sourcesPlan.filter(item => item.status === "throttled").length,
      disabled_sources: sourcesPlan.filter(item => item.status === "disabled").length,
      propagation_signal_sources: Object.keys(trackingSignals).length,
      highest_propagation_path_score: Number(spreadGraph.summary?.highest_propagation_path_score || 0),
      propagation_confidence_signal_sources: Object.keys(propagationConfidenceSignals).length,
      propagation_confidence_explicit_reference_sources: Object.values(propagationConfidenceSignals).filter(item => item.explicitReferenceChain).length,
      lowest_propagation_confidence_score: Object.keys(propagationConfidenceSignals).length
        ? Math.min(...Object.values(propagationConfidenceSignals).map(item => Number(item.minConfidenceScore || 100)))
        : 100,
      entity_topic_signal_sources: Object.keys(entityTopicSignals).length,
      keyword_family_coverage_signal_sources: Object.keys(keywordFamilyCoverageSignals).length,
      keyword_family_coverage_gap_count: keywordFamilyCoverage.summary?.gap_count ?? null,
      keyword_family_coverage_weak_topics: keywordFamilyCoverage.summary?.weak_family_topics ?? null,
      keyword_family_coverage_thin_topics: keywordFamilyCoverage.summary?.thin_family_topics ?? null,
      alert_event_signal_sources: Object.keys(alertEventSignals).length,
      highest_alert_event_score: Math.max(0, ...Object.values(alertEventSignals).map(item => Number(item.score || 0))),
      anomaly_signal_sources: Object.keys(anomalySignals).length,
      highest_anomaly_burst_score: Math.max(0, ...Object.values(anomalySignals).map(item => Number(item.maxAnomalyScore || 0))),
      realtime_anomaly_window_signal_sources: Object.keys(realtimeAnomalyWindowSignals).length,
      realtime_anomaly_window_count: realtimeAnomalyWindowReport.summary?.signal_count ?? null,
      realtime_anomaly_highest_score: realtimeAnomalyWindowReport.summary?.highest_score ?? null,
      realtime_anomaly_sub_hour_signals: realtimeAnomalyWindowReport.summary?.sub_hour_signals ?? null,
      realtime_hot_topic_signal_sources: Object.keys(realtimeHotTopicSignals).length,
      realtime_hot_topic_count: realtimeHotTopicReport.summary?.topic_count ?? null,
      realtime_hot_topic_highest_score: realtimeHotTopicReport.summary?.highest_score ?? null,
      realtime_hot_topic_cross_source_count: realtimeHotTopicReport.summary?.cross_source_hot_topics ?? null,
      official_regulatory_followup_signal_sources: Object.keys(officialRegulatoryFollowupSignals).length,
      official_regulatory_followup_highest_score: Math.max(0, ...Object.values(officialRegulatoryFollowupSignals).map(item => Number(item.score || 0))),
      evidence_gap_signal_sources: Object.keys(evidenceGapSignals).length,
      lowest_evidence_completeness_score: Object.keys(evidenceGapSignals).length
        ? Math.min(...Object.values(evidenceGapSignals).map(item => Number(item.minCompletenessScore || 100)))
        : 100,
      evidence_depth_signal_sources: Object.keys(evidenceDepthSignals).length,
      lowest_evidence_depth_score: Object.keys(evidenceDepthSignals).length
        ? Math.min(...Object.values(evidenceDepthSignals).map(item => Number(item.minDepthScore || 100)))
        : 100,
      evidence_coverage_recovery_signal_sources: Object.keys(evidenceCoverageRecoverySignals).length,
      evidence_coverage_recovery_unrecovered_sources: Object.values(evidenceCoverageRecoverySignals).filter(item => (item.recoveryStatuses || []).some(status => ["failed", "no-evidence", "partial-recovered"].includes(status))).length,
      evidence_coverage_recovery_low_depth_domains: evidenceCoverageRecoveryReport.summary?.low_depth_domain_count ?? null,
      taiwan_priority_site_health_signal_sources: Object.keys(taiwanPrioritySiteHealthSignals).length,
      taiwan_priority_site_runtime_warning_sites: taiwanPrioritySiteHealthReport.summary?.runtime_warning_site_count ?? null,
      taiwan_priority_site_indexed_only_sites: taiwanPrioritySiteHealthReport.summary?.indexed_only_site_count ?? null,
      taiwan_priority_site_partial_sites: taiwanPrioritySiteHealthReport.summary?.partial_site_count ?? null,
      taiwan_priority_site_missing_sites: taiwanPrioritySiteHealthReport.summary?.missing_site_count ?? null,
      evidence_chain_gap_signal_sources: Object.keys(evidenceChainGapSignals).length,
      evidence_chain_gap_count: evidenceChainGapReport.summary?.chain_count ?? null,
      evidence_chain_highest_gap_score: evidenceChainGapReport.summary?.highest_gap_score ?? null,
      evidence_chain_missing_official_regulatory: evidenceChainGapReport.summary?.missing_official_regulatory ?? null,
      commercial_signal_sources: Object.keys(commercialSignals).length,
      commercial_governance_signal_sources: Object.keys(commercialGovernanceSignals).length,
      credibility_signal_sources: Object.keys(credibilitySignals).length,
      high_trust_credibility_sources: Object.values(credibilitySignals).filter(item => ["high-trust", "trusted"].includes(item.label)).length,
      source_quality_signal_sources: Object.keys(sourceQualitySignals).length,
      source_quality_repair_sources: Object.values(sourceQualitySignals).filter(item => item.action === "repair-source").length,
      source_quality_backoff_sources: Object.values(sourceQualitySignals).filter(item => item.action === "tighten-filters").length,
      source_quality_promoted_sources: Object.values(sourceQualitySignals).filter(item => item.action === "promote-source").length,
      noise_suppression_signal_sources: Object.keys(noiseSuppressionSignals).length,
      noise_suppression_repair_sources: Object.values(noiseSuppressionSignals).filter(item => item.action === "repair-or-suppress-source").length,
      noise_suppression_backoff_sources: Object.values(noiseSuppressionSignals).filter(item => item.action === "tighten-source").length,
      noise_suppression_suppressed_keywords: Object.values(noiseSuppressionSignals).reduce((sum, item) => sum + (item.suppressedKeywords || []).length, 0),
      noise_duplicate_amplification_rate: noiseSuppressionReport.summary?.duplicate_amplification_rate ?? null,
      realtime_latency_signal_sources: Object.keys(realtimeLatencySignals).length,
      realtime_discovery_p90_minutes: realtimeLatencyReport.summary?.p90_latency_minutes ?? null,
      realtime_discovery_slow_rate: realtimeLatencyReport.summary?.slow_rate ?? null,
      realtime_source_coverage_signal_sources: Object.keys(realtimeCoverageSignals).length,
      realtime_source_coverage_gap_topics: realtimeCoverageReport.summary?.topic_count ?? null,
      realtime_source_coverage_missing_family_count: realtimeCoverageReport.summary?.missing_family_count ?? null,
      realtime_source_coverage_highest_gap_score: realtimeCoverageReport.summary?.highest_gap_score ?? null,
      social_followup_signal_sources: Object.keys(socialFollowupSignals).length,
      highest_social_followup_score: Math.max(0, ...Object.values(socialFollowupSignals).map(item => Number(item.score || 0))),
      multilingual_query_signal_sources: Object.keys(multilingualQuerySignals).length,
      multilingual_query_effective_count: multilingualQueryQuality.summary?.effective_query_count ?? null,
      multilingual_query_promoted_count: multilingualQueryQuality.summary?.promoted_query_count ?? null,
      multilingual_query_high_risk_count: multilingualQueryQuality.summary?.high_risk_count ?? null,
      free_source_target_coverage_signal_sources: Object.keys(freeSourceTargetCoverageSignals).length,
      free_source_target_coverage_gaps: freeSourceTargetCoverage.summary?.gap_count ?? null,
      free_source_target_lowest_score: freeSourceTargetCoverage.summary?.lowest_coverage_score ?? null,
      access_barrier_alternate_signal_sources: Object.keys(accessBarrierAlternateSignals).length,
      access_barrier_alternate_recovered_targets: Object.values(accessBarrierAlternateSignals).reduce((sum, item) => sum + Number(item.recoveredTargets || 0), 0),
      evidence_coverage_routed_alternate_signal_sources: Object.keys(evidenceCoverageRoutedAlternateSignals).length,
      evidence_coverage_routed_alternate_routes: Object.values(evidenceCoverageRoutedAlternateSignals).reduce((sum, item) => sum + Number(item.routeCount || 0), 0),
      collection_operations_remediation_signal_sources: Object.keys(collectionOperationsRemediationSignals).length,
      collection_operations_remediation_evidence_count: Object.values(collectionOperationsRemediationSignals).reduce((sum, item) => sum + Number(item.evidenceCount || 0), 0),
      event_cluster_signal_sources: Object.keys(eventClusterSignals).length,
      event_cluster_two_hop_signal_sources: Object.values(eventClusterSignals).filter(item => item.twoHopCollection).length,
      event_cluster_explicit_reference_signal_sources: Object.values(eventClusterSignals).filter(item => item.explicitReferenceChain).length,
      event_clusters_with_gaps: eventClusterReport.summary?.clusters_with_gaps ?? null,
      event_clusters_strong_independent_confirmation: eventClusterReport.summary?.strong_independent_confirmation_clusters ?? null,
      event_clusters_useful_independent_confirmation: eventClusterReport.summary?.useful_independent_confirmation_clusters ?? null,
      event_clusters_weak_independent_confirmation: eventClusterReport.summary?.weak_independent_confirmation_clusters ?? null,
      commercial_readiness_level: commercialPlan.summary?.readiness_level || "",
      commercial_readiness_score: commercialPlan.summary?.overall_score ?? null,
      discovery_deep_crawl_candidate_count: discoveryDeepCrawl.candidate_count,
      discovery_deep_crawl_highest_score: discoveryDeepCrawl.highest_score,
    },
    ready_scan_sources: readyScanSources,
    discovery_deep_crawl: discoveryDeepCrawl,
    sources: sourcesPlan,
    retry_plan: retryPlan.summary,
  };
}

function collectionOperationsJobStats(jobs = [], now = Date.now()) {
  const byStatus = {};
  const bySource = new Map();
  const duePending = [];
  const staleRunning = [];
  const retryable = [];
  const terminalFailures = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const status = String(job.status || "unknown");
    const sourceKey = String(job.source_key || "unknown");
    byStatus[status] = (byStatus[status] || 0) + 1;
    const source = bySource.get(sourceKey) || {
      source_key: sourceKey,
      total: 0,
      pending: 0,
      due_pending: 0,
      running: 0,
      stale_running: 0,
      retryable: 0,
      failed: 0,
      partial: 0,
      throttled: 0,
      cooldown: 0,
    };
    source.total += 1;
    if (status === "pending") source.pending += 1;
    if (status === "running") source.running += 1;
    if (status === "failed") source.failed += 1;
    if (status === "partial") source.partial += 1;
    if (status === "throttled") source.throttled += 1;
    if (status === "cooldown") source.cooldown += 1;
    const scheduledMs = new Date(job.scheduled_at || job.created_at || 0).getTime();
    const startedMs = new Date(job.started_at || job.updated_at || job.created_at || 0).getTime();
    const due = status === "pending" && Number.isFinite(scheduledMs) && scheduledMs <= Number(now);
    const stale = status === "running" && Number.isFinite(startedMs) && Number(now) - startedMs > 30 * 60 * 1000;
    const retryableJob = ["failed", "partial", "cooldown", "throttled", "interval"].includes(status)
      && Number(job.attempt_count || 0) < Number(job.max_attempts || 0);
    if (due) {
      source.due_pending += 1;
      duePending.push(job);
    }
    if (stale) {
      source.stale_running += 1;
      staleRunning.push(job);
    }
    if (retryableJob) {
      source.retryable += 1;
      retryable.push(job);
    }
    if (["failed", "partial", "throttled", "cooldown"].includes(status)) terminalFailures.push(job);
    bySource.set(sourceKey, source);
  }
  return {
    byStatus,
    bySource,
    duePending,
    staleRunning,
    retryable,
    terminalFailures,
  };
}

function collectionOperationsSourceStatus(item = {}, jobStats = {}, { now = Date.now(), staleMultiplier = 3 } = {}) {
  const intervalMinutes = Math.max(1, Number(item.scan_interval_minutes || 0) || 1);
  const lastSuccessMs = new Date(item.last_success_at || "").getTime();
  const lastScanMs = new Date(item.last_scan_at || "").getTime();
  const hasSuccess = Number.isFinite(lastSuccessMs);
  const hasScan = Number.isFinite(lastScanMs);
  const ageMinutes = hasSuccess ? Math.floor((Number(now) - lastSuccessMs) / 60000) : null;
  const scanAgeMinutes = hasScan ? Math.floor((Number(now) - lastScanMs) / 60000) : null;
  const staleAfterMinutes = Math.max(intervalMinutes * Math.max(1, Number(staleMultiplier) || 3), item.realtime ? 15 : 60);
  const severelyStaleAfterMinutes = Math.max(staleAfterMinutes * 2, intervalMinutes * 6);
  const issues = [];
  if (item.enabled === false) issues.push("disabled");
  if (item.status === "cooldown") issues.push("source-cooldown");
  if (item.status === "throttled") issues.push("domain-throttle");
  if (item.status === "due") issues.push("due-source");
  if (item.enabled !== false && !hasSuccess) issues.push("no-success-yet");
  if (hasSuccess && ageMinutes > severelyStaleAfterMinutes) issues.push("severely-stale-success");
  else if (hasSuccess && ageMinutes > staleAfterMinutes) issues.push("stale-success");
  if (item.should_scan && !item.due) issues.push("signal-triggered-scan");
  if (Number(jobStats.due_pending || 0) > 0) issues.push("due-pending-jobs");
  if (Number(jobStats.stale_running || 0) > 0) issues.push("stale-running-jobs");
  if (Number(jobStats.retryable || 0) > 0) issues.push("retryable-failures");
  if (item.action === "wait-source-quality-repair") issues.push("quality-repair-needed");
  if (item.action === "wait-source-quality-backoff") issues.push("quality-backoff");
  let health = "healthy";
  if (issues.includes("disabled")) health = "disabled";
  else if (issues.some(issue => ["stale-running-jobs", "severely-stale-success", "no-success-yet"].includes(issue))) health = "critical";
  else if (issues.some(issue => ["due-pending-jobs", "retryable-failures", "stale-success", "source-cooldown", "domain-throttle", "quality-repair-needed"].includes(issue))) health = "degraded";
  else if (issues.length) health = "watch";
  const recommended = [];
  if (issues.includes("due-pending-jobs") || issues.includes("retryable-failures")) recommended.push("execute-due-retry-jobs");
  if (item.should_scan || item.due || issues.includes("stale-success") || issues.includes("no-success-yet")) recommended.push("run-continuous-collection");
  if (issues.includes("quality-repair-needed") || issues.includes("quality-backoff")) recommended.push("review-source-quality-policy");
  if (issues.includes("source-cooldown") || issues.includes("domain-throttle")) recommended.push("respect-backoff-or-switch-alternate-source");
  if (issues.includes("disabled")) recommended.push("review-disabled-source");
  return {
    source_key: item.source_key,
    label: item.label,
    source_type: item.source_type,
    source_family: item.keyword_family_coverage_signal?.families?.[0] || "",
    enabled: item.enabled,
    realtime: item.realtime,
    health,
    issues,
    recommendation: recommended[0] || "keep-monitoring",
    recommended_actions: [...new Set(recommended.length ? recommended : ["keep-monitoring"])],
    action: item.action,
    should_scan: item.should_scan,
    due: item.due,
    status: item.status,
    priority_score: item.priority_score,
    priority_reasons: item.priority_reasons || [],
    scan_interval_minutes: intervalMinutes,
    last_scan_at: item.last_scan_at,
    last_success_at: item.last_success_at,
    last_error: item.last_error,
    age_minutes: ageMinutes,
    scan_age_minutes: scanAgeMinutes,
    stale_after_minutes: staleAfterMinutes,
    waiting_ms: item.waiting_ms || 0,
    next_scan_at: item.next_scan_at,
    job_backlog: {
      total: Number(jobStats.total || 0),
      pending: Number(jobStats.pending || 0),
      due_pending: Number(jobStats.due_pending || 0),
      running: Number(jobStats.running || 0),
      stale_running: Number(jobStats.stale_running || 0),
      retryable: Number(jobStats.retryable || 0),
      failed: Number(jobStats.failed || 0),
      partial: Number(jobStats.partial || 0),
      throttled: Number(jobStats.throttled || 0),
      cooldown: Number(jobStats.cooldown || 0),
    },
  };
}

export function getSentimentCollectionOperationsReport({
  mode = SCAN_MODE_FAST,
  searchSettings = null,
  maxSources = 8,
  retryLimit = 20,
  staleMultiplier = 3,
  now = Date.now(),
} = {}) {
  const plan = planSentimentContinuousCollection({
    mode,
    searchSettings,
    maxSources,
    retryLimit,
    now,
  });
  const jobs = listSentimentCollectionJobs({ limit: 500 });
  const jobStats = collectionOperationsJobStats(jobs, now);
  const sources = (plan.sources || []).map(item => collectionOperationsSourceStatus(
    item,
    jobStats.bySource.get(item.source_key) || {},
    { now, staleMultiplier },
  )).sort((a, b) => {
    const rank = { critical: 0, degraded: 1, watch: 2, healthy: 3, disabled: 4 };
    return (rank[a.health] ?? 9) - (rank[b.health] ?? 9)
      || b.priority_score - a.priority_score
      || a.source_key.localeCompare(b.source_key);
  });
  const actionable = sources.filter(item => !["healthy", "disabled"].includes(item.health));
  const ready = new Set(plan.ready_scan_sources || []);
  const dueRetryJobs = jobStats.duePending.filter(job => String(job.reason || "").includes("retry"));
  return {
    ok: true,
    generated_at: new Date(now).toISOString(),
    mode: plan.mode,
    summary: {
      total_sources: sources.length,
      healthy_sources: sources.filter(item => item.health === "healthy").length,
      watch_sources: sources.filter(item => item.health === "watch").length,
      degraded_sources: sources.filter(item => item.health === "degraded").length,
      critical_sources: sources.filter(item => item.health === "critical").length,
      disabled_sources: sources.filter(item => item.health === "disabled").length,
      ready_scan_sources: plan.summary?.ready_scan_sources || ready.size,
      due_retry_jobs: dueRetryJobs.length,
      due_pending_jobs: jobStats.duePending.length,
      stale_running_jobs: jobStats.staleRunning.length,
      retryable_jobs: jobStats.retryable.length,
      backlog_jobs: jobs.filter(job => ["pending", "running"].includes(String(job.status || ""))).length,
      terminal_failure_jobs: jobStats.terminalFailures.length,
      by_job_status: jobStats.byStatus,
      highest_priority_source: sources[0]?.source_key || "",
      recommended_next_action: dueRetryJobs.length
        ? "execute-due-retry-jobs"
        : ready.size || actionable.some(item => item.recommended_actions.includes("run-continuous-collection"))
          ? "run-continuous-collection"
          : actionable.some(item => item.recommended_actions.includes("review-source-quality-policy"))
            ? "review-source-quality-policy"
            : "keep-monitoring",
    },
    ready_scan_sources: plan.ready_scan_sources || [],
    actionable_sources: actionable.slice(0, 30),
    sources,
    job_backlog: {
      due_pending: jobStats.duePending.slice(0, 30),
      stale_running: jobStats.staleRunning.slice(0, 30),
      retryable: jobStats.retryable.slice(0, 30),
    },
    continuous_plan_summary: plan.summary,
    retry_plan: plan.retry_plan,
  };
}

const COLLECTION_OPERATION_ALTERNATES = {
  youtube: ["browserFallback", "tiktokSearch", "applePodcastSearch", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "openWebDiscovery", "rssFeeds", "ptt", "dcard", "reddit", "publicReviewSites"],
  applePodcastSearch: ["browserFallback", "youtube", "bilibili", "substackSearch", "mediumSearch", "rssFeeds", "googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "reddit"],
  tiktokSearch: ["browserFallback", "youtube", "bilibili", "douyinSearch", "kuaishouSearch", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  ptt: ["browserFallback", "dcard", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds", "youtube"],
  dcard: ["browserFallback", "ptt", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds", "youtube"],
  tiebaSearch: ["browserFallback", "ptt", "dcard", "reddit", "baiduSearch", "baiduNews", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  reddit: ["browserFallback", "xSearch", "facebookSearch", "linkedinSearch", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds", "youtube", "ptt", "dcard"],
  threads: ["browserFallback", "xSearch", "facebookSearch", "linkedinSearch", "mastodon", "bluesky", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds", "youtube"],
  instagram: ["browserFallback", "threads", "xSearch", "facebookSearch", "linkedinSearch", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds", "youtube"],
  xSearch: ["browserFallback", "threads", "instagram", "facebookSearch", "linkedinSearch", "bluesky", "mastodon", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds", "youtube"],
  facebookSearch: ["browserFallback", "xSearch", "linkedinSearch", "threads", "instagram", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds", "youtube"],
  linkedinSearch: ["browserFallback", "xSearch", "facebookSearch", "threads", "instagram", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds", "mediumSearch", "substackSearch"],
  mastodon: ["browserFallback", "bluesky", "threads", "xSearch", "facebookSearch", "linkedinSearch", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds"],
  bluesky: ["browserFallback", "mastodon", "threads", "xSearch", "facebookSearch", "linkedinSearch", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds"],
  telegramPublic: ["browserFallback", "xSearch", "reddit", "threads", "mastodon", "bluesky", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  duckDuckGo: ["browserFallback", "openWebDiscovery", "yandexSearch", "googleNews", "bingNews", "baiduNews", "rssFeeds", "officialOwnedMediaSources", "officialRegulatory", "legalPublicRecords", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "brandImpersonationSources", "securityAdvisorySources", "investorDiscussionSources", "publicStatusPageSources", "gdelt", "youtube", "publicReviewSites", "regionalComplaintSources"],
  openWebDiscovery: ["browserFallback", "duckDuckGo", "yandexSearch", "googleNews", "bingNews", "baiduNews", "rssFeeds", "officialOwnedMediaSources", "officialRegulatory", "legalPublicRecords", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "brandImpersonationSources", "securityAdvisorySources", "investorDiscussionSources", "publicStatusPageSources", "gdelt", "publicReviewSites", "regionalComplaintSources"],
  yandexSearch: ["browserFallback", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds", "gdelt", "officialRegulatory", "legalPublicRecords", "reddit", "substackSearch", "mediumSearch"],
  baiduSearch: ["browserFallback", "baiduNews", "sogouSearch", "soSearch", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery", "gdelt"],
  sogouSearch: ["browserFallback", "baiduSearch", "soSearch", "wechatPublicSearch", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery"],
  soSearch: ["browserFallback", "baiduSearch", "sogouSearch", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery"],
  wechatPublicSearch: ["browserFallback", "sogouSearch", "baiduSearch", "soSearch", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery"],
  toutiaoSearch: ["browserFallback", "baiduNews", "baiduSearch", "sogouSearch", "soSearch", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery"],
  googleNews: ["browserFallback", "bingNews", "baiduNews", "rssFeeds", "officialOwnedMediaSources", "officialRegulatory", "legalPublicRecords", "publicCompanyFilingsSources", "investorDiscussionSources", "publicStatusPageSources", "gdelt", "duckDuckGo", "openWebDiscovery", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"],
  bingNews: ["browserFallback", "googleNews", "baiduNews", "rssFeeds", "officialOwnedMediaSources", "officialRegulatory", "legalPublicRecords", "publicCompanyFilingsSources", "investorDiscussionSources", "publicStatusPageSources", "gdelt", "duckDuckGo", "openWebDiscovery", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"],
  baiduNews: ["browserFallback", "googleNews", "bingNews", "rssFeeds", "officialRegulatory", "gdelt", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"],
  rssFeeds: ["browserFallback", "officialOwnedMediaSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "baiduNews", "gdelt", "duckDuckGo", "openWebDiscovery", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"],
  officialRegulatory: ["browserFallback", "legalPublicRecords", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "securityAdvisorySources", "supplyChainAdvisorySources", "brandImpersonationSources", "rssFeeds", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "openWebDiscovery", "gdelt", "regionalComplaintSources"],
  legalPublicRecords: ["browserFallback", "officialRegulatory", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "securityAdvisorySources", "supplyChainAdvisorySources", "brandImpersonationSources", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds"],
  publicProcurementSources: ["browserFallback", "officialRegulatory", "legalPublicRecords", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "linkedinSearch"],
  publicSanctionsSources: ["browserFallback", "officialRegulatory", "legalPublicRecords", "publicProcurementSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "linkedinSearch"],
  publicProductRecallSources: ["browserFallback", "officialRegulatory", "regionalComplaintSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "legalPublicRecords"],
  publicEnforcementActionSources: ["browserFallback", "officialRegulatory", "legalPublicRecords", "regionalComplaintSources", "publicReviewSites", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "publicProductRecallSources"],
  publicAdvertisingRulingsSources: ["browserFallback", "officialRegulatory", "publicEnforcementActionSources", "legalPublicRecords", "regionalComplaintSources", "publicReviewSites", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "publicRegulatoryWarningLetterSources"],
  publicRegulatoryWarningLetterSources: ["browserFallback", "officialRegulatory", "publicProductRecallSources", "publicEnforcementActionSources", "legalPublicRecords", "regionalComplaintSources", "publicReviewSites", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery"],
  publicCompanyFilingsSources: ["browserFallback", "investorDiscussionSources", "officialRegulatory", "legalPublicRecords", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "linkedinSearch"],
  brandImpersonationSources: ["browserFallback", "securityAdvisorySources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "reddit", "telegramPublic", "xSearch", "officialRegulatory"],
  securityAdvisorySources: ["browserFallback", "supplyChainAdvisorySources", "officialRegulatory", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "githubIssues", "reddit"],
  supplyChainAdvisorySources: ["browserFallback", "securityAdvisorySources", "githubIssues", "gitLabIssues", "googleNews", "bingNews", "rssFeeds", "reddit", "openWebDiscovery"],
  investorDiscussionSources: ["browserFallback", "publicCompanyFilingsSources", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "reddit", "xSearch", "linkedinSearch"],
  publicStatusPageSources: ["browserFallback", "officialOwnedMediaSources", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery", "reddit", "xSearch", "publicReviewSites"],
  officialOwnedMediaSources: ["browserFallback", "rssFeeds", "openWebDiscovery", "duckDuckGo", "googleNews", "bingNews", "publicStatusPageSources", "officialRegulatory"],
  gdelt: ["browserFallback", "googleNews", "bingNews", "baiduNews", "rssFeeds", "officialRegulatory", "duckDuckGo", "openWebDiscovery", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "taiwanNews"],
  yahooTaiwan: ["browserFallback", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery", "taiwanNews"],
  taiwanNews: ["browserFallback", "yahooTaiwan", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery"],
  yahooJapanNews: ["browserFallback", "googleNews", "bingNews", "baiduNews", "rssFeeds", "officialRegulatory", "gdelt", "duckDuckGo", "openWebDiscovery", "yahooTaiwan", "naverKoreaNews", "daumKoreaNews", "taiwanNews"],
  naverKoreaNews: ["browserFallback", "googleNews", "bingNews", "baiduNews", "rssFeeds", "officialRegulatory", "gdelt", "duckDuckGo", "openWebDiscovery", "yahooTaiwan", "yahooJapanNews", "daumKoreaNews", "taiwanNews"],
  daumKoreaNews: ["browserFallback", "googleNews", "bingNews", "baiduNews", "rssFeeds", "officialRegulatory", "gdelt", "duckDuckGo", "openWebDiscovery", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "taiwanNews"],
  publicReviewSites: ["browserFallback", "regionalComplaintSources", "localReviewSources", "employerReviewSources", "googlePlayReviews", "appStoreReviews", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews"],
  regionalComplaintSources: ["browserFallback", "officialRegulatory", "publicReviewSites", "localReviewSources", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "openWebDiscovery", "rssFeeds"],
  appStoreReviews: ["browserFallback", "googlePlayReviews", "publicReviewSites", "localReviewSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews"],
  googlePlayReviews: ["browserFallback", "appStoreReviews", "publicReviewSites", "localReviewSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews"],
  verticalReviewSources: ["browserFallback", "publicReviewSites", "employerReviewSources", "ecommerceReviewSources", "localReviewSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews"],
  employerReviewSources: ["browserFallback", "publicReviewSites", "verticalReviewSources", "localReviewSources", "linkedinSearch", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  ecommerceReviewSources: ["browserFallback", "verticalReviewSources", "publicReviewSites", "employerReviewSources", "localReviewSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews"],
  localReviewSources: ["browserFallback", "publicReviewSites", "regionalComplaintSources", "ecommerceReviewSources", "verticalReviewSources", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  githubIssues: ["browserFallback", "gitLabIssues", "hackerNews", "stackOverflow", "discourseForums", "lemmy", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  gitLabIssues: ["browserFallback", "githubIssues", "hackerNews", "stackOverflow", "discourseForums", "lemmy", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  hackerNews: ["browserFallback", "reddit", "githubIssues", "gitLabIssues", "stackOverflow", "discourseForums", "lemmy", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  stackOverflow: ["browserFallback", "githubIssues", "gitLabIssues", "reddit", "hackerNews", "discourseForums", "lemmy", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  discourseForums: ["browserFallback", "githubIssues", "gitLabIssues", "stackOverflow", "hackerNews", "lemmy", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  lemmy: ["browserFallback", "discourseForums", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "stackOverflow", "mastodon", "bluesky", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "rssFeeds"],
  zhihuSearch: ["browserFallback", "quoraSearch", "reddit", "stackOverflow", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds"],
  quoraSearch: ["browserFallback", "zhihuSearch", "reddit", "lemmy", "duckDuckGo", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds"],
  substackSearch: ["browserFallback", "googleNews", "bingNews", "baiduNews", "rssFeeds", "duckDuckGo", "openWebDiscovery", "quoraSearch", "reddit", "lemmy"],
  mediumSearch: ["browserFallback", "substackSearch", "googleNews", "bingNews", "baiduNews", "rssFeeds", "duckDuckGo", "openWebDiscovery", "quoraSearch", "reddit", "lemmy"],
  wordpressSearch: ["browserFallback", "mediumSearch", "substackSearch", "googleNews", "bingNews", "baiduNews", "rssFeeds", "duckDuckGo", "openWebDiscovery"],
  blogspotSearch: ["browserFallback", "wordpressSearch", "mediumSearch", "substackSearch", "googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery"],
  tumblrSearch: ["browserFallback", "blogspotSearch", "wordpressSearch", "mediumSearch", "substackSearch", "reddit", "lemmy", "threads", "xSearch", "facebookSearch", "linkedinSearch", "mastodon", "bluesky", "duckDuckGo", "openWebDiscovery"],
};

const COLLECTION_OPERATION_SOURCE_HINTS = {
  youtube: "YouTube",
  tiktokSearch: "TikTok",
  ptt: "PTT",
  dcard: "Dcard",
  reddit: "Reddit",
  threads: "Threads",
  instagram: "Instagram",
  xSearch: "X/Twitter",
  facebookSearch: "Facebook",
  linkedinSearch: "LinkedIn",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  googleNews: "新聞",
  bingNews: "新聞",
  baiduNews: "百度 新聞",
  yahooJapanNews: "日本 新聞 Yahoo Japan",
  naverKoreaNews: "韓國 新聞 Naver",
  daumKoreaNews: "韓國 新聞 Daum Kakao",
  rssFeeds: "RSS",
  officialRegulatory: "官方 監管",
  legalPublicRecords: "法律 訴訟 法院",
  publicProcurementSources: "政府採購 合約 招標 中標 USAspending",
  publicSanctionsSources: "OFAC SDN UK Sanctions List OFSI EU sanctions UN Security Council consolidated list financial sanctions asset freeze funds freeze 制裁 黑名單 風險名單",
  publicProductRecallSources: "CPSC openFDA FDA EU Safety Gate RAPEX NHTSA vehicle recall vehicle complaint ODI complaint defect recall fire risk 召回 產品安全 車輛召回 車輛投訴 安全警示",
  publicEnforcementActionSources: "CFPB SEC FTC Federal Trade Commission litigation release administrative proceeding trading suspension 執法 行政處罰 消費者投訴 隱私 詐騙",
  publicAdvertisingRulingsSources: "ASA 廣告裁決 誤導廣告 虛假宣傳",
  publicRegulatoryWarningLetterSources: "FDA warning letters 警告信 CGMP 未批准 摻假",
  publicCompanyFilingsSources: "SEC EDGAR 8-K 10-K 10-Q The Gazette insolvency liquidation winding up strike off 公開披露 破產 清算 註銷",
  brandImpersonationSources: "品牌 仿冒 釣魚 證書",
  securityAdvisorySources: "CVE NVD CISA KEV CISA advisory CISA alert active exploitation emergency directive 漏洞 安全公告",
  supplyChainAdvisorySources: "OSV GHSA 供應鏈 依賴漏洞",
  investorDiscussionSources: "投資者 股價 股票 Stocktwits Yahoo Finance",
  publicStatusPageSources: "Statuspage service status outage incident degraded maintenance",
  officialOwnedMediaSources: "official newsroom company blog press release official statement announcement",
  gdelt: "GDELT",
  duckDuckGo: "搜尋",
  yandexSearch: "Yandex 俄語 搜索",
  openWebDiscovery: "公開網頁",
  publicReviewSites: "投訴 評價",
  regionalComplaintSources: "消費 投訴",
  appStoreReviews: "App Store 評論",
  googlePlayReviews: "Google Play 評論",
  applePodcastSearch: "Apple Podcasts 播客",
  verticalReviewSources: "產品 評價",
  ecommerceReviewSources: "電商 評價",
  localReviewSources: "本地 商家 評價",
};

function collectionOperationSourceTerms(source = {}, keywords = []) {
  const reasonTerms = [];
  for (const reason of source.priority_reasons || []) {
    reasonTerms.push(
      ...(Array.isArray(reason.terms) ? reason.terms : []),
      ...(Array.isArray(reason.keywords) ? reason.keywords : []),
      ...(Array.isArray(reason.suggested_keywords) ? reason.suggested_keywords : []),
      ...(Array.isArray(reason.suggestedKeywords) ? reason.suggestedKeywords : []),
      ...(Array.isArray(reason.topics) ? reason.topics : []),
    );
  }
  return normalizeSentimentMonitorKeywords([
    ...normalizeSentimentMonitorKeywords(keywords || [], ""),
    ...resolveSentimentScanKeywords(getDb()),
    ...reasonTerms,
  ], "").slice(0, 12);
}

function collectionOperationAlternateQueries(source = {}, targetSourceKey = "", keywords = []) {
  const hint = COLLECTION_OPERATION_SOURCE_HINTS[targetSourceKey] || targetSourceKey;
  const terms = collectionOperationSourceTerms(source, keywords);
  return normalizeSentimentMonitorKeywords([
    ...terms,
    ...terms.slice(0, 8).map(term => `${term} ${hint}`),
    source.source_key ? `${source.source_key} unavailable ${hint}` : "",
  ], "").slice(0, 16);
}

function collectionOperationAlternateSourceKeys(source = {}, report = {}, search = {}) {
  const configured = new Set(search.sources || []);
  const candidateKeys = COLLECTION_OPERATION_ALTERNATES[source.source_key] || ["googleNews", "bingNews", "baiduNews", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "duckDuckGo", "yandexSearch", "baiduSearch", "sogouSearch", "soSearch", "rssFeeds", "substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "tumblrSearch", "zhihuSearch", "quoraSearch", "youtube", "tiktokSearch", "xSearch", "facebookSearch", "linkedinSearch", "ptt", "dcard", "publicReviewSites", "localReviewSources"];
  const sourceRows = new Map((report.sources || []).map(item => [item.source_key, item]));
  return candidateKeys
    .filter(key => key !== source.source_key)
    .filter(key => !configured.size || configured.has(key))
    .filter(key => {
      const row = sourceRows.get(key);
      if (!row) return false;
      if (key === "browserFallback" && !browserFallbackAutoEnabled(search, row, [source.source_key], row.config || {})) return false;
      if (row.enabled === false || row.health === "disabled" || row.health === "critical") return false;
      if ((row.issues || []).includes("quality-repair-needed")) return false;
      return true;
    })
    .slice(0, 3);
}

function shouldCreateCollectionOperationBackfill(source = {}) {
  const issues = new Set(source.issues || []);
  return source.health === "critical"
    || issues.has("stale-success")
    || issues.has("severely-stale-success")
    || issues.has("stale-running-jobs")
    || issues.has("no-success-yet")
    || issues.has("source-cooldown")
    || issues.has("domain-throttle");
}

export function planSentimentCollectionOperationsRemediation({
  mode = SCAN_MODE_FAST,
  searchSettings = null,
  maxSources = 8,
  retryLimit = 20,
  staleMultiplier = 3,
  limit = 30,
  keywords = [],
  now = Date.now(),
} = {}) {
  const search = readSentimentSearchSettings(
    typeof searchSettings === "function" ? searchSettings() : searchSettings
  );
  const report = getSentimentCollectionOperationsReport({
    mode,
    searchSettings: search,
    maxSources,
    retryLimit,
    staleMultiplier,
    now,
  });
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const sourceByKey = new Map(listSentimentSources().map(source => [source.source_key, source]));
  const jobs = [];
  for (const source of report.actionable_sources || []) {
    if (!shouldCreateCollectionOperationBackfill(source)) continue;
    const alternates = collectionOperationAlternateSourceKeys(source, report, search);
    for (const targetSourceKey of alternates) {
      const target = sourceByKey.get(targetSourceKey) || {};
      const query = collectionOperationAlternateQueries(source, targetSourceKey, keywords);
      if (!query.length) continue;
      const browserFallbackRecovery = targetSourceKey === "browserFallback"
        ? browserFallbackRecoveryDiagnostics(search, source.source_key, target.config || {})
        : null;
      jobs.push({
        sourceKey: targetSourceKey,
        label: target.label || targetSourceKey,
        reason: "collection-operations-remediation",
        mode: "followup",
        status: "pending",
        priority: Math.max(40, Math.min(100, Number(source.priority_score || 50) + (source.health === "critical" ? 10 : 0))),
        query,
        entity: {
          degraded_source_key: source.source_key,
          degraded_source_label: source.label,
          degraded_health: source.health,
          degraded_issues: source.issues || [],
          monitored_keywords: collectionOperationSourceTerms(source, keywords).slice(0, 12),
        },
        maxAttempts: source.health === "critical" ? 3 : 2,
        scheduledAt: new Date(now).toISOString(),
        metadata: {
          task_type: "collection-operations-remediation",
          original_source_key: source.source_key,
          original_source_health: source.health,
          original_source_issues: source.issues || [],
          remediation_action: "alternate-source-backfill",
          priority_reasons: (source.priority_reasons || []).map(item => item.reason || "").filter(Boolean).slice(0, 8),
          recommended_actions: source.recommended_actions || [],
          ...(browserFallbackRecovery ? { browser_fallback_recovery: browserFallbackRecovery } : {}),
          generated_at: new Date(now).toISOString(),
        },
      });
      if (jobs.length >= safeLimit) break;
    }
    if (jobs.length >= safeLimit) break;
  }
  return {
    ok: true,
    applied: false,
    generated_at: new Date(now).toISOString(),
    summary: {
      actionable_sources: report.actionable_sources?.length || 0,
      critical_sources: report.summary?.critical_sources || 0,
      degraded_sources: report.summary?.degraded_sources || 0,
      due_retry_jobs: report.summary?.due_retry_jobs || 0,
      stale_running_jobs: report.summary?.stale_running_jobs || 0,
      remediation_jobs: jobs.length,
      recommended_next_action: report.summary?.recommended_next_action || "keep-monitoring",
    },
    operations_summary: report.summary,
    jobs,
  };
}

export function applySentimentCollectionOperationsRemediation({
  apply = false,
  mode = SCAN_MODE_FAST,
  searchSettings = null,
  maxSources = 8,
  retryLimit = 20,
  staleMultiplier = 3,
  limit = 30,
  keywords = [],
  operator = "",
  reason = "",
  now = Date.now(),
} = {}) {
  const plan = planSentimentCollectionOperationsRemediation({
    mode,
    searchSettings,
    maxSources,
    retryLimit,
    staleMultiplier,
    limit,
    keywords,
    now,
  });
  const jobs = plan.jobs.map(job => ({
    ...job,
    metadata: {
      ...(job.metadata || {}),
      remediation_operator: String(operator || "").slice(0, 120),
      remediation_reason: String(reason || "").slice(0, 300),
    },
  }));
  const created = apply === true ? createSentimentCollectionJobs({ jobs }) : [];
  return {
    ...plan,
    applied: apply === true,
    created_jobs: created,
    summary: {
      ...plan.summary,
      created_jobs: created.length,
    },
    jobs: apply === true ? created : jobs,
  };
}

export function resetSentimentSourceHealthForTests() {
  sourceHealth.clear();
  domainThrottle.clear();
}

export function summarizeScanFailures(failures, limit = 8) {
  if (!Array.isArray(failures) || failures.length === 0) return [];
  const groups = new Map();
  for (const failure of failures) {
    const source = String(failure?.source || "unknown");
    const reason = compactFailureReason(failure?.message);
    const existing = groups.get(source) || { source, count: 0, reasons: new Map(), examples: [] };
    const count = Number(failure?.count || 1);
    existing.count += count;
    existing.reasons.set(reason, (existing.reasons.get(reason) || 0) + count);
    const example = compactFailureExample(failure?.message);
    if (example && !existing.examples.includes(example) && existing.examples.length < 2) {
      existing.examples.push(example);
    }
    groups.set(source, existing);
  }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(group => ({
      source: group.source,
      count: group.count,
      message: [
        [...group.reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([reason, count]) => `${reason}（${count} 次）`)
          .join("；"),
        group.examples.length ? `例：${group.examples.join("、")}` : "",
      ].filter(Boolean).join("；"),
    }));
}

function sourceExecutionReason(status = "", message = "", diagnostics = null) {
  const diagnosticSummary = diagnostics?.summary || {};
  if (Number(diagnosticSummary.skipped_profile_count || 0) > 0 && Number(diagnosticSummary.runnable_profile_count || 0) === 0) return "browser-auth-expired";
  if (Number(diagnosticSummary.expired_profile_count || 0) > 0 || Number(diagnosticSummary.degraded_profile_count || 0) > 0) return "browser-auth-degraded";
  const normalized = String(status || "").toLowerCase();
  if (normalized === "success") return "executed-success";
  if (normalized === "partial") return "executed-partial";
  if (normalized === "failed") return "executed-failed";
  if (normalized === "blocked") return "external-access-barrier";
  if (normalized === "cooldown") return "source-cooldown";
  if (normalized === "throttled") return "domain-throttled";
  if (normalized === "interval") return "source-interval-not-due";
  if (normalized === "disabled") return "source-disabled";
  if (normalized === "running") return "source-running";
  if (normalized === "pending") return "source-pending";
  if (/來源暫停|cooldown/i.test(message)) return "source-cooldown";
  if (/節流|throttl/i.test(message)) return "domain-throttled";
  if (/間隔|interval/i.test(message)) return "source-interval-not-due";
  return normalized || "unknown";
}

function sourceExecutionRecommendedAction(status = "", message = "", failover = null, diagnostics = null) {
  const reason = sourceExecutionReason(status, message, diagnostics);
  if (failover?.routedTo?.length) return "use-routed-alternate-source";
  if (reason === "browser-auth-expired") return "reauthorize-browser-profile";
  if (reason === "browser-auth-degraded") return "refresh-browser-profile-authorization";
  if (reason === "external-access-barrier") return "authorize-browser-or-use-alternate-source";
  if (reason === "source-cooldown" || reason === "domain-throttled") return "wait-backoff-or-use-alternate-source";
  if (reason === "source-interval-not-due") return "wait-source-interval";
  if (reason === "source-disabled") return "review-source-enable-policy";
  if (reason === "executed-failed" || reason === "executed-partial") return "review-source-error-and-retry";
  if (reason === "executed-success") return "keep";
  return "inspect-source-log";
}

function buildSourceExecutionDiagnostics({
  plan = {},
  sourceRecords = [],
  explicitJobs = [],
  implicitAlternateJobs = [],
  runnableJobs = [],
  collectionJobs = [],
  counts = {},
  failures = [],
  sourceKeywordPlans = new Map(),
  sourceBudgets = new Map(),
  sourceDeepBudgets = new Map(),
  sourceFailoverPlans = new Map(),
  postRunFailoverPlans = new Map(),
} = {}) {
  const requested = new Set(Array.isArray(plan.sources) ? plan.sources : []);
  const explicit = new Set(explicitJobs.map(job => job.key));
  const implicit = new Set(implicitAlternateJobs.map(job => job.key));
  const runnable = new Set(runnableJobs.map(job => job.key));
  const records = new Map((sourceRecords || []).map(source => [source.source_key, source]));
  const jobRows = new Map((collectionJobs || []).map(job => [job.source_key, job]));
  const failureBySource = new Map();
  for (const failure of failures || []) {
    const key = String(failure?.source || "").trim();
    if (!key) continue;
    if (!failureBySource.has(key)) failureBySource.set(key, []);
    failureBySource.get(key).push(String(failure?.message || "").trim());
  }
  const keys = [...new Set([
    ...requested,
    ...explicit,
    ...implicit,
    ...runnable,
    ...Object.keys(counts || {}),
    ...[...jobRows.keys()],
    ...[...failureBySource.keys()],
  ])].filter(Boolean);
  const sources = keys.map(sourceKey => {
    const record = records.get(sourceKey) || {};
    const job = jobRows.get(sourceKey) || {};
    const status = String(job.status || (runnable.has(sourceKey) ? "running" : requested.has(sourceKey) ? "pending" : "not-selected"));
    const messages = failureBySource.get(sourceKey) || [];
    const message = String(job.message || messages[0] || "");
    const failover = postRunFailoverPlans.get(sourceKey) || sourceFailoverPlans.get(sourceKey) || null;
    const resultCount = Number(job.result_count ?? counts[sourceKey] ?? 0) || 0;
    const failureCount = Number(job.failure_count ?? messages.length ?? 0) || 0;
    const diagnostics = job.metadata?.diagnostics || null;
    return {
      source_key: sourceKey,
      label: record.label || job.label || sourceKey,
      requested: requested.has(sourceKey),
      selected: explicit.has(sourceKey),
      implicit_alternate: implicit.has(sourceKey),
      runnable: runnable.has(sourceKey),
      enabled: record.enabled !== false,
      status,
      reason: sourceExecutionReason(status, message, diagnostics),
      recommended_action: sourceExecutionRecommendedAction(status, message, failover, diagnostics),
      result_count: resultCount,
      failure_count: failureCount,
      message,
      keywords_count: (sourceKeywordPlans.get(sourceKey) || []).length,
      budget: sourceBudgets.get(sourceKey) || job.metadata?.budget || null,
      deep_budget: sourceDeepBudgets.get(sourceKey) || job.metadata?.deepBudget || null,
      rss_feed_packs: Array.isArray(job.metadata?.rssFeedPacks) ? job.metadata.rssFeedPacks : [],
      rss_feed_pack_count: Number(job.metadata?.rssFeedPackCount || 0) || 0,
      rss_feed_pack_mode: job.metadata?.rssFeedPackMode || "",
      alternate_sources: failover?.alternateSources || [],
      routed_to: failover?.routedTo || [],
      cooldown_until: job.cooling_until || null,
      diagnostics,
      job_id: job.id || null,
    };
  }).sort((a, b) => {
    const rank = {
      "executed-failed": 0,
      "executed-partial": 1,
      "browser-auth-expired": 2,
      "browser-auth-degraded": 3,
      "external-access-barrier": 4,
      "source-cooldown": 5,
      "domain-throttled": 6,
      "source-disabled": 7,
      "source-interval-not-due": 8,
      "source-pending": 9,
      "executed-success": 10,
      unknown: 11,
    };
    return (rank[a.reason] ?? 9) - (rank[b.reason] ?? 9)
      || Number(b.failure_count || 0) - Number(a.failure_count || 0)
      || a.source_key.localeCompare(b.source_key);
  });
  const executed = sources.filter(item => ["executed-success", "executed-partial", "executed-failed", "external-access-barrier", "browser-auth-expired", "browser-auth-degraded"].includes(item.reason));
  const skipped = sources.filter(item => ["source-cooldown", "domain-throttled", "source-disabled", "source-interval-not-due"].includes(item.reason));
  const zeroResultExecuted = executed.filter(item => Number(item.result_count || 0) === 0);
  const browserAuthExpired = sources.filter(item => item.reason === "browser-auth-expired");
  const browserAuthDegraded = sources.filter(item => item.reason === "browser-auth-degraded");
  return {
    summary: {
      requested_source_count: requested.size,
      selected_source_count: explicit.size,
      implicit_alternate_count: implicit.size,
      runnable_source_count: runnable.size,
      executed_source_count: executed.length,
      skipped_source_count: skipped.length,
      failed_source_count: executed.filter(item => ["executed-failed", "external-access-barrier", "browser-auth-expired"].includes(item.reason)).length,
      partial_source_count: executed.filter(item => ["executed-partial", "browser-auth-degraded"].includes(item.reason)).length,
      browser_auth_expired_source_count: browserAuthExpired.length,
      browser_auth_degraded_source_count: browserAuthDegraded.length,
      browser_auth_action_required_source_count: browserAuthExpired.length + browserAuthDegraded.length,
      zero_result_executed_source_count: zeroResultExecuted.length,
      routed_failover_source_count: sources.filter(item => item.routed_to.length > 0).length,
      not_selected_source_count: Math.max(0, requested.size - explicit.size),
    },
    skipped_sources: skipped,
    failed_sources: sources.filter(item => ["executed-failed", "external-access-barrier", "executed-partial", "browser-auth-expired", "browser-auth-degraded"].includes(item.reason)),
    browser_auth_sources: sources.filter(item => ["browser-auth-expired", "browser-auth-degraded"].includes(item.reason)),
    zero_result_sources: zeroResultExecuted,
    sources,
  };
}

function tableExists(db, tableName) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function selectRecentText(db, tableName, fields, orderBy, limit = 20) {
  if (!tableExists(db, tableName)) return [];
  const columns = fields.map(field => `COALESCE(${field}, '')`).join(" || ' ' || ");
  const rows = db.prepare(`
    SELECT ${columns} AS text
    FROM ${tableName}
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(limit);
  return rows.map(row => row.text).filter(Boolean);
}

function parseJsonList(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function addKeywordCandidate(scores, value, weight = 1) {
  const keyword = normalizeSentimentMonitorKeywords(value)[0] || "";
  if (!keyword || !SAFE_WORK_KEYWORDS.has(keyword)) return;
  scores.set(keyword, (scores.get(keyword) || 0) + weight);
}

function collectWorkKeywordCandidates(text, scores) {
  const source = String(text || "");
  if (!source.trim()) return;

  for (const hint of WORK_KEYWORD_HINTS) {
    if (source.includes(hint)) addKeywordCandidate(scores, hint, 5);
  }
}

export function deriveRecentWorkKeywords(db, limit = 8) {
  const texts = [];
  const scores = new Map();
  for (const text of texts) {
    collectWorkKeywordCandidates(text, scores);
    for (const tag of parseJsonList(text)) collectWorkKeywordCandidates(tag, scores);
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"))
    .map(([keyword]) => keyword)
    .slice(0, limit);
}

export function resolveSentimentScanKeywords(db) {
  const dbKeywords = db.prepare(
    "SELECT keyword FROM crm_keywords WHERE enabled = 1 ORDER BY created_at ASC, id ASC"
  ).all().flatMap(row => normalizeSentimentMonitorKeywords(row.keyword));

  if (dbKeywords.length) return normalizeSentimentMonitorKeywords(dbKeywords);
  return normalizeSentimentMonitorKeywords(deriveRecentWorkKeywords(db));
}

function uniqueExpansionTerms(values = [], limit = 60) {
  const raw = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  for (const value of raw) {
    const term = String(value || "").replace(/\s+/g, " ").trim();
    if (term && !out.includes(term)) out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

function multilingualRiskTermsForExpansion(expansion = {}) {
  const locales = uniqueExpansionTerms(expansion?.multilingualLocales || expansion?.multilingual_locales || expansion?.locales || ["en", "zh-Hans", "zh-Hant", "ja", "ko"], 12);
  const configured = uniqueExpansionTerms(expansion?.multilingualRiskTerms || expansion?.multilingual_risk_terms || expansion?.localeRiskTerms || expansion?.locale_risk_terms, 80);
  const packs = [];
  for (const locale of locales) {
    const key = String(locale || "").trim();
    const normalized = key.toLowerCase();
    const pack = MULTILINGUAL_RISK_TERM_PACKS[key]
      || MULTILINGUAL_RISK_TERM_PACKS[normalized]
      || MULTILINGUAL_RISK_TERM_PACKS[key.replace("_", "-")]
      || [];
    if (pack.length) packs.push(pack);
  }
  const terms = [];
  const maxPackLength = Math.max(0, ...packs.map(pack => pack.length));
  for (let index = 0; index < maxPackLength; index += 1) {
    for (const pack of packs) {
      if (pack[index]) terms.push(pack[index]);
    }
  }
  terms.push(...configured);
  return uniqueExpansionTerms(terms, 120);
}

function addSearchKeyword(out, value, limit) {
  const keyword = String(value || "").replace(/\s+/g, " ").trim();
  if (!keyword || out.includes(keyword)) return false;
  out.push(keyword);
  return out.length >= limit;
}

function eventRiskRank(value) {
  return EVENT_RISK_RANK.get(String(value || "").toLowerCase()) || 0;
}

function normalizeEventExpansionTerm(value) {
  const term = String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[()[\]{}"'“”‘’<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!term || term.length < 2 || term.length > 48) return "";
  if (EVENT_EXPANSION_STOP_WORDS.has(term.toLowerCase()) || EVENT_EXPANSION_STOP_WORDS.has(term)) return "";
  if (/^\d+$/.test(term)) return "";
  return term;
}

function collectEventExpansionCandidate(scores, value, score = 1) {
  const term = normalizeEventExpansionTerm(value);
  if (!term) return;
  scores.set(term, (scores.get(term) || 0) + score);
}

function extractEventEntities(text = []) {
  const source = (Array.isArray(text) ? text : [text]).join(" ");
  const out = [];
  for (const match of source.matchAll(EVENT_EXPANSION_ENTITY_RE)) {
    const term = normalizeEventExpansionTerm(match[0]);
    if (term && !out.includes(term)) out.push(term);
    if (out.length >= 12) break;
  }
  const quoted = source.match(/[「『]([^」』]{2,24})[」』]/g) || [];
  for (const value of quoted) {
    const term = normalizeEventExpansionTerm(value.replace(/[「」『』]/g, ""));
    if (term && !out.includes(term)) out.push(term);
    if (out.length >= 16) break;
  }
  return out;
}

function eventIsEligibleForExpansion(event = {}, settings = {}) {
  if (!event || settings.enabled === false) return false;
  const status = String(event.status || "open").toLowerCase();
  if (["resolved", "closed", "ignored", "archived"].includes(status)) return false;
  if (eventRiskRank(event.risk_level) < eventRiskRank(settings.minRiskLevel || "medium")) {
    const platformCount = Array.isArray(event.platforms) ? event.platforms.length : 0;
    if (platformCount < 2 && Number(event.item_count || 0) < 2) return false;
  }
  const maxAgeDays = Math.max(1, Number(settings.maxAgeDays || settings.max_age_days || 14) || 14);
  const lastSeenMs = new Date(event.last_seen_at || event.updated_at || event.first_seen_at || "").getTime();
  if (Number.isNaN(lastSeenMs)) return true;
  return Date.now() - lastSeenMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

export function deriveEventExpansionKeywords(events = [], {
  mode = SCAN_MODE_FAST,
  settings = {},
  baseKeywords = [],
} = {}) {
  const enabled = settings.enabled !== false;
  if (!enabled) return [];
  const limit = mode === SCAN_MODE_FULL
    ? Math.max(0, Number(settings.maxTermsFull ?? settings.max_terms_full ?? 18) || 0)
    : Math.max(0, Number(settings.maxTermsFast ?? settings.max_terms_fast ?? 6) || 0);
  if (!limit) return [];

  const normalizedBase = normalizeSentimentMonitorKeywords(baseKeywords);
  const includeRiskCombos = settings.includeRiskCombos !== false && settings.include_risk_combos !== false;
  const includePlatformHints = settings.includePlatformHints !== false && settings.include_platform_hints !== false;
  const scores = new Map();
  const eligibleEvents = (Array.isArray(events) ? events : [])
    .filter(event => eventIsEligibleForExpansion(event, settings))
    .sort((a, b) => {
      const riskDiff = eventRiskRank(b.risk_level) - eventRiskRank(a.risk_level);
      return riskDiff || Number(b.item_count || 0) - Number(a.item_count || 0);
    });

  for (const event of eligibleEvents) {
    const riskBoost = eventRiskRank(event.risk_level);
    const itemBoost = Math.min(4, Number(event.item_count || 0));
    const eventKeyword = normalizeEventExpansionTerm(event.keyword);
    const text = `${event.title || ""} ${event.summary || ""}`;
    collectEventExpansionCandidate(scores, eventKeyword, 8 + riskBoost + itemBoost);

    const entities = extractEventEntities([event.title, event.summary]);
    for (const entity of entities) collectEventExpansionCandidate(scores, entity, 5 + riskBoost);

    for (const riskTerm of RISK_SCAN_TERMS) {
      if (!text.includes(riskTerm)) continue;
      collectEventExpansionCandidate(scores, riskTerm, 2 + riskBoost);
      if (includeRiskCombos && eventKeyword && !eventKeyword.includes(riskTerm)) {
        collectEventExpansionCandidate(scores, `${eventKeyword} ${riskTerm}`, 7 + riskBoost + itemBoost);
      }
      for (const entity of entities.slice(0, 4)) {
        if (!entity.includes(riskTerm)) collectEventExpansionCandidate(scores, `${entity} ${riskTerm}`, 4 + riskBoost);
      }
    }

    if (includePlatformHints) {
      const platforms = Array.isArray(event.platforms) ? event.platforms : [];
      for (const platform of platforms) {
        const hint = EVENT_PLATFORM_HINTS.get(String(platform || "").toLowerCase());
        if (!hint || !eventKeyword) continue;
        collectEventExpansionCandidate(scores, `${eventKeyword} ${hint}`, 3 + riskBoost);
      }
    }
  }

  return [...scores.entries()]
    .filter(([term]) => !normalizedBase.includes(term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"))
    .map(([term]) => term)
    .slice(0, limit);
}

function mergeSearchKeywords(baseKeywords = [], eventKeywords = [], limit = SEARCH_KEYWORD_LIMIT) {
  const out = [];
  for (const keyword of [...baseKeywords, ...eventKeywords]) {
    if (addSearchKeyword(out, keyword, limit)) break;
  }
  return out;
}

function sourceSpecificTopicKeywords(sourceKey = "", signal = {}) {
  const keywords = normalizeSentimentMonitorKeywords(signal?.keywords || []);
  const hints = SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey];
  return keywords.sort((a, b) => {
    const aHint = hints.some(hint => String(a).toLowerCase().includes(String(hint).toLowerCase())) ? 1 : 0;
    const bHint = hints.some(hint => String(b).toLowerCase().includes(String(hint).toLowerCase())) ? 1 : 0;
    return bHint - aHint || a.localeCompare(b, "zh-Hant");
  });
}

function sourceSpecificDiscoveryProfileKeywords(sourceKey = "", sourceConfig = {}, baseKeywords = []) {
  if (sourceKey === "applePodcastSearch") {
    const tracking = sourceConfig?.discoveryPodcastTracking || sourceConfig?.discovery_podcast_tracking || {};
    if (tracking.enabled === false) return [];
    const shows = Array.isArray(sourceConfig?.discoveredPodcastShows)
      ? sourceConfig.discoveredPodcastShows
      : Array.isArray(sourceConfig?.discovered_podcast_shows)
        ? sourceConfig.discovered_podcast_shows
        : [];
    if (!shows.length) return [];
    const discoveredTerms = shows.flatMap(show => [
      show?.show_name,
      show?.showName,
      show?.artist_name,
      show?.artistName,
      show?.collection_id,
      show?.collectionId,
      ...(show?.keywords_checked || show?.keywords || []),
      ...(show?.example_titles || []),
    ]);
    return uniqueExpansionTerms([
      ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 6),
      ...discoveredTerms,
      ...shows.map(show => show?.show_name || show?.showName).filter(Boolean).map(name => `${name} podcast`),
    ], 18);
  }
  if (!["duckDuckGo", "googleNews", "bingNews", "baiduNews", "rssFeeds"].includes(sourceKey)) return [];
  const tracking = sourceConfig?.discoveryProfileTracking || sourceConfig?.discovery_profile_tracking || {};
  const domainTracking = sourceConfig?.discoveryDomainTracking || sourceConfig?.discovery_domain_tracking || {};
  if (tracking.enabled === false && domainTracking.enabled === false) return [];
  const profiles = Array.isArray(sourceConfig?.discoveredProfiles)
    ? sourceConfig.discoveredProfiles
    : Array.isArray(sourceConfig?.discovered_profiles)
      ? sourceConfig.discovered_profiles
      : [];
  const domains = Array.isArray(sourceConfig?.discoveredDomains)
    ? sourceConfig.discoveredDomains
    : Array.isArray(sourceConfig?.discovered_domains)
      ? sourceConfig.discovered_domains
      : [];
  if (!profiles.length && !domains.length) return [];
  const discoveredTerms = [
    ...profiles.flatMap(profile => profile?.keywords_checked || profile?.keywords || []),
    ...domains.flatMap(domain => domain?.keywords_checked || domain?.example_titles || domain?.keywords || []),
  ];
  const baseTerms = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 6);
  const terms = uniqueExpansionTerms(sourceKey === "rssFeeds"
    ? [...discoveredTerms, ...baseTerms]
    : [...baseTerms, ...discoveredTerms], sourceKey === "googleNews" || sourceKey === "bingNews" || sourceKey === "baiduNews" ? 10 : sourceKey === "rssFeeds" ? 12 : 18);
  if (!terms.length) return [];
  const out = [];
  for (const profile of profiles.slice(0, 8)) {
    const url = String(profile?.url || "");
    let host = String(profile?.host || "");
    let siteScope = "";
    try {
      const parsed = new URL(url);
      host ||= parsed.hostname.replace(/^www\./, "");
      const path = parsed.pathname.replace(/\/+$/, "");
      siteScope = path && !["/", ""].includes(path) ? `${host}${path}` : host;
    } catch {
      // Ignore malformed tracking profiles.
    }
    if (!host) continue;
    const scope = String(profile?.site_scope || profile?.siteScope || siteScope || host || "")
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "")
      .trim()
      .slice(0, 300);
    if (!scope) continue;
    for (const term of terms.slice(0, sourceKey === "rssFeeds" ? 3 : 4)) {
      const query = `site:${scope} ${term}`;
      if (!out.includes(query)) out.push(query);
      if (out.length >= (sourceKey === "rssFeeds" ? 10 : 16)) return out;
    }
  }
  for (const domain of domains.slice(0, 10)) {
    const siteScope = String(domain?.site_scope || domain?.siteScope || domain?.host || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (!siteScope) continue;
    const suffix = String(domain?.querySuffix || domain?.query_suffix || "").replace(/\s+/g, " ").trim();
    for (const term of terms.slice(0, 4)) {
      const query = `site:${siteScope} ${term}${suffix && !String(term).includes(suffix) ? ` ${suffix}` : ""}`;
      if (!out.includes(query)) out.push(query);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

function openWebDiscoveryTargetsFromSourceConfig(sourceConfig = {}) {
  const configuredTargets = Array.isArray(sourceConfig?.targets)
    ? sourceConfig.targets
    : Array.isArray(sourceConfig?.sites)
      ? sourceConfig.sites
      : [];
  const profiles = Array.isArray(sourceConfig?.discoveredProfiles)
    ? sourceConfig.discoveredProfiles
    : Array.isArray(sourceConfig?.discovered_profiles)
      ? sourceConfig.discovered_profiles
      : [];
  const domains = Array.isArray(sourceConfig?.discoveredDomains)
    ? sourceConfig.discoveredDomains
    : Array.isArray(sourceConfig?.discovered_domains)
      ? sourceConfig.discovered_domains
      : [];
  const discoveredTargets = [...profiles, ...domains].map(item => ({
    ...item,
    domain: item?.domain || item?.host || "",
    siteScope: item?.site_scope || item?.siteScope || item?.host || item?.url || "",
    profile: item?.profile || item?.candidate_type || item?.discovery_source || "discovered-open-web",
    querySuffix: item?.querySuffix || item?.query_suffix || "",
  }));
  return [...discoveredTargets, ...configuredTargets];
}

function openWebDiscoveryTargetsFromEventClusterSignal(signal = {}) {
  if (!signal || Number(signal.priorityBoost || signal.score || 0) <= 0) return [];
  const out = [];
  const add = ({ url = "", keyword = "", label = "", reason = "", type = "", priority = 0 } = {}) => {
    const normalizedUrl = normalizeFollowupUrl(url);
    if (!normalizedUrl) return;
    let parsed;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      return;
    }
    const scope = `${parsed.hostname.replace(/^www\./i, "")}${parsed.pathname || ""}`.replace(/\/+$/g, "");
    const domain = parsed.hostname.replace(/^www\./i, "");
    if (!scope || out.some(item => String(item.siteScope || item.site_scope || "").toLowerCase() === scope.toLowerCase())) return;
    const baseTerms = type === "origin-url"
      ? "原文 OR 來源 OR 引用 OR statement OR response"
      : type === "explicit-reference-chain"
        ? "引用 OR 轉載 OR 轉述 OR original OR source"
        : type === "independent-confirmation-gap"
          ? "獨立查證 OR 第二來源 OR 非轉載 OR verification"
          : "後續 OR 回應 OR 討論 OR follow-up";
    out.push({
      profile: type === "independent-confirmation-gap" ? "discussion" : "open-web",
      domain,
      siteScope: scope,
      url: normalizedUrl,
      querySuffix: [baseTerms, keyword || label || ""].filter(Boolean).join(" OR "),
      sourceWeightTier: type === "origin-url" ? "event-origin-followup" : "event-cluster-followup",
      candidate_type: type || "event-cluster-followup",
      discovery_source: "event-cluster-followup",
      reason,
      score: Math.max(40, Math.min(100, Number(priority || signal.priorityBoost || signal.score || 50))),
    });
  };
  for (const url of signal.originUrls || []) {
    add({
      url,
      keyword: (signal.suggestedKeywords || [])[0] || "",
      label: (signal.clusterLabels || [])[0] || "",
      type: "origin-url",
      reason: "event-cluster-origin-url",
      priority: Number(signal.priorityBoost || 0) + 12,
    });
  }
  for (const target of Array.isArray(signal.followupTargets) ? signal.followupTargets : []) {
    add(target);
  }
  return out.slice(0, 12);
}

const KEYWORD_FAMILY_OPEN_WEB_TARGETS = {
  news: [
    { profile: "news", siteScope: "news.yahoo.com", queryTerms: ["新聞", "報導", "媒體", "news"] },
    { profile: "news", siteScope: "cna.com.tw", queryTerms: ["新聞", "報導", "聲明"] },
    { profile: "news", siteScope: "udn.com", queryTerms: ["新聞", "報導", "爭議"] },
  ],
  forum: [
    { profile: "discussion", siteScope: "ptt.cc/bbs", queryTerms: ["爆料", "投訴", "避雷", "炎上"] },
    { profile: "discussion", siteScope: "dcard.tw/f", queryTerms: ["心得", "投訴", "避雷", "爆料"] },
    { profile: "discussion", siteScope: "reddit.com", queryTerms: ["complaint", "review", "boycott", "refund"] },
    { profile: "discussion", siteScope: "lihkg.com/thread", queryTerms: ["投訴", "爆料", "苦主", "炎上"] },
    { profile: "discussion", siteScope: "mobile01.com/topicdetail.php", queryTerms: ["心得", "評價", "投訴", "災情"] },
    { profile: "discussion", siteScope: "quora.com", queryTerms: ["review", "complaint", "experience"] },
    { profile: "knowledge", siteScope: "zhihu.com", queryTerms: ["如何看待", "投訴", "爆料", "評價"] },
  ],
  community: [
    { profile: "discussion", siteScope: "reddit.com", queryTerms: ["community", "discussion", "complaint"] },
    { profile: "discussion", siteScope: "news.ycombinator.com", queryTerms: ["discussion", "incident", "review"] },
    { profile: "newsletter", siteScope: "substack.com", queryTerms: ["incident", "review", "analysis", "statement"] },
    { profile: "newsletter", siteScope: "medium.com", queryTerms: ["review", "incident", "statement"] },
    { profile: "developer", siteScope: "github.com", queryTerms: ["issue", "bug", "discussion", "security"] },
    { profile: "developer", siteScope: "gitlab.com", queryTerms: ["issue", "bug", "security"] },
    { profile: "developer", siteScope: "stackoverflow.com/questions", queryTerms: ["issue", "error", "bug"] },
  ],
  social: [
    { profile: "social-public", siteScope: "x.com", queryTerms: ["complaint", "boycott", "scam", "statement"] },
    { profile: "social-public", siteScope: "twitter.com", queryTerms: ["complaint", "boycott", "scam", "statement"] },
    { profile: "social-public", siteScope: "threads.net", queryTerms: ["complaint", "review", "boycott", "statement"] },
    { profile: "social-public", siteScope: "instagram.com/p", queryTerms: ["complaint", "review", "boycott", "statement"] },
    { profile: "social-public", siteScope: "facebook.com", queryTerms: ["review", "complaint", "statement", "boycott"] },
    { profile: "social-public", siteScope: "linkedin.com/posts", queryTerms: ["incident", "statement", "complaint", "review"] },
    { profile: "social-public", siteScope: "t.me/s", queryTerms: ["scam", "complaint", "refund", "statement"] },
    { profile: "social-public", siteScope: "xiaohongshu.com/explore", queryTerms: ["避雷", "投訴", "評價", "體驗"] },
    { profile: "social-public", siteScope: "xiaohongshu.com/discovery/item", queryTerms: ["避雷", "投訴", "評價", "體驗"] },
    { profile: "social-public", siteScope: "m.xiaohongshu.com/discovery/item", queryTerms: ["避雷", "投訴", "評價", "體驗"] },
    { profile: "social-public", siteScope: "weibo.com", queryTerms: ["投訴", "爆料", "回應", "聲明"] },
    { profile: "social-public", siteScope: "m.weibo.cn", queryTerms: ["投訴", "爆料", "回應", "聲明"] },
  ],
  video: [
    { profile: "video", siteScope: "youtube.com", queryTerms: ["review", "complaint", "scam", "refund"] },
    { profile: "short-video", siteScope: "tiktok.com", queryTerms: ["review", "complaint", "scam", "boycott"] },
    { profile: "short-video", siteScope: "douyin.com/video", queryTerms: ["避雷", "投訴", "爆料", "詐騙"] },
    { profile: "video", siteScope: "bilibili.com/video", queryTerms: ["避雷", "投訴", "評測", "爆料"] },
    { profile: "video", siteScope: "bilibili.com/read", queryTerms: ["避雷", "投訴", "評測", "爆料"] },
  ],
  review: [
    { profile: "review", siteScope: "trustpilot.com", queryTerms: ["review", "complaint", "refund", "rating"] },
    { profile: "consumer-complaint", siteScope: "complaintsboard.com", queryTerms: ["complaint", "refund", "scam"] },
    { profile: "consumer-complaint", siteScope: "pissedconsumer.com", queryTerms: ["complaint", "refund", "customer service"] },
    { profile: "review", siteScope: "consumeraffairs.com", queryTerms: ["review", "complaint", "rating"] },
    { profile: "review", siteScope: "sitejabber.com", queryTerms: ["review", "complaint", "rating"] },
    { profile: "review", siteScope: "reviews.io/company-reviews", queryTerms: ["review", "rating", "complaint"] },
    { profile: "review", siteScope: "yelp.com/biz", queryTerms: ["review", "complaint", "customer service"] },
    { profile: "review", siteScope: "tripadvisor.com", queryTerms: ["review", "complaint", "experience"] },
    { profile: "review", siteScope: "glassdoor.com/Reviews", queryTerms: ["review", "complaint", "culture", "layoffs"] },
    { profile: "review", siteScope: "indeed.com/cmp", queryTerms: ["review", "complaint", "employee"] },
    { profile: "review", siteScope: "mouthshut.com/review", queryTerms: ["review", "complaint", "refund"] },
    { profile: "review", siteScope: "hellopeter.com/reviews", queryTerms: ["review", "complaint", "customer service"] },
  ],
  complaint: [
    { profile: "consumer-protection", siteScope: "cpc.ey.gov.tw", queryTerms: ["消費", "爭議", "投訴", "退款"] },
    { profile: "consumer-protection", siteScope: "consumer.org.hk", queryTerms: ["complaint", "alert", "consumer"] },
    { profile: "consumer-protection", siteScope: "case.org.sg", queryTerms: ["complaint", "consumer", "dispute"] },
    { profile: "consumer-complaint", siteScope: "complaintsboard.com", queryTerms: ["complaint", "refund", "scam"] },
    { profile: "consumer-complaint", siteScope: "pissedconsumer.com", queryTerms: ["complaint", "refund", "customer service"] },
    { profile: "review", siteScope: "bbb.org", queryTerms: ["complaint", "review", "customer"] },
  ],
  legal: [
    { profile: "legal", siteScope: "courtlistener.com", queryTerms: ["lawsuit", "litigation", "court"] },
    { profile: "legal", siteScope: "law.justia.com", queryTerms: ["lawsuit", "complaint", "settlement"] },
  ],
  "official-regulatory": [
    { profile: "regulatory", siteScope: "consumer.ftc.gov", queryTerms: ["scam", "refund", "complaint", "alert"] },
    { profile: "regulatory", siteScope: "cpsc.gov", queryTerms: ["recall", "safety alert", "warning"] },
    { profile: "consumer-protection", siteScope: "cpc.ey.gov.tw", queryTerms: ["消費", "投訴", "公告", "警示"] },
  ],
  security: [
    { profile: "security", siteScope: "github.com/advisories", queryTerms: ["CVE", "security advisory", "vulnerability"] },
    { profile: "security", siteScope: "nvd.nist.gov", queryTerms: ["CVE", "vulnerability", "advisory"] },
  ],
  finance: [
    { profile: "finance", siteScope: "sec.gov/Archives/edgar", queryTerms: ["investor", "filing", "risk", "market"] },
    { profile: "finance", siteScope: "finance.yahoo.com", queryTerms: ["investor", "market sentiment", "stock"] },
  ],
  operations: [
    { profile: "operations", siteScope: "statuspage.io", queryTerms: ["status", "incident", "outage"] },
    { profile: "operations", siteScope: "githubstatus.com", queryTerms: ["incident", "outage", "degraded"] },
  ],
};

function keywordFamilyOpenWebQuerySuffix(keyword = "", gap = {}, target = {}) {
  const baseTerms = normalizeSentimentMonitorKeywords([
    ...(Array.isArray(gap.suggested_keywords) ? gap.suggested_keywords : []),
    ...(Array.isArray(target.queryTerms) ? target.queryTerms.map(term => `${keyword} ${term}`) : []),
    keyword,
  ]);
  return baseTerms.slice(0, 10).join(" OR ");
}

function openWebDiscoveryTargetsFromKeywordFamilyCoverage(report = {}) {
  const out = [];
  const seen = new Set();
  for (const gap of Array.isArray(report?.gaps) ? report.gaps : []) {
    if (!gap || gap.status === "covered") continue;
    const family = String(gap.source_family || "").trim();
    const keyword = String(gap.keyword || "").trim();
    if (!family || !keyword) continue;
    const targets = KEYWORD_FAMILY_OPEN_WEB_TARGETS[family] || [];
    for (const target of targets) {
      const siteScope = String(target.siteScope || target.site_scope || "").replace(/^https?:\/\//i, "").replace(/\/+$/g, "").trim();
      if (!siteScope) continue;
      const dedupeKey = `${family}\n${keyword}\n${siteScope}`.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const missingBoost = gap.status === "missing-family" ? 12 : 6;
      const riskBoost = Math.min(12, Number(gap.high_risk || 0) * 4);
      const negativeBoost = Math.min(8, Number(gap.negative || 0) * 2);
      out.push({
        profile: target.profile || family || "open-web",
        domain: siteScope.replace(/\/.*$/g, ""),
        siteScope,
        querySuffix: keywordFamilyOpenWebQuerySuffix(keyword, gap, target),
        sourceWeightTier: "keyword-family-coverage-gap",
        candidate_type: "keyword-family-coverage-gap",
        discovery_source: "keyword-family-coverage",
        reason: gap.status === "weak-family" ? "weak-keyword-source-family" : "missing-keyword-source-family",
        score: Math.max(45, Math.min(100, 60 + missingBoost + riskBoost + negativeBoost)),
        keyword,
        source_family: family,
        suggested_sources: Array.isArray(gap.suggested_sources) ? gap.suggested_sources.slice(0, 8) : [],
      });
      if (out.length >= 32) return out;
    }
  }
  return out.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.siteScope || "").localeCompare(String(b.siteScope || ""))).slice(0, 32);
}

function realtimeCoverageOpenWebQuerySuffix(keyword = "", plan = {}, target = {}) {
  const baseTerms = normalizeSentimentMonitorKeywords([
    ...(Array.isArray(plan.suggested_keywords) ? plan.suggested_keywords : []),
    ...(Array.isArray(target.queryTerms) ? target.queryTerms.map(term => `${keyword} ${term}`) : []),
    keyword,
  ]);
  return baseTerms.slice(0, 10).join(" OR ");
}

function openWebDiscoveryTargetsFromRealtimeSourceCoverage(report = {}) {
  const out = [];
  const seen = new Set();
  for (const topic of Array.isArray(report?.topics) ? report.topics : []) {
    const keyword = String(topic.keyword || "").trim();
    if (!keyword) continue;
    const hotScore = Number(topic.hot_score || topic.score || 0);
    const gapScore = Number(topic.coverage_gap_score || 0);
    for (const plan of Array.isArray(topic.family_plans) ? topic.family_plans : []) {
      if (!plan || plan.status === "covered") continue;
      const family = String(plan.family || "").trim();
      if (!family) continue;
      const targets = KEYWORD_FAMILY_OPEN_WEB_TARGETS[family] || [];
      for (const target of targets) {
        const siteScope = String(target.siteScope || target.site_scope || "").replace(/^https?:\/\//i, "").replace(/\/+$/g, "").trim();
        if (!siteScope) continue;
        const dedupeKey = `realtime\n${family}\n${keyword}\n${siteScope}`.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const missingBoost = plan.status === "missing-family" ? 12 : 6;
        const urgencyBoost = Math.min(18, Math.max(hotScore, gapScore) / 6);
        out.push({
          profile: target.profile || family || "open-web",
          domain: siteScope.replace(/\/.*$/g, ""),
          siteScope,
          querySuffix: realtimeCoverageOpenWebQuerySuffix(keyword, plan, target),
          sourceWeightTier: "realtime-source-family-coverage-gap",
          candidate_type: "realtime-source-family-coverage-gap",
          discovery_source: "realtime-source-coverage",
          reason: plan.status === "weak-family" ? "weak-realtime-source-family" : "missing-realtime-source-family",
          score: Math.max(48, Math.min(100, Math.round(58 + missingBoost + urgencyBoost))),
          keyword,
          source_family: family,
          suggested_sources: Array.isArray(plan.recommended_sources) ? plan.recommended_sources.slice(0, 8) : [],
        });
        if (out.length >= 32) return out;
      }
    }
  }
  return out.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.siteScope || "").localeCompare(String(b.siteScope || ""))).slice(0, 32);
}

function openWebDiscoveryTargetsForSource(sourceConfig = {}, eventClusterSignal = null, keywordFamilyCoverageReport = null, realtimeSourceCoverageReport = null) {
  const configured = openWebDiscoveryTargetsFromSourceConfig(sourceConfig);
  const eventTargets = openWebDiscoveryTargetsFromEventClusterSignal(eventClusterSignal);
  const keywordFamilyTargets = openWebDiscoveryTargetsFromKeywordFamilyCoverage(keywordFamilyCoverageReport);
  const realtimeCoverageTargets = openWebDiscoveryTargetsFromRealtimeSourceCoverage(realtimeSourceCoverageReport);
  return [...eventTargets, ...realtimeCoverageTargets, ...keywordFamilyTargets, ...configured];
}

function eventClusterFollowupTargetsForSource(sourceKey = "", eventClusterSignal = null) {
  const key = String(sourceKey || "").trim();
  if (!key || !eventClusterSignal) return [];
  return (Array.isArray(eventClusterSignal.followupTargets) ? eventClusterSignal.followupTargets : [])
    .filter(target => target && (
      !Array.isArray(target.sourceKeys)
      || !target.sourceKeys.length
      || target.sourceKeys.includes(key)
    ))
    .map(target => ({
      type: target.type || "event-cluster-followup",
      url: normalizeFollowupUrl(target.url || ""),
      keyword: String(target.keyword || "").trim(),
      label: String(target.label || "").trim(),
      reason: String(target.reason || "").trim(),
      priority: Math.max(1, Math.min(100, Number(target.priority || 0) || Number(eventClusterSignal.priorityBoost || eventClusterSignal.score || 0) || 40)),
    }))
    .filter(target => target.url || target.keyword || target.label)
    .slice(0, 20);
}

function mergeOpenWebDiscoveryConfigs(openWebConfig = {}, duckDuckGoConfig = {}) {
  return {
    ...duckDuckGoConfig,
    ...openWebConfig,
    targets: openWebConfig.targets || openWebConfig.sites || [],
    discoveredProfiles: [
      ...(Array.isArray(duckDuckGoConfig?.discoveredProfiles) ? duckDuckGoConfig.discoveredProfiles : []),
      ...(Array.isArray(duckDuckGoConfig?.discovered_profiles) ? duckDuckGoConfig.discovered_profiles : []),
      ...(Array.isArray(openWebConfig?.discoveredProfiles) ? openWebConfig.discoveredProfiles : []),
      ...(Array.isArray(openWebConfig?.discovered_profiles) ? openWebConfig.discovered_profiles : []),
    ],
    discoveredDomains: [
      ...(Array.isArray(duckDuckGoConfig?.discoveredDomains) ? duckDuckGoConfig.discoveredDomains : []),
      ...(Array.isArray(duckDuckGoConfig?.discovered_domains) ? duckDuckGoConfig.discovered_domains : []),
      ...(Array.isArray(openWebConfig?.discoveredDomains) ? openWebConfig.discoveredDomains : []),
      ...(Array.isArray(openWebConfig?.discovered_domains) ? openWebConfig.discovered_domains : []),
    ],
  };
}

export function deriveEntityTopicRecallKeywords(topicRecall = {}, {
  mode = SCAN_MODE_FAST,
  baseKeywords = [],
  limit = null,
} = {}) {
  const safeLimit = Math.max(0, Math.min(
    mode === SCAN_MODE_FULL ? 18 : 6,
    Number(limit ?? (mode === SCAN_MODE_FULL ? 18 : 6)) || 0,
  ));
  if (!safeLimit) return [];
  const protectedBase = new Set(normalizeSentimentMonitorKeywords(baseKeywords));
  const rank = { "critical-topic-gap": 0, "topic-gap": 1, "weak-topic": 2, covered: 3 };
  const out = [];
  const topics = (Array.isArray(topicRecall.topics) ? topicRecall.topics : [])
    .filter(item => item && item.status !== "covered")
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
      || Number(a.recall_score || 0) - Number(b.recall_score || 0)
      || Number(b.entity?.priority || 0) - Number(a.entity?.priority || 0)
      || entityTopicRecallScenarioScanRank(a) - entityTopicRecallScenarioScanRank(b)
      || String(a.scenario?.key || "").localeCompare(String(b.scenario?.key || "")));
  for (const topic of topics) {
    const rankedKeywords = normalizeSentimentMonitorKeywords(topic.suggested_keywords || [])
      .map((keyword, index) => ({
        keyword,
        index,
        score: entityTopicRecallKeywordScanScore(keyword, topic),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(item => item.keyword);
    for (const keyword of rankedKeywords) {
      if (protectedBase.has(keyword) || out.includes(keyword)) continue;
      out.push(keyword);
      if (out.length >= safeLimit) return out;
    }
  }
  return out;
}

const ENTITY_TOPIC_RECALL_SCAN_SCENARIO_RANK = new Map([
  ["entity_negative_terms", 0],
  ["fraud", 1],
  ["privacy", 2],
  ["refund", 3],
  ["service", 4],
  ["boycott", 5],
  ["public_response", 6],
]);

function entityTopicRecallScenarioScanRank(topic = {}) {
  const key = String(topic.scenario?.key || "").trim();
  return ENTITY_TOPIC_RECALL_SCAN_SCENARIO_RANK.has(key)
    ? ENTITY_TOPIC_RECALL_SCAN_SCENARIO_RANK.get(key)
    : 20;
}

function entityTopicRecallKeywordScanScore(keyword = "", topic = {}) {
  const normalized = String(keyword || "").toLowerCase();
  const scenarioTerms = normalizeSentimentMonitorKeywords(topic.scenario?.terms || []);
  const familyHints = [
    ...(Array.isArray(topic.missing_families) ? topic.missing_families : []),
    ...(Array.isArray(topic.weak_families) ? topic.weak_families : []),
  ].flatMap(family => (ENTITY_TOPIC_RECALL_FAMILY_SOURCES.get(String(family || "")) || [])
    .flatMap(sourceKey => SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]));
  const platformHints = normalizeSentimentMonitorKeywords([
    ...(topic.entity?.platform_hints || topic.entity?.platformHints || []),
    ...familyHints,
  ]);
  const hasScenarioTerm = scenarioTerms.some(term => term && normalized.includes(term.toLowerCase()));
  const hasPlatformHint = platformHints.some(hint => hint && normalized.includes(hint.toLowerCase()));
  const tokenCount = String(keyword || "").split(/\s+/).filter(Boolean).length;
  return (hasPlatformHint ? 60 : 0)
    + (hasScenarioTerm ? 20 : 0)
    + (tokenCount >= 3 ? 12 : tokenCount === 2 ? 4 : 0);
}

export function mergeEntityTopicRecallSignals(currentRecall = {}, trendRecall = {}) {
  const byKey = new Map();
  const keyFor = (topic = {}) => `${String(topic.entity?.name || "").toLowerCase()}|${String(topic.scenario?.key || "").toLowerCase()}`;
  for (const topic of Array.isArray(currentRecall.topics) ? currentRecall.topics : []) {
    const key = keyFor(topic);
    if (key === "|") continue;
    byKey.set(key, {
      ...topic,
      suggested_keywords: normalizeSentimentMonitorKeywords(topic.suggested_keywords || []),
      recommendations: normalizeSentimentMonitorKeywords(topic.recommendations || []),
    });
  }
  for (const trend of Array.isArray(trendRecall.topics) ? trendRecall.topics : []) {
    const key = keyFor(trend);
    if (key === "|") continue;
    const persistentMissing = normalizeSentimentMonitorKeywords(trend.persistent_missing_families || []);
    const persistentWeak = normalizeSentimentMonitorKeywords(trend.persistent_weak_families || []);
    const existing = byKey.get(key) || {
      entity: trend.entity,
      scenario: trend.scenario,
      expected_families: trend.expected_families || [],
      total: 0,
      negative: 0,
      high_risk: 0,
      recall_score: Number(trend.current_recall_score || trend.average_recall_score || 0),
      status: trend.trend === "persistent-gap" ? "critical-topic-gap" : trend.trend === "worsening" ? "topic-gap" : trend.current_status || "weak-topic",
      missing_families: [],
      weak_families: [],
      suggested_keywords: [],
      recommendations: [],
    };
    const persistentGap = ["persistent-gap", "worsening"].includes(String(trend.trend || ""));
    existing.persistent_trend = trend.trend || existing.persistent_trend || "";
    existing.gap_buckets = Math.max(Number(existing.gap_buckets || 0), Number(trend.gap_buckets || 0));
    existing.missing_families = normalizeSentimentMonitorKeywords([
      ...(existing.missing_families || []),
      ...persistentMissing,
    ]);
    existing.weak_families = normalizeSentimentMonitorKeywords([
      ...(existing.weak_families || []),
      ...persistentWeak,
    ]);
    existing.suggested_keywords = normalizeSentimentMonitorKeywords([
      ...(trend.suggested_keywords || []),
      ...(existing.suggested_keywords || []),
    ]);
    existing.recommendations = normalizeSentimentMonitorKeywords([
      ...(existing.recommendations || []),
      ...(trend.recommendations || []),
    ]);
    existing.recall_score = Math.min(Number(existing.recall_score || 100), Number(trend.current_recall_score || trend.average_recall_score || 100));
    if (persistentGap && existing.missing_families.length) existing.status = "critical-topic-gap";
    else if (persistentGap && existing.weak_families.length) existing.status = "topic-gap";
    byKey.set(key, existing);
  }
  return {
    days: currentRecall.days || trendRecall.days || 14,
    summary: currentRecall.summary || {},
    topics: [...byKey.values()],
  };
}

export function deriveEntityTopicSourceSignals(topicRecall = {}, { maxBoost = 24 } = {}) {
  const signals = {};
  const rank = { "critical-topic-gap": 4, "topic-gap": 3, "weak-topic": 1.5, covered: 0 };
  const addSignal = (sourceKey, topic, family, weight) => {
    if (!sourceKey || weight <= 0) return;
    const signal = signals[sourceKey] || {
      sourceKey,
      score: 0,
      topicCount: 0,
      families: [],
      scenarios: [],
      entities: [],
      keywords: [],
    };
    signal.score += weight;
    signal.topicCount += 1;
    if (family && !signal.families.includes(family)) signal.families.push(family);
    const scenarioKey = String(topic.scenario?.key || "");
    if (scenarioKey && !signal.scenarios.includes(scenarioKey)) signal.scenarios.push(scenarioKey);
    const entityName = String(topic.entity?.name || "");
    if (entityName && !signal.entities.includes(entityName)) signal.entities.push(entityName);
    for (const keyword of normalizeSentimentMonitorKeywords(topic.suggested_keywords || []).slice(0, 8)) {
      if (!signal.keywords.includes(keyword)) signal.keywords.push(keyword);
      if (signal.keywords.length >= 20) break;
    }
    signals[sourceKey] = signal;
  };
  for (const topic of Array.isArray(topicRecall.topics) ? topicRecall.topics : []) {
    if (!topic || topic.status === "covered") continue;
    const baseWeight = (rank[topic.status] || 0)
      + (topic.persistent_trend === "persistent-gap" ? 2 : topic.persistent_trend === "worsening" ? 1 : 0);
    if (!baseWeight) continue;
    const priorityBoost = Math.max(0, Math.min(100, Number(topic.entity?.priority || 50))) / 50;
    const recallBoost = Math.max(0, (100 - Number(topic.recall_score || 0)) / 40);
    const families = [
      ...(Array.isArray(topic.missing_families) ? topic.missing_families.map(family => ({ family, multiplier: 1 })) : []),
      ...(Array.isArray(topic.weak_families) ? topic.weak_families.map(family => ({ family, multiplier: 0.5 })) : []),
    ];
    for (const { family, multiplier } of families) {
      const sourceKeys = ENTITY_TOPIC_RECALL_FAMILY_SOURCES.get(String(family || "")) || [];
      const weight = baseWeight * multiplier + priorityBoost + recallBoost;
      for (const sourceKey of sourceKeys) addSignal(sourceKey, topic, family, weight);
    }
  }
  for (const signal of Object.values(signals)) {
    signal.score = Math.round(Math.min(Number(maxBoost) || 24, signal.score) * 10) / 10;
    signal.priorityBoost = Math.round(signal.score);
    signal.budgetBoost = Math.min(0.4, Math.round((signal.score / 60) * 100) / 100);
    signal.action = signal.score >= 7 ? "prioritize-topic-gap-source" : "watch-topic-gap-source";
  }
  return Object.fromEntries(Object.entries(signals).sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function mergeEntityTopicSourceRecallSignals(sourceSignals = {}, sourceRecall = {}, { maxBoost = 28 } = {}) {
  const signals = { ...(sourceSignals || {}) };
  const rank = { "missing-source-topic": 4, "weak-source-topic": 2, covered: 0 };
  for (const item of Array.isArray(sourceRecall.sources) ? sourceRecall.sources : []) {
    if (!item || item.status === "covered") continue;
    const sourceKey = String(item.source_key || "");
    if (!sourceKey) continue;
    const weight = (rank[item.status] || 0)
      + Math.max(0, Math.min(100, Number(item.entity?.priority || 50))) / 55
      + Math.max(0, (100 - Number(item.recall_score || 0)) / 45);
    const signal = signals[sourceKey] || {
      sourceKey,
      score: 0,
      topicCount: 0,
      families: [],
      scenarios: [],
      entities: [],
      keywords: [],
    };
    signal.score = Number(signal.score || 0) + weight;
    signal.topicCount = Number(signal.topicCount || 0) + 1;
    signal.sourceTopicCount = Number(signal.sourceTopicCount || 0) + 1;
    signal.sourceRecallStatus = item.status;
    if (item.source_family && !signal.families.includes(item.source_family)) signal.families.push(item.source_family);
    const scenarioKey = String(item.scenario?.key || "");
    if (scenarioKey && !signal.scenarios.includes(scenarioKey)) signal.scenarios.push(scenarioKey);
    const entityName = String(item.entity?.name || "");
    if (entityName && !signal.entities.includes(entityName)) signal.entities.push(entityName);
    for (const keyword of normalizeSentimentMonitorKeywords(item.suggested_keywords || []).slice(0, 8)) {
      if (!signal.keywords.includes(keyword)) signal.keywords.push(keyword);
      if (signal.keywords.length >= 24) break;
    }
    signals[sourceKey] = signal;
  }
  for (const signal of Object.values(signals)) {
    signal.score = Math.round(Math.min(Number(maxBoost) || 28, Number(signal.score || 0)) * 10) / 10;
    signal.priorityBoost = Math.round(signal.score);
    signal.budgetBoost = Math.min(0.45, Math.round((signal.score / 62) * 100) / 100);
    signal.action = signal.score >= 7 ? "prioritize-topic-gap-source" : "watch-topic-gap-source";
  }
  return Object.fromEntries(Object.entries(signals).sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function collectEntityKeyword(scores, term, score = 1) {
  const key = String(term || "").replace(/\s+/g, " ").trim();
  if (!key || key.length > 120) return;
  scores.set(key, (scores.get(key) || 0) + score);
}

function monitoredEntityPrecisionTerms(monitoredEntities = {}) {
  if (!monitoredEntities || monitoredEntities.enabled === false) return [];
  const out = [];
  const push = (value) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text || text.length < 2 || text.length > 120) return;
    out.push(text);
  };
  const entities = (Array.isArray(monitoredEntities.entities) ? monitoredEntities.entities : [])
    .filter(entity => entity && entity.enabled !== false);
  for (const entity of entities) {
    push(entity.name);
    for (const value of [
      ...(entity.aliases || []),
      ...(entity.products || []),
      ...(entity.typoVariants || entity.typo_variants || []),
      ...(entity.domains || []),
      ...(entity.officialUrls || entity.official_urls || []),
      ...(entity.socialHandles || entity.social_handles || []),
    ]) {
      push(value);
      const domain = entityDomainFromValue(value);
      if (domain) {
        push(domain);
        const domainParts = domain.split(".").filter(Boolean);
        if (domainParts[0]) push(domainParts[0]);
        if (domainParts.length > 2) push(domainParts.slice(-2).join("."));
      }
      const handle = entityHandleFromValue(value);
      if (handle) push(handle);
    }
  }
  return uniqueExpansionTerms(out, 160);
}

export function deriveMonitoredEntityKeywords(monitoredEntities = {}, {
  mode = SCAN_MODE_FAST,
  baseKeywords = [],
} = {}) {
  if (!monitoredEntities || monitoredEntities.enabled === false) return [];
  const limit = mode === SCAN_MODE_FULL
    ? Math.max(0, Number(monitoredEntities.maxTermsFull ?? monitoredEntities.max_terms_full ?? 24) || 0)
    : Math.max(0, Number(monitoredEntities.maxTermsFast ?? monitoredEntities.max_terms_fast ?? 8) || 0);
  if (!limit) return [];
  const protectedBase = new Set(normalizeSentimentMonitorKeywords(baseKeywords));
  const includeRiskCombos = monitoredEntities.includeRiskCombos !== false && monitoredEntities.include_risk_combos !== false;
  const includeRoleCombos = monitoredEntities.includeRoleCombos !== false && monitoredEntities.include_role_combos !== false;
  const scores = new Map();
  const entities = (Array.isArray(monitoredEntities.entities) ? monitoredEntities.entities : [])
    .filter(entity => entity && entity.enabled !== false)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  for (const entity of entities) {
    const name = String(entity.name || "").replace(/\s+/g, " ").trim();
    const aliases = normalizeSentimentMonitorKeywords(entity.aliases || []);
    const products = normalizeSentimentMonitorKeywords(entity.products || []);
    const people = normalizeSentimentMonitorKeywords(entity.people || []);
    const competitors = normalizeSentimentMonitorKeywords(entity.competitors || []);
    const typos = normalizeSentimentMonitorKeywords(entity.typoVariants || entity.typo_variants || []);
    const industryTerms = normalizeSentimentMonitorKeywords(entity.industryTerms || entity.industry_terms || []);
    const platformHints = normalizeSentimentMonitorKeywords(entity.platformHints || entity.platform_hints || []);
    const negativeTerms = normalizeSentimentMonitorKeywords(entity.negativeTerms || entity.negative_terms || []);
    const mainTerms = normalizeSentimentMonitorKeywords([name, ...aliases, ...typos]);
    for (const term of mainTerms) collectEntityKeyword(scores, term, 12 + Number(entity.priority || 0) / 25);
    for (const term of products) collectEntityKeyword(scores, term, 8);
    for (const term of people) collectEntityKeyword(scores, term, 7);
    for (const term of competitors) collectEntityKeyword(scores, term, 6);
    for (const term of industryTerms) collectEntityKeyword(scores, term, 4);
    if (includeRiskCombos) {
      const riskTerms = negativeTerms.length ? negativeTerms : RISK_SCAN_TERMS.slice(0, 6);
      for (const main of mainTerms.slice(0, 6)) {
        for (const risk of riskTerms.slice(0, mode === SCAN_MODE_FULL ? 8 : 4)) {
          if (!main.includes(risk)) collectEntityKeyword(scores, `${main} ${risk}`, 9);
        }
      }
      for (const product of products.slice(0, 4)) {
        for (const risk of riskTerms.slice(0, mode === SCAN_MODE_FULL ? 4 : 2)) {
          if (!product.includes(risk)) collectEntityKeyword(scores, `${product} ${risk}`, 6);
        }
      }
    }
    if (includeRoleCombos) {
      for (const person of people.slice(0, 4)) {
        collectEntityKeyword(scores, `${person} ${name || "品牌"}`, 5);
        collectEntityKeyword(scores, `${person} 爆料`, 4);
      }
      for (const competitor of competitors.slice(0, 4)) {
        collectEntityKeyword(scores, `${name || mainTerms[0]} ${competitor}`, 4);
      }
    }
    for (const platform of platformHints.slice(0, 6)) {
      for (const main of mainTerms.slice(0, 3)) collectEntityKeyword(scores, `${main} ${platform}`, 4);
    }
  }
  return [...scores.entries()]
    .filter(([term]) => !protectedBase.has(term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"))
    .map(([term]) => term)
    .slice(0, limit);
}

function entityDomainFromValue(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split("/")[0]
      .split("?")[0]
      .toLowerCase();
  }
}

function entityHandleFromValue(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw) && !raw.includes("/")) return raw.replace(/^@+/, "").trim();
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const path = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return path.replace(/^@+/, "") || parsed.hostname.replace(/^www\./i, "").split(".")[0];
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/^@+/, "")
      .replace(/^www\./i, "")
      .split(/[/?#]/)[0]
      .trim();
  }
}

function footprintSourceMode(sourceKey = "") {
  if (["duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "googleNews", "bingNews", "baiduNews", "openWebDiscovery", "gdelt", "rssFeeds", "officialRegulatory", "legalPublicRecords", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "brandImpersonationSources", "securityAdvisorySources", "supplyChainAdvisorySources", "investorDiscussionSources", "publicStatusPageSources", "officialOwnedMediaSources"].includes(sourceKey)) return "search";
  if (["bluesky", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "mastodon", "youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch", "reddit", "lemmy", "ptt", "dcard"].includes(sourceKey)) return "social";
  return "";
}

function monitoredEntitySourceProfile(sourceKey = "") {
  if (["publicReviewSites", "verticalReviewSources", "employerReviewSources", "ecommerceReviewSources", "localReviewSources", "regionalComplaintSources", "appStoreReviews", "googlePlayReviews"].includes(sourceKey)) return "review";
  if (["officialRegulatory", "legalPublicRecords", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicStatusPageSources", "officialOwnedMediaSources"].includes(sourceKey)) return "official";
  if (["brandImpersonationSources", "securityAdvisorySources", "supplyChainAdvisorySources"].includes(sourceKey)) return "security";
  if (["publicCompanyFilingsSources", "investorDiscussionSources"].includes(sourceKey)) return "market";
  if (["youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch", "applePodcastSearch"].includes(sourceKey)) return "video";
  if (["reddit", "ptt", "dcard", "telegramPublic", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "tiebaSearch", "githubIssues", "gitLabIssues", "hackerNews", "stackOverflow", "discourseForums", "lemmy", "zhihuSearch", "quoraSearch"].includes(sourceKey)) return "community";
  if (["substackSearch", "mediumSearch", "wordpressSearch", "blogspotSearch", "tumblrSearch"].includes(sourceKey)) return "blog";
  return footprintSourceMode(sourceKey) || "search";
}

function sourceProfileTerms(sourceKey = "") {
  const profile = monitoredEntitySourceProfile(sourceKey);
  if (profile === "review") return ["review", "rating", "complaint", "refund", "negative review", "客訴", "負評"];
  if (profile === "official") return ["official statement", "press release", "recall", "warning", "lawsuit", "regulatory", "官方聲明", "公告"];
  if (profile === "security") return ["phishing", "impersonation", "vulnerability", "security advisory", "data breach", "釣魚", "漏洞"];
  if (profile === "market") return ["investor", "market sentiment", "filing", "8-K", "short seller", "earnings", "股價", "投資人"];
  if (profile === "video") return ["video", "comments", "reaction", "follow-up", "YouTube", "短影音", "留言"];
  if (profile === "community") return ["discussion", "complaint", "thread", "repost", "viral", "爆料", "討論"];
  if (profile === "blog") return ["blog", "newsletter", "commentary", "analysis", "review", "文章"];
  return ["news", "coverage", "complaint", "backlash", "statement", "報導", "輿論"];
}

function sourceLocaleHints(sourceKey = "") {
  if (["yahooJapanNews"].includes(sourceKey)) return ["ja"];
  if (["naverKoreaNews", "daumKoreaNews"].includes(sourceKey)) return ["ko"];
  if (["baiduSearch", "baiduNews", "sogouSearch", "soSearch", "wechatPublicSearch", "toutiaoSearch", "tiebaSearch", "weiboSearch", "xiaohongshuSearch", "douyinSearch", "kuaishouSearch", "bilibili"].includes(sourceKey)) return ["zh-Hans"];
  if (["taiwanNews", "yahooTaiwan", "ptt", "dcard"].includes(sourceKey)) return ["zh-Hant"];
  if (["googleNews", "bingNews", "duckDuckGo", "openWebDiscovery", "gdelt", "rssFeeds", "publicReviewSites", "regionalComplaintSources", "appStoreReviews", "googlePlayReviews"].includes(sourceKey)) return ["en", "zh-Hant"];
  return [];
}

function sourceHasDedicatedLocale(sourceKey = "") {
  return [
    "yahooJapanNews", "naverKoreaNews", "daumKoreaNews",
    "baiduSearch", "baiduNews", "sogouSearch", "soSearch", "wechatPublicSearch", "toutiaoSearch",
    "tiebaSearch", "weiboSearch", "xiaohongshuSearch", "douyinSearch", "kuaishouSearch", "bilibili",
    "taiwanNews", "yahooTaiwan", "ptt", "dcard",
  ].includes(sourceKey);
}

function sourceSpecificLocaleRiskKeywords(sourceKey = "", baseKeywords = [], keywordExpansion = {}, {
  mode = SCAN_MODE_FAST,
} = {}) {
  const key = String(sourceKey || "");
  if (!key) return [];
  if (!sourceHasDedicatedLocale(key)) return [];
  const includeMultilingual = keywordExpansion?.includeMultilingual !== false
    && keywordExpansion?.include_multilingual !== false;
  if (!includeMultilingual) return [];
  const locales = normalizedLocaleKeys(sourceLocaleHints(key), 8);
  if (!locales.length) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords)
    .slice(0, mode === SCAN_MODE_FULL ? 6 : 3);
  if (!base.length) return [];
  const riskTerms = multilingualRiskTermsForExpansion({
    multilingualLocales: locales,
    multilingualRiskTerms: keywordExpansion?.multilingualRiskTerms || keywordExpansion?.multilingual_risk_terms || [],
  }).slice(0, mode === SCAN_MODE_FULL ? 10 : 5);
  if (!riskTerms.length) return [];
  const out = [];
  for (const keyword of base) {
    for (const risk of riskTerms) {
      if (keyword === risk || keyword.toLowerCase().includes(String(risk || "").toLowerCase())) continue;
      out.push(`${keyword} ${risk}`);
    }
  }
  const limit = sourceHasDedicatedLocale(key)
    ? (mode === SCAN_MODE_FULL ? 24 : 12)
    : (mode === SCAN_MODE_FULL ? 12 : 8);
  return normalizeSentimentMonitorKeywords(out).slice(0, limit);
}

function normalizedLocaleKeys(values = [], limit = 12) {
  const aliases = new Map([
    ["zh", "zh-Hans"],
    ["zh-cn", "zh-Hans"],
    ["zh-hans", "zh-Hans"],
    ["cn", "zh-Hans"],
    ["china", "zh-Hans"],
    ["zh-tw", "zh-Hant"],
    ["zh-hk", "zh-Hant"],
    ["zh-hant", "zh-Hant"],
    ["tw", "zh-Hant"],
    ["taiwan", "zh-Hant"],
    ["hk", "zh-Hant"],
    ["jp", "ja"],
    ["japan", "ja"],
    ["kr", "ko"],
    ["korea", "ko"],
    ["south-korea", "ko"],
    ["us", "en"],
    ["uk", "en"],
    ["gb", "en"],
    ["usa", "en"],
    ["america", "en"],
  ]);
  const out = [];
  for (const value of uniqueExpansionTerms(values, limit * 2)) {
    const raw = String(value || "").trim();
    const lower = raw.toLowerCase().replace(/_/g, "-");
    const key = aliases.get(lower) || raw;
    if (MULTILINGUAL_RISK_TERM_PACKS[key] && !out.includes(key)) out.push(key);
    else if (MULTILINGUAL_RISK_TERM_PACKS[lower] && !out.includes(lower)) out.push(lower);
    if (out.length >= limit) break;
  }
  return out;
}

function termLooksLikeLocale(value = "", locale = "") {
  const text = String(value || "");
  const key = String(locale || "").toLowerCase();
  if (!text.trim()) return false;
  if (key === "ja") return /[ぁ-ゟ゠-ヿ]/u.test(text);
  if (key === "ko") return /[가-힣]/u.test(text);
  if (key === "ar") return /[\u0600-\u06FF]/u.test(text);
  if (key === "hi") return /[\u0900-\u097F]/u.test(text);
  if (key === "th") return /[\u0E00-\u0E7F]/u.test(text);
  if (key === "zh-hans" || key === "zh-hant") return /[\u4e00-\u9fff]/u.test(text);
  if (key === "en" || key === "es" || key === "fr" || key === "de" || key === "pt" || key === "vi") return /[a-z]/i.test(text);
  return false;
}

export function deriveMonitoredEntitySourceKeywords(monitoredEntities = {}, {
  mode = SCAN_MODE_FAST,
  sourceKey = "",
  baseKeywords = [],
  keywordExpansion = {},
  limit = null,
} = {}) {
  if (!monitoredEntities || monitoredEntities.enabled === false || !sourceKey) return [];
  if (monitoredEntities.includeSourceProfileKeywords === false
    || monitoredEntities.include_source_profile_keywords === false
    || monitoredEntities.sourceProfileKeywords === false
    || monitoredEntities.source_profile_keywords === false) return [];
  const includeMultilingual = monitoredEntities.includeMultilingualSourceKeywords !== false
    && monitoredEntities.include_multilingual_source_keywords !== false
    && monitoredEntities.multilingualSourceKeywords !== false
    && monitoredEntities.multilingual_source_keywords !== false
    && keywordExpansion?.includeMultilingual !== false
    && keywordExpansion?.include_multilingual !== false;
  const defaultLimit = mode === SCAN_MODE_FULL ? 28 : 24;
  const safeLimit = Math.max(0, Math.min(mode === SCAN_MODE_FULL ? 36 : 24, Number(limit ?? defaultLimit) || 0));
  if (!safeLimit) return [];
  const protectedBase = new Set(normalizeSentimentMonitorKeywords(baseKeywords));
  const scores = new Map();
  const profile = monitoredEntitySourceProfile(sourceKey);
  const profileTerms = sourceProfileTerms(sourceKey);
  const entities = (Array.isArray(monitoredEntities.entities) ? monitoredEntities.entities : [])
    .filter(entity => entity && entity.enabled !== false)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

  for (const entity of entities) {
    const priorityBoost = Math.max(0, Math.min(100, Number(entity.priority || 50))) / 25;
    const name = String(entity.name || "").replace(/\s+/g, " ").trim();
    const aliases = normalizeSentimentMonitorKeywords(entity.aliases || []);
    const products = normalizeSentimentMonitorKeywords(entity.products || []);
    const people = normalizeSentimentMonitorKeywords(entity.people || []);
    const competitors = normalizeSentimentMonitorKeywords(entity.competitors || []);
    const typos = normalizeSentimentMonitorKeywords(entity.typoVariants || entity.typo_variants || []);
    const industryTerms = normalizeSentimentMonitorKeywords(entity.industryTerms || entity.industry_terms || []);
    const negativeTerms = normalizeSentimentMonitorKeywords(entity.negativeTerms || entity.negative_terms || []);
    const platformHints = normalizeSentimentMonitorKeywords(entity.platformHints || entity.platform_hints || []);
    const localizedAliases = normalizeSentimentMonitorKeywords(entity.localizedAliases || entity.localized_aliases || entity.localeAliases || entity.locale_aliases || []);
    const mainTerms = normalizeSentimentMonitorKeywords([name, ...aliases, ...typos]).slice(0, mode === SCAN_MODE_FULL ? 8 : 5);
    const contextTerms = normalizeSentimentMonitorKeywords([...products, ...people, ...industryTerms]).slice(0, mode === SCAN_MODE_FULL ? 8 : 5);
    const riskTerms = (negativeTerms.length ? negativeTerms : RISK_SCAN_TERMS).slice(0, mode === SCAN_MODE_FULL ? 8 : 4);
    const sourceLocales = sourceLocaleHints(sourceKey);
    const entityLocales = entity.locales || entity.languages || entity.languageHints || entity.language_hints || entity.markets || entity.marketHints || entity.market_hints || [];
    const localeKeys = includeMultilingual
      ? normalizedLocaleKeys(
        sourceHasDedicatedLocale(sourceKey) && sourceLocales.length
          ? sourceLocales
          : [...entityLocales, ...sourceLocales],
        mode === SCAN_MODE_FULL ? 8 : 4,
      )
      : [];
    const localeRiskTerms = localeKeys.length
      ? multilingualRiskTermsForExpansion({
        multilingualLocales: localeKeys,
        multilingualRiskTerms: keywordExpansion?.multilingualRiskTerms || keywordExpansion?.multilingual_risk_terms || [],
      }).slice(0, mode === SCAN_MODE_FULL ? 10 : 5)
      : [];
    const localeRiskTermsByLocale = new Map(localeKeys.map(locale => [
      locale,
      multilingualRiskTermsForExpansion({ multilingualLocales: [locale] }).slice(0, mode === SCAN_MODE_FULL ? 5 : 3),
    ]));

    for (const localized of localizedAliases.slice(0, mode === SCAN_MODE_FULL ? 8 : 5)) {
      collectEntityKeyword(scores, localized, 14 + priorityBoost);
    }

    for (const main of mainTerms) {
      collectEntityKeyword(scores, main, 8 + priorityBoost);
      for (const risk of riskTerms) {
        if (main !== risk && !main.includes(risk)) collectEntityKeyword(scores, `${main} ${risk}`, 14 + priorityBoost);
      }
      for (const profileTerm of profileTerms.slice(0, mode === SCAN_MODE_FULL ? 6 : 4)) {
        if (!main.toLowerCase().includes(profileTerm.toLowerCase())) collectEntityKeyword(scores, `${main} ${profileTerm}`, 7 + priorityBoost);
      }
    }

    for (const product of products.slice(0, mode === SCAN_MODE_FULL ? 6 : 4)) {
      for (const risk of riskTerms.slice(0, 4)) {
        if (product !== risk && !product.includes(risk)) collectEntityKeyword(scores, `${product} ${risk}`, 10 + priorityBoost);
      }
      if (profile === "review") collectEntityKeyword(scores, `${product} review`, 9 + priorityBoost);
      if (profile === "video") collectEntityKeyword(scores, `${product} video`, 8 + priorityBoost);
      if (profile === "official") collectEntityKeyword(scores, `${product} official statement`, 8 + priorityBoost);
      if (profile === "security") collectEntityKeyword(scores, `${product} vulnerability`, 8 + priorityBoost);
    }

    for (const context of contextTerms) {
      for (const risk of riskTerms.slice(0, profile === "review" || profile === "community" ? 4 : 2)) {
        if (context !== risk && !context.includes(risk)) collectEntityKeyword(scores, `${context} ${risk}`, 6 + priorityBoost);
      }
      if (profile === "review") collectEntityKeyword(scores, `${context} review`, 6 + priorityBoost);
      if (profile === "video") collectEntityKeyword(scores, `${context} video`, 5 + priorityBoost);
      if (profile === "official") collectEntityKeyword(scores, `${context} official statement`, 5 + priorityBoost);
      if (profile === "security") collectEntityKeyword(scores, `${context} vulnerability`, 5 + priorityBoost);
    }

    for (const person of people.slice(0, mode === SCAN_MODE_FULL ? 4 : 2)) {
      collectEntityKeyword(scores, `${person} ${name || mainTerms[0] || "brand"}`, 5 + priorityBoost);
      if (profile === "community" || profile === "video") collectEntityKeyword(scores, `${person} 爆料`, 5 + priorityBoost);
      if (profile === "official") collectEntityKeyword(scores, `${person} statement`, 4 + priorityBoost);
    }

    for (const competitor of competitors.slice(0, mode === SCAN_MODE_FULL ? 5 : 3)) {
      const anchor = name || mainTerms[0];
      if (!anchor) continue;
      collectEntityKeyword(scores, `${anchor} ${competitor}`, 4 + priorityBoost);
      if (profile === "review" || profile === "market") collectEntityKeyword(scores, `${anchor} vs ${competitor}`, 4 + priorityBoost);
    }

    for (const platform of platformHints.slice(0, 5)) {
      for (const main of mainTerms.slice(0, 3)) collectEntityKeyword(scores, `${main} ${platform}`, 5 + priorityBoost);
    }

    if (localeRiskTerms.length && (localizedAliases.length || localeKeys.length)) {
      const matchedLocalizedAliases = sourceHasDedicatedLocale(sourceKey)
        ? localizedAliases.filter(alias => localeKeys.some(locale => termLooksLikeLocale(alias, locale)))
        : localizedAliases;
      for (const localized of matchedLocalizedAliases.slice(0, mode === SCAN_MODE_FULL ? 8 : 5)) {
        const matchedLocaleKeys = localeKeys.filter(locale => termLooksLikeLocale(localized, locale));
        const aliasRiskTerms = uniqueExpansionTerms(
          matchedLocaleKeys.flatMap(locale => localeRiskTermsByLocale.get(locale) || []),
          mode === SCAN_MODE_FULL ? 8 : 5,
        );
        for (const risk of aliasRiskTerms.slice(0, mode === SCAN_MODE_FULL ? 5 : 3)) {
          if (!localized.toLowerCase().includes(risk.toLowerCase())) collectEntityKeyword(scores, `${localized} ${risk}`, 13 + priorityBoost);
        }
      }
      const localizedMainTerms = normalizeSentimentMonitorKeywords([...matchedLocalizedAliases, ...mainTerms]).slice(0, mode === SCAN_MODE_FULL ? 8 : 5);
      for (const localized of localizedMainTerms) {
        for (const risk of localeRiskTerms.slice(0, mode === SCAN_MODE_FULL ? 6 : 4)) {
          if (!localized.toLowerCase().includes(risk.toLowerCase())) collectEntityKeyword(scores, `${localized} ${risk}`, 12 + priorityBoost);
        }
      }
      for (const product of products.slice(0, mode === SCAN_MODE_FULL ? 4 : 2)) {
        for (const risk of localeRiskTerms.slice(0, 3)) {
          if (!product.toLowerCase().includes(risk.toLowerCase())) collectEntityKeyword(scores, `${product} ${risk}`, 4 + priorityBoost);
        }
      }
    }
  }

  return [...scores.entries()]
    .filter(([term]) => !protectedBase.has(term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"))
    .map(([term]) => term)
    .slice(0, safeLimit);
}

export function deriveMonitoredEntityFootprintKeywords(monitoredEntities = {}, {
  mode = SCAN_MODE_FAST,
  sourceKey = "",
  baseKeywords = [],
  limit = null,
} = {}) {
  if (!monitoredEntities || monitoredEntities.enabled === false) return [];
  const defaultLimit = sourceKey
    ? (mode === SCAN_MODE_FULL ? 30 : 14)
    : (mode === SCAN_MODE_FULL ? 24 : 8);
  const safeLimit = Math.max(0, Math.min(
    mode === SCAN_MODE_FULL ? 36 : (sourceKey ? 20 : 12),
    Number(limit ?? defaultLimit) || 0,
  ));
  if (!safeLimit) return [];
  const protectedBase = new Set(normalizeSentimentMonitorKeywords(baseKeywords));
  const scores = new Map();
  const sourceMode = footprintSourceMode(sourceKey);
  const entities = (Array.isArray(monitoredEntities.entities) ? monitoredEntities.entities : [])
    .filter(entity => entity && entity.enabled !== false)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

  for (const entity of entities) {
    const priorityBoost = Number(entity.priority || 50) / 25;
    const name = String(entity.name || "").replace(/\s+/g, " ").trim();
    const aliases = normalizeSentimentMonitorKeywords(entity.aliases || []);
    const products = normalizeSentimentMonitorKeywords(entity.products || []);
    const typos = normalizeSentimentMonitorKeywords(entity.typoVariants || entity.typo_variants || []);
    const people = normalizeSentimentMonitorKeywords(entity.people || []);
    const competitors = normalizeSentimentMonitorKeywords(entity.competitors || []);
    const negativeTerms = normalizeSentimentMonitorKeywords(entity.negativeTerms || entity.negative_terms || []).slice(0, mode === SCAN_MODE_FULL ? 8 : 4);
    const riskTerms = negativeTerms.length ? negativeTerms : RISK_SCAN_TERMS.slice(0, mode === SCAN_MODE_FULL ? 6 : 3);
    const mainTerms = normalizeSentimentMonitorKeywords([name, ...aliases, ...typos]).slice(0, 8);
    const contextTerms = normalizeSentimentMonitorKeywords([...products, ...people, ...competitors]).slice(0, mode === SCAN_MODE_FULL ? 8 : 4);
    const domains = uniqueExpansionTerms([
      ...(entity.domains || entity.domainNames || entity.domain_names || []),
      ...(entity.officialUrls || entity.official_urls || []),
    ].map(entityDomainFromValue).filter(Boolean), 20);
    const handles = uniqueExpansionTerms(
      uniqueExpansionTerms(entity.socialHandles || entity.social_handles || entity.handles || [], 30)
        .map(entityHandleFromValue)
        .filter(Boolean),
      30,
    );

    if (!domains.length && !handles.length) continue;
    for (const domain of domains.slice(0, sourceMode === "search" ? 8 : 4)) {
      if (!domain || protectedBase.has(domain)) continue;
      if (!sourceMode) {
        for (const main of mainTerms.slice(0, 3)) collectEntityKeyword(scores, `${main} ${domain}`, 12 + priorityBoost);
      } else if (sourceMode === "search") {
        for (const main of mainTerms.slice(0, 4)) collectEntityKeyword(scores, `site:${domain} ${main}`, 12 + priorityBoost);
        for (const risk of riskTerms.slice(0, 4)) {
          const anchor = mainTerms[0] || name || domain;
          collectEntityKeyword(scores, `site:${domain} ${anchor} ${risk}`, 13 + priorityBoost);
        }
      } else {
        for (const main of mainTerms.slice(0, 3)) collectEntityKeyword(scores, `${main} ${domain}`, 7 + priorityBoost);
      }
      for (const context of contextTerms.slice(0, 4)) collectEntityKeyword(scores, `${context} ${domain}`, 5 + priorityBoost);
    }

    for (const [handleIndex, handle] of handles.slice(0, sourceMode === "social" ? 10 : 5).entries()) {
      if (!handle || protectedBase.has(handle)) continue;
      const handleTerm = handle.startsWith("@") ? handle : `@${handle}`;
      const handlePriority = Math.max(0, 3 - handleIndex);
      if (sourceMode === "search") {
        for (const main of mainTerms.slice(0, 3)) collectEntityKeyword(scores, `"${handleTerm}" ${main}`, 8 + priorityBoost + handlePriority);
      } else {
        collectEntityKeyword(scores, handleTerm, (sourceMode === "social" ? 10 : 6) + priorityBoost + handlePriority);
        for (const main of mainTerms.slice(0, 3)) collectEntityKeyword(scores, `${main} ${handleTerm}`, (sourceMode === "social" ? 9 : 6) + priorityBoost + handlePriority);
        for (const risk of riskTerms.slice(0, 4)) collectEntityKeyword(scores, `${handleTerm} ${risk}`, (sourceMode === "social" ? 7 : 5) + priorityBoost + handlePriority);
      }
    }
  }

  return [...scores.entries()]
    .filter(([term]) => !protectedBase.has(term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"))
    .map(([term]) => term)
    .slice(0, safeLimit);
}

export function deriveCollectionQualityKeywordFeedback(collectionQuality = {}, {
  mode = SCAN_MODE_FAST,
  settings = {},
  baseKeywords = [],
} = {}) {
  const normalizedSettings = {
    enabled: settings.enabled !== false,
    minKeywordSamples: clampBudgetValue(settings.minKeywordSamples ?? settings.min_keyword_samples, 1, 100, 5),
    maxSuppressedKeywords: clampBudgetValue(settings.maxSuppressedKeywords ?? settings.max_suppressed_keywords, 0, 200, 20),
    promotedKeywordsFast: clampBudgetValue(settings.promotedKeywordsFast ?? settings.promoted_keywords_fast, 0, 30, 3),
    promotedKeywordsFull: clampBudgetValue(settings.promotedKeywordsFull ?? settings.promoted_keywords_full, 0, 60, 8),
    minPromoteScore: clampBudgetValue(settings.minPromoteScore ?? settings.min_promote_score, 0, 100, 75),
    maxSuppressScore: clampBudgetValue(settings.maxSuppressScore ?? settings.max_suppress_score, 0, 100, 30),
    suppressLowQualityRate: clampBudgetValue(settings.suppressLowQualityRate ?? settings.suppress_low_quality_rate, 0, 100, 60),
    suppressFailureRate: clampBudgetValue(settings.suppressFailureRate ?? settings.suppress_failure_rate, 0, 100, 50),
  };
  if (!normalizedSettings.enabled) {
    return { promotedKeywords: [], suppressedKeywords: [], keywordActions: [] };
  }
  const protectedKeywords = new Set(normalizeSentimentMonitorKeywords(baseKeywords));
  const promoteLimit = mode === SCAN_MODE_FULL
    ? normalizedSettings.promotedKeywordsFull
    : normalizedSettings.promotedKeywordsFast;
  const promotedKeywords = [];
  const suppressedKeywords = [];
  const keywordActions = [];
  for (const item of Array.isArray(collectionQuality.keywords) ? collectionQuality.keywords : []) {
    const key = String(item?.key || "").replace(/\s+/g, " ").trim();
    if (!key) continue;
    const total = Number(item.total || 0);
    const acceptedCount = Number(item.accepted || item.accepted_count || 0);
    const score = Number(item.score || 0);
    const eventCount = Number(item.event_count || 0);
    const lowQualityRate = Number(item.low_quality_rate || 0);
    const failureRate = Number(item.failure_rate || 0);
    const effectiveRate = Number(item.effective_rate || 0);
    const action = String(item.action || "");
    const suppress = total >= normalizedSettings.minKeywordSamples
      && eventCount <= 0
      && !protectedKeywords.has(key)
      && (
        action === "suppress"
        || score <= normalizedSettings.maxSuppressScore
        || lowQualityRate >= normalizedSettings.suppressLowQualityRate
        || failureRate >= normalizedSettings.suppressFailureRate
      );
    const promoteByEvent = eventCount > 0 && score >= normalizedSettings.minPromoteScore;
    const promoteByEffectiveEvidence = acceptedCount >= normalizedSettings.minKeywordSamples
      && effectiveRate >= 70
      && lowQualityRate < 25
      && failureRate < 25
      && score >= Math.max(30, normalizedSettings.minPromoteScore - 45);
    const promote = (promoteByEvent || promoteByEffectiveEvidence) && action !== "suppress";
    if (suppress && suppressedKeywords.length < normalizedSettings.maxSuppressedKeywords && !suppressedKeywords.includes(key)) {
      suppressedKeywords.push(key);
      keywordActions.push({ keyword: key, action: "suppress", score, total, event_count: eventCount, low_quality_rate: lowQualityRate, failure_rate: failureRate });
      continue;
    }
    if (promote && promotedKeywords.length < promoteLimit && !promotedKeywords.includes(key)) {
      promotedKeywords.push(key);
      keywordActions.push({
        keyword: key,
        action: "promote",
        reason: promoteByEvent ? "event-backed-keyword" : "high-effective-evidence-keyword",
        score,
        total,
        accepted_count: acceptedCount,
        event_count: eventCount,
        effective_rate: effectiveRate,
        low_quality_rate: lowQualityRate,
        failure_rate: failureRate,
      });
    }
  }
  return { promotedKeywords, suppressedKeywords, keywordActions };
}

export function deriveCollectionQualitySourceKeywordFeedback(collectionQuality = {}, sourceKey = "", {
  mode = SCAN_MODE_FAST,
  settings = {},
  baseKeywords = [],
} = {}) {
  const key = String(sourceKey || "");
  const normalizedSettings = {
    enabled: settings.enabled !== false,
    minKeywordSamples: clampBudgetValue(
      settings.minSourceKeywordSamples ?? settings.min_source_keyword_samples ?? settings.minKeywordSamples ?? settings.min_keyword_samples,
      1,
      100,
      3,
    ),
    maxSuppressedKeywords: clampBudgetValue(
      settings.maxSuppressedSourceKeywords ?? settings.max_suppressed_source_keywords ?? settings.maxSuppressedKeywords ?? settings.max_suppressed_keywords,
      0,
      200,
      12,
    ),
    promotedKeywordsFast: clampBudgetValue(
      settings.promotedSourceKeywordsFast ?? settings.promoted_source_keywords_fast ?? settings.promotedKeywordsFast ?? settings.promoted_keywords_fast,
      0,
      30,
      3,
    ),
    promotedKeywordsFull: clampBudgetValue(
      settings.promotedSourceKeywordsFull ?? settings.promoted_source_keywords_full ?? settings.promotedKeywordsFull ?? settings.promoted_keywords_full,
      0,
      60,
      6,
    ),
    minPromoteScore: clampBudgetValue(settings.minPromoteScore ?? settings.min_promote_score, 0, 100, 75),
    maxSuppressScore: clampBudgetValue(settings.maxSuppressScore ?? settings.max_suppress_score, 0, 100, 30),
    suppressLowQualityRate: clampBudgetValue(settings.suppressLowQualityRate ?? settings.suppress_low_quality_rate, 0, 100, 60),
    suppressFailureRate: clampBudgetValue(settings.suppressFailureRate ?? settings.suppress_failure_rate, 0, 100, 50),
    suppressZeroResultRate: clampBudgetValue(settings.suppressZeroResultRate ?? settings.suppress_zero_result_rate, 0, 100, 80),
  };
  if (!normalizedSettings.enabled || !key) {
    return { promotedKeywords: [], suppressedKeywords: [], keywordActions: [] };
  }
  const protectedKeywords = new Set(normalizeSentimentMonitorKeywords(baseKeywords));
  const promoteLimit = mode === SCAN_MODE_FULL
    ? normalizedSettings.promotedKeywordsFull
    : normalizedSettings.promotedKeywordsFast;
  const promotedKeywords = [];
  const suppressedKeywords = [];
  const keywordActions = [];
  for (const item of Array.isArray(collectionQuality.source_keywords) ? collectionQuality.source_keywords : []) {
    const itemSource = String(item?.source_key || item?.sourceKey || "");
    if (itemSource !== key) continue;
    const keyword = String(item?.key || "").replace(/\s+/g, " ").trim();
    if (!keyword) continue;
    const total = Number(item.total || 0);
    const acceptedCount = Number(item.accepted || item.accepted_count || 0);
    const score = Number(item.score || 0);
    const eventCount = Number(item.event_count || 0);
    const highRiskCount = Number(item.high_risk_count || 0);
    const lowQualityRate = Number(item.low_quality_rate || 0);
    const failureRate = Number(item.failure_rate || 0);
    const zeroResultRate = Number(item.zero_result_rate || 0);
    const effectiveRate = Number(item.effective_rate || 0);
    const action = String(item.action || "");
    const suppress = total >= normalizedSettings.minKeywordSamples
      && eventCount <= 0
      && highRiskCount <= 0
      && !protectedKeywords.has(keyword)
      && (
        action === "suppress"
        || score <= normalizedSettings.maxSuppressScore
        || lowQualityRate >= normalizedSettings.suppressLowQualityRate
        || failureRate >= normalizedSettings.suppressFailureRate
        || zeroResultRate >= normalizedSettings.suppressZeroResultRate
      );
    const promoteByEventOrRisk = (eventCount > 0 || highRiskCount > 0) && score >= normalizedSettings.minPromoteScore;
    const promoteByEffectiveEvidence = acceptedCount >= normalizedSettings.minKeywordSamples
      && effectiveRate >= 70
      && lowQualityRate < 25
      && failureRate < 25
      && zeroResultRate < 35
      && score >= Math.max(30, normalizedSettings.minPromoteScore - 45);
    const promote = (promoteByEventOrRisk || promoteByEffectiveEvidence) && action !== "suppress";
    if (suppress && suppressedKeywords.length < normalizedSettings.maxSuppressedKeywords && !suppressedKeywords.includes(keyword)) {
      suppressedKeywords.push(keyword);
      keywordActions.push({ source_key: key, keyword, action: "suppress", score, total, event_count: eventCount, high_risk_count: highRiskCount, low_quality_rate: lowQualityRate, failure_rate: failureRate, zero_result_rate: zeroResultRate });
      continue;
    }
    if (promote && promotedKeywords.length < promoteLimit && !promotedKeywords.includes(keyword)) {
      promotedKeywords.push(keyword);
      keywordActions.push({
        source_key: key,
        keyword,
        action: "promote",
        reason: promoteByEventOrRisk ? "event-or-risk-backed-source-keyword" : "high-effective-source-keyword",
        score,
        total,
        accepted_count: acceptedCount,
        event_count: eventCount,
        high_risk_count: highRiskCount,
        effective_rate: effectiveRate,
        low_quality_rate: lowQualityRate,
        failure_rate: failureRate,
        zero_result_rate: zeroResultRate,
      });
    }
  }
  return { promotedKeywords, suppressedKeywords, keywordActions };
}

function normalizeTemplatePackKeys(value) {
  const keys = uniqueExpansionTerms(value, 20);
  return keys.length ? keys : DEFAULT_QUERY_TEMPLATE_PACK_KEYS;
}

function templatesFromPacks(value) {
  const out = [];
  for (const key of normalizeTemplatePackKeys(value)) {
    if (key === "all") {
      out.push(...Object.values(QUERY_TEMPLATE_PACKS).flat());
      continue;
    }
    out.push(...(QUERY_TEMPLATE_PACKS[key] || []));
  }
  return out;
}

function applyQueryTemplate(template, term) {
  const cleanTerm = String(term || "").replace(/\s+/g, " ").trim();
  if (!cleanTerm) return "";
  return String(template || "")
    .replace(/\{(?:term|keyword|brand|entity)\}/gi, cleanTerm)
    .replace(/\s+/g, " ")
    .trim();
}

export function listSentimentQueryTemplatePacks() {
  return Object.entries(QUERY_TEMPLATE_PACKS).map(([key, templates]) => ({
    key,
    templates: [...templates],
  }));
}

export function expandSentimentSearchKeywords(keywords, limit = SEARCH_KEYWORD_LIMIT, expansion = {}) {
  const normalized = normalizeSentimentMonitorKeywords(keywords);
  const out = [];
  const enabled = expansion?.enabled !== false;
  const includeRelated = enabled && expansion?.includeRelated !== false && expansion?.include_related !== false;
  const includeRiskCombos = enabled && expansion?.includeRiskCombos !== false && expansion?.include_risk_combos !== false;
  const includeQueryTemplates = enabled && expansion?.includeQueryTemplates !== false && expansion?.include_query_templates !== false;
  const includeMultilingual = enabled && expansion?.includeMultilingual !== false && expansion?.include_multilingual !== false;
  const aliases = enabled ? uniqueExpansionTerms(expansion?.aliases || expansion?.brandAliases || expansion?.brand_aliases, 40) : [];
  const competitors = enabled ? uniqueExpansionTerms(expansion?.competitors || expansion?.competitorTerms || expansion?.competitor_terms, 40) : [];
  const industryTerms = enabled ? uniqueExpansionTerms(expansion?.industryTerms || expansion?.industry_terms || expansion?.industries, 40) : [];
  const customTerms = enabled ? uniqueExpansionTerms(expansion?.customTerms || expansion?.custom_terms || expansion?.extraTerms || expansion?.extra_terms, 60) : [];
  const customQueryTemplates = enabled ? uniqueExpansionTerms(expansion?.customQueryTemplates || expansion?.custom_query_templates || expansion?.queryTemplates || expansion?.query_templates, 80) : [];
  const riskTerms = enabled
    ? uniqueExpansionTerms(expansion?.riskTerms || expansion?.risk_terms || RISK_SCAN_TERMS, 30)
    : [];
  const queryTemplates = includeQueryTemplates
    ? [...templatesFromPacks(expansion?.queryTemplatePacks || expansion?.query_template_packs || expansion?.templatePacks || expansion?.template_packs), ...customQueryTemplates]
    : [];
  const multilingualRiskTerms = includeMultilingual ? multilingualRiskTermsForExpansion(expansion) : [];
  const maxMultilingualTerms = Math.max(0, Math.min(80, Number(expansion?.maxMultilingualTerms ?? expansion?.max_multilingual_terms ?? 24) || 24));

  for (const keyword of normalized) {
    if (addSearchKeyword(out, keyword, limit)) return out;
    if (includeRelated) {
      for (const related of RELATED_SEARCH_KEYWORDS.get(keyword) || []) {
        if (addSearchKeyword(out, related, limit)) return out;
      }
    }
  }

  for (const term of [...aliases, ...competitors, ...industryTerms, ...customTerms]) {
    if (addSearchKeyword(out, term, limit)) return out;
  }

  if (includeRiskCombos) {
    const monitoredEntities = [...normalized, ...aliases, ...competitors].filter(Boolean).slice(0, 12);
    for (const entity of monitoredEntities) {
      for (const riskTerm of riskTerms) {
        if (entity === riskTerm || entity.includes(riskTerm)) continue;
        if (addSearchKeyword(out, `${entity} ${riskTerm}`, limit)) return out;
      }
    }
  }

  if (queryTemplates.length) {
    const monitoredTerms = [...normalized, ...aliases, ...competitors, ...customTerms].filter(Boolean).slice(0, 16);
    for (const term of monitoredTerms) {
      for (const template of queryTemplates) {
        if (addSearchKeyword(out, applyQueryTemplate(template, term), limit)) return out;
      }
    }
  }

  if (includeMultilingual && multilingualRiskTerms.length && maxMultilingualTerms > 0) {
    let added = 0;
    const monitoredTerms = [...normalized, ...aliases, ...competitors].filter(Boolean).slice(0, 10);
    for (const term of monitoredTerms) {
      for (const riskTerm of multilingualRiskTerms) {
        if (!term || !riskTerm || term.toLowerCase() === riskTerm.toLowerCase() || term.toLowerCase().includes(riskTerm.toLowerCase())) continue;
        if (addSearchKeyword(out, `${term} ${riskTerm}`, limit)) return out;
        added += 1;
        if (added >= maxMultilingualTerms) return out;
      }
    }
  }

  return out.slice(0, limit);
}

export function normalizeSentimentScanMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["full", "deep", "depth", "深度", "深度扫描", "深度掃描"].includes(normalized)) return SCAN_MODE_FULL;
  if (["watch", "crisis", "warning", "alert", "risk", "危情", "危情扫描", "危情掃描", "预警", "預警"].includes(normalized)) return SCAN_MODE_WATCH;
  return SCAN_MODE_FAST;
}

function clampBudgetValue(value, min, max, fallback) {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function normalizeRunnerBudget(budget = DEFAULT_COLLECTION_BUDGET.fast) {
  return {
    maxPagesPerKeyword: clampBudgetValue(budget.maxPagesPerKeyword || budget.max_pages_per_keyword, 1, 5, DEFAULT_COLLECTION_BUDGET.fast.maxPagesPerKeyword),
    maxItemsPerKeyword: clampBudgetValue(budget.maxItemsPerKeyword || budget.max_items_per_keyword, 1, 50, DEFAULT_COLLECTION_BUDGET.fast.maxItemsPerKeyword),
  };
}

function normalizeRunnerDeepBudget(budget = {}) {
  return {
    maxPagesPerKeyword: clampBudgetValue(budget.maxPagesPerKeyword ?? budget.max_pages_per_keyword, 0, 5, 0),
    maxCommentsPerItem: clampBudgetValue(budget.maxCommentsPerItem ?? budget.max_comments_per_item ?? budget.maxComments ?? budget.max_comments, 0, 100, 0),
    captureQuotedContext: budget.captureQuotedContext ?? budget.capture_quoted_context ?? false ? true : false,
  };
}

function hasDeepBudgetFields(budget = {}) {
  return Boolean(
    budget
    && typeof budget === "object"
    && (
      budget.maxPagesPerKeyword !== undefined
      || budget.max_pages_per_keyword !== undefined
      || budget.maxCommentsPerItem !== undefined
      || budget.max_comments_per_item !== undefined
      || budget.maxComments !== undefined
      || budget.max_comments !== undefined
      || budget.captureQuotedContext !== undefined
      || budget.capture_quoted_context !== undefined
    )
  );
}

function mergeDeepBudget(base = {}, patch = {}) {
  return normalizeRunnerDeepBudget({
    maxPagesPerKeyword: patch.maxPagesPerKeyword ?? patch.max_pages_per_keyword ?? base.maxPagesPerKeyword,
    maxCommentsPerItem: patch.maxCommentsPerItem ?? patch.max_comments_per_item ?? patch.maxComments ?? patch.max_comments ?? base.maxCommentsPerItem,
    captureQuotedContext: patch.captureQuotedContext ?? patch.capture_quoted_context ?? base.captureQuotedContext,
  });
}

function hasRiskScanTerms(keywords = []) {
  const text = (Array.isArray(keywords) ? keywords : []).join(" ");
  return RISK_SCAN_TERMS.some(term => text.includes(term));
}

export function deriveHighRiskWatchKeywords({
  keywords = [],
  monitoredEntityKeywords = [],
  entityFootprintKeywords = [],
  eventExpansionKeywords = [],
  settings = {},
} = {}) {
  if (settings?.enabled === false) return [];
  const limit = Math.max(1, Math.min(40, Number(settings.maxKeywords || settings.max_keywords || 12) || 12));
  const riskTerms = normalizeSentimentMonitorKeywords(settings.riskTerms || settings.risk_terms || RISK_SCAN_TERMS).slice(0, 30);
  const base = normalizeSentimentMonitorKeywords(keywords);
  const entityTerms = settings.includeMonitoredEntities === false || settings.include_monitored_entities === false
    ? []
    : normalizeSentimentMonitorKeywords([...monitoredEntityKeywords, ...entityFootprintKeywords]).filter(keyword => !containsRiskTerm(keyword));
  const eventTerms = settings.includeEventExpansion === false || settings.include_event_expansion === false
    ? []
    : normalizeSentimentMonitorKeywords(eventExpansionKeywords);
  const out = [];
  const add = (value) => {
    const term = String(value || "").replace(/\s+/g, " ").trim();
    if (term && !out.includes(term)) out.push(term);
    return out.length >= limit;
  };
  for (const keyword of [...base, ...entityTerms].slice(0, 12)) {
    for (const risk of riskTerms) {
      if (!keyword || !risk || keyword.includes(risk)) continue;
      if (add(`${keyword} ${risk}`)) return out;
    }
  }
  for (const keyword of eventTerms) {
    if (containsRiskTerm(keyword)) {
      if (add(keyword)) return out;
    }
  }
  for (const keyword of base) {
    if (containsRiskTerm(keyword)) {
      if (add(keyword)) return out;
    }
  }
  for (const risk of riskTerms) {
    if (add(risk)) return out;
  }
  return out.slice(0, limit);
}

export function resolveSourceCollectionBudget(sourceKey, baseBudget = {}, {
  mode = SCAN_MODE_FAST,
  keywords = [],
  profile = null,
  source = null,
  trackingSignal = null,
  contributionSignal = null,
  coverageSignal = null,
  credibilitySignal = null,
  entityTopicSignal = null,
  keywordFamilyCoverageSignal = null,
  realtimeHotTopicSignal = null,
  realtimeAnomalyWindowSignal = null,
  realtimeSourceCoverageSignal = null,
  propagationConfidenceSignal = null,
  alertEventSignal = null,
  officialRegulatoryFollowupSignal = null,
  evidenceChainGapSignal = null,
  socialFollowupSignal = null,
  accessBarrierAlternateSignal = null,
  evidenceCoverageRoutedAlternateSignal = null,
  collectionOperationsRemediationSignal = null,
  multilingualQuerySignal = null,
  freeSourceTargetCoverageSignal = null,
  noiseSuppressionSignal = null,
} = {}) {
  const base = normalizeRunnerBudget(baseBudget);
  const sourceConfig = source?.config || {};
  const configured = sourceConfig.collectionBudget || sourceConfig.collection_budget || {};
  if (configured.maxPagesPerKeyword || configured.max_pages_per_keyword || configured.maxItemsPerKeyword || configured.max_items_per_keyword) {
    return normalizeRunnerBudget({
      maxPagesPerKeyword: configured.maxPagesPerKeyword || configured.max_pages_per_keyword || base.maxPagesPerKeyword,
      maxItemsPerKeyword: configured.maxItemsPerKeyword || configured.max_items_per_keyword || base.maxItemsPerKeyword,
    });
  }

  let pageMultiplier = 1;
  let itemMultiplier = 1;
  const qualityScore = Number(profile?.quality_score || 0);
  const effectiveRate = Number(profile?.effective_rate || 0);
  const failureRate = Number(profile?.failure_rate || 0);
  const lowQualityRate = Number(profile?.low_quality_rate || 0);
  const eventCount = Number(profile?.event_count || 0);
  const sourcePriority = Number(source?.priority || 0);
  const riskMode = hasRiskScanTerms(keywords);
  const credibilityBoost = Number(credibilitySignal?.priorityBoost || 0);
  const officialFollowupBoost = Number(officialRegulatoryFollowupSignal?.priorityBoost || officialRegulatoryFollowupSignal?.score || 0);
  const evidenceChainBoost = Number(evidenceChainGapSignal?.priorityBoost || evidenceChainGapSignal?.score || 0);
  const socialFollowupBoost = Number(socialFollowupSignal?.priorityBoost || socialFollowupSignal?.score || 0);
  const accessBarrierAlternateBoost = Number(accessBarrierAlternateSignal?.priorityBoost || 0);
  const evidenceCoverageRoutedAlternateBoost = Number(evidenceCoverageRoutedAlternateSignal?.priorityBoost || 0);
  const collectionOperationsRemediationBoost = Number(collectionOperationsRemediationSignal?.priorityBoost || 0);
  const multilingualQueryBoost = Number(multilingualQuerySignal?.priorityBoost || 0);
  const freeSourceTargetCoverageBoost = Number(freeSourceTargetCoverageSignal?.priorityBoost || 0);
  const noiseSuppressionBoost = Number(noiseSuppressionSignal?.priorityBoost || 0);
  const realtimeHotTopicBoost = Number(realtimeHotTopicSignal?.priorityBoost || realtimeHotTopicSignal?.score || 0);
  const realtimeAnomalyWindowBoost = Number(realtimeAnomalyWindowSignal?.priorityBoost || realtimeAnomalyWindowSignal?.score || 0);
  const realtimeCoverageBoost = Number(realtimeSourceCoverageSignal?.priorityBoost || realtimeSourceCoverageSignal?.score || 0);
  const keywordFamilyCoverageBoost = Number(keywordFamilyCoverageSignal?.priorityBoost || keywordFamilyCoverageSignal?.score || 0);
  const sourceTierScore = Number(credibilitySignal?.sourceTierScore || 0);
  const contentOriginProfile = credibilitySignal?.contentOriginProfile || {};
  const originHeavy = contentOriginProfile.label === "origin-heavy-source" || Number(contentOriginProfile.originalityRate || 0) >= 70;
  const repostHeavy = contentOriginProfile.label === "repost-heavy-source" || Number(contentOriginProfile.repostRate || 0) >= 50;

  if (mode === SCAN_MODE_FULL && DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
    pageMultiplier += 0.25;
    itemMultiplier += 0.25;
  }
  if (credibilityBoost >= 16 || sourceTierScore >= 80) {
    itemMultiplier += 0.25;
    if (mode === SCAN_MODE_FULL || sourceTierScore >= 80) pageMultiplier += 0.2;
  } else if (credibilityBoost < 0) {
    pageMultiplier -= 0.2;
    itemMultiplier -= 0.25;
  }
  if (socialFollowupBoost >= 20 && SOCIAL_SOURCE_KEYS.has(sourceKey)) {
    itemMultiplier += socialFollowupBoost >= 32 ? 0.35 : 0.2;
    if (mode === SCAN_MODE_FULL) pageMultiplier += 0.15;
  }
  if (accessBarrierAlternateBoost > 0) {
    const boost = Math.min(0.3, Number(accessBarrierAlternateSignal?.budgetBoost || accessBarrierAlternateBoost / 100 || 0));
    itemMultiplier += boost;
    if (["rssFeeds", "officialRegulatory", "legalPublicRecords", "brandImpersonationSources", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "gdelt", "publicReviewSites", "regionalComplaintSources"].includes(sourceKey) || mode === SCAN_MODE_FULL) {
      pageMultiplier += Math.min(0.2, boost);
    }
  }
  if (evidenceCoverageRoutedAlternateBoost > 0) {
    const boost = Math.min(0.28, Number(evidenceCoverageRoutedAlternateSignal?.budgetBoost || evidenceCoverageRoutedAlternateBoost / 100 || 0));
    itemMultiplier += boost;
    if (["rssFeeds", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "gdelt", "reddit", "ptt", "dcard", "youtube", "bilibili", "publicReviewSites", "regionalComplaintSources"].includes(sourceKey) || mode === SCAN_MODE_FULL) {
      pageMultiplier += Math.min(0.18, boost);
    }
  }
  if (collectionOperationsRemediationBoost > 0) {
    const boost = Math.min(0.28, Number(collectionOperationsRemediationSignal?.budgetBoost || collectionOperationsRemediationBoost / 100 || 0));
    itemMultiplier += boost;
    if (["rssFeeds", "officialRegulatory", "legalPublicRecords", "brandImpersonationSources", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "gdelt", "youtube", "ptt", "dcard", "publicReviewSites", "regionalComplaintSources"].includes(sourceKey) || mode === SCAN_MODE_FULL) {
      pageMultiplier += Math.min(0.18, boost);
    }
  }
  if (multilingualQueryBoost > 0) {
    const boost = Math.min(0.22, multilingualQueryBoost / 100);
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || REALTIME_SOURCE_KEYS.has(sourceKey) || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
      pageMultiplier += Math.min(0.14, boost);
    }
  } else if (multilingualQueryBoost < 0) {
    itemMultiplier -= 0.15;
    pageMultiplier -= 0.1;
  }
  if (freeSourceTargetCoverageBoost >= 12) {
    const boost = Math.min(0.24, freeSourceTargetCoverageBoost / 100);
    itemMultiplier += boost;
    if (["publicReviewSites", "verticalReviewSources", "ecommerceReviewSources", "regionalComplaintSources"].includes(sourceKey) || mode === SCAN_MODE_FULL) {
      pageMultiplier += Math.min(0.16, boost);
    }
  }
  if (noiseSuppressionBoost < 0) {
    const penalty = Math.min(0.4, Math.abs(noiseSuppressionBoost) / 100);
    itemMultiplier -= penalty;
    pageMultiplier -= Math.min(0.3, penalty);
  }
  if (officialFollowupBoost >= 24) {
    const boost = Math.min(0.4, officialFollowupBoost / 100);
    itemMultiplier += boost;
    if (["googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "gdelt", "rssFeeds", "officialRegulatory", "legalPublicRecords", "brandImpersonationSources"].includes(sourceKey) || mode === SCAN_MODE_FULL) {
      pageMultiplier += Math.min(0.3, boost);
    }
  }
  if (evidenceChainBoost >= 22) {
    const boost = Math.min(0.4, evidenceChainBoost / 100);
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) {
      pageMultiplier += Math.min(0.28, boost);
    }
  }
  if (realtimeHotTopicBoost >= 20) {
    const boost = Math.min(0.35, realtimeHotTopicBoost / 100);
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || REALTIME_SOURCE_KEYS.has(sourceKey) || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
      pageMultiplier += Math.min(0.25, boost);
    }
  }
  if (realtimeAnomalyWindowBoost >= 24) {
    const boost = Math.min(0.38, realtimeAnomalyWindowBoost / 100);
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || REALTIME_SOURCE_KEYS.has(sourceKey) || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
      pageMultiplier += Math.min(0.25, boost);
    }
  }
  if (realtimeCoverageBoost >= 16) {
    const boost = Math.min(0.3, realtimeCoverageBoost / 100);
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || REALTIME_SOURCE_KEYS.has(sourceKey) || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
      pageMultiplier += Math.min(0.2, boost);
    }
  }
  if (keywordFamilyCoverageBoost >= 8) {
    const boost = Math.min(0.28, Number(keywordFamilyCoverageSignal?.budgetBoost || keywordFamilyCoverageBoost / 100 || 0));
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || REALTIME_SOURCE_KEYS.has(sourceKey) || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
      pageMultiplier += Math.min(0.18, boost);
    }
  }
  if (originHeavy && !repostHeavy) {
    itemMultiplier += 0.2;
    if (mode === SCAN_MODE_FULL || sourceTierScore >= 68) pageMultiplier += 0.15;
  }
  if (repostHeavy) {
    pageMultiplier -= 0.25;
    itemMultiplier -= 0.3;
  }
  if (riskMode && (REALTIME_SOURCE_KEYS.has(sourceKey) || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey))) {
    itemMultiplier += 0.5;
    if (mode === SCAN_MODE_FULL || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) pageMultiplier += 0.5;
  }
  const trackingScore = Number(trackingSignal?.score || 0);
  if (trackingScore >= 60) {
    itemMultiplier += 0.45;
    pageMultiplier += mode === SCAN_MODE_FULL ? 0.35 : 0.25;
  } else if (trackingScore >= 35) {
    itemMultiplier += 0.25;
    if (mode === SCAN_MODE_FULL) pageMultiplier += 0.2;
  }
  if (qualityScore >= 75 && effectiveRate >= 60 && failureRate < 25) {
    itemMultiplier += 0.35;
    if (eventCount > 0 || sourcePriority >= 70) pageMultiplier += 0.25;
  }
  if (contributionSignal?.action === "promote") {
    itemMultiplier += 0.25;
    if (Number(contributionSignal?.event_count || 0) > 0) pageMultiplier += 0.15;
  } else if (contributionSignal?.action === "suppress") {
    pageMultiplier -= 0.3;
    itemMultiplier -= 0.35;
  }
  if (entityTopicSignal?.priorityBoost > 0) {
    const boost = Math.max(0, Math.min(0.4, Number(entityTopicSignal.budgetBoost || 0)));
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || REALTIME_SOURCE_KEYS.has(sourceKey) || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
      pageMultiplier += Math.min(0.25, boost * 0.75);
    }
  }
  if (Number(propagationConfidenceSignal?.priorityBoost || 0) > 0) {
    const boost = Math.min(0.35, Number(propagationConfidenceSignal.priorityBoost || 0) / 100);
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || ["googleNews", "bingNews", "baiduNews", "rssFeeds", "officialRegulatory", "legalPublicRecords", "brandImpersonationSources", "duckDuckGo", "openWebDiscovery", "gdelt"].includes(sourceKey)) pageMultiplier += Math.min(0.25, boost);
  }
  if (Number(alertEventSignal?.priorityBoost || 0) > 0) {
    const boost = Math.min(0.45, Number(alertEventSignal.priorityBoost || 0) / 100);
    itemMultiplier += boost;
    if (mode === SCAN_MODE_FULL || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) {
      pageMultiplier += Math.min(0.3, boost);
    }
  }
  const coverageStatus = String(coverageSignal?.status || "");
  const coverageIssues = new Set(Array.isArray(coverageSignal?.issues) ? coverageSignal.issues : []);
  if (coverageStatus === "stale" || coverageStatus === "under-covered" || coverageIssues.has("under-covered")) {
    pageMultiplier += mode === SCAN_MODE_FULL ? 0.3 : 0.2;
    itemMultiplier += 0.35;
  } else if (coverageStatus === "watch" || coverageIssues.has("weak-contribution")) {
    itemMultiplier += 0.15;
  } else if (coverageStatus === "noisy") {
    pageMultiplier -= 0.25;
    itemMultiplier -= 0.3;
  } else if (coverageStatus === "blocked") {
    pageMultiplier -= 0.2;
    itemMultiplier -= 0.25;
  }
  if (lowQualityRate >= 45 || failureRate >= 40) {
    pageMultiplier -= 0.4;
    itemMultiplier -= 0.45;
  }
  if (sourceConfig.auto_tuning?.action === "repair-source" || sourceConfig.auto_tuning?.action === "tighten-filters") {
    pageMultiplier -= 0.2;
    itemMultiplier -= 0.25;
  }
  return normalizeRunnerBudget({
    maxPagesPerKeyword: base.maxPagesPerKeyword * Math.max(0.5, pageMultiplier),
    maxItemsPerKeyword: base.maxItemsPerKeyword * Math.max(0.5, itemMultiplier),
  });
}

export function resolveSourceDeepCollectionBudget(sourceKey, baseDeepBudget = {}, {
  mode = SCAN_MODE_FAST,
  lane = "",
  keywords = [],
  profile = null,
  source = null,
  trackingSignal = null,
  contributionSignal = null,
  coverageSignal = null,
  credibilitySignal = null,
  deepHealthSignal = null,
  entityTopicSignal = null,
  keywordFamilyCoverageSignal = null,
  realtimeHotTopicSignal = null,
  realtimeAnomalyWindowSignal = null,
  realtimeSourceCoverageSignal = null,
  anomalySignal = null,
  alertEventSignal = null,
  officialRegulatoryFollowupSignal = null,
  evidenceGapSignal = null,
  evidenceChainGapSignal = null,
  propagationConfidenceSignal = null,
  socialFollowupSignal = null,
  eventClusterSignal = null,
  accessBarrierAlternateSignal = null,
  evidenceCoverageRoutedAlternateSignal = null,
  collectionOperationsRemediationSignal = null,
  multilingualQuerySignal = null,
  freeSourceTargetCoverageSignal = null,
  noiseSuppressionSignal = null,
} = {}) {
  const base = normalizeRunnerDeepBudget(baseDeepBudget);
  const sourceConfig = source?.config || {};
  const configured = sourceConfig.deepCollectionBudget || sourceConfig.deep_collection_budget || sourceConfig.deepBudget || sourceConfig.deep_budget || {};
  const modeConfigured = configured?.[lane] || configured?.[mode] || configured?.default || configured;
  if (hasDeepBudgetFields(modeConfigured)) {
    return mergeDeepBudget(base, modeConfigured);
  }

  let pageDelta = 0;
  let commentDelta = 0;
  let captureQuotedContext = base.captureQuotedContext;
  const qualityScore = Number(profile?.quality_score || 0);
  const effectiveRate = Number(profile?.effective_rate || 0);
  const failureRate = Number(profile?.failure_rate || 0);
  const lowQualityRate = Number(profile?.low_quality_rate || 0);
  const eventCount = Number(profile?.event_count || 0);
  const trackingScore = Number(trackingSignal?.score || 0);
  const credibilityBoost = Number(credibilitySignal?.priorityBoost || 0);
  const sourceTierScore = Number(credibilitySignal?.sourceTierScore || 0);
  const contentOriginProfile = credibilitySignal?.contentOriginProfile || {};
  const originHeavy = contentOriginProfile.label === "origin-heavy-source" || Number(contentOriginProfile.originalityRate || 0) >= 70;
  const repostHeavy = contentOriginProfile.label === "repost-heavy-source" || Number(contentOriginProfile.repostRate || 0) >= 50;
  const anomalyScore = Math.max(0, Number(anomalySignal?.maxAnomalyScore || anomalySignal?.score || 0) || 0);
  const anomalyBoost = Math.max(0, Number(anomalySignal?.priorityBoost || 0) || 0);
  const realtimeHotTopicScore = Math.max(0, Number(realtimeHotTopicSignal?.maxHotScore || realtimeHotTopicSignal?.score || 0) || 0);
  const realtimeHotTopicBoost = Math.max(0, Number(realtimeHotTopicSignal?.priorityBoost || 0) || 0);
  const realtimeAnomalyWindowBoost = Math.max(0, Number(realtimeAnomalyWindowSignal?.priorityBoost || 0) || 0);
  const realtimeCoverageBoost = Math.max(0, Number(realtimeSourceCoverageSignal?.priorityBoost || 0) || 0);
  const keywordFamilyCoverageBoost = Math.max(0, Number(keywordFamilyCoverageSignal?.priorityBoost || keywordFamilyCoverageSignal?.score || 0) || 0);
  const alertEventBoost = Math.max(0, Number(alertEventSignal?.priorityBoost || alertEventSignal?.score || 0) || 0);
  const officialFollowupBoost = Math.max(0, Number(officialRegulatoryFollowupSignal?.priorityBoost || officialRegulatoryFollowupSignal?.score || 0) || 0);
  const evidenceGapBoost = Math.max(0, Number(evidenceGapSignal?.priorityBoost || evidenceGapSignal?.score || 0) || 0);
  const evidenceChainBoost = Math.max(0, Number(evidenceChainGapSignal?.priorityBoost || evidenceChainGapSignal?.score || 0) || 0);
  const evidenceChainGapTypes = new Set(Array.isArray(evidenceChainGapSignal?.gapTypes) ? evidenceChainGapSignal.gapTypes : []);
  const socialFollowupBoost = Math.max(0, Number(socialFollowupSignal?.priorityBoost || socialFollowupSignal?.score || 0) || 0);
  const accessBarrierAlternateBoost = Math.max(0, Number(accessBarrierAlternateSignal?.priorityBoost || 0) || 0);
  const evidenceCoverageRoutedAlternateBoost = Math.max(0, Number(evidenceCoverageRoutedAlternateSignal?.priorityBoost || 0) || 0);
  const collectionOperationsRemediationBoost = Math.max(0, Number(collectionOperationsRemediationSignal?.priorityBoost || 0) || 0);
  const multilingualQueryBoost = Math.max(0, Number(multilingualQuerySignal?.priorityBoost || 0) || 0);
  const freeSourceTargetCoverageBoost = Math.max(0, Number(freeSourceTargetCoverageSignal?.priorityBoost || 0) || 0);
  const noiseSuppressionPenalty = Math.max(0, Math.abs(Math.min(0, Number(noiseSuppressionSignal?.priorityBoost || 0) || 0)));
  const socialFollowupReasons = new Set(Array.isArray(socialFollowupSignal?.reasons) ? socialFollowupSignal.reasons : []);
  const evidenceGapReasons = new Set(Array.isArray(evidenceGapSignal?.reasons) ? evidenceGapSignal.reasons : []);
  const sourcePriority = Number(source?.priority || 0);
  const riskMode = hasRiskScanTerms(keywords);
  const coverageStatus = String(coverageSignal?.status || "");
  const coverageIssues = new Set(Array.isArray(coverageSignal?.issues) ? coverageSignal.issues : []);
  const highCostWatch = lane === "high-risk-watch";
  const deepCapable = REALTIME_SOURCE_KEYS.has(sourceKey)
    || DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)
    || ["threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch", "bluesky"].includes(sourceKey);

  if (!deepCapable) return base;

  if (!highCostWatch && (credibilityBoost >= 16 || sourceTierScore >= 80)) {
    pageDelta += 1;
    if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) commentDelta += 8;
  } else if (credibilityBoost < 0) {
    pageDelta -= 1;
    commentDelta -= 6;
  }
  if (!highCostWatch && originHeavy && !repostHeavy) {
    pageDelta += 1;
    if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) commentDelta += 6;
  }
  if (!highCostWatch && repostHeavy) {
    pageDelta -= 1;
    commentDelta -= 8;
  }

  if (!highCostWatch && mode === SCAN_MODE_FULL) {
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += 1;
    if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) commentDelta += 15;
    if (["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && collectionOperationsRemediationBoost >= 14) {
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += collectionOperationsRemediationBoost >= 24 ? 1 : 0;
    if (["youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch", "xSearch", "facebookSearch", "linkedinSearch", "reddit", "ptt", "dcard", "publicReviewSites", "regionalComplaintSources"].includes(sourceKey)) {
      commentDelta += collectionOperationsRemediationBoost >= 24 ? 6 : 3;
    }
  }
  if (!highCostWatch && evidenceCoverageRoutedAlternateBoost >= 14) {
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += evidenceCoverageRoutedAlternateBoost >= 24 ? 1 : 0;
    if (["youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch", "reddit", "ptt", "dcard", "publicReviewSites", "regionalComplaintSources", "threads", "xSearch", "facebookSearch", "linkedinSearch"].includes(sourceKey)) {
      commentDelta += evidenceCoverageRoutedAlternateBoost >= 24 ? 8 : 4;
    }
  }
  if (!highCostWatch && multilingualQueryBoost >= 16) {
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += multilingualQueryBoost >= 24 ? 1 : 0;
    if (["youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch", "xSearch", "facebookSearch", "linkedinSearch", "reddit", "ptt", "dcard", "publicReviewSites", "regionalComplaintSources", "threads", "bluesky"].includes(sourceKey)) {
      commentDelta += multilingualQueryBoost >= 24 ? 6 : 3;
    }
  }
  if (!highCostWatch && freeSourceTargetCoverageBoost >= 18) {
    if (["publicReviewSites", "verticalReviewSources", "ecommerceReviewSources", "regionalComplaintSources"].includes(sourceKey)) {
      pageDelta += freeSourceTargetCoverageBoost >= 24 ? 1 : 0;
      commentDelta += freeSourceTargetCoverageBoost >= 24 ? 8 : 4;
    }
  }
  if (!highCostWatch && noiseSuppressionPenalty >= 12) {
    pageDelta -= noiseSuppressionPenalty >= 28 ? 2 : 1;
    commentDelta -= noiseSuppressionPenalty >= 28 ? 12 : 6;
  }
  if (!highCostWatch && riskMode && (REALTIME_SOURCE_KEYS.has(sourceKey) || trackingScore >= 50)) {
    pageDelta += base.maxPagesPerKeyword > 0 ? 1 : 1;
    commentDelta += base.maxCommentsPerItem > 0 ? 10 : 10;
    if (["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && trackingScore >= 70) {
    pageDelta += 1;
    commentDelta += 15;
    if (["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && anomalyBoost >= 24 && anomalyScore >= 45) {
    const severeBurst = anomalyScore >= 75 || ["critical", "high"].includes(String(anomalySignal?.maxSeverity || "").toLowerCase());
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += severeBurst ? 2 : 1;
    if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) {
      commentDelta += severeBurst ? 25 : 12;
    } else if (REALTIME_SOURCE_KEYS.has(sourceKey)) {
      commentDelta += severeBurst ? 18 : 10;
    } else {
      commentDelta += severeBurst ? 10 : 6;
    }
    if (["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && realtimeHotTopicBoost >= 24 && realtimeHotTopicScore >= 45) {
    const strongHeat = realtimeHotTopicScore >= 78;
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += strongHeat ? 1 : 0;
    if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) {
      commentDelta += strongHeat ? 16 : 8;
    } else if (REALTIME_SOURCE_KEYS.has(sourceKey)) {
      commentDelta += strongHeat ? 12 : 6;
    }
    if (["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && realtimeAnomalyWindowBoost >= 32) {
    const criticalWindow = Number(realtimeAnomalyWindowSignal?.maxScore || 0) >= 85 || (realtimeAnomalyWindowSignal?.severities || []).includes("critical");
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += criticalWindow ? 2 : 1;
    if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) {
      commentDelta += criticalWindow ? 24 : 12;
    } else if (REALTIME_SOURCE_KEYS.has(sourceKey)) {
      commentDelta += criticalWindow ? 16 : 8;
    }
    if (["bluesky", "threads", "instagram", "xSearch", "mastodon"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && realtimeCoverageBoost >= 22) {
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += realtimeCoverageBoost >= 32 ? 1 : 0;
    if (["youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch", "xSearch", "facebookSearch", "linkedinSearch", "reddit", "ptt", "dcard", "threads", "instagram", "mastodon", "bluesky", "publicReviewSites", "regionalComplaintSources"].includes(sourceKey)) {
      commentDelta += realtimeCoverageBoost >= 32 ? 8 : 4;
    }
  }
  if (!highCostWatch && keywordFamilyCoverageBoost >= 10) {
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += keywordFamilyCoverageBoost >= 20 ? 1 : 0;
    if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) {
      commentDelta += keywordFamilyCoverageBoost >= 20 ? 10 : 5;
    } else if (REALTIME_SOURCE_KEYS.has(sourceKey)) {
      commentDelta += keywordFamilyCoverageBoost >= 20 ? 8 : 4;
    }
    if (["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && officialFollowupBoost >= 24) {
    if (["officialRegulatory", "legalPublicRecords", "brandImpersonationSources", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "gdelt", "rssFeeds"].includes(sourceKey)) pageDelta += 1;
    if (["youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch", "xSearch", "facebookSearch", "linkedinSearch", "reddit", "ptt", "dcard", "threads", "mastodon", "bluesky"].includes(sourceKey)) commentDelta += 8;
    if (["bluesky", "threads", "xSearch", "mastodon"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && alertEventBoost >= 24) {
    const severeAlert = ["critical", "high"].includes(String(alertEventSignal?.maxSeverity || "").toLowerCase());
    if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += severeAlert ? 2 : 1;
    if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) {
      commentDelta += severeAlert ? 24 : 12;
    } else if (REALTIME_SOURCE_KEYS.has(sourceKey)) {
      commentDelta += severeAlert ? 16 : 8;
    } else {
      commentDelta += severeAlert ? 8 : 4;
    }
    if (["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && evidenceGapBoost > 0) {
    const strongGap = evidenceGapBoost >= 20 || Number(evidenceGapSignal?.minCompletenessScore || 100) < 45;
    if (evidenceGapReasons.has("missing-body-evidence") && DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
      pageDelta += strongGap ? 2 : 1;
      commentDelta += 4;
    }
    if (evidenceGapReasons.has("missing-comment-evidence")) {
      if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) {
        commentDelta += strongGap ? 24 : 12;
        pageDelta += sourceKey === "youtube" ? 1 : 0;
      } else if (["ptt", "dcard", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "mastodon", "bluesky"].includes(sourceKey)) {
        commentDelta += strongGap ? 16 : 8;
      }
    }
    if (evidenceGapReasons.has("missing-quoted-context") && ["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) {
      captureQuotedContext = true;
      pageDelta += strongGap ? 1 : 0;
      commentDelta += strongGap ? 12 : 6;
    }
    if (evidenceGapReasons.has("missing-video-followup-evidence") && ["youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch"].includes(sourceKey)) {
      pageDelta += strongGap ? 2 : 1;
      commentDelta += strongGap ? 20 : 10;
    }
    if (evidenceGapReasons.has("missing-origin-evidence") || evidenceGapReasons.has("missing-cross-platform-evidence")) {
      if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += strongGap ? 1 : 0;
      if (REALTIME_SOURCE_KEYS.has(sourceKey)) commentDelta += strongGap ? 8 : 4;
    }
  }
  if (!highCostWatch && evidenceChainBoost >= 22) {
    const criticalChain = evidenceChainBoost >= 36 || Number(evidenceChainGapSignal?.maxGapScore || 0) >= 75;
    if (evidenceChainGapTypes.has("body-context") && DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey)) {
      pageDelta += criticalChain ? 2 : 1;
      commentDelta += criticalChain ? 6 : 3;
    }
    if (evidenceChainGapTypes.has("comments-engagement")) {
      if (["youtube", "reddit", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) {
        commentDelta += criticalChain ? 24 : 12;
        if (sourceKey === "youtube") pageDelta += criticalChain ? 1 : 0;
      } else if (["ptt", "dcard", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "mastodon", "bluesky", "publicReviewSites", "regionalComplaintSources"].includes(sourceKey)) {
        commentDelta += criticalChain ? 16 : 8;
      }
    }
    if (evidenceChainGapTypes.has("origin-propagation")) {
      if (DEEP_COVERAGE_SOURCE_KEYS.has(sourceKey) || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += criticalChain ? 1 : 0;
      if (REALTIME_SOURCE_KEYS.has(sourceKey)) commentDelta += criticalChain ? 10 : 5;
    }
    if ((evidenceChainGapTypes.has("official-regulatory") || evidenceChainGapTypes.has("legal-record") || evidenceChainGapTypes.has("brand-impersonation")) && ["officialRegulatory", "legalPublicRecords", "brandImpersonationSources", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "gdelt", "rssFeeds", "regionalComplaintSources", "publicReviewSites"].includes(sourceKey)) {
      pageDelta += criticalChain ? 1 : 0;
    }
    if (evidenceChainGapTypes.has("quoted-context") && ["bluesky", "threads", "instagram", "xSearch", "mastodon"].includes(sourceKey)) {
      captureQuotedContext = true;
      commentDelta += criticalChain ? 12 : 6;
    }
    if (evidenceChainGapTypes.has("video-followup") && ["youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch"].includes(sourceKey)) {
      pageDelta += criticalChain ? 2 : 1;
      commentDelta += criticalChain ? 20 : 10;
    }
  }
  if (!highCostWatch && socialFollowupBoost >= 16 && SOCIAL_SOURCE_KEYS.has(sourceKey)) {
    if (socialFollowupReasons.has("comment-burst")) commentDelta += socialFollowupBoost >= 30 ? 10 : 6;
    if (socialFollowupReasons.has("quoted-context") && ["bluesky", "threads", "instagram", "xSearch", "mastodon"].includes(sourceKey)) captureQuotedContext = true;
    if ((socialFollowupReasons.has("youtube-channel-followup") || socialFollowupReasons.has("related-video-chain")) && sourceKey === "youtube") {
      pageDelta += 1;
      commentDelta += socialFollowupBoost >= 30 ? 8 : 4;
    }
  }
  if (!highCostWatch && accessBarrierAlternateBoost > 0) {
    if (["rssFeeds", "officialRegulatory", "legalPublicRecords", "brandImpersonationSources", "googleNews", "bingNews", "baiduNews", "duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "openWebDiscovery", "gdelt", "publicReviewSites", "regionalComplaintSources"].includes(sourceKey)) pageDelta += accessBarrierAlternateBoost >= 16 ? 1 : 0;
    if (["youtube", "reddit"].includes(sourceKey)) commentDelta += accessBarrierAlternateBoost >= 16 ? 8 : 4;
  }
  if (!highCostWatch && qualityScore >= 75 && effectiveRate >= 60 && failureRate < 25 && (eventCount > 0 || sourcePriority >= 70)) {
    pageDelta += mode === SCAN_MODE_FULL ? 1 : 0;
    commentDelta += 10;
  }
  if (!highCostWatch && contributionSignal?.action === "promote") {
    pageDelta += Number(contributionSignal?.event_count || 0) > 0 ? 1 : 0;
    commentDelta += 10;
  } else if (contributionSignal?.action === "suppress") {
    pageDelta -= 1;
    commentDelta -= 15;
  }
  if (!highCostWatch && deepHealthSignal?.action === "expand") {
    pageDelta += Math.max(0, Math.min(2, Number(deepHealthSignal.pageBoost || 0)));
    commentDelta += Math.max(0, Math.min(30, Number(deepHealthSignal.commentBoost || 0)));
    if (deepHealthSignal.captureQuotedContext && ["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  } else if (deepHealthSignal?.action === "reduce") {
    pageDelta -= Math.max(1, Math.min(2, Number(deepHealthSignal.pagePenalty || 1)));
    commentDelta -= Math.max(10, Math.min(35, Number(deepHealthSignal.commentPenalty || 15)));
    if (deepHealthSignal.disableQuotedContext && ["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = false;
  } else if (!highCostWatch && mode === SCAN_MODE_FULL && deepHealthSignal?.action === "sample") {
    pageDelta += Math.max(0, Math.min(1, Number(deepHealthSignal.pageBoost || 0)));
    commentDelta += Math.max(0, Math.min(8, Number(deepHealthSignal.commentBoost || 0)));
    if (deepHealthSignal.captureQuotedContext && ["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && Number(entityTopicSignal?.priorityBoost || 0) > 0) {
    const budgetBoost = Math.max(0, Math.min(0.5, Number(entityTopicSignal.budgetBoost || 0)));
    const highGap = Number(entityTopicSignal.priorityBoost || 0) >= 15 || Number(entityTopicSignal.score || 0) >= 5;
    if (mode === SCAN_MODE_FULL || highGap || REALTIME_SOURCE_KEYS.has(sourceKey)) pageDelta += Math.max(1, Math.round(budgetBoost * 3));
    commentDelta += Math.max(8, Math.round(budgetBoost * 40));
    if (["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  const propagationConfidenceBoost = Math.max(0, Number(propagationConfidenceSignal?.priorityBoost || 0) || 0);
  const propagationGaps = new Set(Array.isArray(propagationConfidenceSignal?.gaps) ? propagationConfidenceSignal.gaps : []);
  const explicitReferenceChain = Boolean(propagationConfidenceSignal?.explicitReferenceChain)
    || Boolean(eventClusterSignal?.explicitReferenceChain)
    || (Array.isArray(eventClusterSignal?.twoHopReasons) && eventClusterSignal.twoHopReasons.includes("explicit-reference-chain"));
  const explicitReferenceBoost = Math.max(
    0,
    Number(propagationConfidenceSignal?.explicitReferenceCount || 0),
    Number(eventClusterSignal?.explicitReferenceEdgeCount || 0),
  );
  if (!highCostWatch && propagationConfidenceBoost >= 16) {
    pageDelta += propagationConfidenceBoost >= 28 || mode === SCAN_MODE_FULL ? 1 : 0;
    if (propagationGaps.has("thin-timeline") || propagationGaps.has("weak-edge-evidence")) commentDelta += propagationConfidenceBoost >= 28 ? 12 : 8;
    if (propagationGaps.has("missing-cross-family-confirmation") && ["bluesky", "threads", "instagram", "xSearch"].includes(sourceKey)) captureQuotedContext = true;
  }
  if (!highCostWatch && explicitReferenceChain) {
    if (["bluesky", "threads", "instagram", "xSearch", "mastodon"].includes(sourceKey)) {
      captureQuotedContext = true;
      commentDelta += explicitReferenceBoost >= 2 ? 12 : 8;
      pageDelta += mode === SCAN_MODE_FULL || explicitReferenceBoost >= 2 ? 1 : 0;
    } else if (["reddit", "youtube", "ptt", "dcard", "hackerNews", "githubIssues", "gitLabIssues", "discourseForums", "stackOverflow", "lemmy"].includes(sourceKey)) {
      commentDelta += explicitReferenceBoost >= 2 ? 10 : 6;
    } else if (["googleNews", "bingNews", "baiduNews", "rssFeeds", "duckDuckGo", "openWebDiscovery", "gdelt", "officialRegulatory", "legalPublicRecords", "brandImpersonationSources"].includes(sourceKey)) {
      pageDelta += explicitReferenceBoost >= 2 || mode === SCAN_MODE_FULL ? 1 : 0;
    }
  }
  if (!highCostWatch && (coverageStatus === "stale" || coverageStatus === "under-covered" || coverageIssues.has("under-covered"))) {
    pageDelta += mode === SCAN_MODE_FULL ? 1 : 0;
    commentDelta += 8;
  }
  if (coverageStatus === "noisy" || coverageStatus === "blocked" || lowQualityRate >= 45 || failureRate >= 40) {
    pageDelta -= 2;
    commentDelta -= 30;
    if (coverageStatus === "noisy" || lowQualityRate >= 60) captureQuotedContext = false;
  }
  if (sourceConfig.auto_tuning?.action === "repair-source" || sourceConfig.auto_tuning?.action === "tighten-filters") {
    pageDelta -= 1;
    commentDelta -= 15;
  }
  if (highCostWatch) {
    pageDelta = Math.min(pageDelta, 0);
    commentDelta = Math.min(commentDelta, 0);
    captureQuotedContext = false;
  }

  return normalizeRunnerDeepBudget({
    maxPagesPerKeyword: base.maxPagesPerKeyword + pageDelta,
    maxCommentsPerItem: base.maxCommentsPerItem + commentDelta,
    captureQuotedContext,
  });
}

export function deriveDeepCollectionHealthSignals(health = {}) {
  const signals = {};
  for (const item of Array.isArray(health.collectors) ? health.collectors : []) {
    const key = String(item?.source_key || "");
    if (!key) continue;
    const sampleCount = Number(item.evidence_count || 0) + Number(item.comment_count || 0);
    if (!signals[key]) {
      signals[key] = {
        sourceKey: key,
        collectorCount: 0,
        sampleCount: 0,
        evidenceCount: 0,
        commentCount: 0,
        eventCount: 0,
        weightedHealthTotal: 0,
        expandCount: 0,
        reduceCount: 0,
        sampleCollectorCount: 0,
        collectorKinds: [],
      };
    }
    const signal = signals[key];
    signal.collectorCount += 1;
    signal.sampleCount += sampleCount;
    signal.evidenceCount += Number(item.evidence_count || 0);
    signal.commentCount += Number(item.comment_count || 0);
    signal.eventCount += Number(item.event_count || 0);
    signal.weightedHealthTotal += Number(item.health_score || 0) * Math.max(1, sampleCount);
    if (!signal.collectorKinds.includes(item.collector_kind)) signal.collectorKinds.push(item.collector_kind);
    if (item.recommendation === "expand-deep-budget") signal.expandCount += 1;
    if (item.recommendation === "reduce-deep-budget") signal.reduceCount += 1;
    if (item.recommendation === "needs-more-samples") signal.sampleCollectorCount += 1;
  }
  for (const signal of Object.values(signals)) {
    signal.healthScore = signal.sampleCount
      ? Math.round((signal.weightedHealthTotal / Math.max(1, signal.sampleCount)) * 10) / 10
      : 0;
    const hasCommentCollectors = signal.collectorKinds.some(kind => /comments|quote/.test(kind));
    const hasPageCollectors = signal.collectorKinds.some(kind => /metadata|related|followup/.test(kind));
    const hasSocialContext = signal.collectorKinds.some(kind => /quote|social_page/.test(kind));
    if (signal.expandCount > 0 && signal.healthScore >= 60 && signal.eventCount > 0) {
      signal.action = "expand";
      signal.pageBoost = hasPageCollectors ? 1 : 0;
      signal.commentBoost = hasCommentCollectors ? 18 : 8;
      signal.captureQuotedContext = hasSocialContext;
    } else if (signal.reduceCount > signal.expandCount && signal.sampleCount >= 2) {
      signal.action = "reduce";
      signal.pagePenalty = hasPageCollectors ? 2 : 1;
      signal.commentPenalty = hasCommentCollectors ? 20 : 12;
      signal.disableQuotedContext = hasSocialContext;
    } else if (signal.sampleCollectorCount > 0 && signal.sampleCount < 6) {
      signal.action = "sample";
      signal.pageBoost = hasPageCollectors ? 1 : 0;
      signal.commentBoost = hasCommentCollectors ? 6 : 0;
      signal.captureQuotedContext = hasSocialContext;
    } else {
      signal.action = "keep";
      signal.pageBoost = 0;
      signal.commentBoost = 0;
    }
    delete signal.weightedHealthTotal;
  }
  return signals;
}

export function deriveCoverageSourceSignals(coverage = {}) {
  const signals = {};
  for (const item of Array.isArray(coverage.sources) ? coverage.sources : []) {
    const key = String(item?.source_key || "");
    if (!key) continue;
    const status = String(item.status || "watch");
    const issues = Array.isArray(item.issues) ? item.issues : [];
    const recommendation = String(item.recommendation || "");
    const score = Number(item.coverage_score || 0);
    const boost = status === "stale"
      ? 22
      : status === "under-covered"
        ? 20
        : status === "watch"
          ? 8
          : status === "noisy"
            ? -14
            : status === "blocked"
              ? -18
              : status === "disabled"
                ? -100
                : 0;
    signals[key] = {
      sourceKey: key,
      status,
      score,
      issues,
      recommendation,
      priorityBoost: boost,
      freshnessSlaMinutes: item.freshness_sla_minutes,
      ageMinutes: item.age_minutes,
      successAgeMinutes: item.success_age_minutes,
    };
  }
  return signals;
}

export function deriveSourceQualitySignals(profiles = []) {
  const signals = {};
  for (const item of Array.isArray(profiles) ? profiles : []) {
    const key = String(item?.source_key || "");
    if (!key) continue;
    const healthScore = Number(item.health_score || 0);
    const effectiveRate = Number(item.effective_rate || 0);
    const lowQualityRate = Number(item.low_quality_rate || 0);
    const duplicateRate = Number(item.duplicate_rate || 0);
    const failureRate = Number(item.failure_rate || 0);
    const sampleCount = Number(item.sample_count || 0);
    const scanCount = Number(item.scan_count || 0);
    const eventCount = Number(item.event_count || 0);
    const recommendation = String(item.recommendation || "");
    let priorityBoost = 0;
    let action = "monitor";
    const reasons = [];
    if (item.enabled === false) {
      priorityBoost -= 100;
      action = "disabled";
      reasons.push("disabled");
    } else if (scanCount >= 2 && failureRate >= 50) {
      priorityBoost -= 28;
      action = "repair-source";
      reasons.push("high-failure-rate");
    } else if (sampleCount >= 5 && lowQualityRate >= 45) {
      priorityBoost -= 22;
      action = "tighten-filters";
      reasons.push("high-low-quality-rate");
    } else if (sampleCount >= 5 && duplicateRate >= 50) {
      priorityBoost -= 10;
      action = "reduce-priority";
      reasons.push("high-duplicate-rate");
    } else if (sampleCount >= 5 && healthScore >= 75 && effectiveRate >= 70 && eventCount > 0 && failureRate < 20) {
      priorityBoost += 16;
      action = "promote-source";
      reasons.push("healthy-effective-source");
    } else if (sampleCount >= 3 && healthScore >= 60 && failureRate < 30) {
      priorityBoost += 6;
      action = "keep";
      reasons.push("stable-source-quality");
    }
    signals[key] = {
      sourceKey: key,
      action,
      recommendation,
      priorityBoost,
      reasons,
      healthScore,
      effectiveRate,
      lowQualityRate,
      duplicateRate,
      failureRate,
      sampleCount,
      scanCount,
      eventCount,
    };
  }
  return signals;
}

export function deriveNoiseSuppressionSourceSignals(report = {}) {
  const signals = new Map();
  for (const source of Array.isArray(report.sources) ? report.sources : []) {
    const sourceKey = String(source.source_key || "").trim();
    if (!sourceKey) continue;
    const noiseScore = Number(source.noise_score || 0);
    const recommendation = String(source.recommendation || "");
    let priorityBoost = 0;
    let action = "watch-noise";
    if (recommendation === "suppress-or-repair-source-before-more-collection") {
      priorityBoost = -32;
      action = "repair-or-suppress-source";
    } else if (recommendation === "tighten-source-filters-and-reduce-budget") {
      priorityBoost = -18;
      action = "tighten-source";
    } else if (noiseScore >= 35) {
      priorityBoost = -8;
    }
    signals.set(sourceKey, {
      sourceKey,
      action,
      recommendation,
      noiseScore,
      priorityBoost,
      issues: source.issues || [],
      lowQualityRate: Number(source.low_quality_rate || 0),
      duplicateRate: Number(source.duplicate_rate || 0),
      failureRate: Number(source.failure_rate || 0),
      precisionRejectRate: Number(source.precision_reject_rate || 0),
      precisionRejectCount: Number(source.precision_reject_count || 0),
      duplicateClusterCount: Number(source.duplicate_cluster_count || 0),
      duplicateItemCount: Number(source.duplicate_item_count || 0),
      sampleUrls: source.sample_urls || [],
      suppressedKeywords: [],
      tightenedKeywords: [],
    });
  }
  for (const item of Array.isArray(report.source_keywords) ? report.source_keywords : []) {
    const sourceKey = String(item.source_key || "").trim();
    if (!sourceKey) continue;
    const current = signals.get(sourceKey) || {
      sourceKey,
      action: "tighten-source-keywords",
      recommendation: "tighten-source-keywords",
      noiseScore: 0,
      priorityBoost: -6,
      issues: [],
      lowQualityRate: 0,
      duplicateRate: 0,
      failureRate: 0,
      precisionRejectRate: 0,
      precisionRejectCount: 0,
      duplicateClusterCount: 0,
      duplicateItemCount: 0,
      sampleUrls: [],
      suppressedKeywords: [],
      tightenedKeywords: [],
    };
    const keyword = String(item.keyword || "").trim();
    if (!keyword) continue;
    if (item.recommendation === "suppress-source-keyword") {
      if (!current.suppressedKeywords.includes(keyword)) current.suppressedKeywords.push(keyword);
      current.priorityBoost = Math.min(Number(current.priorityBoost || 0), -12);
      if (!current.issues.includes("noisy-source-keywords")) current.issues.push("noisy-source-keywords");
    } else if (item.recommendation === "tighten-source-keyword") {
      if (!current.tightenedKeywords.includes(keyword)) current.tightenedKeywords.push(keyword);
      current.priorityBoost = Math.min(Number(current.priorityBoost || 0), -6);
      if (!current.issues.includes("weak-source-keywords")) current.issues.push("weak-source-keywords");
    }
    current.suppressedKeywords = current.suppressedKeywords.slice(0, 30);
    current.tightenedKeywords = current.tightenedKeywords.slice(0, 30);
    signals.set(sourceKey, current);
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => a[1].priorityBoost - b[1].priorityBoost || b[1].noiseScore - a[1].noiseScore || a[0].localeCompare(b[0])));
}

function recoveryAlternateSourcesForSource(sourceKey = "") {
  const key = String(sourceKey || "");
  const families = [
    {
      sources: ["duckDuckGo", "baiduSearch", "sogouSearch", "soSearch", "yandexSearch", "openWebDiscovery", "googleNews", "bingNews", "baiduNews", "rssFeeds", "gdelt"],
      alternates: ["browserFallback", "openWebDiscovery", "duckDuckGo", "googleNews", "bingNews", "baiduNews", "rssFeeds", "gdelt", "sogouSearch", "soSearch", "yandexSearch"],
    },
    {
      sources: ["taiwanNews", "googleNews", "bingNews", "baiduNews", "yahooTaiwan", "yahooJapanNews", "naverKoreaNews", "daumKoreaNews", "gdelt", "rssFeeds"],
      alternates: ["browserFallback", "taiwanNews", "rssFeeds", "googleNews", "bingNews", "baiduNews", "gdelt", "duckDuckGo", "openWebDiscovery", "officialRegulatory"],
    },
    {
      sources: ["reddit", "ptt", "dcard", "telegramPublic", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "weiboSearch", "xiaohongshuSearch", "mastodon", "bluesky", "tiebaSearch"],
      alternates: ["browserFallback", "reddit", "ptt", "dcard", "threads", "xSearch", "weiboSearch", "xiaohongshuSearch", "tiebaSearch", "telegramPublic", "mastodon", "bluesky", "googleNews", "duckDuckGo", "openWebDiscovery"],
    },
    {
      sources: ["youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch"],
      alternates: ["browserFallback", "youtube", "bilibili", "tiktokSearch", "douyinSearch", "kuaishouSearch", "xSearch", "weiboSearch", "xiaohongshuSearch", "googleNews", "duckDuckGo", "openWebDiscovery"],
    },
    {
      sources: ["githubIssues", "gitLabIssues", "hackerNews", "stackOverflow", "discourseForums", "lemmy", "zhihuSearch", "quoraSearch"],
      alternates: ["githubIssues", "gitLabIssues", "hackerNews", "stackOverflow", "discourseForums", "lemmy", "reddit", "duckDuckGo", "openWebDiscovery", "googleNews"],
    },
    {
      sources: ["officialRegulatory", "legalPublicRecords", "publicProcurementSources", "publicSanctionsSources", "publicProductRecallSources", "publicEnforcementActionSources", "publicAdvertisingRulingsSources", "publicRegulatoryWarningLetterSources", "publicCompanyFilingsSources", "brandImpersonationSources", "securityAdvisorySources", "supplyChainAdvisorySources", "investorDiscussionSources", "publicStatusPageSources", "officialOwnedMediaSources"],
      alternates: ["officialRegulatory", "legalPublicRecords", "publicCompanyFilingsSources", "publicStatusPageSources", "officialOwnedMediaSources", "googleNews", "bingNews", "rssFeeds", "gdelt", "duckDuckGo", "openWebDiscovery"],
    },
    {
      sources: ["publicReviewSites", "verticalReviewSources", "employerReviewSources", "ecommerceReviewSources", "localReviewSources", "regionalComplaintSources", "appStoreReviews", "googlePlayReviews", "applePodcastSearch"],
      alternates: ["publicReviewSites", "regionalComplaintSources", "verticalReviewSources", "ecommerceReviewSources", "appStoreReviews", "googlePlayReviews", "reddit", "googleNews", "duckDuckGo", "openWebDiscovery"],
    },
  ];
  const selected = families.find(family => family.sources.includes(key));
  const fallback = ["googleNews", "bingNews", "rssFeeds", "duckDuckGo", "openWebDiscovery", "gdelt"];
  return [...new Set([...(selected?.alternates || []), ...fallback]
    .map(item => String(item || "").trim())
    .filter(item => item && item !== key))]
    .slice(0, 14);
}

export function deriveSourceRecoveryAction(sourceKey, {
  status = "",
  message = "",
  coolingUntil = null,
  coverageSignal = null,
  credibilitySignal = null,
  qualityFeedback = null,
  budget = null,
} = {}) {
  const key = String(sourceKey || "");
  const normalizedStatus = String(status || "").toLowerCase();
  const reason = compactFailureReason(message);
  const coverageStatus = String(coverageSignal?.status || "");
  const issues = new Set(Array.isArray(coverageSignal?.issues) ? coverageSignal.issues : []);
  const feedbackAction = String(qualityFeedback?.action || "");
  const retryAtMs = coolingUntil ? new Date(coolingUntil).getTime() : NaN;
  const retryAfterMinutes = Number.isNaN(retryAtMs) ? null : Math.max(1, Math.ceil((retryAtMs - Date.now()) / 60000));
  const base = {
    sourceKey: key,
    action: "monitor",
    severity: "low",
    reason,
    retryAfterMinutes,
    queryStrategy: "normal",
    contentControls: {},
    budget,
    alternateSources: [],
  };
  const alternateSources = recoveryAlternateSourcesForSource(key);

  if (normalizedStatus === "disabled" || coverageStatus === "disabled") {
    return {
      ...base,
      action: "enable-or-remove",
      severity: "medium",
      reason: "來源已停用",
      queryStrategy: "none",
    };
  }
  if (/HTTP\s+429/i.test(reason)) {
    return {
      ...base,
      action: "backoff-and-thin-query",
      severity: "high",
      retryAfterMinutes: retryAfterMinutes || 15,
      queryStrategy: "thin-risk-first",
      alternateSources,
    };
  }
  if (/HTTP\s+403/i.test(reason)) {
    return {
      ...base,
      action: "reduce-frequency-and-use-alternates",
      severity: "high",
      retryAfterMinutes: retryAfterMinutes || 30,
      queryStrategy: "minimal",
      alternateSources,
    };
  }
  if (/請求超時|連線被中斷|代理連線異常/i.test(reason)) {
    return {
      ...base,
      action: "retry-with-smaller-budget",
      severity: "medium",
      retryAfterMinutes: retryAfterMinutes || 3,
      queryStrategy: "thin-risk-first",
      alternateSources: alternateSources.slice(0, 6),
    };
  }
  if (normalizedStatus === "cooldown" || coverageStatus === "blocked" || feedbackAction === "repair-source") {
    return {
      ...base,
      action: "repair-source",
      severity: "high",
      retryAfterMinutes: retryAfterMinutes || 10,
      queryStrategy: "thin-risk-first",
      alternateSources,
    };
  }
  if (normalizedStatus === "empty" || normalizedStatus === "no-results") {
    return {
      ...base,
      action: "empty-result-use-alternates",
      severity: "medium",
      reason: reason || "來源本輪無結果，使用同類與跨類免費源補償覆蓋",
      queryStrategy: "thin-risk-first",
      alternateSources: alternateSources.slice(0, 8),
    };
  }
  if (normalizedStatus === "failed" || normalizedStatus === "partial") {
    return {
      ...base,
      action: "route-risk-keywords-to-alternates",
      severity: normalizedStatus === "failed" ? "high" : "medium",
      reason: reason || "來源本輪失敗或部分失敗，使用免費替代源補償關鍵風險詞",
      retryAfterMinutes: retryAfterMinutes || 5,
      queryStrategy: "thin-risk-first",
      alternateSources: alternateSources.slice(0, 10),
    };
  }
  if (coverageStatus === "noisy" || issues.has("noisy") || feedbackAction === "suppress") {
    return {
      ...base,
      action: "tighten-filters",
      severity: "medium",
      queryStrategy: "require-entity-and-risk-term",
    };
  }
  if (coverageStatus === "stale" || issues.has("stale") || issues.has("no-recent-success")) {
    return {
      ...base,
      action: "refresh-schedule",
      severity: "medium",
      queryStrategy: "normal",
    };
  }
  if (coverageStatus === "under-covered" || issues.has("under-covered") || issues.has("weak-contribution")) {
    return {
      ...base,
      action: "increase-coverage",
      severity: "medium",
      queryStrategy: "expand-pages",
    };
  }
  const precisionPolicy = deriveCredibilityPrecisionPolicy(credibilitySignal);
  if (precisionPolicy.queryStrategy) {
    return {
      ...base,
      action: precisionPolicy.queryStrategy === "expand-pages" ? "trusted-source-deepen" : "credibility-tighten-query",
      severity: precisionPolicy.queryStrategy === "expand-pages" ? "low" : "medium",
      reason: precisionPolicy.reason,
      queryStrategy: precisionPolicy.queryStrategy,
      contentControls: precisionPolicy.contentControls,
    };
  }
  return base;
}

function containsRiskTerm(keyword = "") {
  const text = String(keyword || "");
  return RISK_SCAN_TERMS.some(term => text.includes(term));
}

function containsEntityAndRisk(keyword = "", baseKeywords = []) {
  const text = String(keyword || "");
  if (!containsRiskTerm(text)) return false;
  return normalizeSentimentMonitorKeywords(baseKeywords).some(base => base && text.includes(base));
}

export function applySourceQueryStrategy(keywords = [], {
  strategy = "normal",
  baseKeywords = [],
  mode = SCAN_MODE_FAST,
  limit = null,
} = {}) {
  const normalized = normalizeSentimentMonitorKeywords(keywords);
  const base = normalizeSentimentMonitorKeywords(baseKeywords);
  const safeLimit = Math.max(1, Math.min(SEARCH_KEYWORD_LIMIT, Number(limit) || normalized.length || 1));
  const keepUnique = (values) => normalizeSentimentMonitorKeywords(values).slice(0, safeLimit);
  if (!normalized.length || strategy === "none") return [];
  if (strategy === "minimal") {
    const priority = normalized.filter(keyword => base.includes(keyword) || containsRiskTerm(keyword));
    return keepUnique(priority.length ? priority : normalized.slice(0, mode === SCAN_MODE_FULL ? 6 : 3));
  }
  if (strategy === "thin-risk-first") {
    const risk = normalized.filter(containsRiskTerm);
    const protectedBase = normalized.filter(keyword => base.includes(keyword));
    return keepUnique([...protectedBase, ...risk, ...normalized].slice(0, mode === SCAN_MODE_FULL ? 10 : 5));
  }
  if (strategy === "require-entity-and-risk-term") {
    const precise = normalized.filter(keyword => containsEntityAndRisk(keyword, base));
    const risk = normalized.filter(containsRiskTerm);
    return keepUnique(precise.length ? precise : [...risk, ...base, ...normalized].slice(0, mode === SCAN_MODE_FULL ? 8 : 4));
  }
  if (strategy === "expand-pages") {
    return keepUnique(normalized);
  }
  return keepUnique(normalized);
}

export function deriveTrackingSourceSignals(nodes = [], { minPriority = 35 } = {}) {
  const signals = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const trackingPriority = Math.max(0, Math.min(100, Number(node?.tracking_priority || 0) || 0));
    const propagationScore = Math.max(0, Math.min(100, Number(node?.propagation_path_score || node?.propagation_score || 0) || 0));
    const priority = Math.max(trackingPriority, propagationScore);
    if (priority < minPriority) continue;
    const stage = String(node?.propagation_stage || "");
    const stageBoost = stage === "amplifying" ? 18 : stage === "cross-platform-spread" ? 12 : stage === "originating" ? 8 : 0;
    const propagationBoost = propagationScore >= 75 ? 16 : propagationScore >= 55 ? 10 : propagationScore >= 35 ? 4 : 0;
    const sources = Array.isArray(node?.next_tracking_sources) ? node.next_tracking_sources : [];
    for (const sourceKey of sources) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const previous = signals.get(key) || {
        sourceKey: key,
        score: 0,
        eventCount: 0,
        maxPriority: 0,
        maxPropagationPathScore: 0,
        stages: [],
        reasons: [],
        propagationScoreLabels: [],
      };
      previous.score = Math.min(100, previous.score + Math.round((priority + stageBoost + propagationBoost) / 2));
      previous.eventCount += 1;
      previous.maxPriority = Math.max(previous.maxPriority, priority);
      previous.maxPropagationPathScore = Math.max(previous.maxPropagationPathScore, propagationScore);
      if (stage && !previous.stages.includes(stage)) previous.stages.push(stage);
      const scoreLabel = String(node?.propagation_score_label || "");
      if (scoreLabel && !previous.propagationScoreLabels.includes(scoreLabel)) previous.propagationScoreLabels.push(scoreLabel);
      for (const reason of [
        ...(Array.isArray(node?.tracking_reasons) ? node.tracking_reasons : []),
        ...(Array.isArray(node?.propagation_score_reasons) ? node.propagation_score_reasons : []),
      ]) {
        if (reason && !previous.reasons.includes(reason)) previous.reasons.push(reason);
        if (previous.reasons.length >= 10) break;
      }
      signals.set(key, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function propagationConfidenceGapSources(node = {}) {
  const out = new Set(Array.isArray(node.next_tracking_sources) ? node.next_tracking_sources : []);
  const breakdown = node.propagation_confidence_breakdown || {};
  const reasons = new Set(Array.isArray(node.propagation_confidence_reasons) ? node.propagation_confidence_reasons : []);
  const platforms = Array.isArray(node.platforms) ? node.platforms.map(platform => String(platform || "").toLowerCase()) : [];
  const hasNews = platforms.some(platform => ["news", "google_news", "yahoo_taiwan", "taiwan_news", "rss_feeds", "gdelt"].includes(platform));
  const hasSocial = platforms.some(platform => ["threads", "instagram", "x", "twitter", "facebook", "fb", "mastodon", "bluesky", "youtube", "tiktok", "douyin", "kuaishou", "reddit", "dcard", "ptt"].includes(platform));
  if (Number(breakdown.origin_confidence || 0) < 55) {
    ["googleNews", "bingNews", "baiduNews", "rssFeeds", "officialRegulatory", "legalPublicRecords", "brandImpersonationSources", "duckDuckGo", "openWebDiscovery", "gdelt"].forEach(source => out.add(source));
  }
  if (Number(breakdown.edge_count || 0) === 0 || Number(breakdown.average_edge_confidence || 0) < 45) {
    ["duckDuckGo", "googleNews", "bingNews", "baiduNews", "rssFeeds"].forEach(source => out.add(source));
  }
  if (Number(breakdown.timeline_items || 0) < 3) {
    ["threads", "xSearch", "facebookSearch", "linkedinSearch", "dcard", "ptt", "youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch"].forEach(source => out.add(source));
  }
  if (!hasNews) ["googleNews", "bingNews", "baiduNews", "rssFeeds", "gdelt"].forEach(source => out.add(source));
  if (!hasSocial) ["threads", "xSearch", "facebookSearch", "linkedinSearch", "dcard", "ptt", "youtube", "tiktokSearch", "douyinSearch", "kuaishouSearch", "reddit"].forEach(source => out.add(source));
  if (reasons.has("multi-platform-evidence") && !reasons.has("cross-family-evidence")) {
    ["googleNews", "bingNews", "baiduNews", "rssFeeds", "threads", "xSearch", "facebookSearch", "linkedinSearch", "dcard", "ptt"].forEach(source => out.add(source));
  }
  return [...out].filter(Boolean);
}

export function derivePropagationConfidenceSourceSignals(nodes = [], { maxConfidence = 58, minPropagationScore = 35 } = {}) {
  const signals = new Map();
  const confidenceThreshold = Math.max(0, Math.min(100, Number(maxConfidence) || 58));
  const propagationThreshold = Math.max(0, Math.min(100, Number(minPropagationScore) || 35));
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const confidence = Number(node?.propagation_confidence_score || 0);
    const propagation = Number(node?.propagation_path_score || node?.propagation_score || 0);
    const label = String(node?.propagation_confidence_label || "");
    const shouldBackfill = propagation >= propagationThreshold
      && (confidence <= confidenceThreshold || ["low-confidence", "insufficient-confidence"].includes(label));
    if (!shouldBackfill) continue;
    const breakdown = node.propagation_confidence_breakdown || {};
    const adjacentEdges = Array.isArray(node.adjacent_edges) ? node.adjacent_edges : [];
    const explicitEdges = adjacentEdges.filter(edge => edge?.reason?.explicitReference || edge?.evidence?.explicitReference);
    const gaps = [];
    if (Number(breakdown.origin_confidence || 0) < 55) gaps.push("weak-origin-evidence");
    if (Number(breakdown.edge_count || 0) === 0 || Number(breakdown.average_edge_confidence || 0) < 45) gaps.push("weak-edge-evidence");
    if (Number(breakdown.timeline_items || 0) < 3) gaps.push("thin-timeline");
    if (Number(breakdown.platform_count || 0) < 2) gaps.push("missing-cross-platform-confirmation");
    if (Number(breakdown.family_count || 0) < 2) gaps.push("missing-cross-family-confirmation");
    const sourceKeys = propagationConfidenceGapSources(node);
    const baseBoost = propagation >= 75 ? 30 : propagation >= 55 ? 24 : 16;
    const confidenceBoost = confidence < 38 ? 10 : confidence < 58 ? 6 : 2;
    const priorityBoost = Math.min(38, baseBoost + confidenceBoost + Math.min(8, gaps.length * 2));
    const suggestedKeywords = normalizeSentimentMonitorKeywords([
      node.keyword,
      node.label,
      node.likely_origin?.title,
      ...(Array.isArray(node.timeline) ? node.timeline.map(item => item.title || item.keyword) : []),
    ]).slice(0, 12);
    for (const sourceKey of sourceKeys) {
      const previous = signals.get(sourceKey) || {
        sourceKey,
        score: 0,
        priorityBoost: 0,
        eventCount: 0,
        minConfidenceScore: 100,
        maxPropagationPathScore: 0,
        labels: [],
        gaps: [],
        explicitReferenceChain: false,
        explicitReferenceCount: 0,
        explicitReferenceReasons: [],
        suggestedKeywords: [],
        exampleEvents: [],
      };
      previous.eventCount += 1;
      previous.score = Math.min(100, previous.score + Math.round((priorityBoost + propagation) / 2));
      previous.priorityBoost = Math.max(previous.priorityBoost, priorityBoost);
      previous.minConfidenceScore = Math.min(previous.minConfidenceScore, confidence);
      previous.maxPropagationPathScore = Math.max(previous.maxPropagationPathScore, propagation);
      if (label && !previous.labels.includes(label)) previous.labels.push(label);
      if (explicitEdges.length) {
        previous.explicitReferenceChain = true;
        previous.explicitReferenceCount += explicitEdges.length;
        for (const edge of explicitEdges) {
          const evidence = edge.reason || edge.evidence || {};
          for (const reason of evidence.explicitReferenceReasons || []) {
            if (reason && !previous.explicitReferenceReasons.includes(reason) && previous.explicitReferenceReasons.length < 12) {
              previous.explicitReferenceReasons.push(reason);
            }
          }
        }
      }
      for (const gap of gaps) {
        if (gap && !previous.gaps.includes(gap) && previous.gaps.length < 12) previous.gaps.push(gap);
      }
      for (const keyword of suggestedKeywords) {
        if (keyword && !previous.suggestedKeywords.includes(keyword) && previous.suggestedKeywords.length < 16) previous.suggestedKeywords.push(keyword);
      }
      if (node.label && previous.exampleEvents.length < 8) {
        previous.exampleEvents.push({
          id: node.id,
          label: node.label,
          propagation_path_score: propagation,
          propagation_confidence_score: confidence,
        });
      }
      signals.set(sourceKey, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function burstSignalSeverityWeight(severity = "") {
  const key = String(severity || "").toLowerCase();
  if (key === "critical") return 45;
  if (key === "high") return 34;
  if (key === "medium") return 22;
  return 12;
}

function riskLevelWeight(riskLevel = "") {
  const key = String(riskLevel || "").toLowerCase();
  if (key === "critical") return 42;
  if (key === "high") return 32;
  if (key === "medium") return 18;
  return 8;
}

function alertEventSourceKeys(record = {}) {
  const sources = new Set(URGENCY_CORE_SOURCE_KEYS);
  const platforms = Array.isArray(record.platforms) ? record.platforms : [];
  for (const platform of platforms) {
    const normalized = String(platform || "").toLowerCase();
    for (const sourceKey of BURST_PLATFORM_SOURCE_HINTS.get(normalized) || []) sources.add(sourceKey);
  }
  const sourceUrls = Array.isArray(record.source_urls) ? record.source_urls : [];
  for (const url of sourceUrls) {
    const lower = String(url || "").toLowerCase();
    for (const [platform, sourceKeys] of BURST_PLATFORM_SOURCE_HINTS.entries()) {
      if (lower.includes(platform.replace(/_/g, "")) || lower.includes(platform.replace(/_/g, "-"))) {
        for (const sourceKey of sourceKeys) sources.add(sourceKey);
      }
    }
    if (/youtube\.com|youtu\.be/.test(lower)) sources.add("youtube");
    if (/tiktok\.com/.test(lower)) sources.add("tiktokSearch");
    if (/(^|\/\/)(?:www\.|mobile\.)?(?:x|twitter)\.com/.test(lower)) sources.add("xSearch");
    if (/(^|\/\/)(?:www\.|m\.)?facebook\.com|(^|\/\/)fb\.watch/.test(lower)) sources.add("facebookSearch");
    if (/(^|\/\/)(?:www\.)?linkedin\.com/.test(lower)) sources.add("linkedinSearch");
    if (/ptt\.cc/.test(lower)) sources.add("ptt");
    if (/dcard\./.test(lower)) sources.add("dcard");
    if (/reddit\.com/.test(lower)) sources.add("reddit");
  }
  const severity = String(record.severity || record.risk_level || "").toLowerCase();
  if (severity === "critical" || severity === "high") {
    for (const sourceKey of URGENCY_WATCH_SOURCE_KEYS) sources.add(sourceKey);
  }
  return [...sources].filter(Boolean);
}

export function deriveAlertEventUrgencySourceSignals({ alerts = [], events = [] } = {}) {
  const signals = new Map();
  const records = [
    ...(Array.isArray(alerts) ? alerts : []).map(alert => ({
      kind: "alert",
      severity: alert.severity,
      keyword: alert.keyword,
      title: alert.title,
      message: alert.message,
      platforms: alert.platforms || [],
      source_urls: alert.source_urls || [],
      id: alert.id,
    })),
    ...(Array.isArray(events) ? events : []).map(event => ({
      kind: "event",
      risk_level: event.risk_level,
      keyword: event.keyword,
      title: event.title,
      summary: event.summary,
      platforms: event.platforms || [],
      source_urls: event.source_urls || [],
      id: event.id,
    })),
  ];
  for (const record of records) {
    const severity = String(record.severity || record.risk_level || "low").toLowerCase();
    const severityBoost = Math.max(burstSignalSeverityWeight(severity), riskLevelWeight(severity));
    if (severityBoost < 18) continue;
    const sourceKeys = alertEventSourceKeys(record);
    const text = [
      record.keyword,
      record.title,
      record.message,
      record.summary,
      ...(record.platforms || []),
    ].join(" ");
    const riskTerms = RISK_SCAN_TERMS.filter(term => text.includes(term));
    const suggestedKeywords = normalizeSentimentMonitorKeywords([
      record.keyword,
      ...riskTerms,
      ...String(text || "").matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g),
      ...String(text || "").matchAll(/[\u4e00-\u9fff]{2,12}/g),
    ].map(item => Array.isArray(item) ? item[0] : item)).slice(0, 16);
    for (const sourceKey of sourceKeys) {
      const sourceMatched = (record.platforms || []).some(platform => (BURST_PLATFORM_SOURCE_HINTS.get(String(platform || "").toLowerCase()) || []).includes(sourceKey));
      const realtimeBoost = REALTIME_SOURCE_KEYS.has(sourceKey) ? 6 : 0;
      const matchedBoost = sourceMatched ? 8 : 0;
      const score = Math.min(100, severityBoost + realtimeBoost + matchedBoost + Math.min(12, suggestedKeywords.length));
      const previous = signals.get(sourceKey) || {
        sourceKey,
        score: 0,
        priorityBoost: 0,
        alertCount: 0,
        eventCount: 0,
        maxSeverity: "low",
        riskLevels: [],
        platforms: [],
        suggestedKeywords: [],
        examples: [],
      };
      previous.score = Math.min(100, previous.score + Math.round(score / 2));
      previous.priorityBoost = Math.max(previous.priorityBoost, Math.min(48, Math.round(score / 2)));
      if (record.kind === "alert") previous.alertCount += 1;
      if (record.kind === "event") previous.eventCount += 1;
      if (burstSignalSeverityWeight(severity) > burstSignalSeverityWeight(previous.maxSeverity)) previous.maxSeverity = severity;
      if (severity && !previous.riskLevels.includes(severity)) previous.riskLevels.push(severity);
      for (const platform of record.platforms || []) {
        if (platform && !previous.platforms.includes(platform) && previous.platforms.length < 12) previous.platforms.push(platform);
      }
      for (const keyword of suggestedKeywords) {
        if (keyword && !previous.suggestedKeywords.includes(keyword) && previous.suggestedKeywords.length < 16) previous.suggestedKeywords.push(keyword);
      }
      if (previous.examples.length < 8) {
        previous.examples.push({
          kind: record.kind,
          id: record.id || null,
          keyword: record.keyword || "",
          severity,
          title: record.title || "",
        });
      }
      signals.set(sourceKey, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function anomalyBurstSourceKeys(anomaly = {}) {
  const sources = new Set();
  const type = String(anomaly.anomaly_type || anomaly.anomalyType || "");
  const evidence = anomaly.evidence || {};
  const topItems = Array.isArray(evidence.top_items) ? evidence.top_items : [];
  for (const item of topItems) {
    const platform = String(item.platform || "").toLowerCase();
    for (const sourceKey of BURST_PLATFORM_SOURCE_HINTS.get(platform) || []) sources.add(sourceKey);
  }
  if (type === "spread_velocity") {
    for (const sourceKey of [...BURST_WATCH_SOURCE_KEYS, "googleNews", "bingNews", "baiduNews", "rssFeeds"]) sources.add(sourceKey);
  } else if (type === "negative_ratio_shift") {
    for (const sourceKey of BURST_WATCH_SOURCE_KEYS) sources.add(sourceKey);
  } else if (type === "source_weighted_spike") {
    for (const sourceKey of BURST_NEWS_SOURCE_KEYS) sources.add(sourceKey);
  }
  return [...sources].filter(Boolean);
}

function realtimeSourceKeyForPlatform(platform = "") {
  const key = String(platform || "").toLowerCase();
  const hinted = BURST_PLATFORM_SOURCE_HINTS.get(key);
  if (hinted?.length) return hinted[0];
  const normalized = key.replace(/[^a-z0-9]+/g, "");
  if (normalized === "googlenews") return "googleNews";
  if (normalized === "bingnews" || normalized === "bing" || normalized === "bing_news") return "bingNews";
  if (normalized === "yahoojapannews" || normalized === "yahoojapan" || normalized === "yahoojp") return "yahooJapanNews";
  if (normalized === "naverkoreanews" || normalized === "navernews" || normalized === "naverkorea" || normalized === "naver") return "naverKoreaNews";
  if (normalized === "daumkoreanews" || normalized === "daumnews" || normalized === "daumkorea" || normalized === "daum" || normalized === "kakaonews") return "daumKoreaNews";
  if (normalized === "baidunews" || normalized === "baidu_news") return "baiduNews";
  if (normalized === "duckduckgo") return "duckDuckGo";
  if (normalized === "yandex" || normalized === "yandexsearch") return "yandexSearch";
  if (normalized === "sosearch" || normalized === "so" || normalized === "so_search" || normalized === "360search" || normalized === "360") return "soSearch";
  if (normalized === "gdelt") return "gdelt";
  if (normalized === "youtube") return "youtube";
  if (normalized === "tiktok" || normalized === "tiktoksearch") return "tiktokSearch";
  if (normalized === "x" || normalized === "xsearch" || normalized === "twitter" || normalized === "twittersearch") return "xSearch";
  if (normalized === "facebook" || normalized === "facebooksearch" || normalized === "fb") return "facebookSearch";
  if (normalized === "linkedin" || normalized === "linkedinsearch" || normalized === "linked_in") return "linkedinSearch";
  if (normalized === "quora" || normalized === "quorasearch") return "quoraSearch";
  if (normalized === "substack" || normalized === "substacksearch") return "substackSearch";
  if (normalized === "medium" || normalized === "mediumsearch") return "mediumSearch";
  if (normalized === "wordpress" || normalized === "wordpresssearch") return "wordpressSearch";
  if (normalized === "blogspot" || normalized === "blogspotsearch" || normalized === "blogger") return "blogspotSearch";
  if (normalized === "tumblr" || normalized === "tumblrsearch") return "tumblrSearch";
  if (normalized === "ptt") return "ptt";
  if (normalized === "dcard") return "dcard";
  if (normalized === "threads") return "threads";
  if (normalized === "instagram") return "instagram";
  if (normalized === "mastodon") return "mastodon";
  if (normalized === "bluesky") return "bluesky";
  if (normalized === "reddit") return "reddit";
  if (normalized.includes("review")) return "publicReviewSites";
  if (normalized.includes("complaint")) return "regionalComplaintSources";
  return normalized || "";
}

export function deriveAnomalyBurstSourceSignals(anomalies = [], { now = Date.now(), maxAgeHours = 48 } = {}) {
  const signals = new Map();
  const nowMs = Number(now) || Date.now();
  const maxAgeMs = Math.max(1, Number(maxAgeHours) || 48) * 60 * 60 * 1000;
  for (const anomaly of Array.isArray(anomalies) ? anomalies : []) {
    if (String(anomaly?.status || "open") !== "open") continue;
    const endMs = Date.parse(anomaly.window_end || anomaly.updated_at || anomaly.created_at || "");
    if (Number.isFinite(endMs) && nowMs - endMs > maxAgeMs) continue;
    const score = Math.max(0, Math.min(100, Number(anomaly.score || 0) || 0));
    const severityWeight = burstSignalSeverityWeight(anomaly.severity);
    const type = String(anomaly.anomaly_type || anomaly.anomalyType || "unknown");
    const evidence = anomaly.evidence || {};
    const topItems = Array.isArray(evidence.top_items) ? evidence.top_items : [];
      const platforms = [...new Set(topItems.map(item => String(item.platform || "")).filter(Boolean))].slice(0, 8);
      const keywords = [...new Set(topItems.map(item => String(item.keyword || "")).filter(Boolean))].slice(0, 8);
      const titles = [...new Set(topItems.map(item => String(item.title || "")).filter(Boolean))].slice(0, 8);
      const sourceKeys = anomalyBurstSourceKeys(anomaly);
    for (const sourceKey of sourceKeys) {
      const previous = signals.get(sourceKey) || {
        sourceKey,
        score: 0,
        priorityBoost: 0,
        anomalyCount: 0,
        maxAnomalyScore: 0,
        maxSeverity: "low",
        anomalyTypes: [],
        platforms: [],
        keywords: [],
      };
      const sourceMatchedPlatform = topItems.some(item => (BURST_PLATFORM_SOURCE_HINTS.get(String(item.platform || "").toLowerCase()) || []).includes(sourceKey));
      const realtimeBoost = REALTIME_SOURCE_KEYS.has(sourceKey) ? 8 : 0;
      const matchedBoost = sourceMatchedPlatform ? 10 : 0;
      const sourceScore = Math.min(100, Math.round(score * 0.55 + severityWeight + realtimeBoost + matchedBoost));
      previous.score = Math.min(100, previous.score + Math.round(sourceScore / 2));
      previous.priorityBoost = Math.max(previous.priorityBoost, Math.min(45, Math.round(sourceScore / 2)));
      previous.anomalyCount += 1;
      previous.maxAnomalyScore = Math.max(previous.maxAnomalyScore, score);
      if (burstSignalSeverityWeight(anomaly.severity) > burstSignalSeverityWeight(previous.maxSeverity)) {
        previous.maxSeverity = String(anomaly.severity || "low");
      }
      if (type && !previous.anomalyTypes.includes(type)) previous.anomalyTypes.push(type);
      for (const platform of platforms) {
        if (platform && !previous.platforms.includes(platform) && previous.platforms.length < 10) previous.platforms.push(platform);
      }
      for (const keyword of keywords) {
        if (keyword && !previous.keywords.includes(keyword) && previous.keywords.length < 10) previous.keywords.push(keyword);
      }
      previous.titles = previous.titles || [];
      for (const title of titles) {
        if (title && !previous.titles.includes(title) && previous.titles.length < 10) previous.titles.push(title);
      }
      signals.set(sourceKey, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function deriveRealtimeAnomalyWindowSourceSignals(report = {}) {
  const signals = new Map();
  for (const signal of Array.isArray(report.signals) ? report.signals : []) {
    const score = Math.max(0, Math.min(100, Number(signal.score || 0) || 0));
    if (score < 35) continue;
    const sourceKeys = uniqueExpansionTerms([
      ...(signal.suggested_sources || []),
      ...(signal.current?.platforms || []).map(platform => BURST_PLATFORM_SOURCE_HINTS.get(String(platform || "").toLowerCase()) || realtimeSourceKeyForPlatform(platform)).flat(),
    ], 24);
    const baseBoost = score >= 85 ? 46 : score >= 68 ? 38 : score >= 48 ? 30 : 20;
    const subHourBoost = Number(signal.window_hours || 0) < 1 ? 6 : 0;
    const crossPlatformBoost = (signal.reasons || []).includes("cross-platform-acceleration") ? 5 : 0;
    for (const sourceKey of sourceKeys) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const previous = signals.get(key) || {
        sourceKey: key,
        score: 0,
        priorityBoost: 0,
        signalCount: 0,
        maxScore: 0,
        severities: [],
        windows: [],
        reasons: [],
        gaps: [],
        suggestedKeywords: [],
        sampleUrls: [],
      };
      const sourceMatched = (signal.top_items || []).some(item => item.source_key === key || (BURST_PLATFORM_SOURCE_HINTS.get(String(item.platform || "").toLowerCase()) || []).includes(key));
      const matchedBoost = sourceMatched ? 6 : 0;
      const boost = Math.min(52, baseBoost + subHourBoost + crossPlatformBoost + matchedBoost);
      previous.score = Math.min(100, Number(previous.score || 0) + Math.round((score + boost) / 3));
      previous.priorityBoost = Math.max(Number(previous.priorityBoost || 0), boost);
      previous.signalCount += 1;
      previous.maxScore = Math.max(Number(previous.maxScore || 0), score);
      if (signal.severity && !previous.severities.includes(signal.severity)) previous.severities.push(signal.severity);
      if (signal.window_label && !previous.windows.includes(signal.window_label)) previous.windows.push(signal.window_label);
      previous.reasons = uniqueExpansionTerms([...(previous.reasons || []), ...(signal.reasons || [])], 16);
      previous.gaps = uniqueExpansionTerms([...(previous.gaps || []), ...(signal.gaps || [])], 16);
      previous.suggestedKeywords = normalizeSentimentMonitorKeywords([
        ...previous.suggestedKeywords,
        ...(signal.suggested_keywords || []),
        ...(signal.top_items || []).map(item => item.title),
      ]).slice(0, 18);
      previous.sampleUrls = uniqueExpansionTerms([...previous.sampleUrls, ...(signal.sample_urls || [])], 8);
      signals.set(key, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function deriveRealtimeHotTopicSourceSignals(report = {}) {
  const signals = new Map();
  for (const topic of Array.isArray(report.topics) ? report.topics : []) {
    const score = Math.max(0, Math.min(100, Number(topic.score || 0) || 0));
    if (score < 38) continue;
    const sourceKeys = uniqueExpansionTerms([
      ...(topic.suggested_sources || []),
      ...(topic.current?.source_keys || []),
    ], 24);
    const baseBoost = score >= 78 ? 38 : score >= 58 ? 30 : 20;
    const gapBoost = Math.min(8, (topic.gaps || []).length * 2);
    const crossSourceBoost = Number(topic.current?.source_family_count || 0) >= 2 ? 5 : 0;
    for (const sourceKey of sourceKeys) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const previous = signals.get(key) || {
        sourceKey: key,
        score: 0,
        priorityBoost: 0,
        topicCount: 0,
        maxHotScore: 0,
        maxLabel: "",
        keywords: [],
        sourceFamilies: [],
        gaps: [],
        suggestedKeywords: [],
        sampleUrls: [],
      };
      const matchedSource = (topic.current?.source_keys || []).includes(key);
      const matchedBoost = matchedSource ? 5 : 0;
      const boost = Math.min(45, baseBoost + gapBoost + crossSourceBoost + matchedBoost);
      previous.score = Math.min(100, Number(previous.score || 0) + Math.round((score + boost) / 3));
      previous.priorityBoost = Math.max(Number(previous.priorityBoost || 0), boost);
      previous.topicCount += 1;
      if (score > Number(previous.maxHotScore || 0)) {
        previous.maxHotScore = score;
        previous.maxLabel = topic.label || "";
      }
      for (const keyword of normalizeSentimentMonitorKeywords([topic.keyword])) {
        if (keyword && !previous.keywords.includes(keyword) && previous.keywords.length < 12) previous.keywords.push(keyword);
      }
      previous.sourceFamilies = [...new Set([
        ...previous.sourceFamilies,
        ...(topic.current?.source_families || []),
      ])].slice(0, 14);
      previous.gaps = [...new Set([
        ...previous.gaps,
        ...(topic.gaps || []),
      ])].slice(0, 14);
      previous.sampleUrls = [...new Set([
        ...previous.sampleUrls,
        ...(topic.sample_urls || []),
      ])].slice(0, 8);
      previous.suggestedKeywords = normalizeSentimentMonitorKeywords([
        ...previous.suggestedKeywords,
        topic.keyword,
        ...(topic.reasons || []).includes("high-risk-topic") ? "危機" : "",
        ...(topic.gaps || []).includes("missing-news-confirmation") ? "新聞" : "",
        ...(topic.gaps || []).includes("missing-public-feedback-confirmation") ? "投訴" : "",
        ...(topic.gaps || []).includes("missing-social-community-confirmation") ? "爆料" : "",
      ]).slice(0, 16);
      signals.set(key, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function deriveKeywordSourceFamilyCoverageSignals(report = {}, { maxBoost = 26 } = {}) {
  const signals = new Map();
  for (const gap of Array.isArray(report.gaps) ? report.gaps : []) {
    if (!gap || gap.status === "covered") continue;
    const sourceKeys = uniqueExpansionTerms(gap.suggested_sources || [], 20);
    const base = gap.status === "missing-family" ? 7 : 4;
    const riskBoost = Math.min(6, Number(gap.high_risk || 0) * 3);
    const negativeBoost = Math.min(4, Number(gap.negative || 0) * 2);
    const weight = base + riskBoost + negativeBoost;
    for (const sourceKey of sourceKeys) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const signal = signals.get(key) || {
        sourceKey: key,
        score: 0,
        priorityBoost: 0,
        gapCount: 0,
        keywords: [],
        families: [],
        statuses: [],
        suggestedKeywords: [],
      };
      signal.score += weight;
      signal.gapCount += 1;
      if (gap.keyword && !signal.keywords.includes(gap.keyword)) signal.keywords.push(gap.keyword);
      if (gap.source_family && !signal.families.includes(gap.source_family)) signal.families.push(gap.source_family);
      if (gap.status && !signal.statuses.includes(gap.status)) signal.statuses.push(gap.status);
      for (const keyword of normalizeSentimentMonitorKeywords(gap.suggested_keywords || []).slice(0, 10)) {
        if (!signal.suggestedKeywords.includes(keyword) && signal.suggestedKeywords.length < 24) signal.suggestedKeywords.push(keyword);
      }
      signals.set(key, signal);
    }
  }
  for (const signal of signals.values()) {
    signal.score = Math.round(Math.min(Number(maxBoost) || 26, Number(signal.score || 0)) * 10) / 10;
    signal.priorityBoost = Math.round(signal.score);
    signal.budgetBoost = Math.min(0.35, Math.round((signal.score / 70) * 100) / 100);
    signal.action = signal.score >= 10 ? "prioritize-keyword-family-gap-source" : "watch-keyword-family-gap-source";
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function officialRegulatoryEvidenceTier(metrics = {}, evidenceType = "") {
  const tiers = normalizeSentimentMonitorKeywords([
    metrics.source_weight_tier,
    metrics.sourceWeightTier,
    ...(Array.isArray(metrics.discovery_source_weight_tiers) ? metrics.discovery_source_weight_tiers : []),
    ...(Array.isArray(metrics.source_weight_tiers) ? metrics.source_weight_tiers : []),
  ]).map(tier => String(tier || "").toLowerCase());
  if (tiers.includes("regulatory-alert")) return "regulatory-alert";
  if (tiers.includes("official-consumer-protection")) return "official-consumer-protection";
  if (tiers.includes("regulatory")) return "regulatory";
  if (["regulatory_notice", "consumer_protection_notice"].includes(String(evidenceType || ""))) {
    return evidenceType === "consumer_protection_notice" ? "official-consumer-protection" : "regulatory";
  }
  return "";
}

function officialRegulatoryEvidenceKeywords(row = {}, metrics = {}) {
  const saved = getDb().prepare("SELECT keyword FROM crm_keywords WHERE enabled = 1 ORDER BY id DESC LIMIT 20").all()
    .map(item => item.keyword);
  const text = [
    row.title,
    row.content_text,
    row.url,
    metrics.feed_name,
    metrics.article_section,
    metrics.site_name,
    ...(Array.isArray(metrics.deep_crawl_outlinks) ? metrics.deep_crawl_outlinks.map(link => `${link.label || ""} ${link.url || ""}`) : []),
  ].join(" ");
  const matchedSaved = saved.filter(keyword => keyword && text.includes(keyword));
  const textTerms = [
    ...String(text || "").matchAll(/[\u4e00-\u9fff]{2,10}/g),
    ...String(text || "").matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g),
  ].map(match => match[0]);
  const riskTerms = [
    ...RISK_SCAN_TERMS,
    "官方聲明", "官方声明", "回應", "回应", "後續", "后续", "召回", "安全警示", "通報", "通报", "notice", "recall", "statement", "response", "timeline",
  ].filter(term => text.toLowerCase().includes(String(term).toLowerCase()));
  const savedSet = new Set(matchedSaved.map(term => String(term || "").toLowerCase()));
  const riskSet = new Set(riskTerms.map(term => String(term || "").toLowerCase()));
  const filteredTextTerms = textTerms.filter(term => {
    const value = String(term || "").trim();
    const lower = value.toLowerCase();
    if (!value || OFFICIAL_REGULATORY_KEYWORD_STOPWORDS.has(lower)) return false;
    if (savedSet.has(lower) || riskSet.has(lower) || OFFICIAL_REGULATORY_BUSINESS_TERMS.has(lower)) return true;
    if (/[\u4e00-\u9fff]/.test(value)) return !/^(官方|安全|警示|客戶|客户|公共|媒體|媒体|討論|讨论)$/.test(value);
    return /^[A-Z][A-Za-z0-9_-]{2,}$/.test(value) && !OFFICIAL_REGULATORY_KEYWORD_STOPWORDS.has(lower);
  });
  return normalizeSentimentMonitorKeywords([...matchedSaved, ...riskTerms, ...filteredTextTerms]).slice(0, 16);
}

export function deriveOfficialRegulatoryFollowupSourceSignals({ days = 14, limit = 120 } = {}) {
  const safeDays = Math.max(1, Math.min(90, Number(days) || 14));
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 120));
  const rows = getDb().prepare(`
    SELECT source_key, evidence_type, title, content_text, url, metrics_json, captured_at
    FROM sentiment_evidence_documents
    WHERE captured_at >= datetime('now', ?)
    ORDER BY captured_at DESC, id DESC
    LIMIT ?
  `).all(`-${safeDays} days`, safeLimit);
  const signals = new Map();
  for (const row of rows) {
    const metrics = parseJsonObject(row.metrics_json);
    const tier = officialRegulatoryEvidenceTier(metrics, row.evidence_type);
    if (!tier || !OFFICIAL_REGULATORY_TIERS.has(tier)) continue;
    const keywords = officialRegulatoryEvidenceKeywords(row, metrics);
    const reasons = [
      tier,
      row.evidence_type || "",
      ...(Array.isArray(metrics.discovery_priority_reasons) ? metrics.discovery_priority_reasons : []),
      ...(Array.isArray(metrics.deep_crawl_quality_reasons) ? metrics.deep_crawl_quality_reasons : []),
    ].filter(Boolean);
    for (const [sourceKey, baseBoost] of OFFICIAL_REGULATORY_FOLLOWUP_SOURCES.entries()) {
      const previous = signals.get(sourceKey) || {
        sourceKey,
        score: 0,
        priorityBoost: 0,
        evidenceCount: 0,
        tiers: [],
        reasons: [],
        suggestedKeywords: [],
        sampleUrls: [],
        exampleTitles: [],
      };
      const tierBoost = tier === "regulatory-alert" ? 8 : tier === "official-consumer-protection" ? 5 : 3;
      previous.score = Math.min(100, previous.score + Math.round((baseBoost + tierBoost) / 2));
      previous.priorityBoost = Math.max(previous.priorityBoost, Math.min(42, baseBoost + tierBoost));
      previous.evidenceCount += 1;
      if (!previous.tiers.includes(tier)) previous.tiers.push(tier);
      for (const reason of reasons) if (reason && !previous.reasons.includes(reason) && previous.reasons.length < 12) previous.reasons.push(reason);
      for (const keyword of keywords) if (keyword && !previous.suggestedKeywords.includes(keyword) && previous.suggestedKeywords.length < 18) previous.suggestedKeywords.push(keyword);
      if (row.url && !previous.sampleUrls.includes(row.url) && previous.sampleUrls.length < 8) previous.sampleUrls.push(row.url);
      if (row.title && !previous.exampleTitles.includes(row.title) && previous.exampleTitles.length < 8) previous.exampleTitles.push(row.title);
      signals.set(sourceKey, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function deriveEvidenceCompletenessSourceSignals(briefs = [], { minMissing = 1 } = {}) {
  const signals = new Map();
  for (const brief of Array.isArray(briefs) ? briefs : []) {
    const completeness = brief?.fact_findings?.evidence_completeness || brief?.evidence_completeness || null;
    if (!completeness) continue;
    const missing = Array.isArray(completeness.missing) ? completeness.missing : [];
    if (missing.length < minMissing) continue;
    const score = Math.max(0, Math.min(100, Number(completeness.score || 0) || 0));
    const severity = String(brief.severity || "").toLowerCase();
    const severityBoost = severity === "critical" ? 12 : severity === "high" ? 8 : severity === "medium" ? 4 : 0;
    const gapWeight = score < 35 ? 18 : score < 55 ? 12 : 8;
    const text = [...missing, ...(Array.isArray(completeness.suggested_collection) ? completeness.suggested_collection : [])].join(" ");
    for (const group of EVIDENCE_GAP_SOURCE_GROUPS) {
      if (!group.pattern.test(text)) continue;
      for (const sourceKey of group.sources) {
        const previous = signals.get(sourceKey) || {
          sourceKey,
          score: 0,
          priorityBoost: 0,
          briefCount: 0,
          minCompletenessScore: 100,
          missing: [],
          recommendations: [],
          reasons: [],
          severities: [],
        };
        previous.briefCount += 1;
        previous.minCompletenessScore = Math.min(previous.minCompletenessScore, score);
        previous.score = Math.min(100, previous.score + gapWeight + severityBoost + Math.min(8, missing.length * 2));
        previous.priorityBoost = Math.max(previous.priorityBoost, Math.min(35, gapWeight + severityBoost + Math.min(8, missing.length * 2)));
        if (!previous.reasons.includes(group.reason)) previous.reasons.push(group.reason);
        if (severity && !previous.severities.includes(severity)) previous.severities.push(severity);
        for (const item of missing) {
          if (item && !previous.missing.includes(item) && previous.missing.length < 12) previous.missing.push(item);
        }
        for (const item of completeness.suggested_collection || []) {
          if (item && !previous.recommendations.includes(item) && previous.recommendations.length < 10) previous.recommendations.push(item);
        }
        signals.set(sourceKey, previous);
      }
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function deriveEvidenceDepthSourceSignals(depthReport = {}, { maxScore = 58 } = {}) {
  const signals = new Map();
  const evidence = Array.isArray(depthReport.evidence) ? depthReport.evidence : [];
  const threshold = Math.max(0, Math.min(100, Number(maxScore || 58)));
  for (const item of evidence) {
    const score = Math.max(0, Math.min(100, Number(item.depth_score || 0) || 0));
    if (score > threshold && item.depth_level !== "thin" && item.depth_level !== "insufficient") continue;
    const missing = Array.isArray(item.missing) ? item.missing : [];
    if (!missing.length) continue;
    const missingText = `${missing.join(" ")} ${(item.suggested_collection || []).join(" ")}`;
    const gapWeight = score < 35 ? 18 : score < 58 ? 12 : 7;
    for (const group of EVIDENCE_DEPTH_SOURCE_GROUPS) {
      if (!group.pattern.test(missingText)) continue;
      for (const sourceKey of group.sources) {
        const previous = signals.get(sourceKey) || {
          sourceKey,
          score: 0,
          priorityBoost: 0,
          evidenceCount: 0,
          minDepthScore: 100,
          levels: [],
          missing: [],
          reasons: [],
          exampleTitles: [],
          suggestedKeywords: [],
        };
        previous.evidenceCount += 1;
        previous.minDepthScore = Math.min(previous.minDepthScore, score);
        previous.score = Math.min(100, previous.score + gapWeight + Math.min(8, missing.length * 2));
        previous.priorityBoost = Math.max(previous.priorityBoost, Math.min(32, gapWeight + Math.min(8, missing.length * 2)));
        if (item.depth_level && !previous.levels.includes(item.depth_level)) previous.levels.push(item.depth_level);
        if (!previous.reasons.includes(group.reason)) previous.reasons.push(group.reason);
        for (const value of missing) {
          if (value && !previous.missing.includes(value) && previous.missing.length < 12) previous.missing.push(value);
        }
        if (item.title && !previous.exampleTitles.includes(item.title) && previous.exampleTitles.length < 8) previous.exampleTitles.push(item.title);
        for (const keyword of normalizeSentimentMonitorKeywords([item.title, item.url].filter(Boolean))) {
          if (keyword && !previous.suggestedKeywords.includes(keyword) && previous.suggestedKeywords.length < 12) previous.suggestedKeywords.push(keyword);
        }
        signals.set(sourceKey, previous);
      }
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function deriveEvidenceCoverageRecoverySourceSignals(recoveryReport = {}) {
  const signals = new Map();
  const mergeSignal = (sourceKey, group = {}, {
    recoveryStatus = "",
    priorityBoost = 0,
    scoreBoost = 0,
    jobCount = 0,
    insertedCount = 0,
    failureCount = 0,
    routedFromSource = "",
    routedAlternate = false,
  } = {}) => {
    const key = String(sourceKey || "").trim();
    if (!key) return;
    const previous = signals.get(key) || {
      sourceKey: key,
      score: 0,
      priorityBoost: 0,
      jobCount: 0,
      insertedCount: 0,
      failureCount: 0,
      recoveryStatuses: [],
      targetTypes: [],
      targets: [],
      actions: [],
      lowDepthSourceKeys: [],
      lowDepthDomains: [],
      lowDepthUrls: [],
      lowDepthCommentUrls: [],
      lowDepthFeedNames: [],
      sampleQueries: [],
      sampleFollowupQueries: [],
      suggestedKeywords: [],
      recommendedAlternateSources: [],
      failureReasons: [],
      routedFromSources: [],
      routedAlternate,
      reasons: [],
    };
    previous.jobCount += jobCount;
    previous.insertedCount += insertedCount;
    previous.failureCount += failureCount;
    previous.priorityBoost = Math.max(previous.priorityBoost, Math.min(36, priorityBoost));
    previous.score = Math.min(100, previous.score + scoreBoost + Math.min(10, jobCount * 2));
    previous.routedAlternate = previous.routedAlternate || Boolean(routedAlternate);
    for (const value of [recoveryStatus]) if (value && !previous.recoveryStatuses.includes(value)) previous.recoveryStatuses.push(value);
    for (const value of [group.target_type]) if (value && !previous.targetTypes.includes(value)) previous.targetTypes.push(value);
    for (const value of [group.target]) if (value && !previous.targets.includes(value) && previous.targets.length < 8) previous.targets.push(value);
    for (const value of [group.action]) if (value && !previous.actions.includes(value)) previous.actions.push(value);
    for (const value of [routedFromSource]) if (value && !previous.routedFromSources.includes(value) && previous.routedFromSources.length < 8) previous.routedFromSources.push(value);
    for (const value of group.low_depth_source_keys || []) if (value && !previous.lowDepthSourceKeys.includes(value) && previous.lowDepthSourceKeys.length < 12) previous.lowDepthSourceKeys.push(value);
    for (const value of group.low_depth_domains || []) if (value && !previous.lowDepthDomains.includes(value) && previous.lowDepthDomains.length < 12) previous.lowDepthDomains.push(value);
    for (const value of group.low_depth_urls || []) if (value && !previous.lowDepthUrls.includes(value) && previous.lowDepthUrls.length < 12) previous.lowDepthUrls.push(value);
    for (const value of group.low_depth_comment_urls || []) if (value && !previous.lowDepthCommentUrls.includes(value) && previous.lowDepthCommentUrls.length < 12) previous.lowDepthCommentUrls.push(value);
    for (const value of group.low_depth_feed_names || []) if (value && !previous.lowDepthFeedNames.includes(value) && previous.lowDepthFeedNames.length < 12) previous.lowDepthFeedNames.push(value);
    for (const value of group.sample_queries || []) if (value && !previous.sampleQueries.includes(value) && previous.sampleQueries.length < 8) previous.sampleQueries.push(value);
    for (const value of group.sample_followup_queries || []) if (value && !previous.sampleFollowupQueries.includes(value) && previous.sampleFollowupQueries.length < 8) previous.sampleFollowupQueries.push(value);
    for (const value of group.recommended_alternate_sources || []) if (value && !previous.recommendedAlternateSources.includes(value) && previous.recommendedAlternateSources.length < 12) previous.recommendedAlternateSources.push(value);
    for (const value of group.failure_reasons || []) if (value && !previous.failureReasons.includes(value) && previous.failureReasons.length < 12) previous.failureReasons.push(value);
    const suggestedSeeds = [
      ...(group.sample_followup_queries || []),
      ...(group.sample_queries || []),
      ...(group.followup_search_terms || []),
      ...(group.low_depth_domains || []),
      ...(group.low_depth_comment_urls || []),
      ...(group.low_depth_feed_names || []),
      ...(group.recommended_alternate_sources || []),
      routedFromSource,
    ];
    for (const keyword of normalizeSentimentMonitorKeywords(suggestedSeeds)) {
      if (!previous.suggestedKeywords.includes(keyword) && previous.suggestedKeywords.length < 14) previous.suggestedKeywords.push(keyword);
    }
    const reason = routedAlternate
      ? "evidence-coverage-routed-alternate"
      : recoveryStatus === "recovered"
        ? "evidence-coverage-recovered"
        : recoveryStatus === "partial-recovered"
          ? "evidence-coverage-partial"
          : recoveryStatus === "pending"
            ? "evidence-coverage-pending"
            : "evidence-coverage-unrecovered";
    if (!previous.reasons.includes(reason)) previous.reasons.push(reason);
    signals.set(key, previous);
  };
  for (const group of Array.isArray(recoveryReport.groups) ? recoveryReport.groups : []) {
    const sourceKey = String(group.source_key || "").trim();
    if (!sourceKey) continue;
    const recoveryStatus = String(group.recovery_status || "").trim();
    const jobCount = Math.max(0, Number(group.job_count || 0) || 0);
    const insertedCount = Math.max(0, Number(group.inserted_count || 0) || 0);
    const failureCount = Math.max(0, Number(group.failure_count || 0) || 0);
    const failedCount = Math.max(0, Number(group.failed_count || 0) || 0);
    const blockedCount = Math.max(0, Number(group.blocked_count || 0) || 0);
    const pendingCount = Math.max(0, Number(group.pending_count || 0) || 0);
    let priorityBoost = 0;
    if (recoveryStatus === "failed") priorityBoost = 26;
    else if (recoveryStatus === "no-evidence") priorityBoost = 22;
    else if (recoveryStatus === "partial-recovered") priorityBoost = 16;
    else if (recoveryStatus === "pending") priorityBoost = 10;
    else if (recoveryStatus === "recovered") priorityBoost = 5;
    priorityBoost += Math.min(8, failedCount * 3 + blockedCount * 4 + failureCount);
    if (insertedCount > 0 && recoveryStatus === "recovered") priorityBoost = Math.min(priorityBoost, 8);
    mergeSignal(sourceKey, group, {
      recoveryStatus,
      priorityBoost,
      scoreBoost: priorityBoost,
      jobCount,
      insertedCount,
      failureCount: failureCount + failedCount + blockedCount,
    });
    const shouldRouteAlternate = ["failed", "no-evidence", "partial-recovered"].includes(recoveryStatus)
      || failedCount > 0
      || blockedCount > 0
      || failureCount > 0;
    if (shouldRouteAlternate) {
      for (const alternateSource of group.recommended_alternate_sources || []) {
        if (!alternateSource || alternateSource === sourceKey) continue;
        mergeSignal(alternateSource, group, {
          recoveryStatus: "routed-alternate",
          priorityBoost: Math.max(18, Math.min(28, priorityBoost - 4)),
          scoreBoost: Math.max(18, Math.min(32, priorityBoost)),
          jobCount,
          insertedCount: 0,
          failureCount: 0,
          routedFromSource: sourceKey,
          routedAlternate: true,
        });
      }
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function deriveTaiwanPrioritySiteHealthSourceSignals(healthReport = {}) {
  const sites = Array.isArray(healthReport.sites) ? healthReport.sites : [];
  const weakSites = sites.filter(site => ["runtime-warning", "missing", "partial", "indexed-only"].includes(String(site.coverage_status || "")));
  if (!weakSites.length) return {};
  const targets = ["rssFeeds", "taiwanNews"];
  const signals = new Map(targets.map(sourceKey => [sourceKey, {
    sourceKey,
    score: 0,
    priorityBoost: 0,
    siteCount: 0,
    runtimeWarningSiteCount: 0,
    indexedOnlySiteCount: 0,
    partialSiteCount: 0,
    missingSiteCount: 0,
    siteNames: [],
    domains: [],
    families: [],
    coverageStatuses: [],
    recommendedActions: [],
    suggestedKeywords: [],
    reasons: [],
  }]));
  for (const site of weakSites) {
    const status = String(site.coverage_status || "").trim();
    const domain = String(site.site || "").trim();
    const name = String(site.name || "").trim();
    const action = String(site.recommended_action || "").trim();
    const family = String(site.family || "").trim();
    let boost = 0;
    if (status === "runtime-warning") boost = 30;
    else if (status === "missing") boost = 28;
    else if (status === "partial") boost = 20;
    else if (status === "indexed-only") boost = 16;
    const runtimePenalty = Math.min(8, Number(site.runtime_unhealthy_feed_count || 0) * 4);
    for (const signal of signals.values()) {
      signal.siteCount += 1;
      if (status === "runtime-warning") signal.runtimeWarningSiteCount += 1;
      if (status === "indexed-only") signal.indexedOnlySiteCount += 1;
      if (status === "partial") signal.partialSiteCount += 1;
      if (status === "missing") signal.missingSiteCount += 1;
      signal.priorityBoost = Math.max(signal.priorityBoost, Math.min(36, boost + runtimePenalty));
      signal.score = Math.min(100, signal.score + boost + runtimePenalty);
      for (const value of [name]) if (value && !signal.siteNames.includes(value) && signal.siteNames.length < 16) signal.siteNames.push(value);
      for (const value of [domain]) if (value && !signal.domains.includes(value) && signal.domains.length < 16) signal.domains.push(value);
      for (const value of [family]) if (value && !signal.families.includes(value) && signal.families.length < 12) signal.families.push(value);
      for (const value of [status]) if (value && !signal.coverageStatuses.includes(value)) signal.coverageStatuses.push(value);
      for (const value of [action]) if (value && !signal.recommendedActions.includes(value)) signal.recommendedActions.push(value);
      const reason = status === "runtime-warning"
        ? "taiwan-priority-site-runtime-warning"
        : status === "missing"
          ? "taiwan-priority-site-missing"
          : status === "partial"
            ? "taiwan-priority-site-partial"
            : "taiwan-priority-site-indexed-only";
      if (!signal.reasons.includes(reason)) signal.reasons.push(reason);
      for (const keyword of normalizeSentimentMonitorKeywords([
        name,
        domain,
        domain ? `site:${domain}` : "",
        action.includes("native") || action.includes("entry") ? `${name} RSS` : "",
        action.includes("sitemap") ? `${name} sitemap` : "",
        status === "runtime-warning" ? `${name} Google News` : "",
        status === "runtime-warning" ? `${name} Bing News` : "",
      ])) {
        if (keyword && !signal.suggestedKeywords.includes(keyword) && signal.suggestedKeywords.length < 18) signal.suggestedKeywords.push(keyword);
      }
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

export function deriveEvidenceChainGapSourceSignals(report = {}) {
  const signals = new Map();
  for (const chain of Array.isArray(report.chains) ? report.chains : []) {
    const gapScore = Number(chain.gap_score || 0);
    if (gapScore < 35) continue;
    const sourceKeys = uniqueExpansionTerms(chain.suggested_sources || [], 24);
    const boost = gapScore >= 75 ? 36 : gapScore >= 55 ? 28 : 18;
    for (const sourceKey of sourceKeys) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const previous = signals.get(key) || {
        sourceKey: key,
        score: 0,
        priorityBoost: 0,
        chainCount: 0,
        maxGapScore: 0,
        gapLevels: [],
        gapTypes: [],
        missing: [],
        suggestedKeywords: [],
        sampleUrls: [],
      };
      previous.chainCount += 1;
      previous.score = Math.min(100, Number(previous.score || 0) + Math.round(boost / 2));
      previous.priorityBoost = Math.max(Number(previous.priorityBoost || 0), boost);
      previous.maxGapScore = Math.max(Number(previous.maxGapScore || 0), gapScore);
      if (chain.gap_level && !previous.gapLevels.includes(chain.gap_level)) previous.gapLevels.push(chain.gap_level);
      for (const type of chain.gap_types || []) if (type && !previous.gapTypes.includes(type)) previous.gapTypes.push(type);
      for (const item of chain.missing || []) if (item && !previous.missing.includes(item) && previous.missing.length < 16) previous.missing.push(item);
      previous.suggestedKeywords = normalizeSentimentMonitorKeywords([
        ...previous.suggestedKeywords,
        ...(chain.suggested_keywords || []),
        ...(chain.sample_titles || []),
      ]).slice(0, 18);
      previous.sampleUrls = uniqueExpansionTerms([...previous.sampleUrls, ...(chain.sample_urls || [])], 8);
      signals.set(key, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function commercialSeverityBoost(severity = "") {
  const value = String(severity || "").toLowerCase();
  if (value === "critical") return 30;
  if (value === "high") return 22;
  if (value === "medium") return 14;
  return 8;
}

function addCommercialSourceSignal(signals, sourceKey, input = {}) {
  const key = String(sourceKey || "").trim();
  if (!key) return;
  const severityBoost = commercialSeverityBoost(input.severity);
  const previous = signals.get(key) || {
    sourceKey: key,
    score: 0,
    priorityBoost: 0,
    actionCount: 0,
    readinessLevel: input.readinessLevel || "",
    overallScore: input.overallScore ?? null,
    areas: [],
    actions: [],
    reasons: [],
    suggestedKeywords: [],
  };
  const baseBoost = Math.max(0, Number(input.boost || 0) || severityBoost);
  previous.score = Math.min(100, previous.score + baseBoost);
  previous.priorityBoost = Math.max(previous.priorityBoost, Math.min(45, baseBoost));
  previous.actionCount += 1;
  if (input.readinessLevel && !previous.readinessLevel) previous.readinessLevel = input.readinessLevel;
  if (input.overallScore !== undefined && input.overallScore !== null) previous.overallScore = input.overallScore;
  if (input.area && !previous.areas.includes(input.area)) previous.areas.push(input.area);
  if (input.action && !previous.actions.includes(input.action)) previous.actions.push(input.action);
  if (input.reason && !previous.reasons.includes(input.reason)) previous.reasons.push(input.reason);
  for (const keyword of normalizeSentimentMonitorKeywords(input.suggestedKeywords || [])) {
    if (!previous.suggestedKeywords.includes(keyword) && previous.suggestedKeywords.length < 20) previous.suggestedKeywords.push(keyword);
  }
  signals.set(key, previous);
}

function commercialSourceKeysForEvidence(action = {}) {
  const sourceKeys = new Set();
  const evidence = action.evidence || {};
  for (const patch of evidence.source_patches || []) {
    if (patch?.source_key) sourceKeys.add(patch.source_key);
  }
  for (const gap of evidence.top_gaps || []) {
    for (const family of [...(gap.missing_families || []), ...(gap.weak_families || [])]) {
      for (const sourceKey of ENTITY_TOPIC_RECALL_FAMILY_SOURCES.get(String(family || "")) || []) sourceKeys.add(sourceKey);
    }
  }
  for (const brief of evidence.weakest_briefs || []) {
    const text = `${(brief.missing || []).join(" ")} ${(brief.suggested_collection || []).join(" ")}`;
    for (const group of EVIDENCE_GAP_SOURCE_GROUPS) {
      if (!group.pattern.test(text)) continue;
      for (const sourceKey of group.sources) sourceKeys.add(sourceKey);
    }
  }
  if (action.action === "strengthen-watch-and-propagation-tracking") {
    for (const sourceKey of BURST_WATCH_SOURCE_KEYS) sourceKeys.add(sourceKey);
  }
  return [...sourceKeys];
}

export function deriveCommercialReadinessSourceSignals(remediationPlan = {}) {
  const signals = new Map();
  const readinessLevel = remediationPlan.summary?.readiness_level || remediationPlan.readiness?.readiness_level || "";
  const overallScore = remediationPlan.summary?.overall_score ?? remediationPlan.readiness?.overall_score ?? null;
  for (const action of Array.isArray(remediationPlan.actions) ? remediationPlan.actions : []) {
    const sourceKeys = commercialSourceKeysForEvidence(action);
    const suggestedKeywords = action.payload?.suggested_keywords || [];
    const boost = commercialSeverityBoost(action.severity)
      + (String(action.action || "").startsWith("preview-") ? 6 : 0)
      + Math.min(8, sourceKeys.length ? 0 : 4);
    for (const sourceKey of sourceKeys) {
      addCommercialSourceSignal(signals, sourceKey, {
        severity: action.severity,
        area: action.area,
        action: action.action,
        reason: action.reason,
        boost,
        readinessLevel,
        overallScore,
        suggestedKeywords,
      });
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function commercialGovernanceBoost(decision = "", fallback = 0) {
  const value = String(decision || "");
  if (value === "rollback-or-adjust") return 42;
  if (value === "repair-source") return 36;
  if (value === "adjust-query") return 32;
  if (value === "scan-for-evidence") return 28;
  if (value === "monitor") return 14;
  if (value === "keep") return 8;
  return Math.max(0, Number(fallback || 0));
}

export function deriveCommercialPostScanGovernanceSourceSignals(governanceReport = {}) {
  const signals = new Map();
  for (const recommendation of Array.isArray(governanceReport.recommendations) ? governanceReport.recommendations : []) {
    const sourceKeys = uniqueExpansionTerms([
      ...(recommendation.source_keys || []),
      recommendation.source_key,
      ...(recommendation.collection_hint?.source_keys || []),
    ], 50);
    const decision = recommendation.decision || "";
    const boost = commercialGovernanceBoost(decision, recommendation.priority_score);
    for (const sourceKey of sourceKeys) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const previous = signals.get(key) || {
        sourceKey: key,
        score: 0,
        priorityBoost: 0,
        decisionCount: 0,
        decisions: [],
        actions: [],
        auditIds: [],
        reasons: [],
      };
      previous.score = Math.min(100, Number(previous.score || 0) + boost);
      previous.priorityBoost = Math.max(Number(previous.priorityBoost || 0), Math.min(45, boost));
      previous.decisionCount += 1;
      if (decision && !previous.decisions.includes(decision)) previous.decisions.push(decision);
      if (recommendation.commercial_action && !previous.actions.includes(recommendation.commercial_action)) previous.actions.push(recommendation.commercial_action);
      if (recommendation.audit_id && !previous.auditIds.includes(recommendation.audit_id)) previous.auditIds.push(recommendation.audit_id);
      if (recommendation.post_scan_recommendation && !previous.reasons.includes(recommendation.post_scan_recommendation)) previous.reasons.push(recommendation.post_scan_recommendation);
      signals.set(key, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function realtimeLatencyBoost(source = {}) {
  const slowRate = Number(source.slow_rate || 0);
  const p90 = Number(source.p90_latency_minutes || 0);
  const target = Math.max(1, Number(source.target_minutes || 60));
  const ratio = p90 / target;
  if (source.recommendation === "increase-watch-frequency-and-query-specificity") return 36;
  if (source.recommendation === "increase-realtime-watch-priority") return 32;
  if (ratio >= 2 || slowRate >= 60) return 30;
  if (ratio > 1 || slowRate >= 25) return 22;
  if (source.recommendation === "collect-more-latency-samples") return 10;
  return 0;
}

export function deriveRealtimeDiscoveryLatencySourceSignals(latencyReport = {}) {
  const signals = new Map();
  for (const source of Array.isArray(latencyReport.sources) ? latencyReport.sources : []) {
    const sourceKey = String(source.source_key || "").trim();
    if (!sourceKey) continue;
    const boost = realtimeLatencyBoost(source);
    if (boost <= 0) continue;
    signals.set(sourceKey, {
      sourceKey,
      score: Math.min(100, boost + Math.min(35, Number(source.slow_rate || 0) / 2)),
      priorityBoost: Math.min(45, boost),
      sampleCount: Number(source.sample_count || 0),
      targetMinutes: Number(source.target_minutes || 0),
      averageLatencyMinutes: Number(source.average_latency_minutes || 0),
      p90LatencyMinutes: Number(source.p90_latency_minutes || 0),
      slowRate: Number(source.slow_rate || 0),
      highRiskSlowCount: Number(source.high_risk_slow_count || 0),
      watchLaneSource: Boolean(source.watch_lane_source),
      recommendation: source.recommendation || "",
      exampleTitles: source.example_titles || [],
    });
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function realtimeCoverageExpectedFamilies(topic = {}) {
  const current = topic.current || {};
  const reasons = new Set(Array.isArray(topic.reasons) ? topic.reasons : []);
  const gaps = new Set(Array.isArray(topic.gaps) ? topic.gaps : []);
  const out = new Set(["news", "search"]);
  if (Number(current.high_risk || 0) > 0 || reasons.has("high-risk-topic")) {
    out.add("social");
    out.add("forum");
    out.add("video");
    out.add("complaint");
  }
  if (Number(current.negative_rate || 0) >= 40 || reasons.has("negative-heavy-topic")) {
    out.add("review");
    out.add("complaint");
  }
  if (reasons.has("fast-cross-platform-spread") || reasons.has("cross-source-family-heat")) {
    out.add("social");
    out.add("forum");
    out.add("video");
  }
  if (gaps.has("missing-public-feedback-confirmation")) {
    out.add("forum");
    out.add("review");
    out.add("complaint");
  }
  if (gaps.has("missing-social-community-confirmation")) {
    out.add("social");
    out.add("forum");
    out.add("community");
  }
  return [...out];
}

function realtimeCoverageSourceCandidates(family = "", schedule = [], now = Date.now()) {
  const allowed = REALTIME_COVERAGE_FAMILY_SOURCES.get(family) || [];
  return schedule
    .filter(item => allowed.includes(item.source_key))
    .map(item => {
      const lastSuccessMs = new Date(item.last_success_at || item.last_scan_at || "").getTime();
      const staleMinutes = Number.isNaN(lastSuccessMs) ? 9999 : Math.round(Math.max(0, now - lastSuccessMs) / 60_000);
      const waitingMinutes = Math.round(Math.max(0, Number(item.waiting_ms || 0)) / 60_000);
      return {
        source_key: item.source_key,
        family,
        enabled: item.enabled !== false,
        status: item.status,
        due: Boolean(item.due),
        realtime: Boolean(item.realtime),
        scan_interval_minutes: Number(item.scan_interval_minutes || 0),
        waiting_minutes: waitingMinutes,
        stale_minutes: staleMinutes,
        priority: Number(item.priority || 0),
        last_success_at: item.last_success_at || null,
      };
    })
    .sort((a, b) => {
      const statusRank = { due: 0, waiting: 1, throttled: 2, cooldown: 3, disabled: 4 };
      return (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9)
        || b.realtime - a.realtime
        || b.stale_minutes - a.stale_minutes
        || b.priority - a.priority
        || a.source_key.localeCompare(b.source_key);
    });
}

function targetProfileSet(target = {}) {
  return new Set([
    ...(target.profiles || []),
    ...(target.tags || []),
    target.tier,
    target.key,
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
}

function configuredTargetNames(config = {}) {
  return new Set([
    ...(Array.isArray(config.targets) ? config.targets : []),
    ...(Array.isArray(config.sites) ? config.sites : []),
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
}

function configuredTargetProfiles(config = {}) {
  return new Set([
    ...(Array.isArray(config.targetProfiles) ? config.targetProfiles : []),
    ...(Array.isArray(config.target_profiles) ? config.target_profiles : []),
    ...(Array.isArray(config.profiles) ? config.profiles : []),
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
}

function configList(config = {}, ...keys) {
  return keys.flatMap(key => {
    const value = config?.[key];
    if (Array.isArray(value)) return value;
    if (value == null || value === "") return [];
    return String(value).split(/[,\s，、;；]+/);
  });
}

function namedTargetFromValue(value, { prefix, profiles = [], tags = [], tier = "" } = {}) {
  const raw = typeof value === "object" && value !== null
    ? (value.name || value.key || value.id || value.handle || value.username || value.url || value.value || "")
    : value;
  const keyValue = String(raw || "").trim().replace(/^@+/, "");
  if (!keyValue) return null;
  const label = typeof value === "object" && value !== null
    ? String(value.label || value.title || value.name || raw || "").trim()
    : keyValue;
  return {
    key: `${prefix}:${keyValue.toLowerCase()}`,
    name: label || keyValue,
    profiles,
    tags,
    tier,
  };
}

function hostFromTargetValue(value = "") {
  const raw = typeof value === "object" && value !== null
    ? (value.url || value.href || value.domain || value.host || value.name || value.label || "")
    : value;
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    const match = text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/i);
    return match ? match[1].replace(/^www\./i, "").toLowerCase() : "";
  }
}

function targetLabel(value = {}, fallback = "") {
  if (typeof value === "object" && value !== null) {
    return String(value.name || value.label || value.title || value.url || fallback || "").trim();
  }
  return String(value || fallback || "").trim();
}

function configuredTargetSearchValue(value = "") {
  if (typeof value === "object" && value !== null) {
    return String(value.name || value.label || value.title || value.ticker || value.symbol || value.cashtag || value.cik || value.cve || value.product || value.vendor || value.package || value.packageName || value.package_name || value.repository || value.repo || value.project || value.projectId || value.project_id || value.tag || value.forum || value.community || value.instance || value.channel || value.channelId || value.channel_id || value.handle || value.username || value.user || value.profile || value.account || value.siteQuery || value.site_query || value.siteScope || value.site_scope || value.domain || value.host || value.url || value.value || value.id || "").trim();
  }
  return String(value || "").trim();
}

function configuredDomainSearchTerms(value = "") {
  const host = hostFromTargetValue(value);
  const raw = configuredTargetSearchValue(value);
  const hostParts = host.split(".").filter(Boolean);
  return uniqueExpansionTerms([
    host,
    raw,
    hostParts.length > 1 ? hostParts.slice(0, -1).join(".") : "",
    hostParts[0] || "",
  ], 8);
}

function sourceSpecificConfiguredTargetKeywords(sourceKey = "", sourceConfig = {}, baseKeywords = []) {
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4);
  const out = [];
  const pushTerms = (values = [], extras = []) => {
    for (const value of values) {
      const term = configuredTargetSearchValue(value);
      if (!term) continue;
      out.push(term);
      for (const extra of extras) out.push(`${term} ${extra}`);
    }
  };
  const routedAlternateKeywords = configList(sourceConfig, "routedAlternateKeywords", "routed_alternate_keywords", "evidenceCoverageRoutedAlternateKeywords", "evidence_coverage_routed_alternate_keywords");
  if (routedAlternateKeywords.length) {
    if (sourceKey === "reddit") pushTerms(routedAlternateKeywords, ["Reddit", "comments", "discussion"]);
    else if (sourceKey === "youtube") pushTerms(routedAlternateKeywords, ["YouTube", "comments", "video"]);
    else if (sourceKey === "bilibili") pushTerms(routedAlternateKeywords, ["Bilibili", "B站", "彈幕"]);
    else if (sourceKey === "ptt") pushTerms(routedAlternateKeywords, ["PTT", "討論", "爆料"]);
    else if (sourceKey === "dcard") pushTerms(routedAlternateKeywords, ["Dcard", "留言", "討論"]);
    else if (["threads", "xSearch", "facebookSearch", "linkedinSearch", "instagram"].includes(sourceKey)) pushTerms(routedAlternateKeywords, ["回應", "轉傳", "留言"]);
    else if (["rssFeeds", "googleNews", "bingNews", "baiduNews", "openWebDiscovery", "duckDuckGo", "gdelt"].includes(sourceKey)) pushTerms(routedAlternateKeywords, ["後續", "評論", "source"]);
    else if (sourceKey === "publicReviewSites" || sourceKey === "regionalComplaintSources") pushTerms(routedAlternateKeywords, ["complaint", "review", "refund"]);
    else pushTerms(routedAlternateKeywords);
  }
  if (sourceKey === "publicCompanyFilingsSources") {
    const targets = configList(sourceConfig, "companies", "company", "ciks", "cik", "tickers", "ticker", "symbols", "symbol", "targets");
    pushTerms(targets, ["SEC filing", "EDGAR", "8-K", "10-K"]);
  } else if (sourceKey === "brandImpersonationSources") {
    const targets = configList(sourceConfig, "domains", "domain", "brandDomains", "brand_domains", "targetDomains", "target_domains", "targets");
    for (const term of targets.flatMap(configuredDomainSearchTerms)) {
      out.push(term, `${term} phishing`, `${term} impersonation`, `${term} certificate transparency`);
    }
  } else if (sourceKey === "securityAdvisorySources") {
    const targets = configList(sourceConfig, "products", "product", "vendors", "vendor", "cves", "cve", "targets", "targetProducts", "target_products");
    pushTerms(targets, ["CVE", "vulnerability", "CISA advisory", "exploit"]);
  } else if (sourceKey === "supplyChainAdvisorySources") {
    const targets = configList(sourceConfig, "packages", "package", "dependencies", "dependency", "ecosystems", "ecosystem", "targets", "targetPackages", "target_packages");
    pushTerms(targets, ["OSV", "GHSA", "package vulnerability", "dependency vulnerability"]);
  } else if (sourceKey === "investorDiscussionSources") {
    const targets = configList(sourceConfig, "tickers", "ticker", "symbols", "symbol", "cashtags", "cashtag", "targets");
    for (const value of targets) {
      const term = configuredTargetSearchValue(value).replace(/^\$+/, "");
      if (!term) continue;
      const upper = /^[A-Za-z0-9.=-]{1,8}$/.test(term) ? term.toUpperCase() : term;
      out.push(upper, `$${upper}`, `${upper} Stocktwits`, `${upper} investor`, `${upper} market sentiment`);
    }
  } else if (sourceKey === "publicStatusPageSources") {
    const targets = configList(sourceConfig, "targets", "statusPageTargets", "status_page_targets");
    for (const value of targets) {
      const terms = configuredDomainSearchTerms(value);
      const label = targetLabel(value, configuredTargetSearchValue(value));
      for (const term of uniqueExpansionTerms([label, ...terms], 8)) {
        out.push(term, `${term} status page`, `${term} outage`, `${term} incident`, `${term} degraded service`);
      }
    }
  } else if (sourceKey === "officialOwnedMediaSources") {
    const targets = configList(sourceConfig, "targets", "ownedMediaTargets", "owned_media_targets", "officialTargets", "official_targets");
    for (const value of targets) {
      const terms = configuredDomainSearchTerms(value);
      const label = targetLabel(value, configuredTargetSearchValue(value));
      for (const term of uniqueExpansionTerms([label, ...terms], 8)) {
        out.push(term, `${term} official statement`, `${term} newsroom`, `${term} press release`, `${term} company blog`);
      }
    }
  } else if (sourceKey === "applePodcastSearch") {
    const shows = [
      ...configList(sourceConfig, "shows", "show", "podcasts", "podcast", "targets"),
      ...(Array.isArray(sourceConfig?.discoveredPodcastShows) ? sourceConfig.discoveredPodcastShows : []),
      ...(Array.isArray(sourceConfig?.discovered_podcast_shows) ? sourceConfig.discovered_podcast_shows : []),
    ];
    for (const value of shows) {
      const term = configuredTargetSearchValue(value) || String(value?.show_name || value?.showName || value?.collection_id || value?.collectionId || "").trim();
      if (!term) continue;
      out.push(term, `${term} podcast`, `${term} podcast episode`, `${term} interview`);
    }
  } else if (sourceKey === "appStoreReviews") {
    const targets = [
      ...configList(sourceConfig, "appIds", "app_ids", "targets"),
      ...(Array.isArray(sourceConfig?.discoveredApps) ? sourceConfig.discoveredApps : []),
      ...(Array.isArray(sourceConfig?.discovered_apps) ? sourceConfig.discovered_apps : []),
    ];
    for (const value of targets) {
      const term = configuredTargetSearchValue(value) || String(value?.app_name || value?.appName || value?.app_id || value?.appId || "").trim();
      if (!term) continue;
      out.push(term, `${term} App Store review`, `${term} iOS app complaint`, `${term} rating`);
    }
  } else if (sourceKey === "googlePlayReviews") {
    const targets = [
      ...configList(sourceConfig, "packageIds", "package_ids", "appIds", "app_ids", "targets"),
      ...(Array.isArray(sourceConfig?.discoveredApps) ? sourceConfig.discoveredApps : []),
      ...(Array.isArray(sourceConfig?.discovered_apps) ? sourceConfig.discovered_apps : []),
    ];
    for (const value of targets) {
      const term = configuredTargetSearchValue(value) || String(value?.app_name || value?.appName || value?.package_id || value?.packageId || "").trim();
      if (!term) continue;
      out.push(term, `${term} Google Play review`, `${term} Android app complaint`, `${term} Play Store rating`);
    }
  } else if (sourceKey === "reddit") {
    const targets = configList(sourceConfig, "subreddits", "subreddit", "communities", "targets");
    pushTerms(targets, ["subreddit", "reddit discussion", "reddit complaint"]);
  } else if (sourceKey === "ptt") {
    const targets = configList(sourceConfig, "boards", "board", "targets");
    pushTerms(targets, ["PTT", "PTT 爆料", "PTT 投訴"]);
  } else if (sourceKey === "dcard") {
    const targets = configList(sourceConfig, "forums", "forum", "forumAliases", "forum_aliases", "targets");
    pushTerms(targets, ["Dcard", "Dcard 爆料", "Dcard 投訴"]);
  } else if (sourceKey === "telegramPublic") {
    const targets = configList(sourceConfig, "channels", "channel", "publicChannels", "public_channels", "targets");
    pushTerms(targets, ["Telegram channel", "public channel complaint", "爆料 頻道"]);
  } else if (sourceKey === "threads") {
    const targets = configList(sourceConfig, "profiles", "profile", "accounts", "account", "handles", "handle", "targets");
    pushTerms(targets, ["Threads profile", "Threads post", "Threads complaint"]);
  } else if (sourceKey === "instagram") {
    const targets = configList(sourceConfig, "profiles", "profile", "accounts", "account", "handles", "handle", "targets");
    pushTerms(targets, ["Instagram profile", "Instagram post", "Instagram complaint"]);
  } else if (sourceKey === "githubIssues") {
    const targets = configList(sourceConfig, "repositories", "repository", "repos", "repo", "targets");
    pushTerms(targets, ["GitHub issue", "bug report", "discussion", "regression"]);
  } else if (sourceKey === "gitLabIssues") {
    const targets = configList(sourceConfig, "projects", "project", "projectIds", "project_ids", "targets");
    pushTerms(targets, ["GitLab issue", "bug report", "incident", "regression"]);
  } else if (sourceKey === "hackerNews") {
    const targets = configList(sourceConfig, "authors", "author", "usernames", "users", "targets");
    pushTerms(targets, ["Hacker News", "discussion", "comments", "launch"]);
  } else if (sourceKey === "stackOverflow") {
    const targets = configList(sourceConfig, "tags", "tag", "stackTags", "stack_tags", "targets");
    pushTerms(targets, ["Stack Overflow", "question", "bug", "support"]);
  } else if (sourceKey === "discourseForums") {
    const targets = configList(sourceConfig, "sites", "site", "forums", "forum", "targets", "targetProfiles", "target_profiles", "profiles");
    pushTerms(targets, ["Discourse", "support forum", "bug report", "incident"]);
  } else if (sourceKey === "lemmy") {
    const targets = configList(sourceConfig, "instances", "instance", "communities", "community", "targets");
    pushTerms(targets, ["Lemmy", "federated discussion", "community complaint", "incident"]);
  } else if (sourceKey === "mastodon") {
    const targets = configList(sourceConfig, "instances", "instance", "tags", "tag", "handles", "handle", "targets");
    pushTerms(targets, ["Mastodon", "ActivityPub", "boost", "complaint"]);
  } else if (sourceKey === "bluesky") {
    const targets = configList(sourceConfig, "handles", "handle", "profiles", "profile", "accounts", "account", "targets");
    pushTerms(targets, ["Bluesky", "post", "reply", "complaint"]);
  } else if (sourceKey === "youtube") {
    const targets = configList(sourceConfig, "channels", "channel", "channelIds", "channel_ids", "handles", "handle", "profiles", "targets");
    pushTerms(targets, ["YouTube", "video", "comments", "review"]);
  } else if (sourceKey === "bilibili") {
    const targets = configList(sourceConfig, "channels", "channel", "users", "user", "profiles", "profile", "targets");
    pushTerms(targets, ["Bilibili", "B站", "视频", "弹幕"]);
  } else if (sourceKey === "tiktokSearch") {
    const targets = configList(sourceConfig, "handles", "handle", "profiles", "profile", "accounts", "account", "targets");
    pushTerms(targets, ["TikTok", "video", "comments", "complaint"]);
  } else if (sourceKey === "douyinSearch") {
    const targets = configList(sourceConfig, "handles", "handle", "profiles", "profile", "accounts", "account", "targets");
    pushTerms(targets, ["抖音", "视频", "评论", "爆料"]);
  } else if (sourceKey === "kuaishouSearch") {
    const targets = configList(sourceConfig, "handles", "handle", "profiles", "profile", "accounts", "account", "targets");
    pushTerms(targets, ["快手", "视频", "评论", "投诉"]);
  } else if (sourceKey === "xSearch") {
    const targets = configList(sourceConfig, "handles", "handle", "profiles", "profile", "accounts", "account", "targets");
    pushTerms(targets, ["X post", "Twitter post", "thread", "complaint"]);
  } else if (sourceKey === "facebookSearch") {
    const targets = configList(sourceConfig, "pages", "page", "groups", "group", "profiles", "profile", "accounts", "account", "targets");
    pushTerms(targets, ["Facebook post", "group discussion", "comments", "complaint"]);
  } else if (sourceKey === "linkedinSearch") {
    const targets = configList(sourceConfig, "companies", "company", "pages", "page", "profiles", "profile", "targets");
    pushTerms(targets, ["LinkedIn post", "company update", "employee discussion", "complaint"]);
  } else if (sourceKey === "weiboSearch") {
    const targets = configList(sourceConfig, "handles", "handle", "profiles", "profile", "accounts", "account", "targets");
    pushTerms(targets, ["微博", "热搜", "评论", "投诉"]);
  } else if (sourceKey === "xiaohongshuSearch") {
    const targets = configList(sourceConfig, "handles", "handle", "profiles", "profile", "accounts", "account", "targets");
    pushTerms(targets, ["小红书", "笔记", "评论", "避雷"]);
  } else if (sourceKey === "tiebaSearch") {
    const targets = configList(sourceConfig, "forums", "forum", "bars", "bar", "communities", "community", "targets");
    pushTerms(targets, ["贴吧", "吧", "爆料", "投诉"]);
  } else if (sourceKey === "publicReviewSites") {
    const targets = configList(sourceConfig, "targets", "sites");
    pushTerms(targets, ["review", "negative review", "complaint", "refund"]);
  } else if (sourceKey === "verticalReviewSources") {
    const targets = configList(sourceConfig, "targets", "sites");
    pushTerms(targets, ["software review", "app review", "rating", "alternatives"]);
  } else if (sourceKey === "employerReviewSources") {
    const targets = configList(sourceConfig, "targets", "sites");
    pushTerms(targets, ["employee review", "workplace complaint", "layoff", "culture"]);
  } else if (sourceKey === "ecommerceReviewSources") {
    const targets = configList(sourceConfig, "targets", "sites");
    pushTerms(targets, ["marketplace review", "seller complaint", "delivery refund", "product rating"]);
  } else if (sourceKey === "localReviewSources") {
    const targets = configList(sourceConfig, "targets", "sites");
    pushTerms(targets, ["local review", "service complaint", "rating", "customer complaint"]);
  } else if (sourceKey === "regionalComplaintSources") {
    const targets = configList(sourceConfig, "targets", "sites");
    pushTerms(targets, ["consumer protection", "complaint", "refund dispute", "regulatory warning"]);
  }
  if (!out.length) return [];
  return uniqueExpansionTerms([...out, ...base], 20);
}

function dynamicFreeSourceTargets(sourceKey = "", config = {}) {
  if (sourceKey === "reddit") {
    return configList(config, "subreddits", "subreddit", "communities")
      .map(item => namedTargetFromValue(item, {
        prefix: "reddit-subreddit",
        profiles: ["community-target", "subreddit", "forum", "social"],
        tags: ["configured", "reddit", "community", "forum", "social"],
        tier: "tracked-subreddit",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "ptt") {
    return configList(config, "boards", "board")
      .map(item => namedTargetFromValue(item, {
        prefix: "ptt-board",
        profiles: ["community-target", "ptt-board", "forum", "taiwan"],
        tags: ["configured", "ptt", "board", "forum", "taiwan"],
        tier: "tracked-ptt-board",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "dcard") {
    return configList(config, "forums", "forum", "forumAliases", "forum_aliases")
      .map(item => namedTargetFromValue(item, {
        prefix: "dcard-forum",
        profiles: ["community-target", "dcard-forum", "forum", "taiwan"],
        tags: ["configured", "dcard", "forum", "taiwan"],
        tier: "tracked-dcard-forum",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "telegramPublic") {
    return configList(config, "channels", "channel", "publicChannels", "public_channels")
      .map(item => namedTargetFromValue(item, {
        prefix: "telegram-channel",
        profiles: ["public-channel", "messaging", "social", "community-target"],
        tags: ["configured", "telegram", "channel", "messaging", "social"],
        tier: "tracked-telegram-channel",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "threads") {
    return configList(config, "profiles", "profile", "accounts", "account", "handles", "handle")
      .map(item => namedTargetFromValue(item, {
        prefix: "threads-profile",
        profiles: ["social-profile", "threads-profile", "social"],
        tags: ["configured", "threads", "profile", "social"],
        tier: "tracked-threads-profile",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "instagram") {
    return configList(config, "profiles", "profile", "accounts", "account", "handles", "handle")
      .map(item => namedTargetFromValue(item, {
        prefix: "instagram-profile",
        profiles: ["social-profile", "instagram-profile", "social"],
        tags: ["configured", "instagram", "profile", "social"],
        tier: "tracked-instagram-profile",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "publicStatusPageSources") {
    const targets = configList(config, "targets", "statusPageTargets", "status_page_targets");
    const seen = new Set();
    return targets.map(target => {
      const host = hostFromTargetValue(target);
      const keyValue = host || String(typeof target === "object" && target !== null ? target.url || target.name || target.label || "" : target || "").trim();
      if (!keyValue || seen.has(keyValue.toLowerCase())) return null;
      seen.add(keyValue.toLowerCase());
      return {
        key: `status-page:${keyValue.toLowerCase()}`,
        name: targetLabel(target, keyValue),
        profiles: ["status-page", "operations", "official", host].filter(Boolean),
        tags: ["configured", "status-page", "operations", "incident", host].filter(Boolean),
        tier: "tracked-public-status-page",
      };
    }).filter(Boolean);
  }
  if (sourceKey === "officialOwnedMediaSources") {
    const targets = configList(config, "targets", "ownedMediaTargets", "owned_media_targets", "officialTargets", "official_targets");
    const seen = new Set();
    return targets.map(target => {
      const host = hostFromTargetValue(target);
      const keyValue = host || String(typeof target === "object" && target !== null ? target.url || target.name || target.label || "" : target || "").trim();
      if (!keyValue || seen.has(keyValue.toLowerCase())) return null;
      seen.add(keyValue.toLowerCase());
      return {
        key: `official-owned-media:${keyValue.toLowerCase()}`,
        name: targetLabel(target, keyValue),
        profiles: ["owned-media", "official-response", "official", "newsroom", host].filter(Boolean),
        tags: ["configured", "official", "owned-media", "newsroom", "statement", host].filter(Boolean),
        tier: "tracked-official-owned-media",
      };
    }).filter(Boolean);
  }
  if (sourceKey === "publicCompanyFilingsSources") {
    return configList(config, "companies", "company", "ciks", "cik", "tickers", "ticker", "symbols", "symbol", "targets")
      .map(item => namedTargetFromValue(item, {
        prefix: "company-filing-target",
        profiles: ["company-filing", "finance", "official", "regulatory"],
        tags: ["configured", "company-filing", "sec", "edgar", "material-event"],
        tier: "tracked-company-filing-target",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "brandImpersonationSources") {
    const targets = configList(config, "domains", "domain", "brandDomains", "brand_domains", "targetDomains", "target_domains", "targets");
    const seen = new Set();
    return targets.map(target => {
      const host = hostFromTargetValue(target);
      const keyValue = host || String(typeof target === "object" && target !== null ? target.domain || target.host || target.url || target.name || target.label || "" : target || "").trim();
      if (!keyValue || seen.has(keyValue.toLowerCase())) return null;
      seen.add(keyValue.toLowerCase());
      return {
        key: `brand-domain:${keyValue.toLowerCase()}`,
        name: targetLabel(target, keyValue),
        profiles: ["brand-domain", "security", "impersonation", "phishing", host].filter(Boolean),
        tags: ["configured", "brand", "domain", "phishing", "impersonation", "certificate-transparency", host].filter(Boolean),
        tier: "tracked-brand-domain",
      };
    }).filter(Boolean);
  }
  if (sourceKey === "securityAdvisorySources") {
    return configList(config, "products", "product", "vendors", "vendor", "cves", "cve", "targets", "targetProducts", "target_products")
      .map(item => {
        const target = namedTargetFromValue(item, {
          prefix: "security-advisory-target",
          profiles: ["security-advisory-target", "security", "vulnerability"],
          tags: ["configured", "security", "vulnerability", "cve", "cisa"],
          tier: "tracked-security-advisory-target",
        });
        if (!target) return null;
        if (/^CVE-\d{4}-\d{4,}$/i.test(target.name)) {
          target.profiles = [...new Set([...target.profiles, "cve"])];
          target.tags = [...new Set([...target.tags, "cve-id"])];
        }
        return target;
      })
      .filter(Boolean);
  }
  if (sourceKey === "supplyChainAdvisorySources") {
    return configList(config, "packages", "package", "dependencies", "dependency", "ecosystems", "ecosystem", "targets", "targetPackages", "target_packages")
      .map(item => namedTargetFromValue(item, {
        prefix: "supply-chain-package",
        profiles: ["supply-chain-package", "security", "dependency", "opensource"],
        tags: ["configured", "supply-chain", "package", "dependency", "osv", "ghsa"],
        tier: "tracked-supply-chain-package",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "investorDiscussionSources") {
    return configList(config, "tickers", "ticker", "symbols", "symbol", "cashtags", "cashtag", "targets")
      .map(item => namedTargetFromValue(item, {
        prefix: "investor-market-target",
        profiles: ["investor-market", "finance", "market", "social"],
        tags: ["configured", "investor", "market", "ticker", "stocktwits"],
        tier: "tracked-investor-market-target",
      }))
      .filter(Boolean);
  }
  if (sourceKey === "appStoreReviews") {
    const appIds = configList(config, "appIds", "app_ids");
    const discoveredApps = configList(config, "discoveredApps", "discovered_apps")
      .filter(item => item && typeof item === "object");
    const seen = new Set();
    return [
      ...appIds.map(appId => ({ app_id: appId })),
      ...discoveredApps,
    ].map(app => {
      const appId = String(app?.app_id || app?.appId || app?.id || app || "").trim();
      if (!/^\d{5,}$/.test(appId) || seen.has(appId)) return null;
      seen.add(appId);
      const country = String(app?.country || "").trim().toLowerCase();
      const name = String(app?.app_name || app?.appName || app?.name || "").trim();
      return {
        key: `app-store-app:${appId}`,
        name: name || `App Store ${appId}`,
        profiles: ["app", "mobile-app", "ios-app", "review", country].filter(Boolean),
        tags: ["discovered", "app", "mobile", "ios", "review", country].filter(Boolean),
        tier: "tracked-app-store-app",
      };
    }).filter(Boolean);
  }
  if (sourceKey === "googlePlayReviews") {
    const packageIds = configList(config, "packageIds", "package_ids", "appIds", "app_ids");
    const discoveredApps = configList(config, "discoveredApps", "discovered_apps")
      .filter(item => item && typeof item === "object");
    const seen = new Set();
    return [
      ...packageIds.map(packageId => ({ package_id: packageId })),
      ...discoveredApps,
    ].map(app => {
      const packageId = String(app?.package_id || app?.packageId || app?.id || app || "").trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageId) || seen.has(packageId)) return null;
      seen.add(packageId);
      const country = String(app?.country || "").trim().toLowerCase();
      const language = String(app?.language || app?.lang || "").trim().toLowerCase();
      const name = String(app?.app_name || app?.appName || app?.name || "").trim();
      return {
        key: `google-play-app:${packageId}`,
        name: name || packageId,
        profiles: ["app", "mobile-app", "android-app", "review", country, language].filter(Boolean),
        tags: ["discovered", "app", "mobile", "android", "review", country, language].filter(Boolean),
        tier: "tracked-google-play-app",
      };
    }).filter(Boolean);
  }
  if (sourceKey !== "applePodcastSearch") return [];
  const shows = Array.isArray(config.discoveredPodcastShows)
    ? config.discoveredPodcastShows
    : Array.isArray(config.discovered_podcast_shows)
      ? config.discovered_podcast_shows
      : [];
  return shows
    .map(show => {
      const collectionId = String(show?.collection_id || show?.collectionId || "").trim();
      if (!collectionId) return null;
      const showName = String(show?.show_name || show?.showName || show?.name || "").trim();
      const country = String(show?.country || "").trim().toLowerCase();
      return {
        key: `podcast-show:${collectionId}`,
        name: showName || `Podcast ${collectionId}`,
        profiles: ["podcast-show", "audio", country].filter(Boolean),
        tags: ["discovered", "podcast", "audio", country].filter(Boolean),
        tier: "discovered-podcast-show",
      };
    })
    .filter(Boolean);
}

export function getSentimentFreeSourceTargetCoverageReport({ searchSettings = null, limit = 100 } = {}) {
  const search = readSentimentSearchSettings(searchSettings || null);
  const configuredSources = new Set(Array.isArray(search.sources) && search.sources.length ? search.sources : listSentimentSources().map(source => source.source_key));
  const sourceRows = new Map(listSentimentSources().map(source => [source.source_key, source]));
  const sources = [];
  const gaps = [];
  for (const [sourceKey, catalog] of Object.entries(FREE_SOURCE_TARGET_CATALOGS)) {
    if (!configuredSources.has(sourceKey)) continue;
    const config = sourceRows.get(sourceKey)?.config || {};
    const targetNames = configuredTargetNames(config);
    const profileFilter = configuredTargetProfiles(config);
    const dynamicTargets = dynamicFreeSourceTargets(sourceKey, config);
    const combinedCatalog = [...catalog, ...dynamicTargets];
    const selectedTargets = combinedCatalog.filter(target => {
      const profiles = targetProfileSet(target);
      const targetMatched = !targetNames.size || targetNames.has(String(target.key || "").toLowerCase()) || targetNames.has(String(target.name || "").toLowerCase());
      const profileMatched = !profileFilter.size || [...profileFilter].some(profile => profiles.has(profile));
      return targetMatched && profileMatched;
    });
    const activeTargets = selectedTargets.length ? selectedTargets : combinedCatalog;
    const profileCounts = new Map();
    for (const target of activeTargets) {
      for (const profile of targetProfileSet(target)) {
        profileCounts.set(profile, (profileCounts.get(profile) || 0) + 1);
      }
    }
    const expectedProfiles = FREE_SOURCE_TARGET_EXPECTATIONS.filter(item => item.sources.includes(sourceKey));
    const missingProfiles = [];
    for (const expectation of expectedProfiles) {
      if (!profileCounts.has(expectation.profile)) {
        missingProfiles.push(expectation);
        gaps.push({
          source_key: sourceKey,
          profile: expectation.profile,
          label: expectation.label,
          weight: expectation.weight,
          suggested_terms: expectation.terms,
          recommendation: "expand-free-source-target-profile",
        });
      }
    }
    const coverageScore = expectedProfiles.length
      ? Math.max(0, Math.min(100, Math.round(((expectedProfiles.length - missingProfiles.length) / expectedProfiles.length) * 100)))
      : 100;
    sources.push({
      source_key: sourceKey,
      target_count: activeTargets.length,
      configured_target_count: targetNames.size,
      configured_profile_count: profileFilter.size,
      catalog_target_count: catalog.length,
      dynamic_target_count: dynamicTargets.length,
      expected_profile_count: expectedProfiles.length,
      covered_profile_count: expectedProfiles.length - missingProfiles.length,
      missing_profile_count: missingProfiles.length,
      coverage_score: coverageScore,
      target_profiles: [...profileCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 30)
        .map(([profile, count]) => ({ profile, count })),
      missing_profiles: missingProfiles.map(item => ({
        profile: item.profile,
        label: item.label,
        weight: item.weight,
        suggested_terms: item.terms,
      })),
      recommendation: missingProfiles.length ? "expand-target-profile-coverage" : "target-profile-coverage-ok",
    });
  }
  const sortedSources = sources
    .sort((a, b) => a.coverage_score - b.coverage_score || b.missing_profile_count - a.missing_profile_count || a.source_key.localeCompare(b.source_key))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 100)));
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    summary: {
      source_count: sortedSources.length,
      weak_source_count: sortedSources.filter(item => item.coverage_score < 75).length,
      gap_count: gaps.length,
      missing_profiles: uniqueExpansionTerms(gaps.map(item => item.profile), 40),
      suggested_sources: uniqueExpansionTerms(gaps.map(item => item.source_key), 20),
      suggested_terms: normalizeSentimentMonitorKeywords(gaps.flatMap(item => item.suggested_terms || [])).slice(0, 40),
      lowest_coverage_score: sortedSources.length ? Math.min(...sortedSources.map(item => item.coverage_score)) : 100,
    },
    sources: sortedSources,
    gaps: gaps.sort((a, b) => b.weight - a.weight || a.source_key.localeCompare(b.source_key) || a.profile.localeCompare(b.profile)),
  };
}

export function deriveFreeSourceTargetCoverageSignals(report = {}) {
  const signals = new Map();
  for (const source of Array.isArray(report.sources) ? report.sources : []) {
    const missing = Array.isArray(source.missing_profiles) ? source.missing_profiles : [];
    if (!missing.length) continue;
    const score = Math.max(0, Math.min(100, 100 - Number(source.coverage_score || 0)));
    const priorityBoost = Math.min(28, 8 + missing.reduce((sum, item) => sum + Math.min(8, Number(item.weight || 0)), 0));
    const key = String(source.source_key || "");
    if (!key) continue;
    signals.set(key, {
      sourceKey: key,
      score,
      priorityBoost,
      targetCount: source.target_count || 0,
      coverageScore: source.coverage_score || 0,
      missingProfileCount: missing.length,
      missingProfiles: missing.map(item => item.profile),
      suggestedTerms: normalizeSentimentMonitorKeywords(missing.flatMap(item => item.suggested_terms || [])).slice(0, 18),
      recommendation: source.recommendation,
    });
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function freeSourceTargetCoverageJobKey(sourceKey = "", signal = {}, terms = [], now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const seed = [
    "free-source-target-coverage",
    sourceKey,
    day,
    Number(signal.coverageScore || 0),
    (signal.missingProfiles || []).slice(0, 8).join("|"),
    terms.slice(0, 6).join("|"),
  ].join(":");
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `free-source-target-coverage:${sourceKey}:${day}:${(hash >>> 0).toString(16)}`;
}

export function planSentimentFreeSourceTargetCoverageFollowupJobs({
  searchSettings = null,
  keywords = [],
  limit = 30,
  now = Date.now(),
} = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const search = readSentimentSearchSettings(searchSettings || null);
  const baseKeywords = normalizeSentimentMonitorKeywords([
    ...(Array.isArray(keywords) ? keywords : []),
    ...(Array.isArray(search.keywords) ? search.keywords : []),
  ]).slice(0, 12);
  const coverage = getSentimentFreeSourceTargetCoverageReport({ searchSettings: search, limit: 200 });
  const signals = deriveFreeSourceTargetCoverageSignals(coverage);
  const sourceRows = new Map(listSentimentSources().map(source => [source.source_key, source]));
  const jobs = [];
  for (const [sourceKey, signal] of Object.entries(signals)) {
    if (Number(signal.missingProfileCount || 0) <= 0) continue;
    const source = sourceRows.get(sourceKey);
    if (source && source.enabled === false) continue;
    const query = sourceSpecificFreeSourceTargetCoverageKeywords(sourceKey, signal, baseKeywords)
      .concat(baseKeywords.length ? [] : normalizeSentimentMonitorKeywords(signal.suggestedTerms || []).slice(0, 8));
    const normalizedQuery = normalizeSentimentMonitorKeywords(query).slice(0, 16);
    if (!normalizedQuery.length) continue;
    const priority = Math.max(40, Math.min(96, 52 + Number(signal.priorityBoost || 0) + Math.round(Number(signal.score || 0) / 5)));
    jobs.push({
      jobKey: freeSourceTargetCoverageJobKey(sourceKey, signal, normalizedQuery, now),
      sourceKey,
      label: `Free source target coverage: ${source?.label || sourceKey}`,
      reason: "recoverable-free-source-target-coverage",
      mode: SCAN_MODE_FAST,
      status: "pending",
      priority,
      query: normalizedQuery,
      entity: {
        source_key: sourceKey,
        source_label: source?.label || sourceKey,
        target_type: "free-source-target-coverage",
        missing_profiles: signal.missingProfiles || [],
        suggested_terms: signal.suggestedTerms || [],
      },
      maxAttempts: 2,
      scheduledAt: new Date(now).toISOString(),
      metadata: {
        task_type: "free-source-target-coverage",
        free_source_target_coverage: {
          source_key: sourceKey,
          recommendation: signal.recommendation || "expand-target-profile-coverage",
          coverage_score: Number(signal.coverageScore || 0) || 0,
          target_count: Math.max(0, Number(signal.targetCount || 0) || 0),
          missing_profile_count: Math.max(0, Number(signal.missingProfileCount || 0) || 0),
          missing_profiles: Array.isArray(signal.missingProfiles) ? signal.missingProfiles : [],
          suggested_terms: Array.isArray(signal.suggestedTerms) ? signal.suggestedTerms : [],
        },
        planned_query_count: normalizedQuery.length,
        planned_queries: normalizedQuery,
      },
    });
  }
  const planned = jobs
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || a.sourceKey.localeCompare(b.sourceKey))
    .slice(0, safeLimit);
  return {
    ok: true,
    applied: false,
    generated_at: new Date(now).toISOString(),
    coverage_summary: coverage.summary || {},
    summary: {
      planned_jobs: planned.length,
      free_source_target_coverage_jobs: planned.length,
      source_count: new Set(planned.map(job => job.sourceKey)).size,
      weak_source_count: Number(coverage.summary?.weak_source_count || 0) || 0,
      gap_count: Number(coverage.summary?.gap_count || 0) || 0,
      highest_priority: Math.max(0, ...planned.map(job => Number(job.priority || 0))),
    },
    jobs: planned,
  };
}

export function applySentimentFreeSourceTargetCoverageFollowupJobs({
  apply = false,
  searchSettings = null,
  keywords = [],
  limit = 30,
  operator = "",
  reason = "",
  now = Date.now(),
} = {}) {
  const plan = planSentimentFreeSourceTargetCoverageFollowupJobs({ searchSettings, keywords, limit, now });
  const jobs = plan.jobs.map(job => ({
    ...job,
    metadata: {
      ...(job.metadata || {}),
      followup_operator: String(operator || "").slice(0, 120),
      followup_reason: String(reason || "").slice(0, 300),
      planned_at: plan.generated_at,
    },
  }));
  const created = apply === true ? createSentimentCollectionJobs({ jobs }) : [];
  const skippedRunning = created.filter(job => job.skipped || job.upsert_action === "skipped_running").length;
  return {
    ...plan,
    applied: apply === true,
    summary: {
      ...plan.summary,
      created_jobs: created.length,
      skipped_running_jobs: skippedRunning,
    },
    jobs: apply === true ? created : jobs,
  };
}

export function getSentimentRealtimeSourceCoverageReport({
  lookbackHours = 6,
  limit = 30,
  minScore = 38,
  now = Date.now(),
  searchSettings = null,
} = {}) {
  const safeNow = Number.isNaN(new Date(now).getTime()) ? Date.now() : new Date(now).getTime();
  const search = readSentimentSearchSettings(searchSettings || null);
  const configuredSources = new Set(Array.isArray(search.sources) && search.sources.length ? search.sources : listSentimentSources().map(source => source.source_key));
  const schedule = listSentimentSourceSchedule({
    now: safeNow,
    sources: listSentimentSources().filter(source => configuredSources.has(source.source_key)),
  });
  const topicsReport = listSentimentRealtimeHotTopics({
    lookbackHours,
    limit,
    minCurrent: 1,
    now: safeNow,
  });
  const topics = (topicsReport.topics || [])
    .filter(topic => Number(topic.score || 0) >= Math.max(0, Math.min(100, Number(minScore) || 38)))
    .map(topic => {
      const currentFamilies = new Set(topic.current?.source_families || []);
      const expectedFamilies = realtimeCoverageExpectedFamilies(topic);
      const missingFamilies = expectedFamilies.filter(family => !currentFamilies.has(family));
      const weakFamilies = expectedFamilies.filter(family => {
        if (missingFamilies.includes(family)) return false;
        const candidates = realtimeCoverageSourceCandidates(family, schedule, safeNow).filter(item => item.enabled);
        return candidates.length > 0 && !candidates.some(item => item.due || item.stale_minutes <= Math.max(30, item.scan_interval_minutes * 2));
      });
      const familyPlans = [...new Set([...missingFamilies, ...weakFamilies])].map(family => {
        const candidates = realtimeCoverageSourceCandidates(family, schedule, safeNow);
        const enabledCandidates = candidates.filter(item => item.enabled);
        const recommendedSources = (enabledCandidates.length ? enabledCandidates : candidates)
          .filter(item => !["disabled", "cooldown", "throttled"].includes(item.status) || item.due || item.status === "waiting")
          .slice(0, 4)
          .map(item => item.source_key);
        return {
          family,
          status: missingFamilies.includes(family) ? "missing-family" : "weak-family",
          recommended_sources: recommendedSources,
          candidate_sources: candidates.slice(0, 6),
          suggested_keywords: normalizeSentimentMonitorKeywords([
            topic.keyword,
            `${topic.keyword} 投訴`,
            `${topic.keyword} 退款`,
            `${topic.keyword} 爆料`,
            `${topic.keyword} 負評`,
            `${topic.keyword} crisis`,
            `${topic.keyword} complaint`,
          ]).slice(0, 12),
        };
      });
      const gapScore = Math.min(100, Math.round(
        Number(topic.score || 0)
        + missingFamilies.length * 10
        + weakFamilies.length * 6
        + Number(topic.current?.high_risk || 0) * 5
        + Number(topic.current?.negative || 0) * 2
      ));
      return {
        keyword: topic.keyword,
        hot_score: Number(topic.score || 0),
        coverage_gap_score: gapScore,
        label: gapScore >= 82 ? "critical-realtime-coverage-gap" : gapScore >= 62 ? "high-realtime-coverage-gap" : "watch-realtime-coverage-gap",
        recommendation: missingFamilies.length ? "fill-realtime-source-family-gaps" : weakFamilies.length ? "refresh-weak-realtime-source-families" : "monitor-realtime-coverage",
        current_families: [...currentFamilies],
        expected_families: expectedFamilies,
        missing_families: missingFamilies,
        weak_families: weakFamilies,
        family_plans: familyPlans,
        suggested_sources: uniqueExpansionTerms(familyPlans.flatMap(plan => plan.recommended_sources || []), 20),
        suggested_keywords: normalizeSentimentMonitorKeywords(familyPlans.flatMap(plan => plan.suggested_keywords || [])).slice(0, 20),
        sample_urls: topic.sample_urls || [],
        reasons: topic.reasons || [],
        gaps: topic.gaps || [],
      };
    })
    .filter(topic => topic.missing_families.length || topic.weak_families.length)
    .sort((a, b) => b.coverage_gap_score - a.coverage_gap_score || b.missing_families.length - a.missing_families.length || a.keyword.localeCompare(b.keyword, "zh-Hant"));
  return {
    ok: true,
    lookback_hours: Math.max(1, Math.min(72, Number(lookbackHours) || 6)),
    min_score: Math.max(0, Math.min(100, Number(minScore) || 38)),
    summary: {
      topic_count: topics.length,
      critical_gap_topics: topics.filter(topic => topic.label === "critical-realtime-coverage-gap").length,
      high_gap_topics: topics.filter(topic => topic.label === "high-realtime-coverage-gap").length,
      missing_family_count: topics.reduce((sum, topic) => sum + topic.missing_families.length, 0),
      weak_family_count: topics.reduce((sum, topic) => sum + topic.weak_families.length, 0),
      recommended_sources: uniqueExpansionTerms(topics.flatMap(topic => topic.suggested_sources || []), 30),
      highest_gap_score: Math.max(0, ...topics.map(topic => Number(topic.coverage_gap_score || 0))),
    },
    topics,
  };
}

export function deriveRealtimeSourceCoverageSignals(report = {}) {
  const signals = new Map();
  for (const topic of Array.isArray(report.topics) ? report.topics : []) {
    const gapScore = Number(topic.coverage_gap_score || 0);
    if (gapScore < 45) continue;
    for (const plan of Array.isArray(topic.family_plans) ? topic.family_plans : []) {
      const family = String(plan.family || "");
      const sourceKeys = uniqueExpansionTerms(plan.recommended_sources || [], 8);
      for (const sourceKey of sourceKeys) {
        const key = String(sourceKey || "").trim();
        if (!key) continue;
        const current = signals.get(key) || {
          sourceKey: key,
          score: 0,
          priorityBoost: 0,
          gapCount: 0,
          keywords: [],
          families: [],
          statuses: [],
          suggestedKeywords: [],
          sampleUrls: [],
        };
        current.score = Math.max(Number(current.score || 0), gapScore);
        current.priorityBoost = Math.max(Number(current.priorityBoost || 0), Math.min(38, Math.round(gapScore / 3) + (plan.status === "missing-family" ? 8 : 3)));
        current.gapCount += 1;
        if (topic.keyword && !current.keywords.includes(topic.keyword)) current.keywords.push(topic.keyword);
        if (family && !current.families.includes(family)) current.families.push(family);
        if (plan.status && !current.statuses.includes(plan.status)) current.statuses.push(plan.status);
        current.suggestedKeywords = normalizeSentimentMonitorKeywords([
          ...current.suggestedKeywords,
          ...(plan.suggested_keywords || []),
          ...(topic.suggested_keywords || []),
        ]).slice(0, 16);
        current.sampleUrls = uniqueExpansionTerms([
          ...current.sampleUrls,
          ...(topic.sample_urls || []),
        ], 8);
        signals.set(key, current);
      }
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function eventClusterGapBoost(cluster = {}) {
  const propagation = Number(cluster.propagation_path_score || 0);
  const independentScore = Number(cluster.independent_confirmation?.score || 0);
  const gaps = Array.isArray(cluster.evidence_gaps) ? cluster.evidence_gaps : [];
  let boost = propagation >= 75 ? 34 : propagation >= 55 ? 28 : propagation >= 35 ? 22 : 14;
  if (independentScore >= 78) boost += 8;
  else if (independentScore >= 58) boost += 5;
  else if (independentScore < 38 && propagation >= 35) boost += 7;
  if (gaps.includes("missing-origin-candidate")) boost += 8;
  if (gaps.includes("missing-social-amplification")) boost += 6;
  if (gaps.includes("missing-news-confirmation")) boost += 5;
  if (gaps.includes("missing-independent-source-confirmation")) boost += 7;
  if (gaps.includes("missing-public-feedback-confirmation")) boost += 5;
  if (gaps.includes("missing-official-regulatory-confirmation")) boost += 4;
  if (gaps.includes("duplicate-amplification-needs-independent-confirmation")) boost += 6;
  if (Number(cluster.edge_count || 0) > 0) boost += 4;
  if (Number(cluster.explicit_reference_edge_count || 0) > 0) boost += 6;
  if (cluster.event_count >= 2) boost += 4;
  return Math.min(45, boost);
}

function normalizeFollowupUrl(value = "") {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|yclid$|mc_)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function followupSourceKeysForPlatform(platform = "") {
  const key = String(platform || "").toLowerCase();
  const hinted = BURST_PLATFORM_SOURCE_HINTS.get(key);
  if (hinted?.length) return hinted;
  const normalized = key.replace(/[^a-z0-9]+/g, "");
  if (normalized.includes("google") && normalized.includes("news")) return ["googleNews"];
  if (normalized.includes("bing") && normalized.includes("news")) return ["bingNews"];
  if (normalized.includes("baidu") && normalized.includes("news")) return ["baiduNews"];
  if (normalized.includes("rss")) return ["rssFeeds"];
  if (normalized.includes("gdelt")) return ["gdelt"];
  if (normalized.includes("duckduckgo")) return ["duckDuckGo"];
  if (normalized.includes("openweb")) return ["openWebDiscovery"];
  return [];
}

function eventClusterFollowupTargets(cluster = {}) {
  const targets = [];
  const add = (target = {}) => {
    const sourceKeys = uniqueExpansionTerms(target.sourceKeys || target.source_keys || [], 8);
    const url = normalizeFollowupUrl(target.url || "");
    const keyword = String(target.keyword || "").trim();
    const reason = String(target.reason || "").trim();
    if (!url && !keyword && !sourceKeys.length) return;
    const key = `${target.type || "target"}:${url || keyword}:${sourceKeys.join("|")}:${reason}`;
    if (targets.some(item => item.key === key)) return;
    targets.push({
      key,
      type: target.type || "event-cluster-followup",
      url,
      keyword,
      label: String(target.label || cluster.label || "").trim(),
      sourceKeys,
      reason,
      priority: Math.max(1, Math.min(100, Number(target.priority || cluster.tracking_priority || cluster.propagation_path_score || 40))),
    });
  };

  const basePriority = Math.max(35, Number(cluster.tracking_priority || 0), Number(cluster.propagation_path_score || 0));
  if (cluster.likely_origin?.url) {
    add({
      type: "origin-url",
      url: cluster.likely_origin.url,
      label: cluster.likely_origin.title || cluster.label,
      sourceKeys: [
        ...followupSourceKeysForPlatform(cluster.likely_origin.platform),
        "openWebDiscovery",
        "duckDuckGo",
        "googleNews",
        "bingNews",
        "rssFeeds",
      ],
      reason: "likely-origin-followup",
      priority: basePriority + 12,
    });
  }
  for (const amplifier of Array.isArray(cluster.amplifiers) ? cluster.amplifiers : []) {
    const sourceKeys = uniqueExpansionTerms([
      ...(amplifier.platforms || []).flatMap(followupSourceKeysForPlatform),
      ...(amplifier.amplification_platforms || []).flatMap(followupSourceKeysForPlatform),
    ], 10);
    add({
      type: "amplifier-platform",
      keyword: amplifier.label || cluster.label || cluster.keyword || "",
      label: amplifier.label || cluster.label,
      sourceKeys,
      reason: "amplifier-followup",
      priority: Math.max(basePriority, Number(amplifier.tracking_priority || amplifier.propagation_path_score || 0)),
    });
  }
  for (const platform of uniqueExpansionTerms(cluster.platforms || [], 16)) {
    const sourceKeys = followupSourceKeysForPlatform(platform);
    if (!sourceKeys.length) continue;
    add({
      type: "observed-platform",
      keyword: cluster.keyword || cluster.label || "",
      label: cluster.label,
      sourceKeys,
      reason: "observed-platform-followup",
      priority: basePriority,
    });
  }
  if (Number(cluster.explicit_reference_profile?.explicit_reference_edge_count || cluster.explicit_reference_edge_count || 0) > 0) {
    add({
      type: "explicit-reference-chain",
      keyword: cluster.keyword || cluster.label || "",
      label: cluster.label,
      sourceKeys: ["openWebDiscovery", "duckDuckGo", "googleNews", "bingNews", "rssFeeds", "bluesky", "mastodon", "threads", "instagram", "xSearch", "facebookSearch", "linkedinSearch", "reddit", "ptt", "dcard"],
      reason: "explicit-reference-chain-followup",
      priority: basePriority + 10,
    });
  }
  if ((cluster.evidence_gaps || []).includes("explicit-reference-needs-independent-confirmation")
    || (cluster.evidence_gaps || []).includes("missing-independent-source-confirmation")) {
    add({
      type: "independent-confirmation-gap",
      keyword: cluster.keyword || cluster.label || "",
      label: cluster.label,
      sourceKeys: ["googleNews", "bingNews", "baiduNews", "rssFeeds", "publicReviewSites", "regionalComplaintSources", "reddit", "youtube", "bilibili", "ptt", "dcard"],
      reason: "independent-confirmation-followup",
      priority: basePriority + 8,
    });
  }
  return targets
    .sort((a, b) => b.priority - a.priority || a.type.localeCompare(b.type))
    .slice(0, 20);
}

export function deriveEventClusterSourceSignals(clusterReport = {}) {
  const signals = new Map();
  for (const cluster of Array.isArray(clusterReport.clusters) ? clusterReport.clusters : []) {
    const gaps = Array.isArray(cluster.evidence_gaps) ? cluster.evidence_gaps : [];
    if (!gaps.length && Number(cluster.propagation_path_score || 0) < 35 && Number(cluster.event_count || 0) < 2) continue;
    const followupTargets = eventClusterFollowupTargets(cluster);
    const sourceKeys = uniqueExpansionTerms([
      ...(cluster.next_tracking_sources || []),
      ...followupTargets.flatMap(target => target.sourceKeys || []),
    ], 30);
    const twoHopCollection = Number(cluster.event_count || 0) >= 2 || Number(cluster.edge_count || 0) > 0;
    const explicitReferenceEdgeCount = Number(cluster.explicit_reference_edge_count || 0);
    const explicitReferenceReasons = uniqueExpansionTerms(cluster.explicit_reference_reasons || [], 12);
    const boost = eventClusterGapBoost(cluster);
    for (const sourceKey of sourceKeys) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const previous = signals.get(key) || {
        sourceKey: key,
        score: 0,
        priorityBoost: 0,
        clusterCount: 0,
        maxPropagationPathScore: 0,
        gaps: [],
        clusterLabels: [],
        suggestedKeywords: [],
        independentConfirmationLabels: [],
        independentSourceFamilies: [],
        maxIndependentConfirmationScore: 0,
        minIndependentConfirmationScore: 100,
        confirmedClusterCount: 0,
        twoHopCollection: false,
        twoHopReasons: [],
        explicitReferenceChain: false,
        explicitReferenceEdgeCount: 0,
        explicitReferenceReasons: [],
        followupTargets: [],
        originUrls: [],
        amplifierPlatforms: [],
        independentConfirmationNeeded: false,
      };
      previous.score = Math.min(100, Number(previous.score || 0) + boost);
      previous.priorityBoost = Math.max(Number(previous.priorityBoost || 0), boost);
      previous.clusterCount += 1;
      previous.maxPropagationPathScore = Math.max(previous.maxPropagationPathScore, Number(cluster.propagation_path_score || 0));
      if (explicitReferenceEdgeCount > 0) {
        previous.explicitReferenceChain = true;
        previous.explicitReferenceEdgeCount += explicitReferenceEdgeCount;
        for (const reason of explicitReferenceReasons) {
          if (reason && !previous.explicitReferenceReasons.includes(reason) && previous.explicitReferenceReasons.length < 12) previous.explicitReferenceReasons.push(reason);
        }
      }
      for (const target of followupTargets.filter(item => !item.sourceKeys.length || item.sourceKeys.includes(key))) {
        const publicTarget = {
          type: target.type,
          url: target.url,
          keyword: target.keyword,
          label: target.label,
          reason: target.reason,
          priority: target.priority,
        };
        if (!previous.followupTargets.some(item => item.type === publicTarget.type && item.url === publicTarget.url && item.keyword === publicTarget.keyword && item.reason === publicTarget.reason) && previous.followupTargets.length < 20) {
          previous.followupTargets.push(publicTarget);
        }
        if (target.type === "origin-url" && target.url && !previous.originUrls.includes(target.url) && previous.originUrls.length < 8) previous.originUrls.push(target.url);
        if (target.type === "amplifier-platform") {
          for (const platform of cluster.platforms || []) {
            if (platform && !previous.amplifierPlatforms.includes(platform) && previous.amplifierPlatforms.length < 12) previous.amplifierPlatforms.push(platform);
          }
        }
      }
      const independent = cluster.independent_confirmation || {};
      const independentScore = Number(independent.score || 0);
      previous.maxIndependentConfirmationScore = Math.max(Number(previous.maxIndependentConfirmationScore || 0), independentScore);
      previous.minIndependentConfirmationScore = Math.min(Number(previous.minIndependentConfirmationScore || 100), independentScore || 100);
      if (independentScore >= 58) previous.confirmedClusterCount += 1;
      if (independent.label && !previous.independentConfirmationLabels.includes(independent.label)) previous.independentConfirmationLabels.push(independent.label);
      previous.independentSourceFamilies = [...new Set([
        ...previous.independentSourceFamilies,
        ...(independent.source_families || []),
      ])].slice(0, 12);
      for (const gap of gaps) if (gap && !previous.gaps.includes(gap)) previous.gaps.push(gap);
      if (gaps.includes("explicit-reference-needs-independent-confirmation") || gaps.includes("missing-independent-source-confirmation")) {
        previous.independentConfirmationNeeded = true;
      }
      if (cluster.label && !previous.clusterLabels.includes(cluster.label)) previous.clusterLabels.push(cluster.label);
      if (twoHopCollection) {
        previous.twoHopCollection = true;
        for (const reason of ["multi-event-cluster", Number(cluster.edge_count || 0) > 0 ? "has-propagation-edges" : "", explicitReferenceEdgeCount > 0 ? "explicit-reference-chain" : ""]) {
          if (reason && !previous.twoHopReasons.includes(reason)) previous.twoHopReasons.push(reason);
        }
      }
      for (const keyword of normalizeSentimentMonitorKeywords([cluster.keyword, cluster.label])) {
        if (keyword && !previous.suggestedKeywords.includes(keyword) && previous.suggestedKeywords.length < 12) previous.suggestedKeywords.push(keyword);
      }
      signals.set(key, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function sourceSpecificAnomalyKeywords(sourceKey, anomalySignal = null, baseKeywords = []) {
  if (!anomalySignal || Number(anomalySignal.priorityBoost || anomalySignal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4);
  const evidenceKeywords = normalizeSentimentMonitorKeywords(anomalySignal.keywords || []).slice(0, 8);
  const titleRiskTerms = normalizeSentimentMonitorKeywords((anomalySignal.titles || [])
    .flatMap(title => RISK_SCAN_TERMS.filter(term => String(title || "").includes(term)))).slice(0, 8);
  const riskKeywords = normalizeSentimentMonitorKeywords([...evidenceKeywords.filter(containsRiskTerm), ...titleRiskTerms, ...evidenceKeywords]).slice(0, 8);
  const platformHints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const main of (base.length ? base : evidenceKeywords).slice(0, 4)) {
    if (!main) continue;
    for (const risk of (riskKeywords.length ? riskKeywords : RISK_SCAN_TERMS.slice(0, 3)).slice(0, 4)) {
      if (risk && !String(main).includes(risk)) out.push(`${main} ${risk}`);
      for (const hint of platformHints) {
        if (hint) out.push(`${main} ${risk} ${hint}`.trim());
      }
    }
  }
  for (const keyword of evidenceKeywords) {
    for (const hint of platformHints) {
      if (keyword && hint && !String(keyword).includes(hint)) out.push(`${keyword} ${hint}`);
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificRealtimeHotTopicKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || signal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4);
  const topicKeywords = normalizeSentimentMonitorKeywords([
    ...(signal.keywords || []),
    ...(signal.suggestedKeywords || []),
  ]).slice(0, 10);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const gapTerms = normalizeSentimentMonitorKeywords([
    ...(signal.gaps || []).includes("missing-news-confirmation") ? ["新聞", "媒體", "聲明"] : [],
    ...(signal.gaps || []).includes("missing-public-feedback-confirmation") ? ["投訴", "退款", "客服", "評價"] : [],
    ...(signal.gaps || []).includes("missing-social-community-confirmation") ? ["爆料", "轉傳", "討論"] : [],
    ...(signal.gaps || []).includes("missing-cross-source-confirmation") ? ["交叉驗證", "多平台"] : [],
    ...(signal.maxHotScore >= 78 ? ["危機", "延燒"] : []),
  ]).slice(0, 8);
  const out = [];
  for (const main of (topicKeywords.length ? topicKeywords : base).slice(0, 6)) {
    if (!main) continue;
    for (const term of (gapTerms.length ? gapTerms : RISK_SCAN_TERMS.slice(0, 3)).slice(0, 4)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificRealtimeAnomalyWindowKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || signal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4);
  const anomalyKeywords = normalizeSentimentMonitorKeywords([
    ...(signal.suggestedKeywords || []),
    ...(signal.reasons || []),
  ]).slice(0, 10);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const riskTerms = normalizeSentimentMonitorKeywords([
    ...anomalyKeywords.filter(containsRiskTerm),
    ...(signal.reasons || []).includes("negative-acceleration") ? ["負評", "投訴"] : [],
    ...(signal.reasons || []).includes("high-risk-acceleration") ? ["危機", "爆料"] : [],
    ...(signal.gaps || []).includes("needs-official-response") ? ["官方回應", "聲明"] : [],
    ...(signal.gaps || []).includes("needs-video-or-comment-confirmation") ? ["留言", "評論"] : [],
  ]).slice(0, 8);
  const out = [];
  for (const main of (anomalyKeywords.length ? anomalyKeywords : base).slice(0, 6)) {
    if (!main) continue;
    for (const term of (riskTerms.length ? riskTerms : RISK_SCAN_TERMS.slice(0, 4)).slice(0, 4)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificFreeSourceTargetCoverageKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || signal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 5);
  const terms = normalizeSentimentMonitorKeywords(signal.suggestedTerms || []).slice(0, 10);
  const profiles = normalizeSentimentMonitorKeywords(signal.missingProfiles || []).slice(0, 8);
  const out = [];
  for (const keyword of base) {
    for (const term of terms.slice(0, 5)) {
      if (keyword && term && !String(keyword).toLowerCase().includes(String(term).toLowerCase())) out.push(`${keyword} ${term}`);
    }
    for (const profile of profiles.slice(0, 4)) {
      if (keyword && profile) out.push(`${keyword} ${profile}`);
    }
  }
  if (sourceKey === "regionalComplaintSources") {
    for (const keyword of base) out.push(`${keyword} consumer protection`, `${keyword} regulatory warning`, `${keyword} recall`);
  } else if (sourceKey === "publicReviewSites") {
    for (const keyword of base) out.push(`${keyword} complaint`, `${keyword} negative review`, `${keyword} refund`);
  } else if (sourceKey === "verticalReviewSources") {
    for (const keyword of base) out.push(`${keyword} software review`, `${keyword} app review`, `${keyword} G2`);
  } else if (sourceKey === "ecommerceReviewSources") {
    for (const keyword of base) out.push(`${keyword} marketplace review`, `${keyword} seller complaint`, `${keyword} delivery refund`);
  } else if (sourceKey === "legalPublicRecords") {
    for (const keyword of base) out.push(`${keyword} lawsuit`, `${keyword} litigation`, `${keyword} class action`, `${keyword} court docket`);
  } else if (sourceKey === "publicProcurementSources") {
    for (const keyword of base) out.push(`${keyword} USAspending`, `${keyword} contract award`, `${keyword} procurement`, `${keyword} government contract`);
  } else if (sourceKey === "publicSanctionsSources") {
    for (const keyword of base) out.push(`${keyword} OFAC`, `${keyword} SDN`, `${keyword} UK sanctions`, `${keyword} OFSI`, `${keyword} EU sanctions`, `${keyword} UN Security Council`, `${keyword} UN consolidated list`, `${keyword} financial sanctions`, `${keyword} asset freeze`, `${keyword} funds freeze`, `${keyword} sanctions`, `${keyword} watchlist`);
  } else if (sourceKey === "publicProductRecallSources") {
    for (const keyword of base) out.push(`${keyword} recall`, `${keyword} CPSC`, `${keyword} openFDA`, `${keyword} EU Safety Gate`, `${keyword} NHTSA`, `${keyword} vehicle recall`, `${keyword} vehicle complaint`, `${keyword} product safety`);
  } else if (sourceKey === "publicEnforcementActionSources") {
    for (const keyword of base) out.push(`${keyword} CFPB complaint`, `${keyword} SEC enforcement`, `${keyword} enforcement action`, `${keyword} regulatory action`);
  } else if (sourceKey === "publicAdvertisingRulingsSources") {
    for (const keyword of base) out.push(`${keyword} ASA ruling`, `${keyword} misleading advertising`, `${keyword} advertising standards`, `${keyword} greenwashing`);
  } else if (sourceKey === "publicCompanyFilingsSources") {
    for (const keyword of base) out.push(`${keyword} SEC filing`, `${keyword} EDGAR`, `${keyword} 8-K`, `${keyword} 10-K`, `${keyword} The Gazette`, `${keyword} insolvency`, `${keyword} liquidation`, `${keyword} winding up`);
  } else if (sourceKey === "brandImpersonationSources") {
    for (const keyword of base) out.push(`${keyword} phishing`, `${keyword} impersonation`, `${keyword} fake domain`, `${keyword} certificate transparency`);
  } else if (sourceKey === "securityAdvisorySources") {
    for (const keyword of base) out.push(`${keyword} CVE`, `${keyword} vulnerability`, `${keyword} exploit`, `${keyword} CISA advisory`, `${keyword} CISA alert`, `${keyword} security advisory`);
  } else if (sourceKey === "supplyChainAdvisorySources") {
    for (const keyword of base) out.push(`${keyword} OSV`, `${keyword} GHSA`, `${keyword} package vulnerability`, `${keyword} dependency vulnerability`);
  } else if (sourceKey === "investorDiscussionSources") {
    for (const keyword of base) out.push(`${keyword} Stocktwits`, `${keyword} investor`, `${keyword} market sentiment`, `${keyword} earnings risk`);
  } else if (sourceKey === "publicStatusPageSources") {
    for (const keyword of base) out.push(`${keyword} status page`, `${keyword} outage`, `${keyword} service status`, `${keyword} incident`);
  } else if (sourceKey === "officialOwnedMediaSources") {
    for (const keyword of base) out.push(`${keyword} official statement`, `${keyword} newsroom`, `${keyword} press release`, `${keyword} company blog`);
  } else if (sourceKey === "applePodcastSearch") {
    for (const keyword of base) out.push(`${keyword} podcast`, `${keyword} podcast episode`, `${keyword} audio interview`, `${keyword} 播客`, `${keyword} 音频`, `${keyword} 訪談`);
  } else if (sourceKey === "appStoreReviews") {
    for (const keyword of base) out.push(`${keyword} App Store review`, `${keyword} iOS app complaint`, `${keyword} iPhone app rating`, `${keyword} app crash`, `${keyword} app refund`, `${keyword} app 客訴`);
  } else if (sourceKey === "googlePlayReviews") {
    for (const keyword of base) out.push(`${keyword} Google Play review`, `${keyword} Android app complaint`, `${keyword} Play Store rating`, `${keyword} app crash`, `${keyword} app refund`, `${keyword} app 客訴`);
  } else if (sourceKey === "reddit") {
    for (const keyword of base) out.push(`${keyword} subreddit`, `${keyword} reddit complaint`, `${keyword} reddit discussion`, `${keyword} community complaint`);
  } else if (sourceKey === "ptt") {
    for (const keyword of base) out.push(`${keyword} PTT`, `${keyword} PTT 爆料`, `${keyword} PTT 投訴`, `${keyword} 看板`);
  } else if (sourceKey === "dcard") {
    for (const keyword of base) out.push(`${keyword} Dcard`, `${keyword} Dcard 爆料`, `${keyword} Dcard 投訴`, `${keyword} forum`);
  } else if (sourceKey === "telegramPublic") {
    for (const keyword of base) out.push(`${keyword} Telegram channel`, `${keyword} public channel complaint`, `${keyword} 爆料 頻道`, `${keyword} 社群 頻道`);
  } else if (sourceKey === "threads") {
    for (const keyword of base) out.push(`${keyword} Threads profile`, `${keyword} Threads post`, `${keyword} Threads complaint`, `${keyword} social profile`);
  } else if (sourceKey === "instagram") {
    for (const keyword of base) out.push(`${keyword} Instagram profile`, `${keyword} Instagram post`, `${keyword} Instagram complaint`, `${keyword} social profile`);
  } else if (sourceKey === "publicStatusPageSources") {
    for (const keyword of base) out.push(`${keyword} status page`, `${keyword} service status`, `${keyword} outage`, `${keyword} incident`, `${keyword} degraded service`, `${keyword} maintenance`);
  } else if (sourceKey === "officialOwnedMediaSources") {
    for (const keyword of base) out.push(`${keyword} official statement`, `${keyword} newsroom`, `${keyword} press release`, `${keyword} company blog`, `${keyword} incident response`, `${keyword} apology`);
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificKeywordFamilyCoverageKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || signal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4);
  const keywords = normalizeSentimentMonitorKeywords([
    ...(signal.suggestedKeywords || []),
    ...(signal.keywords || []),
  ]).slice(0, 12);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const keyword of (keywords.length ? keywords : base).slice(0, 8)) {
    if (!keyword) continue;
    out.push(keyword);
    for (const hint of hints) {
      if (hint && !String(keyword).includes(hint)) out.push(`${keyword} ${hint}`);
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificOfficialRegulatoryFollowupKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || signal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords([
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
    ...(signal.suggestedKeywords || []),
  ]).slice(0, 8);
  const tiers = new Set(Array.isArray(signal.tiers) ? signal.tiers : []);
  const terms = normalizeSentimentMonitorKeywords([
    "官方聲明", "官方声明", "回應", "回应", "後續", "后续",
    ...(tiers.has("regulatory-alert") ? ["召回", "安全警示", "通報", "通报", "recall", "safety alert"] : []),
    ...(tiers.has("official-consumer-protection") ? ["投訴", "投诉", "消費者", "消费者", "complaint"] : []),
    "statement", "response", "timeline",
  ]).slice(0, 10);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const main of base.slice(0, 6)) {
    if (!main) continue;
    for (const term of terms.slice(0, 5)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  for (const keyword of signal.suggestedKeywords || []) {
    for (const hint of hints) {
      if (keyword && hint && !String(keyword).includes(hint)) out.push(`${keyword} ${hint}`);
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 14);
}

function sourceSpecificAlertEventKeywords(sourceKey, alertEventSignal = null, baseKeywords = []) {
  if (!alertEventSignal || Number(alertEventSignal.priorityBoost || alertEventSignal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords([
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
    ...(alertEventSignal.suggestedKeywords || []),
  ]).slice(0, 8);
  const signalRiskTerms = normalizeSentimentMonitorKeywords([
    ...(alertEventSignal.suggestedKeywords || []).filter(containsRiskTerm),
    ...RISK_SCAN_TERMS.filter(term => (alertEventSignal.suggestedKeywords || []).some(keyword => String(keyword || "").includes(term))),
  ]).slice(0, 8);
  const terms = signalRiskTerms.length ? signalRiskTerms : RISK_SCAN_TERMS.slice(0, 4);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const main of base.slice(0, 6)) {
    if (!main) continue;
    for (const term of terms.slice(0, 5)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  for (const keyword of alertEventSignal.suggestedKeywords || []) {
    for (const hint of hints) {
      if (keyword && hint && !String(keyword).includes(hint)) out.push(`${keyword} ${hint}`);
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 14);
}

function evidenceGapRiskTerms(signal = {}) {
  const reasons = new Set(Array.isArray(signal.reasons) ? signal.reasons : []);
  const missingText = `${(signal.missing || []).join(" ")} ${(signal.recommendations || []).join(" ")}`;
  const terms = [];
  if (reasons.has("missing-body-evidence") || reasons.has("thin-body-or-page-metadata") || /正文|页面|頁面|body|article/i.test(missingText)) terms.push("爆料", "投訴", "官方聲明");
  if (reasons.has("missing-comment-evidence") || reasons.has("missing-comments-or-engagement") || /评论|評論|回复|回覆|comment|reply/i.test(missingText)) terms.push("留言", "評論", "投訴");
  if (reasons.has("missing-origin-evidence") || /首发|首發|来源|來源|origin/i.test(missingText)) terms.push("首發", "爆料", "來源");
  if (reasons.has("missing-cross-platform-evidence") || /跨平台|传播|傳播|扩散|擴散/i.test(missingText)) terms.push("轉傳", "炎上", "擴散");
  if (reasons.has("missing-fact-claim-evidence") || /事实|事實|矛盾|声明|聲明/i.test(missingText)) terms.push("證據", "澄清", "官方聲明");
  if (reasons.has("missing-quoted-context") || /引用|转述|轉述|quoted|repost/i.test(missingText)) terms.push("轉貼", "引用", "轉述");
  if (reasons.has("missing-video-followup-evidence") || /视频|影片|抖音|快手|video|YouTube/i.test(missingText)) terms.push("影片", "抖音", "快手", "YouTube", "爆料");
  return normalizeSentimentMonitorKeywords(terms.length ? terms : RISK_SCAN_TERMS.slice(0, 4)).slice(0, 8);
}

function sourceSpecificEvidenceGapKeywords(sourceKey, evidenceGapSignal = null, baseKeywords = []) {
  if (!evidenceGapSignal || Number(evidenceGapSignal.priorityBoost || evidenceGapSignal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4);
  const terms = evidenceGapRiskTerms(evidenceGapSignal);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const main of base) {
    for (const term of terms.slice(0, 5)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificEvidenceDepthKeywords(sourceKey, evidenceDepthSignal = null, baseKeywords = []) {
  if (!evidenceDepthSignal || Number(evidenceDepthSignal.priorityBoost || evidenceDepthSignal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords([
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
    ...(evidenceDepthSignal.suggestedKeywords || []),
  ]).slice(0, 6);
  const reasonSet = new Set(Array.isArray(evidenceDepthSignal.reasons) ? evidenceDepthSignal.reasons : []);
  const priorityTerms = reasonSet.has("missing-comments-or-engagement") ? ["留言", "評論", "投訴"] : [];
  const terms = normalizeSentimentMonitorKeywords([...priorityTerms, ...evidenceGapRiskTerms({
    reasons: evidenceDepthSignal.reasons || [],
    missing: evidenceDepthSignal.missing || [],
    recommendations: [],
  })]).slice(0, 8);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const main of base) {
    for (const term of terms.slice(0, 4)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificEvidenceCoverageRecoveryKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || signal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords([
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
    ...(signal.suggestedKeywords || []),
    ...(signal.sampleFollowupQueries || []),
  ]).slice(0, 8);
  const statuses = new Set(Array.isArray(signal.recoveryStatuses) ? signal.recoveryStatuses : []);
  const terms = normalizeSentimentMonitorKeywords([
    statuses.has("failed") || statuses.has("no-evidence") ? "原文" : "",
    statuses.has("failed") || statuses.has("no-evidence") ? "完整報導" : "",
    statuses.has("partial-recovered") ? "後續" : "",
    ...(signal.actions || []).includes("collect-comments-and-replies") ? "留言" : "",
    ...(signal.actions || []).includes("deepen-low-depth-evidence") ? "官方回應" : "",
    ...(signal.lowDepthDomains || []),
    ...(signal.lowDepthCommentUrls || []),
    ...(signal.lowDepthFeedNames || []),
    ...(signal.recommendedAlternateSources || []),
  ]).slice(0, 8);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const main of base) {
    out.push(main);
    for (const term of terms.slice(0, 5)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificTaiwanPrioritySiteHealthKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || signal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4);
  const sites = normalizeSentimentMonitorKeywords([
    ...(signal.siteNames || []),
    ...(signal.domains || []),
    ...(signal.suggestedKeywords || []),
  ]).slice(0, 10);
  const statuses = new Set(Array.isArray(signal.coverageStatuses) ? signal.coverageStatuses : []);
  const terms = normalizeSentimentMonitorKeywords([
    statuses.has("runtime-warning") ? "Google News" : "",
    statuses.has("runtime-warning") ? "Bing News" : "",
    statuses.has("runtime-warning") ? "最新" : "",
    statuses.has("indexed-only") || statuses.has("partial") || statuses.has("missing") ? "RSS" : "",
    statuses.has("indexed-only") || statuses.has("partial") || statuses.has("missing") ? "sitemap" : "",
    ...(signal.recommendedActions || []).some(action => String(action || "").includes("browser")) ? "公開搜尋" : "",
  ]).slice(0, 8);
  const out = [];
  for (const keyword of sites) out.push(keyword);
  for (const main of base) {
    for (const site of sites.slice(0, 6)) {
      out.push(`${main} ${site}`);
      for (const term of terms.slice(0, 4)) {
        if (term && !String(site).includes(term)) out.push(`${main} ${site} ${term}`);
      }
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 14);
}

function propagationConfidenceRiskTerms(signal = {}) {
  const gaps = new Set(Array.isArray(signal.gaps) ? signal.gaps : []);
  const terms = [];
  if (gaps.has("weak-origin-evidence")) terms.push("首發", "來源", "爆料");
  if (gaps.has("weak-edge-evidence")) terms.push("轉傳", "引用", "相關討論");
  if (gaps.has("thin-timeline")) terms.push("後續", "留言", "評論");
  if (gaps.has("missing-cross-platform-confirmation")) terms.push("跨平台", "轉貼", "炎上");
  if (gaps.has("missing-cross-family-confirmation")) terms.push("新聞", "社群", "官方聲明");
  return normalizeSentimentMonitorKeywords(terms.length ? terms : ["轉傳", "首發", "評論", "來源"]).slice(0, 8);
}

function sourceSpecificPropagationConfidenceKeywords(sourceKey, propagationConfidenceSignal = null, baseKeywords = []) {
  if (!propagationConfidenceSignal || Number(propagationConfidenceSignal.priorityBoost || propagationConfidenceSignal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords([
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
    ...(propagationConfidenceSignal.suggestedKeywords || []),
  ]).slice(0, 6);
  const terms = propagationConfidenceRiskTerms(propagationConfidenceSignal);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const main of base) {
    for (const term of terms.slice(0, 5)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificEventClusterKeywords(sourceKey, eventClusterSignal = null, baseKeywords = []) {
  if (!eventClusterSignal || Number(eventClusterSignal.priorityBoost || eventClusterSignal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4);
  const followupTargets = Array.isArray(eventClusterSignal.followupTargets) ? eventClusterSignal.followupTargets : [];
  const originHosts = uniqueExpansionTerms((eventClusterSignal.originUrls || []).map(hostFromTargetValue), 6);
  const targetKeywords = normalizeSentimentMonitorKeywords(followupTargets.flatMap(target => [
    target.keyword,
    target.label,
    target.url ? hostFromTargetValue(target.url) : "",
  ])).slice(0, 10);
  const clusterKeywords = normalizeSentimentMonitorKeywords([
    ...(eventClusterSignal.suggestedKeywords || []),
    ...(eventClusterSignal.clusterLabels || []),
    ...targetKeywords,
  ]).slice(0, 8);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const terms = normalizeSentimentMonitorKeywords([
    ...(eventClusterSignal.twoHopCollection ? ["後續", "轉載", "回應"] : []),
    ...(eventClusterSignal.explicitReferenceChain ? ["引用", "轉述", "原文", "來源"] : []),
    ...(eventClusterSignal.originUrls?.length ? ["原文", "來源", "canonical"] : []),
    ...(eventClusterSignal.independentConfirmationNeeded ? ["獨立查證", "第二來源", "交叉驗證"] : []),
    ...((eventClusterSignal.gaps || []).includes("missing-origin-candidate") ? ["首發", "爆料", "來源"] : []),
    ...((eventClusterSignal.gaps || []).includes("missing-social-amplification") ? ["轉傳", "炎上", "擴散"] : []),
    ...((eventClusterSignal.gaps || []).includes("missing-news-confirmation") ? ["媒體", "新聞", "官方聲明"] : []),
    ...((eventClusterSignal.gaps || []).includes("missing-independent-source-confirmation") ? ["交叉驗證", "多平台", "證實"] : []),
    ...((eventClusterSignal.gaps || []).includes("missing-public-feedback-confirmation") ? ["投訴", "評價", "客服"] : []),
    ...((eventClusterSignal.gaps || []).includes("missing-official-regulatory-confirmation") ? ["官方", "監管", "公告"] : []),
    ...((eventClusterSignal.gaps || []).includes("duplicate-amplification-needs-independent-confirmation") ? ["原始來源", "獨立爆料", "查證"] : []),
    ...((eventClusterSignal.gaps || []).includes("explicit-reference-needs-independent-confirmation") ? ["原始來源", "獨立來源", "非轉載"] : []),
  ]).slice(0, 8);
  const out = [];
  for (const host of originHosts) {
    for (const main of (clusterKeywords.length ? clusterKeywords : base).slice(0, sourceKey === "openWebDiscovery" ? 6 : 3)) {
      if (main && host) out.push(`${main} ${host}`, `${main} 原文 ${host}`);
    }
  }
  for (const main of (clusterKeywords.length ? clusterKeywords : base)) {
    if (!main) continue;
    for (const term of (terms.length ? terms : RISK_SCAN_TERMS.slice(0, 3)).slice(0, 4)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) {
        if (hint) out.push(`${main} ${term} ${hint}`.trim());
      }
    }
  }
  for (const target of followupTargets.slice(0, 8)) {
    const targetKeyword = normalizeSentimentMonitorKeywords([target.keyword, target.label, target.url ? hostFromTargetValue(target.url) : ""])[0];
    if (!targetKeyword) continue;
    if (target.type === "origin-url") out.push(`${targetKeyword} 原文`, `${targetKeyword} 來源`, `${targetKeyword} 引用`);
    if (target.type === "explicit-reference-chain") out.push(`${targetKeyword} 轉載`, `${targetKeyword} 引用`, `${targetKeyword} 轉述`);
    if (target.type === "independent-confirmation-gap") out.push(`${targetKeyword} 獨立查證`, `${targetKeyword} 第二來源`, `${targetKeyword} 非轉載`);
    if (target.type === "amplifier-platform") out.push(`${targetKeyword} 擴散`, `${targetKeyword} 回應`, `${targetKeyword} 留言`);
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

export function deriveSocialFollowupSourceSignals(report = {}) {
  const signals = new Map();
  for (const signal of Array.isArray(report.signals) ? report.signals : []) {
    const sources = Array.isArray(signal.suggested_sources) ? signal.suggested_sources : [];
    const priorityBoost = Math.max(0, Math.min(42, Number(signal.priorityBoost || signal.priority_boost || signal.score / 2 || 0)));
    for (const sourceKey of sources) {
      const key = String(sourceKey || "").trim();
      if (!key) continue;
      const previous = signals.get(key) || {
        sourceKey: key,
        score: 0,
        priorityBoost: 0,
        signalCount: 0,
        reasons: [],
        suggestedKeywords: [],
        sampleUrls: [],
        signalTypes: [],
      };
      previous.score = Math.min(100, previous.score + Math.round((Number(signal.score || 0) + priorityBoost) / 2));
      previous.priorityBoost = Math.max(previous.priorityBoost, priorityBoost);
      previous.signalCount += 1;
      if (signal.signal_type && !previous.signalTypes.includes(signal.signal_type)) previous.signalTypes.push(signal.signal_type);
      for (const reason of signal.reasons || []) if (reason && !previous.reasons.includes(reason) && previous.reasons.length < 12) previous.reasons.push(reason);
      for (const keyword of signal.suggested_keywords || []) if (keyword && !previous.suggestedKeywords.includes(keyword) && previous.suggestedKeywords.length < 16) previous.suggestedKeywords.push(keyword);
      for (const url of signal.sample_urls || []) if (url && !previous.sampleUrls.includes(url) && previous.sampleUrls.length < 8) previous.sampleUrls.push(url);
      signals.set(key, previous);
    }
  }
  return Object.fromEntries([...signals.entries()].sort((a, b) => b[1].priorityBoost - a[1].priorityBoost || b[1].score - a[1].score || a[0].localeCompare(b[0])));
}

function sourceSpecificSocialFollowupKeywords(sourceKey, socialFollowupSignal = null, baseKeywords = []) {
  if (!socialFollowupSignal || Number(socialFollowupSignal.priorityBoost || socialFollowupSignal.score || 0) <= 0) return [];
  const base = normalizeSentimentMonitorKeywords([
    ...(socialFollowupSignal.suggestedKeywords || []),
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
  ]).slice(0, 8);
  const reasons = new Set(Array.isArray(socialFollowupSignal.reasons) ? socialFollowupSignal.reasons : []);
  const terms = normalizeSentimentMonitorKeywords([
    ...(reasons.has("quoted-context") ? ["引用", "轉述", "轉貼"] : []),
    ...(reasons.has("comment-burst") ? ["留言", "評論", "回覆"] : []),
    ...(reasons.has("author-continuity") ? ["最新", "後續", "爆料"] : []),
    ...(reasons.has("youtube-channel-followup") || reasons.has("related-video-chain") ? ["後續影片", "YouTube", "留言"] : []),
    ...(reasons.size ? [] : ["後續", "轉傳", "評論"]),
  ]).slice(0, 8);
  const hints = normalizeSentimentMonitorKeywords(SOURCE_TOPIC_KEYWORD_HINTS.get(sourceKey) || [sourceKey]).slice(0, 3);
  const out = [];
  for (const main of base) {
    for (const term of (terms.length ? terms : ["後續", "評論", "轉傳"]).slice(0, 4)) {
      if (term && !String(main).includes(term)) out.push(`${main} ${term}`);
      for (const hint of hints) if (hint) out.push(`${main} ${term} ${hint}`.trim());
    }
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificAccessBarrierAlternateKeywords(sourceKey, accessBarrierAlternateSignal = null, baseKeywords = []) {
  if (!accessBarrierAlternateSignal || Number(accessBarrierAlternateSignal.priorityBoost || 0) <= 0) return [];
  const seeds = normalizeSentimentMonitorKeywords([
    ...(accessBarrierAlternateSignal.queryTerms || []),
    ...(accessBarrierAlternateSignal.blockedDomains || []),
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
  ]).slice(0, 10);
  const out = [];
  for (const term of seeds) {
    if (term.length >= 3) out.push(term);
    if (!containsRiskTerm(term)) {
      if (sourceKey === "youtube") out.push(`${term} YouTube`);
      else if (sourceKey === "reddit") out.push(`${term} Reddit`);
      else if (sourceKey === "legalPublicRecords") out.push(`${term} lawsuit`);
      else if (sourceKey === "publicProcurementSources") out.push(`${term} contract award`);
      else if (sourceKey === "publicSanctionsSources") out.push(`${term} OFAC`, `${term} EU sanctions`, `${term} UN sanctions`);
      else if (sourceKey === "publicProductRecallSources") out.push(`${term} recall`, `${term} NHTSA`, `${term} vehicle complaint`);
      else if (sourceKey === "publicEnforcementActionSources") out.push(`${term} enforcement action`);
      else if (sourceKey === "publicAdvertisingRulingsSources") out.push(`${term} ASA ruling`);
      else if (sourceKey === "publicRegulatoryWarningLetterSources") out.push(`${term} FDA warning letter`);
      else if (sourceKey === "publicCompanyFilingsSources") out.push(`${term} SEC filing`, `${term} The Gazette`);
      else if (sourceKey === "brandImpersonationSources") out.push(`${term} phishing`);
      else if (sourceKey === "securityAdvisorySources") out.push(`${term} CVE`, `${term} CISA alert`);
      else if (sourceKey === "supplyChainAdvisorySources") out.push(`${term} OSV`);
      else if (sourceKey === "investorDiscussionSources") out.push(`${term} investor`);
      else if (sourceKey === "publicStatusPageSources") out.push(`${term} outage`, `${term} status page`);
      else if (sourceKey === "officialOwnedMediaSources") out.push(`${term} official statement`, `${term} newsroom`);
      else if (sourceKey === "publicReviewSites" || sourceKey === "regionalComplaintSources") out.push(`${term} complaint`);
    }
    if (out.length >= 12) break;
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

function sourceSpecificEvidenceCoverageRoutedAlternateKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || 0) <= 0) return [];
  const seeds = normalizeSentimentMonitorKeywords([
    ...(signal.routedKeywords || []),
    ...(signal.lowDepthUrls || []).map(hostFromTargetValue),
    ...(signal.lowDepthCommentUrls || []).map(hostFromTargetValue),
    ...(signal.targets || []).map(hostFromTargetValue),
    ...(signal.originalSources || []),
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
  ]).slice(0, 12);
  const out = [];
  for (const term of seeds) {
    if (term.length >= 3) out.push(term);
    if (!containsRiskTerm(term)) {
      if (sourceKey === "reddit") out.push(`${term} Reddit`, `${term} comments`);
      else if (sourceKey === "youtube") out.push(`${term} YouTube`, `${term} comments`);
      else if (sourceKey === "bilibili") out.push(`${term} Bilibili`, `${term} 彈幕`);
      else if (sourceKey === "ptt") out.push(`${term} PTT`, `${term} 討論`);
      else if (sourceKey === "dcard") out.push(`${term} Dcard`, `${term} 留言`);
      else if (["threads", "xSearch", "facebookSearch", "linkedinSearch"].includes(sourceKey)) out.push(`${term} 回應`, `${term} 轉傳`);
      else if (["rssFeeds", "googleNews", "bingNews", "baiduNews", "openWebDiscovery", "duckDuckGo"].includes(sourceKey)) out.push(`${term} 後續`, `${term} 評論`);
      else if (sourceKey === "publicReviewSites" || sourceKey === "regionalComplaintSources") out.push(`${term} complaint`, `${term} review`);
    }
    if (out.length >= 14) break;
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 14);
}

function sourceSpecificCollectionOperationsRemediationKeywords(sourceKey, signal = null, baseKeywords = []) {
  if (!signal || Number(signal.priorityBoost || 0) <= 0) return [];
  const seeds = normalizeSentimentMonitorKeywords([
    ...(signal.queryTerms || []),
    ...(signal.compensatedSources || []),
    ...normalizeSentimentMonitorKeywords(baseKeywords).slice(0, 4),
  ]).slice(0, 10);
  const out = [];
  for (const term of seeds) {
    if (term.length >= 3) out.push(term);
    if (!containsRiskTerm(term)) {
      if (sourceKey === "youtube") out.push(`${term} YouTube`);
      else if (sourceKey === "reddit") out.push(`${term} Reddit`);
      else if (sourceKey === "ptt") out.push(`${term} PTT`);
      else if (sourceKey === "dcard") out.push(`${term} Dcard`);
      else if (sourceKey === "legalPublicRecords") out.push(`${term} litigation`);
      else if (sourceKey === "publicProcurementSources") out.push(`${term} procurement`);
      else if (sourceKey === "publicSanctionsSources") out.push(`${term} sanctions`, `${term} financial sanctions`, `${term} UN consolidated list`);
      else if (sourceKey === "publicProductRecallSources") out.push(`${term} product safety`, `${term} vehicle recall`, `${term} defect complaint`);
      else if (sourceKey === "publicEnforcementActionSources") out.push(`${term} regulatory complaint`);
      else if (sourceKey === "publicAdvertisingRulingsSources") out.push(`${term} misleading advertising`);
      else if (sourceKey === "publicRegulatoryWarningLetterSources") out.push(`${term} warning letter`);
      else if (sourceKey === "publicCompanyFilingsSources") out.push(`${term} EDGAR`, `${term} liquidation`);
      else if (sourceKey === "brandImpersonationSources") out.push(`${term} impersonation`);
      else if (sourceKey === "securityAdvisorySources") out.push(`${term} vulnerability`, `${term} security advisory`);
      else if (sourceKey === "supplyChainAdvisorySources") out.push(`${term} package vulnerability`);
      else if (sourceKey === "investorDiscussionSources") out.push(`${term} market sentiment`);
      else if (sourceKey === "publicStatusPageSources") out.push(`${term} service status`, `${term} incident`);
      else if (sourceKey === "officialOwnedMediaSources") out.push(`${term} company statement`, `${term} press release`);
      else if (sourceKey === "publicReviewSites" || sourceKey === "regionalComplaintSources") out.push(`${term} complaint`);
    }
    if (out.length >= 12) break;
  }
  return normalizeSentimentMonitorKeywords(out).slice(0, 12);
}

export function resolveSentimentScanPlan({ mode, keywords, search, events = [], collectionQuality = null, entityTopicRecall = null, reason = "manual" }) {
  const scanMode = normalizeSentimentScanMode(mode);
  const watchMode = (scanMode === SCAN_MODE_WATCH || String(reason || "") === "watch") && search?.highRiskWatch?.enabled !== false;
  const highRiskWatch = search?.highRiskWatch || {};
  const configuredSources = Array.isArray(search?.sources) ? search.sources : [];
  const budget = watchMode
    ? (highRiskWatch.budget || DEFAULT_COLLECTION_BUDGET.fast)
    : scanMode === SCAN_MODE_FULL
    ? (search?.collectionBudget?.full || DEFAULT_COLLECTION_BUDGET.full)
    : (search?.collectionBudget?.fast || DEFAULT_COLLECTION_BUDGET.fast);
  const deepBudget = watchMode
    ? normalizeRunnerDeepBudget(search?.deepCollectionBudget?.watch || {})
    : scanMode === SCAN_MODE_FULL
      ? normalizeRunnerDeepBudget(search?.deepCollectionBudget?.full || {})
      : normalizeRunnerDeepBudget(search?.deepCollectionBudget?.fast || {});
  const incremental = search?.incremental || DEFAULT_INCREMENTAL_SETTINGS;
  const eventExpansion = search?.eventExpansion || {};
  const collectionQualityFeedback = search?.collectionQualityFeedback || {};
  const monitoredEntities = search?.monitoredEntities || {};
  const baseLimit = watchMode
    ? Math.max(1, Math.min(FAST_SCAN_KEYWORD_LIMIT, Number(highRiskWatch.maxKeywords || highRiskWatch.max_keywords || 12) || 12))
    : scanMode === SCAN_MODE_FULL ? SEARCH_KEYWORD_LIMIT : FAST_SCAN_KEYWORD_LIMIT;
  const monitoredEntityKeywords = deriveMonitoredEntityKeywords(monitoredEntities, {
    mode: scanMode,
    baseKeywords: keywords,
  });
  const entityFootprintKeywords = deriveMonitoredEntityFootprintKeywords(monitoredEntities, {
    mode: scanMode,
    baseKeywords: keywords,
  });
  const eventExpansionKeywords = deriveEventExpansionKeywords(events, {
    mode: scanMode,
    settings: eventExpansion,
    baseKeywords: keywords,
  });
  const entityTopicRecallKeywords = deriveEntityTopicRecallKeywords(entityTopicRecall || {}, {
    mode: scanMode,
    baseKeywords: keywords,
  });
  const qualityFeedback = deriveCollectionQualityKeywordFeedback(collectionQuality || {}, {
    mode: scanMode,
    settings: collectionQualityFeedback,
    baseKeywords: keywords,
  });
  const dynamicExpansionCount = eventExpansionKeywords.length + entityTopicRecallKeywords.length;
  const baseKeywordLimit = dynamicExpansionCount
    ? Math.max(1, baseLimit - dynamicExpansionCount)
    : baseLimit;
  const expandedKeywords = expandSentimentSearchKeywords(keywords, baseKeywordLimit, search?.keywordExpansion);
  const entityAwareKeywords = monitoredEntityKeywords.length || entityFootprintKeywords.length
    ? [...normalizeSentimentMonitorKeywords(keywords), ...monitoredEntityKeywords, ...entityFootprintKeywords, ...expandedKeywords]
    : expandedKeywords;
  const mergedKeywords = entityTopicRecallKeywords.length
    ? mergeSearchKeywords(
      [...normalizeSentimentMonitorKeywords(keywords), ...entityTopicRecallKeywords, ...entityAwareKeywords],
      eventExpansionKeywords,
      baseLimit,
    )
    : mergeSearchKeywords(
      entityAwareKeywords,
      eventExpansionKeywords,
      baseLimit,
    );
  const prioritizedKeywords = qualityFeedback.promotedKeywords.length
    ? mergeSearchKeywords(
      [...normalizeSentimentMonitorKeywords(keywords), ...qualityFeedback.promotedKeywords, ...mergedKeywords],
      [],
      baseLimit,
    )
    : mergedKeywords;
  const suppressed = new Set(qualityFeedback.suppressedKeywords);
  const searchKeywords = prioritizedKeywords.filter(keyword => !suppressed.has(keyword));
  const effectiveEventExpansionKeywords = eventExpansionKeywords.filter(keyword => !suppressed.has(keyword));
  const effectivePromotedKeywords = qualityFeedback.promotedKeywords.filter(keyword => searchKeywords.includes(keyword));
  const effectiveSuppressedKeywords = qualityFeedback.suppressedKeywords.filter(keyword => !normalizeSentimentMonitorKeywords(keywords).includes(keyword));
  const qualityFeedbackResult = {
    ...qualityFeedback,
    promotedKeywords: effectivePromotedKeywords,
    suppressedKeywords: effectiveSuppressedKeywords,
  };
  if (watchMode) {
    const watchKeywords = deriveHighRiskWatchKeywords({
      keywords,
      monitoredEntityKeywords,
      entityFootprintKeywords,
      eventExpansionKeywords: effectiveEventExpansionKeywords,
      settings: highRiskWatch,
    });
    const watchSources = (Array.isArray(highRiskWatch.sources) && highRiskWatch.sources.length ? highRiskWatch.sources : configuredSources)
      .filter(source => configuredSources.includes(source));
    return {
      mode: SCAN_MODE_WATCH,
      lane: "high-risk-watch",
      enrich: false,
      sources: watchSources.length ? watchSources : configuredSources,
      budget,
      deepBudget,
      incremental,
      highRiskWatch,
      eventExpansion,
      domainControls: search?.domainControls || {},
      contentControls: search?.contentControls || {},
      collectionQualityFeedback,
      monitoredEntities,
      qualityFeedback: qualityFeedbackResult,
      monitoredEntityKeywords: monitoredEntityKeywords.filter(keyword => watchKeywords.includes(keyword) || watchKeywords.some(item => item.includes(keyword))),
      entityFootprintKeywords: entityFootprintKeywords.filter(keyword => watchKeywords.includes(keyword) || watchKeywords.some(item => item.includes(keyword))),
      entityTopicRecallKeywords: entityTopicRecallKeywords.filter(keyword => watchKeywords.includes(keyword)),
      eventExpansionKeywords: effectiveEventExpansionKeywords.filter(keyword => watchKeywords.includes(keyword)),
      searchKeywords: watchKeywords,
    };
  }
  if (scanMode === SCAN_MODE_FULL) {
    return {
      mode: SCAN_MODE_FULL,
      lane: "full",
      enrich: true,
      sources: configuredSources,
      budget,
      deepBudget,
      incremental,
      highRiskWatch,
      eventExpansion,
      domainControls: search?.domainControls || {},
      contentControls: search?.contentControls || {},
      collectionQualityFeedback,
      monitoredEntities,
      qualityFeedback: qualityFeedbackResult,
      monitoredEntityKeywords: monitoredEntityKeywords.filter(keyword => searchKeywords.includes(keyword)),
      entityFootprintKeywords: entityFootprintKeywords.filter(keyword => searchKeywords.includes(keyword)),
      entityTopicRecallKeywords: entityTopicRecallKeywords.filter(keyword => searchKeywords.includes(keyword)),
      eventExpansionKeywords: effectiveEventExpansionKeywords,
      searchKeywords,
    };
  }

  return {
    mode: SCAN_MODE_FAST,
    lane: "fast",
    enrich: false,
    sources: configuredSources,
    budget,
    deepBudget,
    incremental,
    highRiskWatch,
    eventExpansion,
    domainControls: search?.domainControls || {},
    contentControls: search?.contentControls || {},
    collectionQualityFeedback,
    monitoredEntities,
    qualityFeedback: qualityFeedbackResult,
    monitoredEntityKeywords: monitoredEntityKeywords.filter(keyword => searchKeywords.includes(keyword)),
    entityFootprintKeywords: entityFootprintKeywords.filter(keyword => searchKeywords.includes(keyword)),
    entityTopicRecallKeywords: entityTopicRecallKeywords.filter(keyword => searchKeywords.includes(keyword)),
    eventExpansionKeywords: effectiveEventExpansionKeywords,
    searchKeywords,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.bus - bbyclaw EventBus
 * @param {object} opts.log
 * @param {object|Function} opts.searchSettings
 * @returns {Function} runner 函式
 */
export function createScraperRunner({ bus, log, notificationSettings, searchSettings }) {
  return async function runScraper({ mode = SCAN_MODE_FAST, reason = "manual", sources = null } = {}) {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const db = getDb();
    const keywords = resolveSentimentScanKeywords(db);

    let search = readSentimentSearchSettings(
      typeof searchSettings === "function" ? searchSettings() : searchSettings
    );
    const coverageSearch = search;
    const sourceOverride = [...new Set((Array.isArray(sources) ? sources : [])
      .map(source => String(source || "").trim())
      .filter(Boolean))];
    if (sourceOverride.length) {
      search = readSentimentSearchSettings({ ...search, sources: sourceOverride });
    }
    const tuning = applySentimentSourceQualityTuning({ days: 7, minSamples: 5, minScans: 2 });
    if (tuning.updated.length) {
      log.info(`[CRM/Scraper] 已根據來源品質自動調整：${tuning.updated.map(item => `${item.source_key}:${item.action}`).join(", ")}`);
    }
    const sourceRecords = listSentimentSources();
    const sourceConfigs = new Map(sourceRecords.map(source => [source.source_key, source.config || {}]));
    const sourceRecordByKey = new Map(sourceRecords.map(source => [source.source_key, source]));
    const sourceProfiles = new Map(
      listSentimentSourceQualityProfiles({ days: 7, limit: 200 }).map(profile => [profile.source_key, profile])
    );
    const sourceCoverageSignals = deriveCoverageSourceSignals(listSentimentSourceCoverageScores({ days: 7, limit: 300 }));
    const qualityFeedbackSettings = search?.collectionQualityFeedback || {};
    const collectionQuality = qualityFeedbackSettings.enabled === false
      ? { sources: [], keywords: [], authors: [] }
      : listSentimentCollectionContributionScores({
        days: qualityFeedbackSettings.days || 14,
        limit: 100,
      });
    const collectionQualitySources = new Map((collectionQuality.sources || []).map(source => [source.key, source]));
    const noiseSuppressionSourceSignals = deriveNoiseSuppressionSourceSignals(listSentimentNoiseSuppressionReport({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
      minSamples: 2,
    }));
    const deepHealthSignals = deriveDeepCollectionHealthSignals(listSentimentDeepCollectionHealthProfiles({
      days: qualityFeedbackSettings.days || 14,
      limit: 200,
    }));
    const eventExpansionLimit = search?.eventExpansion?.recentEventLimit || search?.eventExpansion?.recent_event_limit || 12;
    const expansionEvents = search?.eventExpansion?.enabled === false
      ? []
      : listSentimentEvents({ limit: Math.max(1, Math.min(50, Number(eventExpansionLimit) || 12)) });
    const entityTopicRecall = search?.monitoredEntities?.enabled === false
      ? { topics: [] }
      : listSentimentEntityTopicRecallGaps({
        search,
        days: qualityFeedbackSettings.days || 14,
        limit: 100,
      });
    const entityTopicTrend = search?.monitoredEntities?.enabled === false
      ? { topics: [] }
      : listSentimentEntityTopicRecallTrend({
        search,
        days: Math.max(30, Number(qualityFeedbackSettings.days || 14) || 14),
        bucketDays: 7,
        limit: 100,
      });
    const entityTopicSourceRecall = search?.monitoredEntities?.enabled === false
      ? { sources: [] }
      : listSentimentEntityTopicSourceRecallGaps({
        search,
        days: qualityFeedbackSettings.days || 14,
        limit: 300,
      });
    const entityTopicScanRecall = mergeEntityTopicRecallSignals(entityTopicRecall, entityTopicTrend);
    const entityTopicSourceSignals = mergeEntityTopicSourceRecallSignals(
      deriveEntityTopicSourceSignals(entityTopicScanRecall),
      entityTopicSourceRecall,
    );
    const keywordFamilyCoverageReport = listSentimentKeywordSourceFamilyCoverage({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
      minTotal: 1,
      search: coverageSearch,
    });
    const keywordFamilyCoverageSignals = deriveKeywordSourceFamilyCoverageSignals(keywordFamilyCoverageReport);
    const plan = resolveSentimentScanPlan({ mode, keywords, search, events: expansionEvents, collectionQuality, entityTopicRecall: entityTopicScanRecall, reason });
    const searchKeywords = plan.searchKeywords;
    const proxyUrl = search.proxyEnabled ? search.proxyUrl : "";
    const trackingSourceSignals = search?.eventExpansion?.enabled === false
      ? {}
      : deriveTrackingSourceSignals(buildSentimentSpreadGraph({ limit: Math.max(10, Math.min(100, Number(eventExpansionLimit) * 2 || 24)) }).nodes);
    const propagationConfidenceSourceSignals = search?.eventExpansion?.enabled === false
      ? {}
      : derivePropagationConfidenceSourceSignals(buildSentimentSpreadGraph({ limit: Math.max(10, Math.min(100, Number(eventExpansionLimit) * 2 || 24)) }).nodes);
    const alertEventSourceSignals = deriveAlertEventUrgencySourceSignals({
      alerts: listSentimentAlerts({ status: "open", limit: 50 }),
      events: listSentimentEvents({ status: "open", limit: 50 }),
    });
    const anomalySourceSignals = deriveAnomalyBurstSourceSignals(listSentimentAnomalies({ status: "open", limit: 50 }));
    const realtimeAnomalyWindowSourceSignals = deriveRealtimeAnomalyWindowSourceSignals(listSentimentRealtimeAnomalyWindows({
      windows: [0.083, 0.25, 1, 6, 24],
      limit: 80,
      minScore: 35,
    }));
    const realtimeHotTopicSourceSignals = deriveRealtimeHotTopicSourceSignals(listSentimentRealtimeHotTopics({
      lookbackHours: 6,
      limit: 50,
    }));
    const realtimeCoverageReport = getSentimentRealtimeSourceCoverageReport({
      lookbackHours: 6,
      limit: 80,
      minScore: 38,
      searchSettings: coverageSearch,
    });
    const realtimeSourceCoverageSignals = deriveRealtimeSourceCoverageSignals(realtimeCoverageReport);
    const officialRegulatoryFollowupSourceSignals = deriveOfficialRegulatoryFollowupSourceSignals({ days: 14, limit: 120 });
    const evidenceGapSourceSignals = deriveEvidenceCompletenessSourceSignals(listCrisisBriefs({ limit: 20 }));
    const evidenceDepthSourceSignals = deriveEvidenceDepthSourceSignals(listSentimentEvidenceDepthReport({ days: 14, limit: 200 }));
    const evidenceCoverageRecoverySourceSignals = deriveEvidenceCoverageRecoverySourceSignals(getSentimentEvidenceCoverageFollowupRecoveryReport({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
    }));
    const taiwanPrioritySiteHealthReport = getSentimentTaiwanMediaSourceHealthReport({
      configuredPacks: listPublicRssFeedPacks(),
      limit: 100,
    });
    const taiwanPrioritySiteHealthSourceSignals = deriveTaiwanPrioritySiteHealthSourceSignals(taiwanPrioritySiteHealthReport);
    const evidenceChainGapSourceSignals = deriveEvidenceChainGapSourceSignals(listSentimentEvidenceChainGapReport({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
      minGapScore: 20,
    }));
    const socialFollowupSourceSignals = deriveSocialFollowupSourceSignals(listSentimentSocialFollowupSignals({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
      minScore: 25,
    }));
    const eventClusterSourceSignals = deriveEventClusterSourceSignals(getSentimentEventClusterAnalysisReport({ limit: 100 }));
    const accessBarrierAlternateSourceSignals = deriveAccessBarrierAlternateSourceSignals(listAccessBarrierAlternateRecoveryEffectiveness({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
    }));
    const evidenceCoverageRoutedAlternateSourceSignals = deriveEvidenceCoverageRoutedAlternateSourceSignals(getSentimentEvidenceCoverageRoutedAlternateEffectivenessReport({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
    }));
    const collectionOperationsRemediationSourceSignals = deriveCollectionOperationsRemediationSourceSignals(listSentimentCollectionOperationsRemediationEffectiveness({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
    }));
    const multilingualQuerySourceSignals = deriveMultilingualQuerySourceSignals(listSentimentMultilingualQueryQuality({
      days: qualityFeedbackSettings.days || 14,
      limit: 100,
      minSamples: 1,
    }));
    const freeSourceTargetCoverageSignals = deriveFreeSourceTargetCoverageSignals(getSentimentFreeSourceTargetCoverageReport({
      searchSettings: search,
      limit: 100,
    }));
    const commercialSourceSignals = deriveCommercialReadinessSourceSignals(getSentimentCommercialRemediationPlan({
      days: plan.qualityFeedback?.days || 14,
      limit: 100,
    }));
    const credibilitySourceSignals = deriveCredibilitySourceSignals(getSentimentSourceCredibilityReport({ days: 30, limit: 300 }));
    const sourceBudgets = new Map();
    const sourceBudget = (key) => resolveSourceCollectionBudget(key, plan.budget, {
      mode: plan.mode,
      keywords: searchKeywords,
      profile: sourceProfiles.get(key),
      source: sourceRecordByKey.get(key),
      trackingSignal: trackingSourceSignals[key],
      contributionSignal: collectionQualitySources.get(key),
      coverageSignal: sourceCoverageSignals[key],
      credibilitySignal: credibilitySourceSignals[key],
      propagationConfidenceSignal: propagationConfidenceSourceSignals[key],
      alertEventSignal: alertEventSourceSignals[key],
      officialRegulatoryFollowupSignal: officialRegulatoryFollowupSourceSignals[key],
      deepHealthSignal: deepHealthSignals[key],
      entityTopicSignal: entityTopicSourceSignals[key],
      keywordFamilyCoverageSignal: keywordFamilyCoverageSignals[key],
      realtimeHotTopicSignal: realtimeHotTopicSourceSignals[key],
      realtimeAnomalyWindowSignal: realtimeAnomalyWindowSourceSignals[key],
      realtimeSourceCoverageSignal: realtimeSourceCoverageSignals[key],
      anomalySignal: anomalySourceSignals[key],
      evidenceDepthSignal: evidenceDepthSourceSignals[key],
      evidenceChainGapSignal: evidenceChainGapSourceSignals[key],
      socialFollowupSignal: socialFollowupSourceSignals[key],
      eventClusterSignal: eventClusterSourceSignals[key],
      accessBarrierAlternateSignal: accessBarrierAlternateSourceSignals[key],
      evidenceCoverageRoutedAlternateSignal: evidenceCoverageRoutedAlternateSourceSignals[key],
      collectionOperationsRemediationSignal: collectionOperationsRemediationSourceSignals[key],
      multilingualQuerySignal: multilingualQuerySourceSignals[key],
      freeSourceTargetCoverageSignal: freeSourceTargetCoverageSignals[key],
      noiseSuppressionSignal: noiseSuppressionSourceSignals[key],
    });
    const budgetForSource = (key) => {
      if (!sourceBudgets.has(key)) sourceBudgets.set(key, sourceBudget(key));
      return sourceBudgets.get(key);
    };
    const sourceDeepBudgets = new Map();
    const sourceDeepBudget = (key) => resolveSourceDeepCollectionBudget(key, plan.deepBudget, {
      mode: plan.mode,
      lane: plan.lane,
      keywords: searchKeywords,
      profile: sourceProfiles.get(key),
      source: sourceRecordByKey.get(key),
      trackingSignal: trackingSourceSignals[key],
      contributionSignal: collectionQualitySources.get(key),
      coverageSignal: sourceCoverageSignals[key],
      credibilitySignal: credibilitySourceSignals[key],
      propagationConfidenceSignal: propagationConfidenceSourceSignals[key],
      alertEventSignal: alertEventSourceSignals[key],
      officialRegulatoryFollowupSignal: officialRegulatoryFollowupSourceSignals[key],
      deepHealthSignal: deepHealthSignals[key],
      entityTopicSignal: entityTopicSourceSignals[key],
        keywordFamilyCoverageSignal: keywordFamilyCoverageSignals[key],
        realtimeHotTopicSignal: realtimeHotTopicSourceSignals[key],
        realtimeAnomalyWindowSignal: realtimeAnomalyWindowSourceSignals[key],
        realtimeSourceCoverageSignal: realtimeSourceCoverageSignals[key],
        anomalySignal: anomalySourceSignals[key],
      evidenceGapSignal: evidenceGapSourceSignals[key],
      evidenceDepthSignal: evidenceDepthSourceSignals[key],
      evidenceChainGapSignal: evidenceChainGapSourceSignals[key],
      socialFollowupSignal: socialFollowupSourceSignals[key],
      eventClusterSignal: eventClusterSourceSignals[key],
      accessBarrierAlternateSignal: accessBarrierAlternateSourceSignals[key],
      evidenceCoverageRoutedAlternateSignal: evidenceCoverageRoutedAlternateSourceSignals[key],
      collectionOperationsRemediationSignal: collectionOperationsRemediationSourceSignals[key],
        multilingualQuerySignal: multilingualQuerySourceSignals[key],
        freeSourceTargetCoverageSignal: freeSourceTargetCoverageSignals[key],
        noiseSuppressionSignal: noiseSuppressionSourceSignals[key],
      });
    const deepBudgetForSource = (key) => {
      if (!sourceDeepBudgets.has(key)) sourceDeepBudgets.set(key, sourceDeepBudget(key));
      return sourceDeepBudgets.get(key);
    };
    const sourceRecoveryActions = new Map();
    const sourceFailoverPlans = new Map();
    const sourceFailoverReceived = new Map();
    const postRunFailoverPlans = new Map();
    const sourceKeywordQualityFeedbacks = new Map();
    const recoveryActionForSource = (key, context = {}) => {
      const action = deriveSourceRecoveryAction(key, {
        ...context,
        coverageSignal: sourceCoverageSignals[key] || null,
        credibilitySignal: credibilitySourceSignals[key] || null,
        qualityFeedback: collectionQualitySources.get(key) || null,
        budget: budgetForSource(key),
      });
      const configuredStrategy = sourceRecordByKey.get(key)?.config?.queryStrategy || sourceRecordByKey.get(key)?.config?.query_strategy;
      const normalizedStrategy = ["normal", "minimal", "thin-risk-first", "require-entity-and-risk-term", "expand-pages", "none"].includes(String(configuredStrategy || ""))
        ? String(configuredStrategy)
        : "";
      const nextAction = normalizedStrategy ? { ...action, queryStrategy: normalizedStrategy, configuredQueryStrategy: true } : action;
      sourceRecoveryActions.set(key, nextAction);
      return nextAction;
    };
    const sourceKeywordPlans = new Map();
    const sourceKeywordQualityFeedbackForSource = (key) => {
      if (!sourceKeywordQualityFeedbacks.has(key)) {
        sourceKeywordQualityFeedbacks.set(key, deriveCollectionQualitySourceKeywordFeedback(collectionQuality, key, {
          mode: plan.mode,
          settings: qualityFeedbackSettings,
          baseKeywords: keywords,
        }));
      }
      return sourceKeywordQualityFeedbacks.get(key);
    };
    const keywordsForSource = (key, recoveryActionOverride = null) => {
      const recoveryAction = recoveryActionOverride || sourceRecoveryActions.get(key) || recoveryActionForSource(key);
      const limit = key === "gdelt" && plan.mode === SCAN_MODE_FAST ? GDELT_FAST_KEYWORD_LIMIT : null;
      const sourceKeywordQualityFeedback = sourceKeywordQualityFeedbackForSource(key);
      const topicKeywords = sourceSpecificTopicKeywords(key, entityTopicSourceSignals[key]);
      const keywordFamilyCoverageKeywords = sourceSpecificKeywordFamilyCoverageKeywords(key, keywordFamilyCoverageSignals[key], keywords);
      const alertEventKeywords = sourceSpecificAlertEventKeywords(key, alertEventSourceSignals[key], keywords);
      const realtimeHotTopicKeywords = sourceSpecificRealtimeHotTopicKeywords(key, realtimeHotTopicSourceSignals[key], keywords);
      const realtimeAnomalyWindowKeywords = sourceSpecificRealtimeAnomalyWindowKeywords(key, realtimeAnomalyWindowSourceSignals[key], keywords);
      const realtimeSourceCoverageKeywords = normalizeSentimentMonitorKeywords(realtimeSourceCoverageSignals[key]?.suggestedKeywords || []).slice(0, 12);
      const anomalyKeywords = sourceSpecificAnomalyKeywords(key, anomalySourceSignals[key], keywords);
      const evidenceGapKeywords = sourceSpecificEvidenceGapKeywords(key, evidenceGapSourceSignals[key], keywords);
      const evidenceDepthKeywords = sourceSpecificEvidenceDepthKeywords(key, evidenceDepthSourceSignals[key], keywords);
      const evidenceCoverageRecoveryKeywords = sourceSpecificEvidenceCoverageRecoveryKeywords(key, evidenceCoverageRecoverySourceSignals[key], keywords);
      const taiwanPrioritySiteHealthKeywords = sourceSpecificTaiwanPrioritySiteHealthKeywords(key, taiwanPrioritySiteHealthSourceSignals[key], keywords);
      const evidenceChainKeywords = normalizeSentimentMonitorKeywords(evidenceChainGapSourceSignals[key]?.suggestedKeywords || []).slice(0, 12);
      const officialRegulatoryFollowupKeywords = sourceSpecificOfficialRegulatoryFollowupKeywords(key, officialRegulatoryFollowupSourceSignals[key], keywords);
      const propagationConfidenceKeywords = sourceSpecificPropagationConfidenceKeywords(key, propagationConfidenceSourceSignals[key], keywords);
      const eventClusterKeywords = sourceSpecificEventClusterKeywords(key, eventClusterSourceSignals[key], keywords);
      const socialFollowupKeywords = sourceSpecificSocialFollowupKeywords(key, socialFollowupSourceSignals[key], keywords);
      const accessBarrierAlternateKeywords = sourceSpecificAccessBarrierAlternateKeywords(key, accessBarrierAlternateSourceSignals[key], keywords);
      const evidenceCoverageRoutedAlternateKeywords = sourceSpecificEvidenceCoverageRoutedAlternateKeywords(key, evidenceCoverageRoutedAlternateSourceSignals[key], keywords);
      const collectionOperationsRemediationKeywords = sourceSpecificCollectionOperationsRemediationKeywords(key, collectionOperationsRemediationSourceSignals[key], keywords);
      const multilingualQueryKeywords = normalizeSentimentMonitorKeywords(multilingualQuerySourceSignals[key]?.suggestedKeywords || []).slice(0, 12);
      const sourceLocaleRiskKeywords = sourceSpecificLocaleRiskKeywords(key, keywords, search?.keywordExpansion || {}, { mode: plan.mode });
      const freeSourceTargetCoverageKeywords = sourceSpecificFreeSourceTargetCoverageKeywords(key, freeSourceTargetCoverageSignals[key], keywords);
      const configuredTargetKeywords = sourceSpecificConfiguredTargetKeywords(key, sourceConfigs.get(key), keywords);
      const entitySourceKeywords = deriveMonitoredEntitySourceKeywords(plan.monitoredEntities, {
        mode: plan.mode,
        sourceKey: key,
        baseKeywords: keywords,
        keywordExpansion: search?.keywordExpansion || {},
      });
      const entityFootprintKeywords = deriveMonitoredEntityFootprintKeywords(plan.monitoredEntities, {
        mode: plan.mode,
        sourceKey: key,
        baseKeywords: keywords,
      });
      const discoveryProfileKeywords = sourceSpecificDiscoveryProfileKeywords(key, sourceConfigs.get(key), keywords);
      const commercialKeywords = normalizeSentimentMonitorKeywords(commercialSourceSignals[key]?.suggestedKeywords || []).slice(0, 12);
      const baseSourceKeywords = applySourceQueryStrategy([...topicKeywords, ...searchKeywords], {
        strategy: recoveryAction.queryStrategy,
        baseKeywords: keywords,
        mode: plan.mode,
        limit,
      });
      const feedbackKeywords = normalizeSentimentMonitorKeywords([...sourceKeywordQualityFeedback.promotedKeywords, ...alertEventKeywords, ...realtimeAnomalyWindowKeywords, ...realtimeHotTopicKeywords, ...realtimeSourceCoverageKeywords, ...anomalyKeywords, ...officialRegulatoryFollowupKeywords, ...evidenceGapKeywords, ...evidenceDepthKeywords, ...evidenceCoverageRecoveryKeywords, ...taiwanPrioritySiteHealthKeywords, ...evidenceChainKeywords, ...propagationConfidenceKeywords, ...eventClusterKeywords, ...socialFollowupKeywords, ...accessBarrierAlternateKeywords, ...evidenceCoverageRoutedAlternateKeywords, ...collectionOperationsRemediationKeywords, ...multilingualQueryKeywords, ...sourceLocaleRiskKeywords, ...configuredTargetKeywords, ...freeSourceTargetCoverageKeywords, ...keywordFamilyCoverageKeywords, ...commercialKeywords]);
      const feedbackSourceKeywords = feedbackKeywords.length
        ? applySourceQueryStrategy([...feedbackKeywords, ...baseSourceKeywords], {
          strategy: recoveryAction.queryStrategy,
          baseKeywords: keywords,
          mode: plan.mode,
          limit,
        })
        : baseSourceKeywords;
      const failoverKeywords = (sourceFailoverReceived.get(key) || []).flatMap(item => item.keywords || []);
      const suppressedForSource = normalizeSentimentMonitorKeywords([
        ...(sourceKeywordQualityFeedback.suppressedKeywords || []),
        ...(multilingualQuerySourceSignals[key]?.suppressedKeywords || []),
        ...(noiseSuppressionSourceSignals[key]?.suppressedKeywords || []),
      ]);
      const precisionBaseKeywords = ENTITY_PRECISION_SOURCE_KEYS.has(key) && entityPrecisionTerms.length
        ? normalizeSentimentMonitorKeywords(keywords).slice(0, plan.mode === SCAN_MODE_FULL ? 6 : 3)
        : [];
      const feedbackHeadLimit = plan.mode === SCAN_MODE_FULL ? 18 : 12;
      const feedbackHeadKeywords = feedbackSourceKeywords.slice(0, feedbackHeadLimit);
      const feedbackTailKeywords = feedbackSourceKeywords.slice(feedbackHeadLimit);
      const sourceKeywords = normalizeSentimentMonitorKeywords([
        ...discoveryProfileKeywords,
        ...failoverKeywords,
        ...anomalyKeywords,
        ...eventClusterKeywords,
        ...feedbackHeadKeywords,
        ...precisionBaseKeywords,
        ...entitySourceKeywords,
        ...entityFootprintKeywords,
        ...feedbackTailKeywords,
      ])
        .filter(keyword => !suppressedForSource.some(suppressedKeyword => keyword === suppressedKeyword || keyword.endsWith(` ${suppressedKeyword}`)))
        .slice(0, limit || SEARCH_KEYWORD_LIMIT);
      sourceKeywordPlans.set(key, sourceKeywords);
      return sourceKeywords;
    };
    const failoverAttributionForSource = (key) => sourceFailoverReceived.get(key) || [];
    const rssFeedPackDiagnosticsForSource = (key) => {
      if (key !== "rssFeeds") return {};
      const packs = rssFeedPacksForScanMode(search, plan.mode, sourceConfigs.get("rssFeeds") || {});
      return {
        rssFeedPacks: packs,
        rssFeedPackCount: packs.length,
        rssFeedPackMode: plan.mode,
      };
    };
    const metadataForSource = (key, context = {}) => {
      const recoveryAction = recoveryActionForSource(key, context);
      return {
        budget: budgetForSource(key),
        deepBudget: deepBudgetForSource(key),
        mode: plan.mode,
        ...rssFeedPackDiagnosticsForSource(key),
        sourceKeywords: keywordsForSource(key, recoveryAction),
        contentControls: sourceContentControls(key),
        failoverReceived: failoverAttributionForSource(key),
        trackingSignal: trackingSourceSignals[key] || null,
        alertEventSignal: alertEventSourceSignals[key] || null,
        realtimeHotTopicSignal: realtimeHotTopicSourceSignals[key] || null,
        realtimeAnomalyWindowSignal: realtimeAnomalyWindowSourceSignals[key] || null,
        realtimeSourceCoverageSignal: realtimeSourceCoverageSignals[key] || null,
        anomalySignal: anomalySourceSignals[key] || null,
        officialRegulatoryFollowupSignal: officialRegulatoryFollowupSourceSignals[key] || null,
        evidenceGapSignal: evidenceGapSourceSignals[key] || null,
        evidenceDepthSignal: evidenceDepthSourceSignals[key] || null,
        evidenceCoverageRecoverySignal: evidenceCoverageRecoverySourceSignals[key] || null,
        taiwanPrioritySiteHealthSignal: taiwanPrioritySiteHealthSourceSignals[key] || null,
        evidenceChainGapSignal: evidenceChainGapSourceSignals[key] || null,
        socialFollowupSignal: socialFollowupSourceSignals[key] || null,
        multilingualQuerySignal: multilingualQuerySourceSignals[key] || null,
        freeSourceTargetCoverageSignal: freeSourceTargetCoverageSignals[key] || null,
        accessBarrierAlternateSignal: accessBarrierAlternateSourceSignals[key] || null,
        evidenceCoverageRoutedAlternateSignal: evidenceCoverageRoutedAlternateSourceSignals[key] || null,
        collectionOperationsRemediationSignal: collectionOperationsRemediationSourceSignals[key] || null,
        propagationConfidenceSignal: propagationConfidenceSourceSignals[key] || null,
        eventClusterSignal: eventClusterSourceSignals[key] || null,
        eventClusterFollowupTargets: eventClusterFollowupTargetsForSource(key, eventClusterSourceSignals[key]),
        openWebDiscoveryTargets: key === "openWebDiscovery"
          ? openWebDiscoveryTargetsForSource(openWebDiscoveryConfig, eventClusterSourceSignals[key], keywordFamilyCoverageReport, realtimeCoverageReport).slice(0, 32)
          : [],
        commercialSignal: commercialSourceSignals[key] || null,
        credibilitySignal: credibilitySourceSignals[key] || null,
        qualityFeedback: collectionQualitySources.get(key) || null,
        sourceKeywordQualityFeedback: sourceKeywordQualityFeedbackForSource(key),
        noiseSuppressionSignal: noiseSuppressionSourceSignals[key] || null,
        coverageSignal: sourceCoverageSignals[key] || null,
        deepHealthSignal: deepHealthSignals[key] || null,
        entityTopicSignal: entityTopicSourceSignals[key] || null,
        keywordFamilyCoverageSignal: keywordFamilyCoverageSignals[key] || null,
        throttleState: throttleSnapshotForSource(key, sourceRecordByKey.get(key), Date.now()),
        recoveryAction,
      };
    };
    const selected = new Set(plan.sources);
    const browserFallbackSourceConfig = sourceConfigs.get("browserFallback") || {};
    const browserFallbackScanSettings = browserFallbackSettingsForScan(
      search,
      [...selected],
      browserFallbackSourceConfig,
    );
    const browserFallbackEnabled = browserFallbackAutoEnabled(
      search,
      sourceRecordByKey.get("browserFallback"),
      [...selected],
      browserFallbackSourceConfig,
    );
    const isImplicitAlternateSource = (sourceKey = "") => String(sourceKey || "") === "browserFallback" && browserFallbackEnabled;
    const addSourceFailoverPlan = (fromSource, recoveryAction, context = {}) => {
      const alternateSources = Array.isArray(recoveryAction?.alternateSources) ? recoveryAction.alternateSources : [];
      if (!alternateSources.length) return null;
      const sourceKeywords = applySourceQueryStrategy(searchKeywords, {
        strategy: recoveryAction.queryStrategy || "thin-risk-first",
        baseKeywords: keywords,
        mode: plan.mode,
        limit: plan.mode === SCAN_MODE_FULL ? 10 : 5,
      });
      if (!sourceKeywords.length) return null;
      const planItem = {
        fromSource,
        status: context.status || "",
        reason: recoveryAction.reason || context.message || "",
        keywords: sourceKeywords,
        alternateSources,
        routedTo: [],
      };
      sourceFailoverPlans.set(fromSource, planItem);
      for (const target of alternateSources) {
        const targetRecord = sourceRecordByKey.get(target);
        if (!targetRecord || targetRecord.enabled === false || (!selected.has(target) && !isImplicitAlternateSource(target))) continue;
        if (isImplicitAlternateSource(target) && context.status === "empty") continue;
        if (isImplicitAlternateSource(target) && context.implicitAlternateAllowed === false) continue;
        if (activeSourceCooldown(target, now)) continue;
        if (!context.allowThrottledTargets && activeDomainThrottle(throttlePolicyForSource(target, targetRecord), now)) continue;
        const interval = reason === "schedule" ? sourceIntervalCooldown(targetRecord, now) : null;
        if (interval) continue;
        const received = sourceFailoverReceived.get(target) || [];
        received.push({ fromSource, reason: planItem.reason, keywords: sourceKeywords });
        sourceFailoverReceived.set(target, received);
        planItem.routedTo.push(target);
      }
      return planItem;
    };
    const addPostRunFailoverPlan = (fromSource, recoveryAction, context = {}) => {
      const planItem = addSourceFailoverPlan(fromSource, recoveryAction, { ...context, allowThrottledTargets: true });
      if (planItem) postRunFailoverPlans.set(fromSource, planItem);
      return planItem;
    };
    const sourceSince = (key) => sourceIncrementalSince(sourceRecordByKey.get(key), { reason, incremental: plan.incremental });
    const sourceIncrementalCursor = (key) => sourceRecordByKey.get(key)?.config?.incrementalCursor
      || sourceRecordByKey.get(key)?.config?.incremental_cursor
      || {};
    const sourceDomainControls = (key) => mergeDomainControls(
      plan.domainControls,
      sourceConfigs.get(key)?.domainControls || sourceConfigs.get(key)?.domain_controls,
    );
    const entityPrecisionTerms = monitoredEntityPrecisionTerms(plan.monitoredEntities);
    const sourceEntityPrecisionControls = (key) => {
      const configured = sourceConfigs.get(key)?.entityPrecision || sourceConfigs.get(key)?.entity_precision || {};
      const enabled = configured.enabled ?? configured.requireEntityTerms ?? configured.require_entity_terms;
      if (enabled === false) return {};
      if (enabled === true || (ENTITY_PRECISION_SOURCE_KEYS.has(key) && entityPrecisionTerms.length)) {
        return {
          requireEntityTerms: true,
          entityTerms: [
            ...entityPrecisionTerms,
            ...normalizeSentimentMonitorKeywords(configured.entityTerms || configured.entity_terms || []),
          ],
        };
      }
      return {};
    };
    const mergeContentControls = (...controls) => {
      const normalized = controls.map(control => normalizeSentimentContentControls(control || {}));
      return normalizeSentimentContentControls({
        requireAnyTerms: [...new Set(normalized.flatMap(control => control.requireAnyTerms || []))],
        requireEntityTerms: normalized.some(control => control.requireEntityTerms === true),
        entityTerms: [...new Set(normalized.flatMap(control => control.entityTerms || []))],
        excludeTerms: [...new Set(normalized.flatMap(control => control.excludeTerms || []))],
        entityContextTerms: [...new Set(normalized.flatMap(control => control.entityContextTerms || []))],
        ambiguousTerms: [...new Set(normalized.flatMap(control => control.ambiguousTerms || []))],
        excludeEntityContexts: [...new Set(normalized.flatMap(control => control.excludeEntityContexts || []))],
        minRelevanceScore: Math.max(...normalized.map(control => Number(control.minRelevanceScore || 0))),
        minQualityScore: Math.max(...normalized.map(control => Number(control.minQualityScore || 0))),
      });
    };
    const sourceContentControls = (key) => mergeContentControls(
      plan.contentControls,
      sourceEntityPrecisionControls(key),
      sourceConfigs.get(key)?.contentControls || sourceConfigs.get(key)?.content_controls,
      sourceRecoveryActions.get(key)?.contentControls || recoveryActionForSource(key).contentControls,
    );
    const openWebDiscoveryConfig = mergeOpenWebDiscoveryConfigs(
      sourceConfigs.get("openWebDiscovery") || {},
      sourceConfigs.get("duckDuckGo") || {},
    );
    const sourceOptions = [
      { key: "taiwanNews", label: "台灣新聞 RSS", run: () => scrapeTaiwanNewsFeeds(keywordsForSource("taiwanNews"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("taiwanNews"), deepBudget: deepBudgetForSource("taiwanNews"), since: sourceSince("taiwanNews"), domainControls: sourceDomainControls("taiwanNews"), contentControls: sourceContentControls("taiwanNews"), failoverAttribution: failoverAttributionForSource("taiwanNews") }) },
      { key: "yahooTaiwan", label: "Yahoo奇摩搜尋", run: () => scrapeYahooTaiwan(keywordsForSource("yahooTaiwan"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("yahooTaiwan"), deepBudget: deepBudgetForSource("yahooTaiwan"), domainControls: sourceDomainControls("yahooTaiwan"), contentControls: sourceContentControls("yahooTaiwan") }) },
      { key: "yahooJapanNews", label: "Yahoo Japan 公開新聞搜索", run: () => scrapeYahooJapanNews(keywordsForSource("yahooJapanNews"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("yahooJapanNews"), deepBudget: deepBudgetForSource("yahooJapanNews"), since: sourceSince("yahooJapanNews"), domainControls: sourceDomainControls("yahooJapanNews"), contentControls: sourceContentControls("yahooJapanNews") }) },
      { key: "naverKoreaNews", label: "Naver 韓國公開新聞搜索", run: () => scrapeNaverKoreaNews(keywordsForSource("naverKoreaNews"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("naverKoreaNews"), deepBudget: deepBudgetForSource("naverKoreaNews"), since: sourceSince("naverKoreaNews"), domainControls: sourceDomainControls("naverKoreaNews"), contentControls: sourceContentControls("naverKoreaNews") }) },
      { key: "daumKoreaNews", label: "Daum/Kakao 韓國公開新聞搜索", run: () => scrapeDaumKoreaNews(keywordsForSource("daumKoreaNews"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("daumKoreaNews"), deepBudget: deepBudgetForSource("daumKoreaNews"), since: sourceSince("daumKoreaNews"), domainControls: sourceDomainControls("daumKoreaNews"), contentControls: sourceContentControls("daumKoreaNews") }) },
      { key: "baiduSearch", label: "百度公開搜索", run: () => scrapeBaiduSearch(keywordsForSource("baiduSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("baiduSearch"), deepBudget: deepBudgetForSource("baiduSearch"), since: sourceSince("baiduSearch"), domainControls: sourceDomainControls("baiduSearch"), contentControls: sourceContentControls("baiduSearch") }) },
      { key: "baiduNews", label: "百度新聞搜索", run: () => scrapeBaiduNews(keywordsForSource("baiduNews"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("baiduNews"), deepBudget: deepBudgetForSource("baiduNews"), since: sourceSince("baiduNews"), domainControls: sourceDomainControls("baiduNews"), contentControls: sourceContentControls("baiduNews") }) },
      { key: "sogouSearch", label: "搜狗公開搜索", run: () => scrapeSogouSearch(keywordsForSource("sogouSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("sogouSearch"), deepBudget: deepBudgetForSource("sogouSearch"), since: sourceSince("sogouSearch"), domainControls: sourceDomainControls("sogouSearch"), contentControls: sourceContentControls("sogouSearch") }) },
      { key: "soSearch", label: "360公開搜索", run: () => scrapeSoSearch(keywordsForSource("soSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("soSearch"), deepBudget: deepBudgetForSource("soSearch"), since: sourceSince("soSearch"), domainControls: sourceDomainControls("soSearch"), contentControls: sourceContentControls("soSearch") }) },
      { key: "wechatPublicSearch", label: "微信公開文章搜索", run: () => scrapeWechatPublicSearch(keywordsForSource("wechatPublicSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("wechatPublicSearch"), deepBudget: deepBudgetForSource("wechatPublicSearch"), since: sourceSince("wechatPublicSearch"), domainControls: sourceDomainControls("wechatPublicSearch"), contentControls: sourceContentControls("wechatPublicSearch") }) },
      { key: "toutiaoSearch", label: "今日頭條公開文章搜索", run: () => scrapeToutiaoSearch(keywordsForSource("toutiaoSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("toutiaoSearch"), deepBudget: deepBudgetForSource("toutiaoSearch"), since: sourceSince("toutiaoSearch"), domainControls: sourceDomainControls("toutiaoSearch"), contentControls: sourceContentControls("toutiaoSearch") }) },
      { key: "googleNews", label: "Google News 台灣", run: () => scrapeGoogleNews(keywordsForSource("googleNews"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("googleNews"), deepBudget: deepBudgetForSource("googleNews"), since: sourceSince("googleNews"), newsEngines: sourceConfigs.get("googleNews")?.newsEngines || sourceConfigs.get("googleNews")?.news_engines || undefined, newsMarkets: sourceConfigs.get("googleNews")?.newsMarkets || sourceConfigs.get("googleNews")?.news_markets || undefined, domainControls: sourceDomainControls("googleNews"), contentControls: sourceContentControls("googleNews"), failoverAttribution: failoverAttributionForSource("googleNews") }) },
      { key: "bingNews", label: "Bing News RSS", run: () => scrapeBingNews(keywordsForSource("bingNews"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("bingNews"), deepBudget: deepBudgetForSource("bingNews"), since: sourceSince("bingNews"), newsEngines: sourceConfigs.get("bingNews")?.newsEngines || sourceConfigs.get("bingNews")?.news_engines || undefined, newsMarkets: sourceConfigs.get("bingNews")?.newsMarkets || sourceConfigs.get("bingNews")?.news_markets || undefined, domainControls: sourceDomainControls("bingNews"), contentControls: sourceContentControls("bingNews"), failoverAttribution: failoverAttributionForSource("bingNews") }) },
      { key: "duckDuckGo", label: "DuckDuckGo", run: () => scrapeDuckDuckGo(keywordsForSource("duckDuckGo"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("duckDuckGo"), deepBudget: deepBudgetForSource("duckDuckGo"), searchEngines: sourceConfigs.get("duckDuckGo")?.searchEngines || sourceConfigs.get("duckDuckGo")?.search_engines || undefined, publicSearchProfiles: sourceConfigs.get("duckDuckGo")?.publicSearchProfiles || sourceConfigs.get("duckDuckGo")?.public_search_profiles || sourceConfigs.get("duckDuckGo")?.searchProfiles || sourceConfigs.get("duckDuckGo")?.search_profiles || undefined, domainControls: sourceDomainControls("duckDuckGo"), contentControls: sourceContentControls("duckDuckGo"), failoverAttribution: failoverAttributionForSource("duckDuckGo") }) },
      { key: "yandexSearch", label: "Yandex 公開搜索", run: () => scrapeYandexSearch(keywordsForSource("yandexSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("yandexSearch"), deepBudget: deepBudgetForSource("yandexSearch"), since: sourceSince("yandexSearch"), domainControls: sourceDomainControls("yandexSearch"), contentControls: sourceContentControls("yandexSearch") }) },
      { key: "openWebDiscovery", label: "開放網頁發現", run: () => scrapeOpenWebDiscovery(keywordsForSource("openWebDiscovery"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("openWebDiscovery"), deepBudget: deepBudgetForSource("openWebDiscovery"), targets: openWebDiscoveryTargetsForSource(openWebDiscoveryConfig, eventClusterSourceSignals.openWebDiscovery, keywordFamilyCoverageReport, realtimeCoverageReport), domainControls: sourceDomainControls("openWebDiscovery"), contentControls: sourceContentControls("openWebDiscovery"), failoverAttribution: failoverAttributionForSource("openWebDiscovery") }) },
      { key: "gdelt", label: "GDELT", run: () => scrapeGdelt(keywordsForSource("gdelt"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("gdelt"), deepBudget: deepBudgetForSource("gdelt"), since: sourceSince("gdelt"), gdeltProfiles: sourceConfigs.get("gdelt")?.gdeltProfiles || sourceConfigs.get("gdelt")?.gdelt_profiles || sourceConfigs.get("gdelt")?.profiles || undefined, domainControls: sourceDomainControls("gdelt"), contentControls: sourceContentControls("gdelt"), failoverAttribution: failoverAttributionForSource("gdelt") }) },
      { key: "rssFeeds", label: "通用 RSS", run: () => scrapeRssFeeds(keywordsForSource("rssFeeds"), { proxyUrl, enrich: plan.enrich, feeds: sourceConfigs.get("rssFeeds")?.feeds || [], feedPacks: rssFeedPacksForScanMode(search, plan.mode, sourceConfigs.get("rssFeeds") || {}), budget: budgetForSource("rssFeeds"), deepBudget: deepBudgetForSource("rssFeeds"), since: sourceSince("rssFeeds"), cursor: sourceIncrementalCursor("rssFeeds"), domainControls: sourceDomainControls("rssFeeds"), contentControls: sourceContentControls("rssFeeds"), failoverAttribution: failoverAttributionForSource("rssFeeds") }) },
      { key: "officialRegulatory", label: "官方/監管公告", run: () => scrapeOfficialRegulatorySources(keywordsForSource("officialRegulatory"), { proxyUrl, enrich: plan.enrich, feeds: sourceConfigs.get("officialRegulatory")?.feeds || [], feedPacks: sourceConfigs.get("officialRegulatory")?.feedPacks || sourceConfigs.get("officialRegulatory")?.feed_packs || [], budget: budgetForSource("officialRegulatory"), deepBudget: deepBudgetForSource("officialRegulatory"), since: sourceSince("officialRegulatory"), cursor: sourceIncrementalCursor("officialRegulatory"), domainControls: sourceDomainControls("officialRegulatory"), contentControls: sourceContentControls("officialRegulatory"), failoverAttribution: failoverAttributionForSource("officialRegulatory") }) },
      { key: "legalPublicRecords", label: "法律/訴訟公開記錄", run: () => scrapeLegalPublicRecords(keywordsForSource("legalPublicRecords"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("legalPublicRecords"), deepBudget: deepBudgetForSource("legalPublicRecords"), since: sourceSince("legalPublicRecords"), domainControls: sourceDomainControls("legalPublicRecords"), contentControls: sourceContentControls("legalPublicRecords"), failoverAttribution: failoverAttributionForSource("legalPublicRecords") }) },
      { key: "publicProcurementSources", label: "公開採購/合約公告", run: () => scrapePublicProcurementSources(keywordsForSource("publicProcurementSources"), { proxyUrl, budget: budgetForSource("publicProcurementSources"), since: sourceSince("publicProcurementSources"), domainControls: sourceDomainControls("publicProcurementSources"), contentControls: sourceContentControls("publicProcurementSources"), failoverAttribution: failoverAttributionForSource("publicProcurementSources") }) },
      { key: "publicSanctionsSources", label: "公開制裁/風險名單", run: () => scrapePublicSanctionsSources(keywordsForSource("publicSanctionsSources"), { proxyUrl, budget: budgetForSource("publicSanctionsSources"), since: sourceSince("publicSanctionsSources"), targets: sourceConfigs.get("publicSanctionsSources")?.targets || sourceConfigs.get("publicSanctionsSources")?.sanctionsTargets || sourceConfigs.get("publicSanctionsSources")?.sanctions_targets || undefined, domainControls: sourceDomainControls("publicSanctionsSources"), contentControls: sourceContentControls("publicSanctionsSources"), failoverAttribution: failoverAttributionForSource("publicSanctionsSources") }) },
      { key: "publicProductRecallSources", label: "公開產品召回/安全警示", run: () => scrapePublicProductRecallSources(keywordsForSource("publicProductRecallSources"), { proxyUrl, budget: budgetForSource("publicProductRecallSources"), since: sourceSince("publicProductRecallSources"), targets: sourceConfigs.get("publicProductRecallSources")?.targets || sourceConfigs.get("publicProductRecallSources")?.recallTargets || sourceConfigs.get("publicProductRecallSources")?.recall_targets || undefined, domainControls: sourceDomainControls("publicProductRecallSources"), contentControls: sourceContentControls("publicProductRecallSources"), failoverAttribution: failoverAttributionForSource("publicProductRecallSources") }) },
      { key: "publicEnforcementActionSources", label: "公開執法/投訴記錄", run: () => scrapePublicEnforcementActionSources(keywordsForSource("publicEnforcementActionSources"), { proxyUrl, budget: budgetForSource("publicEnforcementActionSources"), since: sourceSince("publicEnforcementActionSources"), targets: sourceConfigs.get("publicEnforcementActionSources")?.targets || sourceConfigs.get("publicEnforcementActionSources")?.enforcementTargets || sourceConfigs.get("publicEnforcementActionSources")?.enforcement_targets || undefined, domainControls: sourceDomainControls("publicEnforcementActionSources"), contentControls: sourceContentControls("publicEnforcementActionSources"), failoverAttribution: failoverAttributionForSource("publicEnforcementActionSources") }) },
      { key: "publicAdvertisingRulingsSources", label: "公開廣告監管裁決", run: () => scrapePublicAdvertisingRulingsSources(keywordsForSource("publicAdvertisingRulingsSources"), { proxyUrl, budget: budgetForSource("publicAdvertisingRulingsSources"), since: sourceSince("publicAdvertisingRulingsSources"), targets: sourceConfigs.get("publicAdvertisingRulingsSources")?.targets || sourceConfigs.get("publicAdvertisingRulingsSources")?.advertisingTargets || sourceConfigs.get("publicAdvertisingRulingsSources")?.advertising_targets || undefined, domainControls: sourceDomainControls("publicAdvertisingRulingsSources"), contentControls: sourceContentControls("publicAdvertisingRulingsSources"), failoverAttribution: failoverAttributionForSource("publicAdvertisingRulingsSources") }) },
      { key: "publicRegulatoryWarningLetterSources", label: "公開監管警告信", run: () => scrapePublicRegulatoryWarningLetterSources(keywordsForSource("publicRegulatoryWarningLetterSources"), { proxyUrl, budget: budgetForSource("publicRegulatoryWarningLetterSources"), since: sourceSince("publicRegulatoryWarningLetterSources"), targets: sourceConfigs.get("publicRegulatoryWarningLetterSources")?.targets || sourceConfigs.get("publicRegulatoryWarningLetterSources")?.warningLetterTargets || sourceConfigs.get("publicRegulatoryWarningLetterSources")?.warning_letter_targets || undefined, domainControls: sourceDomainControls("publicRegulatoryWarningLetterSources"), contentControls: sourceContentControls("publicRegulatoryWarningLetterSources"), failoverAttribution: failoverAttributionForSource("publicRegulatoryWarningLetterSources") }) },
      { key: "publicCompanyFilingsSources", label: "公司公開披露/風險公告", run: () => scrapePublicCompanyFilingsSources(keywordsForSource("publicCompanyFilingsSources"), { proxyUrl, budget: budgetForSource("publicCompanyFilingsSources"), since: sourceSince("publicCompanyFilingsSources"), domainControls: sourceDomainControls("publicCompanyFilingsSources"), contentControls: sourceContentControls("publicCompanyFilingsSources"), failoverAttribution: failoverAttributionForSource("publicCompanyFilingsSources") }) },
      { key: "brandImpersonationSources", label: "品牌仿冒/釣魚域名", run: () => scrapeBrandImpersonationSources(keywordsForSource("brandImpersonationSources"), { proxyUrl, budget: budgetForSource("brandImpersonationSources"), since: sourceSince("brandImpersonationSources"), domainControls: sourceDomainControls("brandImpersonationSources"), contentControls: sourceContentControls("brandImpersonationSources"), failoverAttribution: failoverAttributionForSource("brandImpersonationSources") }) },
      { key: "securityAdvisorySources", label: "安全漏洞/已利用漏洞公告", run: () => scrapeSecurityAdvisorySources(keywordsForSource("securityAdvisorySources"), { proxyUrl, budget: budgetForSource("securityAdvisorySources"), since: sourceSince("securityAdvisorySources"), domainControls: sourceDomainControls("securityAdvisorySources"), contentControls: sourceContentControls("securityAdvisorySources"), failoverAttribution: failoverAttributionForSource("securityAdvisorySources") }) },
      { key: "supplyChainAdvisorySources", label: "開源供應鏈漏洞公告", run: () => scrapeSupplyChainAdvisorySources(keywordsForSource("supplyChainAdvisorySources"), { proxyUrl, budget: budgetForSource("supplyChainAdvisorySources"), since: sourceSince("supplyChainAdvisorySources"), domainControls: sourceDomainControls("supplyChainAdvisorySources"), contentControls: sourceContentControls("supplyChainAdvisorySources"), failoverAttribution: failoverAttributionForSource("supplyChainAdvisorySources") }) },
      { key: "investorDiscussionSources", label: "投資者/市場討論源", run: () => scrapeInvestorDiscussionSources(keywordsForSource("investorDiscussionSources"), { proxyUrl, budget: budgetForSource("investorDiscussionSources"), since: sourceSince("investorDiscussionSources"), domainControls: sourceDomainControls("investorDiscussionSources"), contentControls: sourceContentControls("investorDiscussionSources"), failoverAttribution: failoverAttributionForSource("investorDiscussionSources") }) },
      { key: "publicStatusPageSources", label: "公開狀態頁/服務中斷", run: () => scrapePublicStatusPageSources(keywordsForSource("publicStatusPageSources"), { proxyUrl, budget: budgetForSource("publicStatusPageSources"), since: sourceSince("publicStatusPageSources"), targets: sourceConfigs.get("publicStatusPageSources")?.targets || sourceConfigs.get("publicStatusPageSources")?.statusPageTargets || sourceConfigs.get("publicStatusPageSources")?.status_page_targets || [], domainControls: sourceDomainControls("publicStatusPageSources"), contentControls: sourceContentControls("publicStatusPageSources"), failoverAttribution: failoverAttributionForSource("publicStatusPageSources") }) },
      { key: "officialOwnedMediaSources", label: "官方自有媒體/新聞室", run: () => scrapeOfficialOwnedMediaSources(keywordsForSource("officialOwnedMediaSources"), { proxyUrl, budget: budgetForSource("officialOwnedMediaSources"), deepBudget: deepBudgetForSource("officialOwnedMediaSources"), since: sourceSince("officialOwnedMediaSources"), targets: sourceConfigs.get("officialOwnedMediaSources")?.targets || sourceConfigs.get("officialOwnedMediaSources")?.ownedMediaTargets || sourceConfigs.get("officialOwnedMediaSources")?.owned_media_targets || sourceConfigs.get("officialOwnedMediaSources")?.officialTargets || sourceConfigs.get("officialOwnedMediaSources")?.official_targets || [], domainControls: sourceDomainControls("officialOwnedMediaSources"), contentControls: sourceContentControls("officialOwnedMediaSources"), failoverAttribution: failoverAttributionForSource("officialOwnedMediaSources") }) },
      { key: "githubIssues", label: "GitHub Issues", run: () => scrapeGitHubIssues(keywordsForSource("githubIssues"), { proxyUrl, budget: budgetForSource("githubIssues"), deepBudget: deepBudgetForSource("githubIssues"), since: sourceSince("githubIssues"), repositories: sourceConfigs.get("githubIssues")?.repositories || sourceConfigs.get("githubIssues")?.repos || sourceConfigs.get("githubIssues")?.repository || [], domainControls: sourceDomainControls("githubIssues"), contentControls: sourceContentControls("githubIssues"), failoverAttribution: failoverAttributionForSource("githubIssues") }) },
      { key: "gitLabIssues", label: "GitLab Issues", run: () => scrapeGitLabIssues(keywordsForSource("gitLabIssues"), { proxyUrl, budget: budgetForSource("gitLabIssues"), deepBudget: deepBudgetForSource("gitLabIssues"), since: sourceSince("gitLabIssues"), projects: sourceConfigs.get("gitLabIssues")?.projects || sourceConfigs.get("gitLabIssues")?.projectIds || sourceConfigs.get("gitLabIssues")?.project_ids || [], domainControls: sourceDomainControls("gitLabIssues"), contentControls: sourceContentControls("gitLabIssues"), failoverAttribution: failoverAttributionForSource("gitLabIssues") }) },
      { key: "reddit", label: "Reddit", run: () => scrapeReddit(keywordsForSource("reddit"), { proxyUrl, budget: budgetForSource("reddit"), deepBudget: deepBudgetForSource("reddit"), since: sourceSince("reddit"), subreddits: sourceConfigs.get("reddit")?.subreddits || sourceConfigs.get("reddit")?.subreddit || sourceConfigs.get("reddit")?.communities || [], domainControls: sourceDomainControls("reddit"), contentControls: sourceContentControls("reddit"), failoverAttribution: failoverAttributionForSource("reddit") }) },
      { key: "hackerNews", label: "Hacker News", run: () => scrapeHackerNews(keywordsForSource("hackerNews"), { proxyUrl, budget: budgetForSource("hackerNews"), deepBudget: deepBudgetForSource("hackerNews"), since: sourceSince("hackerNews"), authors: sourceConfigs.get("hackerNews")?.authors || sourceConfigs.get("hackerNews")?.author || sourceConfigs.get("hackerNews")?.usernames || sourceConfigs.get("hackerNews")?.users || [], domainControls: sourceDomainControls("hackerNews"), contentControls: sourceContentControls("hackerNews"), failoverAttribution: failoverAttributionForSource("hackerNews") }) },
      { key: "stackOverflow", label: "Stack Overflow", run: () => scrapeStackOverflow(keywordsForSource("stackOverflow"), { proxyUrl, budget: budgetForSource("stackOverflow"), deepBudget: deepBudgetForSource("stackOverflow"), since: sourceSince("stackOverflow"), tags: sourceConfigs.get("stackOverflow")?.tags || sourceConfigs.get("stackOverflow")?.tag || sourceConfigs.get("stackOverflow")?.stackTags || sourceConfigs.get("stackOverflow")?.stack_tags || [], domainControls: sourceDomainControls("stackOverflow"), contentControls: sourceContentControls("stackOverflow"), failoverAttribution: failoverAttributionForSource("stackOverflow") }) },
      { key: "zhihuSearch", label: "知乎公開搜索", run: () => scrapeZhihuSearch(keywordsForSource("zhihuSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("zhihuSearch"), deepBudget: deepBudgetForSource("zhihuSearch"), since: sourceSince("zhihuSearch"), domainControls: sourceDomainControls("zhihuSearch"), contentControls: sourceContentControls("zhihuSearch") }) },
      { key: "quoraSearch", label: "Quora 公開搜索", run: () => scrapeQuoraSearch(keywordsForSource("quoraSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("quoraSearch"), deepBudget: deepBudgetForSource("quoraSearch"), since: sourceSince("quoraSearch"), domainControls: sourceDomainControls("quoraSearch"), contentControls: sourceContentControls("quoraSearch") }) },
      { key: "substackSearch", label: "Substack 公開搜索", run: () => scrapeSubstackSearch(keywordsForSource("substackSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("substackSearch"), deepBudget: deepBudgetForSource("substackSearch"), since: sourceSince("substackSearch"), domainControls: sourceDomainControls("substackSearch"), contentControls: sourceContentControls("substackSearch") }) },
      { key: "mediumSearch", label: "Medium 公開搜索", run: () => scrapeMediumSearch(keywordsForSource("mediumSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("mediumSearch"), deepBudget: deepBudgetForSource("mediumSearch"), since: sourceSince("mediumSearch"), domainControls: sourceDomainControls("mediumSearch"), contentControls: sourceContentControls("mediumSearch") }) },
      { key: "wordpressSearch", label: "WordPress 公開博客搜索", run: () => scrapeWordPressSearch(keywordsForSource("wordpressSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("wordpressSearch"), deepBudget: deepBudgetForSource("wordpressSearch"), since: sourceSince("wordpressSearch"), domainControls: sourceDomainControls("wordpressSearch"), contentControls: sourceContentControls("wordpressSearch") }) },
      { key: "blogspotSearch", label: "Blogspot/Blogger 公開博客搜索", run: () => scrapeBlogspotSearch(keywordsForSource("blogspotSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("blogspotSearch"), deepBudget: deepBudgetForSource("blogspotSearch"), since: sourceSince("blogspotSearch"), domainControls: sourceDomainControls("blogspotSearch"), contentControls: sourceContentControls("blogspotSearch") }) },
      { key: "tumblrSearch", label: "Tumblr 公開搜索", run: () => scrapeTumblrSearch(keywordsForSource("tumblrSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("tumblrSearch"), deepBudget: deepBudgetForSource("tumblrSearch"), since: sourceSince("tumblrSearch"), domainControls: sourceDomainControls("tumblrSearch"), contentControls: sourceContentControls("tumblrSearch") }) },
      { key: "discourseForums", label: "Discourse Forums", run: () => scrapeDiscourseForums(keywordsForSource("discourseForums"), { proxyUrl, budget: budgetForSource("discourseForums"), deepBudget: deepBudgetForSource("discourseForums"), sites: sourceConfigs.get("discourseForums")?.sites || [], targetProfiles: sourceConfigs.get("discourseForums")?.targetProfiles || sourceConfigs.get("discourseForums")?.target_profiles || sourceConfigs.get("discourseForums")?.profiles || [], since: sourceSince("discourseForums"), domainControls: sourceDomainControls("discourseForums"), contentControls: sourceContentControls("discourseForums"), failoverAttribution: failoverAttributionForSource("discourseForums") }) },
      { key: "lemmy", label: "Lemmy", run: () => scrapeLemmySearch(keywordsForSource("lemmy"), { proxyUrl, budget: budgetForSource("lemmy"), deepBudget: deepBudgetForSource("lemmy"), instances: sourceConfigs.get("lemmy")?.instances || sourceConfigs.get("lemmy")?.instance || [], since: sourceSince("lemmy"), domainControls: sourceDomainControls("lemmy"), contentControls: sourceContentControls("lemmy"), failoverAttribution: failoverAttributionForSource("lemmy") }) },
      { key: "mastodon", label: "Mastodon / ActivityPub", run: () => scrapeMastodonTags(keywordsForSource("mastodon"), { proxyUrl, budget: budgetForSource("mastodon"), deepBudget: deepBudgetForSource("mastodon"), instances: sourceConfigs.get("mastodon")?.instances || [], since: sourceSince("mastodon"), domainControls: sourceDomainControls("mastodon"), contentControls: sourceContentControls("mastodon"), failoverAttribution: failoverAttributionForSource("mastodon") }) },
      { key: "bluesky", label: "Bluesky", run: () => scrapeBlueskySearch(keywordsForSource("bluesky"), { proxyUrl, budget: budgetForSource("bluesky"), deepBudget: deepBudgetForSource("bluesky"), since: sourceSince("bluesky"), domainControls: sourceDomainControls("bluesky"), contentControls: sourceContentControls("bluesky"), failoverAttribution: failoverAttributionForSource("bluesky") }) },
      { key: "telegramPublic", label: "Telegram 公開頻道", run: () => scrapeTelegramPublicChannels(keywordsForSource("telegramPublic"), { proxyUrl, budget: budgetForSource("telegramPublic"), deepBudget: deepBudgetForSource("telegramPublic"), since: sourceSince("telegramPublic"), channels: sourceConfigs.get("telegramPublic")?.channels || sourceConfigs.get("telegramPublic")?.channel || sourceConfigs.get("telegramPublic")?.publicChannels || sourceConfigs.get("telegramPublic")?.public_channels || [], domainControls: sourceDomainControls("telegramPublic"), contentControls: sourceContentControls("telegramPublic"), failoverAttribution: failoverAttributionForSource("telegramPublic") }) },
      { key: "ptt", label: "PTT", run: () => scrapePTT(keywordsForSource("ptt"), { proxyUrl, budget: budgetForSource("ptt"), boards: sourceConfigs.get("ptt")?.boards || sourceConfigs.get("ptt")?.board || [] }) },
      { key: "dcard", label: "Dcard", run: () => scrapeDcard(keywordsForSource("dcard"), { proxyUrl, budget: budgetForSource("dcard"), forums: sourceConfigs.get("dcard")?.forums || sourceConfigs.get("dcard")?.forum || sourceConfigs.get("dcard")?.forumAliases || sourceConfigs.get("dcard")?.forum_aliases || [] }) },
      { key: "tiebaSearch", label: "百度貼吧公開搜索", run: () => scrapeTiebaSearch(keywordsForSource("tiebaSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("tiebaSearch"), deepBudget: deepBudgetForSource("tiebaSearch"), since: sourceSince("tiebaSearch"), domainControls: sourceDomainControls("tiebaSearch"), contentControls: sourceContentControls("tiebaSearch") }) },
      { key: "threads", label: "Threads", run: () => scrapeThreads(keywordsForSource("threads"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("threads"), deepBudget: deepBudgetForSource("threads"), profiles: sourceConfigs.get("threads")?.profiles || sourceConfigs.get("threads")?.profile || sourceConfigs.get("threads")?.accounts || sourceConfigs.get("threads")?.account || sourceConfigs.get("threads")?.handles || sourceConfigs.get("threads")?.handle || [], domainControls: sourceDomainControls("threads"), contentControls: sourceContentControls("threads") }) },
      { key: "instagram", label: "Instagram / INS", run: () => scrapeInstagram(keywordsForSource("instagram"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("instagram"), deepBudget: deepBudgetForSource("instagram"), profiles: sourceConfigs.get("instagram")?.profiles || sourceConfigs.get("instagram")?.profile || sourceConfigs.get("instagram")?.accounts || sourceConfigs.get("instagram")?.account || sourceConfigs.get("instagram")?.handles || sourceConfigs.get("instagram")?.handle || [], domainControls: sourceDomainControls("instagram"), contentControls: sourceContentControls("instagram") }) },
      { key: "xSearch", label: "X/Twitter 公開搜索", run: () => scrapeXSearch(keywordsForSource("xSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("xSearch"), deepBudget: deepBudgetForSource("xSearch"), since: sourceSince("xSearch"), domainControls: sourceDomainControls("xSearch"), contentControls: sourceContentControls("xSearch") }) },
      { key: "facebookSearch", label: "Facebook 公開搜索", run: () => scrapeFacebookSearch(keywordsForSource("facebookSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("facebookSearch"), deepBudget: deepBudgetForSource("facebookSearch"), since: sourceSince("facebookSearch"), domainControls: sourceDomainControls("facebookSearch"), contentControls: sourceContentControls("facebookSearch") }) },
      { key: "linkedinSearch", label: "LinkedIn 公開搜索", run: () => scrapeLinkedInSearch(keywordsForSource("linkedinSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("linkedinSearch"), deepBudget: deepBudgetForSource("linkedinSearch"), since: sourceSince("linkedinSearch"), domainControls: sourceDomainControls("linkedinSearch"), contentControls: sourceContentControls("linkedinSearch") }) },
      { key: "weiboSearch", label: "微博公開搜索", run: () => scrapeWeiboSearch(keywordsForSource("weiboSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("weiboSearch"), deepBudget: deepBudgetForSource("weiboSearch"), since: sourceSince("weiboSearch"), domainControls: sourceDomainControls("weiboSearch"), contentControls: sourceContentControls("weiboSearch") }) },
      { key: "xiaohongshuSearch", label: "小紅書公開搜索", run: () => scrapeXiaohongshuSearch(keywordsForSource("xiaohongshuSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("xiaohongshuSearch"), deepBudget: deepBudgetForSource("xiaohongshuSearch"), since: sourceSince("xiaohongshuSearch"), domainControls: sourceDomainControls("xiaohongshuSearch"), contentControls: sourceContentControls("xiaohongshuSearch") }) },
      { key: "tiktokSearch", label: "TikTok 公開視頻搜索", run: () => scrapeTikTokSearch(keywordsForSource("tiktokSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("tiktokSearch"), deepBudget: deepBudgetForSource("tiktokSearch"), since: sourceSince("tiktokSearch"), domainControls: sourceDomainControls("tiktokSearch"), contentControls: sourceContentControls("tiktokSearch") }) },
      { key: "douyinSearch", label: "抖音公開視頻搜索", run: () => scrapeDouyinSearch(keywordsForSource("douyinSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("douyinSearch"), deepBudget: deepBudgetForSource("douyinSearch"), since: sourceSince("douyinSearch"), domainControls: sourceDomainControls("douyinSearch"), contentControls: sourceContentControls("douyinSearch") }) },
      { key: "kuaishouSearch", label: "快手公開視頻搜索", run: () => scrapeKuaishouSearch(keywordsForSource("kuaishouSearch"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("kuaishouSearch"), deepBudget: deepBudgetForSource("kuaishouSearch"), since: sourceSince("kuaishouSearch"), domainControls: sourceDomainControls("kuaishouSearch"), contentControls: sourceContentControls("kuaishouSearch") }) },
      { key: "browserFallback", label: "授權瀏覽器兜底采集", run: () => scrapeBrowserFallback(keywordsForSource("browserFallback"), { browserSettings: browserFallbackScanSettings.browserSettings, sourceConfig: browserFallbackScanSettings.sourceConfig, budget: budgetForSource("browserFallback"), domainControls: sourceDomainControls("browserFallback"), contentControls: sourceContentControls("browserFallback") }) },
      { key: "youtube", label: "YouTube", run: () => scrapeYouTube(keywordsForSource("youtube"), { proxyUrl, budget: budgetForSource("youtube"), deepBudget: deepBudgetForSource("youtube"), since: sourceSince("youtube"), domainControls: sourceDomainControls("youtube"), contentControls: sourceContentControls("youtube") }) },
      { key: "bilibili", label: "Bilibili / B站", run: () => scrapeBilibiliSearch(keywordsForSource("bilibili"), { proxyUrl, budget: budgetForSource("bilibili"), deepBudget: deepBudgetForSource("bilibili"), since: sourceSince("bilibili"), domainControls: sourceDomainControls("bilibili"), contentControls: sourceContentControls("bilibili") }) },
      { key: "applePodcastSearch", label: "Apple Podcasts 公開搜索", run: () => scrapeApplePodcastSearch(keywordsForSource("applePodcastSearch"), { proxyUrl, budget: budgetForSource("applePodcastSearch"), since: sourceSince("applePodcastSearch"), country: sourceConfigs.get("applePodcastSearch")?.country || "us", language: sourceConfigs.get("applePodcastSearch")?.language || sourceConfigs.get("applePodcastSearch")?.lang || "en_us", discoveredPodcastShows: sourceConfigs.get("applePodcastSearch")?.discoveredPodcastShows || sourceConfigs.get("applePodcastSearch")?.discovered_podcast_shows || [], domainControls: sourceDomainControls("applePodcastSearch"), contentControls: sourceContentControls("applePodcastSearch") }) },
      { key: "appStoreReviews", label: "App Store 評論", run: () => scrapeAppStoreReviews(keywordsForSource("appStoreReviews"), { proxyUrl, budget: budgetForSource("appStoreReviews"), since: sourceSince("appStoreReviews"), countries: sourceConfigs.get("appStoreReviews")?.countries || [], appIds: sourceConfigs.get("appStoreReviews")?.appIds || sourceConfigs.get("appStoreReviews")?.app_ids || [], domainControls: sourceDomainControls("appStoreReviews"), contentControls: sourceContentControls("appStoreReviews") }) },
      { key: "googlePlayReviews", label: "Google Play 評論", run: () => scrapeGooglePlayReviews(keywordsForSource("googlePlayReviews"), { proxyUrl, budget: budgetForSource("googlePlayReviews"), since: sourceSince("googlePlayReviews"), countries: sourceConfigs.get("googlePlayReviews")?.countries || [], languages: sourceConfigs.get("googlePlayReviews")?.languages || sourceConfigs.get("googlePlayReviews")?.langs || [], packageIds: sourceConfigs.get("googlePlayReviews")?.packageIds || sourceConfigs.get("googlePlayReviews")?.package_ids || sourceConfigs.get("googlePlayReviews")?.appIds || sourceConfigs.get("googlePlayReviews")?.app_ids || [], domainControls: sourceDomainControls("googlePlayReviews"), contentControls: sourceContentControls("googlePlayReviews") }) },
      { key: "publicReviewSites", label: "公開評價/投訴站", run: () => scrapePublicReviewSites(keywordsForSource("publicReviewSites"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("publicReviewSites"), deepBudget: deepBudgetForSource("publicReviewSites"), targets: sourceConfigs.get("publicReviewSites")?.targets || sourceConfigs.get("publicReviewSites")?.sites || [], targetProfiles: sourceConfigs.get("publicReviewSites")?.targetProfiles || sourceConfigs.get("publicReviewSites")?.target_profiles || sourceConfigs.get("publicReviewSites")?.profiles || [], domainControls: sourceDomainControls("publicReviewSites"), contentControls: sourceContentControls("publicReviewSites"), failoverAttribution: failoverAttributionForSource("publicReviewSites") }) },
      { key: "verticalReviewSources", label: "垂直產品/社群評價源", run: () => scrapeVerticalReviewSources(keywordsForSource("verticalReviewSources"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("verticalReviewSources"), deepBudget: deepBudgetForSource("verticalReviewSources"), targets: sourceConfigs.get("verticalReviewSources")?.targets || sourceConfigs.get("verticalReviewSources")?.sites || [], targetProfiles: sourceConfigs.get("verticalReviewSources")?.targetProfiles || sourceConfigs.get("verticalReviewSources")?.target_profiles || sourceConfigs.get("verticalReviewSources")?.profiles || [], domainControls: sourceDomainControls("verticalReviewSources"), contentControls: sourceContentControls("verticalReviewSources"), failoverAttribution: failoverAttributionForSource("verticalReviewSources") }) },
      { key: "employerReviewSources", label: "雇主/員工公開評價源", run: () => scrapeEmployerReviewSources(keywordsForSource("employerReviewSources"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("employerReviewSources"), deepBudget: deepBudgetForSource("employerReviewSources"), targets: sourceConfigs.get("employerReviewSources")?.targets || sourceConfigs.get("employerReviewSources")?.sites || [], targetProfiles: sourceConfigs.get("employerReviewSources")?.targetProfiles || sourceConfigs.get("employerReviewSources")?.target_profiles || sourceConfigs.get("employerReviewSources")?.profiles || [], domainControls: sourceDomainControls("employerReviewSources"), contentControls: sourceContentControls("employerReviewSources"), failoverAttribution: failoverAttributionForSource("employerReviewSources") }) },
      { key: "ecommerceReviewSources", label: "電商/市場公開評價源", run: () => scrapeEcommerceReviewSources(keywordsForSource("ecommerceReviewSources"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("ecommerceReviewSources"), deepBudget: deepBudgetForSource("ecommerceReviewSources"), targets: sourceConfigs.get("ecommerceReviewSources")?.targets || sourceConfigs.get("ecommerceReviewSources")?.sites || [], targetProfiles: sourceConfigs.get("ecommerceReviewSources")?.targetProfiles || sourceConfigs.get("ecommerceReviewSources")?.target_profiles || sourceConfigs.get("ecommerceReviewSources")?.profiles || [], domainControls: sourceDomainControls("ecommerceReviewSources"), contentControls: sourceContentControls("ecommerceReviewSources"), failoverAttribution: failoverAttributionForSource("ecommerceReviewSources") }) },
      { key: "localReviewSources", label: "本地商家/服務公開評價源", run: () => scrapeLocalReviewSources(keywordsForSource("localReviewSources"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("localReviewSources"), deepBudget: deepBudgetForSource("localReviewSources"), targets: sourceConfigs.get("localReviewSources")?.targets || sourceConfigs.get("localReviewSources")?.sites || [], targetProfiles: sourceConfigs.get("localReviewSources")?.targetProfiles || sourceConfigs.get("localReviewSources")?.target_profiles || sourceConfigs.get("localReviewSources")?.profiles || [], domainControls: sourceDomainControls("localReviewSources"), contentControls: sourceContentControls("localReviewSources"), failoverAttribution: failoverAttributionForSource("localReviewSources") }) },
      { key: "regionalComplaintSources", label: "區域投訴/消費者保護源", run: () => scrapeRegionalComplaintSources(keywordsForSource("regionalComplaintSources"), { proxyUrl, enrich: plan.enrich, budget: budgetForSource("regionalComplaintSources"), deepBudget: deepBudgetForSource("regionalComplaintSources"), targets: sourceConfigs.get("regionalComplaintSources")?.targets || sourceConfigs.get("regionalComplaintSources")?.sites || [], targetProfiles: sourceConfigs.get("regionalComplaintSources")?.targetProfiles || sourceConfigs.get("regionalComplaintSources")?.target_profiles || sourceConfigs.get("regionalComplaintSources")?.profiles || [], domainControls: sourceDomainControls("regionalComplaintSources"), contentControls: sourceContentControls("regionalComplaintSources"), failoverAttribution: failoverAttributionForSource("regionalComplaintSources") }) },
    ];
    const disabledSources = sourceRecords
      .filter(source => selected.has(source.source_key) && !source.enabled)
      .map(source => source.source_key);
    const sortJobsByPriority = (a, b) => {
      const leftImplicitAlternate = !selected.has(a.key) && isImplicitAlternateSource(a.key);
      const rightImplicitAlternate = !selected.has(b.key) && isImplicitAlternateSource(b.key);
      if (leftImplicitAlternate !== rightImplicitAlternate) return leftImplicitAlternate ? 1 : -1;
      const left = Number(sourceRecordByKey.get(a.key)?.priority ?? 50)
        + Math.min(25, Number(trackingSourceSignals[a.key]?.score || 0) / 4)
        + Number(sourceCoverageSignals[a.key]?.priorityBoost || 0)
        + Number(entityTopicSourceSignals[a.key]?.priorityBoost || 0)
        + Number(socialFollowupSourceSignals[a.key]?.priorityBoost || 0)
        + Number(collectionOperationsRemediationSourceSignals[a.key]?.priorityBoost || 0)
        + Number(credibilitySourceSignals[a.key]?.priorityBoost || 0)
        + Number(eventClusterSourceSignals[a.key]?.priorityBoost || 0);
      const right = Number(sourceRecordByKey.get(b.key)?.priority ?? 50)
        + Math.min(25, Number(trackingSourceSignals[b.key]?.score || 0) / 4)
        + Number(sourceCoverageSignals[b.key]?.priorityBoost || 0)
        + Number(entityTopicSourceSignals[b.key]?.priorityBoost || 0)
        + Number(socialFollowupSourceSignals[b.key]?.priorityBoost || 0)
        + Number(collectionOperationsRemediationSourceSignals[b.key]?.priorityBoost || 0)
        + Number(credibilitySourceSignals[b.key]?.priorityBoost || 0)
        + Number(eventClusterSourceSignals[b.key]?.priorityBoost || 0);
      return right - left || a.key.localeCompare(b.key);
    };
    const explicitJobs = sourceOptions
      .filter(job => selected.has(job.key) && sourceRecordByKey.get(job.key)?.enabled !== false)
      .sort(sortJobsByPriority);
    const implicitAlternateJobs = sourceOptions
      .filter(job => !selected.has(job.key) && isImplicitAlternateSource(job.key) && sourceRecordByKey.get(job.key)?.enabled !== false)
      .sort(sortJobsByPriority);
    const jobs = [...explicitJobs, ...implicitAlternateJobs];
    log.info(`[CRM/Scraper] 開始${plan.mode === SCAN_MODE_FAST ? "快速" : "完整"}掃描，關鍵詞: ${keywords.join(", ")}，延伸詞: ${searchKeywords.join(", ")}，來源: ${explicitJobs.map(job => job.key).join(", ")}${disabledSources.length ? `，已停用: ${disabledSources.join(", ")}` : ""}`);

    const batch = createSentimentScanBatch({
      reason,
      mode: plan.mode,
      keywords,
      searchKeywords,
      eventExpansionKeywords: plan.eventExpansionKeywords,
      requestedSources: plan.sources,
      sources: explicitJobs.map(job => job.key),
      disabledSources,
      startedAt: startedAtIso,
    });
    const priorityForSource = (key) => Number(sourceRecordByKey.get(key)?.priority ?? 50)
      + Math.min(25, Number(trackingSourceSignals[key]?.score || 0) / 4)
      + Number(sourceCoverageSignals[key]?.priorityBoost || 0)
      + Number(entityTopicSourceSignals[key]?.priorityBoost || 0)
      + Number(collectionOperationsRemediationSourceSignals[key]?.priorityBoost || 0)
      + Number(credibilitySourceSignals[key]?.priorityBoost || 0)
      + Number(eventClusterSourceSignals[key]?.priorityBoost || 0)
      + Number(taiwanPrioritySiteHealthSourceSignals[key]?.priorityBoost || 0);
    const collectionJobs = createSentimentCollectionJobs({
      batchId: batch?.id,
      jobs: [
        ...explicitJobs.map(job => ({
          sourceKey: job.key,
          label: job.label,
          reason,
          mode: plan.mode,
          priority: priorityForSource(job.key),
          query: selected.has(job.key) ? keywordsForSource(job.key) : [],
          entity: {
            monitored_keywords: plan.monitoredEntityKeywords || [],
            entity_footprint_keywords: plan.entityFootprintKeywords || [],
            entity_topic_recall_keywords: plan.entityTopicRecallKeywords || [],
            event_expansion_keywords: plan.eventExpansionKeywords || [],
          },
          metadata: {
            budget: budgetForSource(job.key),
            deepBudget: deepBudgetForSource(job.key),
            ...rssFeedPackDiagnosticsForSource(job.key),
            trackingSignal: trackingSourceSignals[job.key] || null,
            realtimeHotTopicSignal: realtimeHotTopicSourceSignals[job.key] || null,
            coverageSignal: sourceCoverageSignals[job.key] || null,
            entityTopicSignal: entityTopicSourceSignals[job.key] || null,
            keywordFamilyCoverageSignal: keywordFamilyCoverageSignals[job.key] || null,
            taiwanPrioritySiteHealthSignal: taiwanPrioritySiteHealthSourceSignals[job.key] || null,
            eventClusterSignal: eventClusterSourceSignals[job.key] || null,
            eventClusterFollowupTargets: eventClusterFollowupTargetsForSource(job.key, eventClusterSourceSignals[job.key]),
          },
        })),
        ...disabledSources.map(sourceKey => ({
          sourceKey,
          label: sourceRecordByKey.get(sourceKey)?.label || sourceKey,
          reason,
          mode: plan.mode,
          status: "pending",
          priority: priorityForSource(sourceKey),
          query: searchKeywords,
          entity: {
            monitored_keywords: plan.monitoredEntityKeywords || [],
            entity_footprint_keywords: plan.entityFootprintKeywords || [],
            entity_topic_recall_keywords: plan.entityTopicRecallKeywords || [],
            event_expansion_keywords: plan.eventExpansionKeywords || [],
          },
          metadata: {
            disabled: true,
            budget: budgetForSource(sourceKey),
            deepBudget: deepBudgetForSource(sourceKey),
            ...rssFeedPackDiagnosticsForSource(sourceKey),
            realtimeHotTopicSignal: realtimeHotTopicSourceSignals[sourceKey] || null,
            coverageSignal: sourceCoverageSignals[sourceKey] || null,
            entityTopicSignal: entityTopicSourceSignals[sourceKey] || null,
            keywordFamilyCoverageSignal: keywordFamilyCoverageSignals[sourceKey] || null,
            taiwanPrioritySiteHealthSignal: taiwanPrioritySiteHealthSourceSignals[sourceKey] || null,
            eventClusterSignal: eventClusterSourceSignals[sourceKey] || null,
            eventClusterFollowupTargets: eventClusterFollowupTargetsForSource(sourceKey, eventClusterSourceSignals[sourceKey]),
          },
        })),
      ],
    });
    const collectionJobBySource = new Map(collectionJobs.map(job => [job.source_key, job]));
    const ensureCollectionJob = (job, overrides = {}) => {
      if (collectionJobBySource.has(job.key)) return collectionJobBySource.get(job.key);
      const created = createSentimentCollectionJobs({
        batchId: batch?.id,
        jobs: [{
          sourceKey: job.key,
          label: job.label,
          reason,
          mode: plan.mode,
          priority: priorityForSource(job.key),
          query: overrides.query ?? (selected.has(job.key) ? keywordsForSource(job.key) : []),
          entity: {
            monitored_keywords: plan.monitoredEntityKeywords || [],
            entity_footprint_keywords: plan.entityFootprintKeywords || [],
            entity_topic_recall_keywords: plan.entityTopicRecallKeywords || [],
            event_expansion_keywords: plan.eventExpansionKeywords || [],
          },
          metadata: {
            budget: budgetForSource(job.key),
            deepBudget: deepBudgetForSource(job.key),
            trackingSignal: trackingSourceSignals[job.key] || null,
            realtimeHotTopicSignal: realtimeHotTopicSourceSignals[job.key] || null,
            coverageSignal: sourceCoverageSignals[job.key] || null,
            entityTopicSignal: entityTopicSourceSignals[job.key] || null,
            keywordFamilyCoverageSignal: keywordFamilyCoverageSignals[job.key] || null,
            eventClusterSignal: eventClusterSourceSignals[job.key] || null,
            eventClusterFollowupTargets: eventClusterFollowupTargetsForSource(job.key, eventClusterSourceSignals[job.key]),
            ...(overrides.metadata || {}),
          },
        }],
      })[0];
      if (created) collectionJobBySource.set(job.key, created);
      return created;
    };
    const now = Date.now();
    for (const sourceKey of disabledSources) {
      const source = sourceRecordByKey.get(sourceKey);
      updateSentimentCollectionJob(collectionJobBySource.get(sourceKey)?.id, {
        status: "disabled",
        message: "來源已在 sentiment_sources 中停用",
        metadata: { terminal_reason: "disabled-source" },
      });
      recordSentimentScanSourceLog({
        batchId: batch?.id,
        sourceKey,
        label: source?.label || sourceKey,
        status: "disabled",
        message: "來源已在 sentiment_sources 中停用",
        metadata: metadataForSource(sourceKey, { status: "disabled", message: "來源已在 sentiment_sources 中停用" }),
      });
    }
    const runnableJobs = [];
    const skippedFailures = [];
    for (const job of jobs) {
      if (!selected.has(job.key) && isImplicitAlternateSource(job.key)) continue;
      const sourceRecord = sourceRecordByKey.get(job.key) || {};
      if (reason === "schedule") {
        const intervalCooldown = sourceIntervalCooldown(sourceRecord, now);
        if (intervalCooldown) {
          const remaining = formatDuration(intervalCooldown.until - now);
          updateSentimentCollectionJob(collectionJobBySource.get(job.key)?.id, {
            status: "interval",
            message: `未到來源掃描間隔：${sourceRecord.scan_interval_minutes || intervalCooldown.intervalMinutes} 分鐘，約 ${remaining} 後再試`,
            coolingUntil: new Date(intervalCooldown.until).toISOString(),
            metadata: { terminal_reason: "source-interval" },
          });
          recordSentimentScanSourceLog({
            batchId: batch?.id,
            sourceKey: job.key,
            label: job.label,
            status: "interval",
            message: `未到來源掃描間隔：${sourceRecord.scan_interval_minutes || intervalCooldown.intervalMinutes} 分鐘，約 ${remaining} 後再試`,
            metadata: metadataForSource(job.key, {
              status: "interval",
              message: `未到來源掃描間隔：${sourceRecord.scan_interval_minutes || intervalCooldown.intervalMinutes} 分鐘，約 ${remaining} 後再試`,
              coolingUntil: new Date(intervalCooldown.until).toISOString(),
            }),
            coolingUntil: new Date(intervalCooldown.until).toISOString(),
          });
          continue;
        }
      }
      const cooldown = activeSourceCooldown(job.key, now);
      if (cooldown) {
        const remaining = formatDuration(cooldown.until - now);
        const message = `來源暫停中：${cooldown.reason}，約 ${remaining} 後再試`;
        const recoveryAction = recoveryActionForSource(job.key, {
          status: "cooldown",
          message,
          coolingUntil: new Date(cooldown.until).toISOString(),
        });
        addSourceFailoverPlan(job.key, recoveryAction, { status: "cooldown", message });
        updateSentimentCollectionJob(collectionJobBySource.get(job.key)?.id, {
          status: "cooldown",
          message,
          coolingUntil: new Date(cooldown.until).toISOString(),
          metadata: { terminal_reason: "source-cooldown", recoveryAction },
        });
        skippedFailures.push({
          source: job.key,
          message,
        });
        recordSentimentScanSourceLog({
          batchId: batch?.id,
          sourceKey: job.key,
          label: job.label,
          status: "cooldown",
          message,
          metadata: metadataForSource(job.key, { status: "cooldown", message, coolingUntil: new Date(cooldown.until).toISOString() }),
          coolingUntil: new Date(cooldown.until).toISOString(),
        });
        continue;
      }
      const throttlePolicy = throttlePolicyForSource(job.key, sourceRecord);
      const throttle = activeDomainThrottle(throttlePolicy, now);
      if (throttle) {
        const remaining = formatDuration(throttle.until - now);
        const message = `來源域名節流中：${throttle.domain}，${throttle.reason}，約 ${remaining} 後再試`;
        const recoveryAction = recoveryActionForSource(job.key, {
          status: "throttled",
          message,
          coolingUntil: new Date(throttle.until).toISOString(),
        });
        addSourceFailoverPlan(job.key, recoveryAction, { status: "throttled", message });
        updateSentimentCollectionJob(collectionJobBySource.get(job.key)?.id, {
          status: "throttled",
          message,
          coolingUntil: new Date(throttle.until).toISOString(),
          metadata: { terminal_reason: "domain-throttle", recoveryAction },
        });
        skippedFailures.push({
          source: job.key,
          message,
        });
        recordSentimentScanSourceLog({
          batchId: batch?.id,
          sourceKey: job.key,
          label: job.label,
          status: "throttled",
          message,
          metadata: metadataForSource(job.key, { status: "throttled", message, coolingUntil: new Date(throttle.until).toISOString() }),
          coolingUntil: new Date(throttle.until).toISOString(),
        });
        continue;
      }
      recordDomainThrottleStart(throttlePolicy, now);
      runnableJobs.push(job);
    }
    const settled = await Promise.all(runnableJobs.map(async job => {
      const sourceStartedAt = Date.now();
      updateSentimentCollectionJob(collectionJobBySource.get(job.key)?.id, {
        status: "running",
        startedAt: new Date(sourceStartedAt).toISOString(),
        incrementAttempt: true,
        metadata: { runtime_started_at: new Date(sourceStartedAt).toISOString() },
      });
      try {
        const value = await withSourceJobTimeout(job.run(), { sourceKey: job.key, mode: plan.mode });
        return { status: "fulfilled", value, durationMs: Date.now() - sourceStartedAt };
      } catch (error) {
        return { status: "rejected", reason: error, durationMs: Date.now() - sourceStartedAt };
      }
    }));
    const counts = Object.fromEntries(sourceOptions.map(job => [job.key, 0]));
    const failures = [...skippedFailures];
    const warn = log?.warn?.bind(log) ?? log?.info?.bind(log) ?? console.warn;
    const applySettledJobResult = (job, result) => {
      if (result.status === "fulfilled") {
        const sourceResult = normalizeSourceResult(result.value);
        counts[job.key] = sourceResult.count;
        const sourceFailures = [];
        for (const failure of sourceResult.failures) {
          const message = formatSourceFailure(failure);
          failures.push({ source: job.key, message });
          sourceFailures.push(message);
          warn(`[CRM/Scraper] ${job.label} 部分掃描失敗: ${message}`);
        }
        const sourceExecutionDiagnostics = {
          ...(sourceResult.diagnostics || {}),
          ...(freeSourceTargetCoverageExecutionDiagnostics(
            job.key,
            freeSourceTargetCoverageSignals[job.key],
            sourceKeywordPlans.get(job.key) || [],
            sourceResult,
            sourceFailures,
          ) || {}),
          ...(keywordSourceFamilyCoverageExecutionDiagnostics(
            job.key,
            keywordFamilyCoverageSignals[job.key]
              || (job.key === "openWebDiscovery" ? keywordSourceFamilyCoverageDiscoverySignal(keywordFamilyCoverageReport) : null),
            sourceKeywordPlans.get(job.key) || [],
            sourceResult,
            sourceFailures,
          ) || {}),
          ...(multilingualQueryQualityExecutionDiagnostics(
            job.key,
            multilingualQuerySourceSignals[job.key],
            sourceKeywordPlans.get(job.key) || [],
            sourceResult,
            sourceFailures,
          ) || {}),
          ...(eventClusterFollowupExecutionDiagnostics(
            job.key,
            eventClusterSourceSignals[job.key],
            sourceKeywordPlans.get(job.key) || [],
            sourceResult,
            sourceFailures,
          ) || {}),
        };
        updateSentimentSourceCollectionCursor(job.key, {
          success: sourceFailures.length === 0,
          reason,
          mode: plan.mode,
          batchId: batch?.id,
          since: sourceSince(job.key),
          keywords: sourceKeywordPlans.get(job.key) || [],
          resultCount: sourceResult.count,
          failureCount: sourceFailures.length,
          finishedAt: new Date().toISOString(),
          cursor: sourceResult.cursor,
        });
        if (sourceFailures.length) {
          const recoverableAccessBarrier = allFailuresAreRecoverableExternalAccessBarriers(sourceFailures, job.key);
          const partialMessage = recoverableAccessBarrier
            ? recoverableExternalAccessBarrierMessage(sourceFailures)
            : summarizeScanFailures(sourceFailures.map(message => ({ source: job.key, message })), 1)[0]?.message || sourceFailures[0] || "";
          recordSourceFailure(job.key, sourceFailures);
          recordDomainThrottleFailure(throttlePolicyForSource(job.key, sourceRecordByKey.get(job.key)), sourceFailures);
          updateSentimentSourceScanState(job.key, {
            success: false,
            error: recoverableAccessBarrier ? "" : sourceFailures[0] || "部分掃描失敗",
          });
          const recoveryAction = recoveryActionForSource(job.key, {
            status: "partial",
            message: partialMessage,
          });
          addPostRunFailoverPlan(job.key, recoveryAction, {
            status: "partial",
            message: partialMessage,
            implicitAlternateAllowed: recoverableAccessBarrier,
          });
          updateSentimentCollectionJob(collectionJobBySource.get(job.key)?.id, {
            status: "partial",
            resultCount: sourceResult.count,
            failureCount: sourceFailures.length,
            durationMs: result.durationMs,
            message: partialMessage,
            metadata: {
              failures: sourceFailures,
              terminal_reason: recoverableAccessBarrier ? "recoverable-external-access-barrier" : "partial-source-failures",
              recoverableAccessBarrier,
              recoveryAction,
              ...(Object.keys(sourceExecutionDiagnostics).length ? { diagnostics: sourceExecutionDiagnostics } : {}),
            },
          });
          recordSentimentScanSourceLog({
            batchId: batch?.id,
            sourceKey: job.key,
            label: job.label,
            status: "partial",
            count: sourceResult.count,
            failureCount: sourceFailures.length,
            durationMs: result.durationMs,
            metadata: {
              ...metadataForSource(job.key, {
                status: "partial",
                message: partialMessage,
              }),
              ...(Object.keys(sourceExecutionDiagnostics).length ? { diagnostics: sourceExecutionDiagnostics } : {}),
            },
            message: partialMessage,
          });
        } else {
          const emptyRecoveryAction = sourceResult.count === 0
            ? recoveryActionForSource(job.key, {
              status: "empty",
              message: "來源本輪無結果",
            })
            : null;
          if (emptyRecoveryAction?.alternateSources?.length) {
            addPostRunFailoverPlan(job.key, emptyRecoveryAction, { status: "empty", message: "來源本輪無結果" });
          }
          recordSourceSuccess(job.key);
          recordDomainThrottleSuccess(throttlePolicyForSource(job.key, sourceRecordByKey.get(job.key)));
          updateSentimentSourceScanState(job.key, { success: true });
          updateSentimentCollectionJob(collectionJobBySource.get(job.key)?.id, {
            status: "success",
            resultCount: sourceResult.count,
            failureCount: 0,
            durationMs: result.durationMs,
            metadata: {
              terminal_reason: sourceResult.count === 0 ? "source-empty-success" : "source-success",
              ...(emptyRecoveryAction ? { recoveryAction: emptyRecoveryAction } : {}),
              ...(Object.keys(sourceExecutionDiagnostics).length ? { diagnostics: sourceExecutionDiagnostics } : {}),
            },
          });
          recordSentimentScanSourceLog({
            batchId: batch?.id,
            sourceKey: job.key,
            label: job.label,
            status: "success",
            count: sourceResult.count,
            durationMs: result.durationMs,
            metadata: (() => {
              const metadata = metadataForSource(job.key, { status: "success" });
              if (emptyRecoveryAction) {
                metadata.recoveryAction = emptyRecoveryAction;
                sourceRecoveryActions.set(job.key, emptyRecoveryAction);
              }
              if (Object.keys(sourceExecutionDiagnostics).length) metadata.diagnostics = sourceExecutionDiagnostics;
              return metadata;
            })(),
          });
        }
        return;
      }

      const message = String(result.reason?.message ?? result.reason);
      const recoverableAccessBarrier = isRecoverableExternalAccessBarrier(message);
      const displayMessage = recoverableAccessBarrier
        ? recoverableExternalAccessBarrierMessage([message])
        : message;
      failures.push({ source: job.key, message });
      recordSourceFailure(job.key, message);
      recordDomainThrottleFailure(throttlePolicyForSource(job.key, sourceRecordByKey.get(job.key)), message);
      updateSentimentSourceScanState(job.key, { success: false, error: recoverableAccessBarrier ? "" : message });
      const recoveryAction = recoveryActionForSource(job.key, {
        status: "failed",
        message: displayMessage,
      });
      addPostRunFailoverPlan(job.key, recoveryAction, {
        status: "failed",
        message: displayMessage,
        implicitAlternateAllowed: recoverableAccessBarrier,
      });
      updateSentimentCollectionJob(collectionJobBySource.get(job.key)?.id, {
        status: recoverableAccessBarrier ? "blocked" : "failed",
        failureCount: 1,
        durationMs: result.durationMs,
        message: displayMessage,
        metadata: {
          terminal_reason: recoverableAccessBarrier ? "recoverable-external-access-barrier" : "source-exception",
          retry_recommended: true,
          recoverableAccessBarrier,
          recoveryAction,
        },
      });
      recordSentimentScanSourceLog({
        batchId: batch?.id,
        sourceKey: job.key,
        label: job.label,
        status: recoverableAccessBarrier ? "blocked" : "failed",
        failureCount: 1,
        durationMs: result.durationMs,
        metadata: metadataForSource(job.key, { status: recoverableAccessBarrier ? "blocked" : "failed", message: displayMessage }),
        message: displayMessage,
      });
      warn(`[CRM/Scraper] ${job.label} 掃描${recoverableAccessBarrier ? "受限" : "失敗"}: ${displayMessage}`);
    };

    settled.forEach((result, index) => {
      const job = runnableJobs[index];
      applySettledJobResult(job, result);
    });

    const deferredImplicitAlternateJobs = implicitAlternateJobs;
    for (const job of deferredImplicitAlternateJobs) {
      if (!failoverAttributionForSource(job.key).length) {
        continue;
      }
      ensureCollectionJob(job, {
        metadata: {
          implicitAlternate: true,
        },
      });
      const sourceStartedAt = Date.now();
      updateSentimentCollectionJob(collectionJobBySource.get(job.key)?.id, {
        status: "running",
        startedAt: new Date(sourceStartedAt).toISOString(),
        incrementAttempt: true,
        metadata: { runtime_started_at: new Date(sourceStartedAt).toISOString(), implicitAlternate: true },
      });
      let result;
      try {
        const value = await withSourceJobTimeout(job.run(), { sourceKey: job.key, mode: plan.mode });
        result = { status: "fulfilled", value, durationMs: Date.now() - sourceStartedAt };
      } catch (error) {
        result = { status: "rejected", reason: error, durationMs: Date.now() - sourceStartedAt };
      }
      applySettledJobResult(job, result);
    }

    const {
      browserFallback: browserFallbackCount = 0,
      yahooTaiwan: yahooTaiwanCount,
      yahooJapanNews: yahooJapanNewsCount,
      naverKoreaNews: naverKoreaNewsCount,
      daumKoreaNews: daumKoreaNewsCount,
      baiduSearch: baiduSearchCount,
      baiduNews: baiduNewsCount,
      sogouSearch: sogouSearchCount,
      soSearch: soSearchCount,
      wechatPublicSearch: wechatPublicSearchCount,
      toutiaoSearch: toutiaoSearchCount,
      taiwanNews: taiwanNewsCount,
      googleNews: googleNewsCount,
      bingNews: bingNewsCount,
      duckDuckGo: duckDuckGoCount,
      yandexSearch: yandexSearchCount,
      gdelt: gdeltCount,
      rssFeeds: rssFeedsCount,
      officialRegulatory: officialRegulatoryCount,
      githubIssues: githubIssuesCount,
      gitLabIssues: gitLabIssuesCount,
      reddit: redditCount,
      hackerNews: hackerNewsCount,
      stackOverflow: stackOverflowCount,
      lemmy: lemmyCount,
      zhihuSearch: zhihuSearchCount,
      quoraSearch: quoraSearchCount,
      substackSearch: substackSearchCount,
      mediumSearch: mediumSearchCount,
      wordpressSearch: wordpressSearchCount,
      blogspotSearch: blogspotSearchCount,
      tumblrSearch: tumblrSearchCount,
      mastodon: mastodonCount,
      bluesky: blueskyCount,
      telegramPublic: telegramPublicCount,
      ptt: pttCount,
      dcard: dcardCount,
      tiebaSearch: tiebaSearchCount,
      threads: threadsCount,
      instagram: instagramCount,
      xSearch: xSearchCount,
      facebookSearch: facebookSearchCount,
      linkedinSearch: linkedinSearchCount,
      weiboSearch: weiboSearchCount,
      xiaohongshuSearch: xiaohongshuSearchCount,
      tiktokSearch: tiktokSearchCount,
      douyinSearch: douyinSearchCount,
      kuaishouSearch: kuaishouSearchCount,
      youtube: youtubeCount,
      bilibili: bilibiliCount,
      applePodcastSearch: applePodcastSearchCount,
      appStoreReviews: appStoreReviewsCount,
      googlePlayReviews: googlePlayReviewsCount,
      publicReviewSites: publicReviewSitesCount,
      verticalReviewSources: verticalReviewSourcesCount,
      employerReviewSources: employerReviewSourcesCount,
      ecommerceReviewSources: ecommerceReviewSourcesCount,
      localReviewSources: localReviewSourcesCount,
      regionalComplaintSources: regionalComplaintSourcesCount,
      legalPublicRecords: legalPublicRecordsCount,
      publicProcurementSources: publicProcurementSourcesCount,
      publicSanctionsSources: publicSanctionsSourcesCount,
      publicProductRecallSources: publicProductRecallSourcesCount,
      publicEnforcementActionSources: publicEnforcementActionSourcesCount,
      publicAdvertisingRulingsSources: publicAdvertisingRulingsSourcesCount,
      publicRegulatoryWarningLetterSources: publicRegulatoryWarningLetterSourcesCount,
      publicCompanyFilingsSources: publicCompanyFilingsSourcesCount,
      brandImpersonationSources: brandImpersonationSourcesCount,
      securityAdvisorySources: securityAdvisorySourcesCount,
      supplyChainAdvisorySources: supplyChainAdvisorySourcesCount,
      investorDiscussionSources: investorDiscussionSourcesCount,
      publicStatusPageSources: publicStatusPageSourcesCount,
      officialOwnedMediaSources: officialOwnedMediaSourcesCount,
    } = counts;
    const total = browserFallbackCount + taiwanNewsCount + yahooTaiwanCount + yahooJapanNewsCount + naverKoreaNewsCount + daumKoreaNewsCount + baiduSearchCount + baiduNewsCount + sogouSearchCount + soSearchCount + yandexSearchCount + wechatPublicSearchCount + toutiaoSearchCount + googleNewsCount + bingNewsCount + duckDuckGoCount + gdeltCount + rssFeedsCount + officialRegulatoryCount + legalPublicRecordsCount + publicProcurementSourcesCount + publicSanctionsSourcesCount + publicProductRecallSourcesCount + publicEnforcementActionSourcesCount + publicAdvertisingRulingsSourcesCount + publicRegulatoryWarningLetterSourcesCount + publicCompanyFilingsSourcesCount + brandImpersonationSourcesCount + securityAdvisorySourcesCount + supplyChainAdvisorySourcesCount + investorDiscussionSourcesCount + publicStatusPageSourcesCount + officialOwnedMediaSourcesCount + githubIssuesCount + gitLabIssuesCount + redditCount + hackerNewsCount + stackOverflowCount + lemmyCount + zhihuSearchCount + quoraSearchCount + substackSearchCount + mediumSearchCount + wordpressSearchCount + blogspotSearchCount + tumblrSearchCount + mastodonCount + blueskyCount + telegramPublicCount + pttCount + dcardCount + tiebaSearchCount + threadsCount + instagramCount + xSearchCount + facebookSearchCount + linkedinSearchCount + weiboSearchCount + xiaohongshuSearchCount + tiktokSearchCount + douyinSearchCount + kuaishouSearchCount + youtubeCount + bilibiliCount + applePodcastSearchCount + appStoreReviewsCount + googlePlayReviewsCount + publicReviewSitesCount + verticalReviewSourcesCount + employerReviewSourcesCount + ecommerceReviewSourcesCount + localReviewSourcesCount + regionalComplaintSourcesCount;
    const failureCount = countFailures(failures);
    const riskRow = db.prepare(`
      SELECT
        SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) AS negative,
        0 AS highRisk
      FROM crm_sentiment
      WHERE found_at >= ?
    `).get(startedAtIso);
    const durationMs = Date.now() - startedAt;
    const intelligence = processSentimentIntelligence({
      since: startedAtIso,
      bus,
      log,
      notificationSettings: typeof notificationSettings === "function" ? notificationSettings() : notificationSettings,
    });
    log.info(`[CRM/Scraper] 掃描完成：授權瀏覽器兜底 ${browserFallbackCount} 條，台灣新聞 ${taiwanNewsCount} 條，Yahoo奇摩 ${yahooTaiwanCount} 條，Yahoo Japan 公開新聞搜索 ${yahooJapanNewsCount} 條，Naver 韓國公開新聞搜索 ${naverKoreaNewsCount} 條，Daum/Kakao 韓國公開新聞搜索 ${daumKoreaNewsCount} 條，百度公開搜索 ${baiduSearchCount} 條，百度新聞搜索 ${baiduNewsCount} 條，搜狗公開搜索 ${sogouSearchCount} 條，360公開搜索 ${soSearchCount} 條，Yandex 公開搜索 ${yandexSearchCount} 條，微信公開文章搜索 ${wechatPublicSearchCount} 條，今日頭條公開文章搜索 ${toutiaoSearchCount} 條，Google News ${googleNewsCount} 條，Bing News ${bingNewsCount} 條，DuckDuckGo ${duckDuckGoCount} 條，GDELT ${gdeltCount} 條，通用 RSS ${rssFeedsCount} 條，官方/監管公告 ${officialRegulatoryCount} 條，法律/訴訟公開記錄 ${legalPublicRecordsCount} 條，公開採購/合約公告 ${publicProcurementSourcesCount} 條，公開制裁/風險名單 ${publicSanctionsSourcesCount} 條，公開產品召回/安全警示 ${publicProductRecallSourcesCount} 條，公開執法/投訴記錄 ${publicEnforcementActionSourcesCount} 條，公開廣告監管裁決 ${publicAdvertisingRulingsSourcesCount} 條，公開監管警告信 ${publicRegulatoryWarningLetterSourcesCount} 條，上市公司 SEC 公開披露 ${publicCompanyFilingsSourcesCount} 條，品牌仿冒/釣魚域名 ${brandImpersonationSourcesCount} 條，安全漏洞/已利用漏洞公告 ${securityAdvisorySourcesCount} 條，開源供應鏈漏洞公告 ${supplyChainAdvisorySourcesCount} 條，投資者/市場討論源 ${investorDiscussionSourcesCount} 條，公開狀態頁/服務中斷 ${publicStatusPageSourcesCount} 條，官方自有媒體/新聞室 ${officialOwnedMediaSourcesCount} 條，GitHub Issues ${githubIssuesCount} 條，GitLab Issues ${gitLabIssuesCount} 條，Reddit ${redditCount} 條，Hacker News ${hackerNewsCount} 條，Stack Overflow ${stackOverflowCount} 條，Lemmy ${lemmyCount} 條，知乎公開搜索 ${zhihuSearchCount} 條，Quora公開搜索 ${quoraSearchCount} 條，Substack公開搜索 ${substackSearchCount} 條，Medium公開搜索 ${mediumSearchCount} 條，WordPress公開博客搜索 ${wordpressSearchCount} 條，Blogspot/Blogger公開博客搜索 ${blogspotSearchCount} 條，Tumblr公開搜索 ${tumblrSearchCount} 條，Mastodon ${mastodonCount} 條，Bluesky ${blueskyCount} 條，Telegram 公開頻道 ${telegramPublicCount} 條，PTT ${pttCount} 條，Dcard ${dcardCount} 條，百度貼吧公開搜索 ${tiebaSearchCount} 條，Threads ${threadsCount} 條，Instagram/INS ${instagramCount} 條，X/Twitter公開搜索 ${xSearchCount} 條，Facebook公開搜索 ${facebookSearchCount} 條，LinkedIn公開搜索 ${linkedinSearchCount} 條，微博公開搜索 ${weiboSearchCount} 條，小紅書公開搜索 ${xiaohongshuSearchCount} 條，TikTok公開視頻搜索 ${tiktokSearchCount} 條，抖音公開視頻搜索 ${douyinSearchCount} 條，快手公開視頻搜索 ${kuaishouSearchCount} 條，YouTube ${youtubeCount} 條，Bilibili/B站 ${bilibiliCount} 條，Apple Podcasts ${applePodcastSearchCount} 條，App Store 評論 ${appStoreReviewsCount} 條，Google Play 評論 ${googlePlayReviewsCount} 條，公開評價/投訴站 ${publicReviewSitesCount} 條，垂直產品/社群評價源 ${verticalReviewSourcesCount} 條，雇主/員工公開評價源 ${employerReviewSourcesCount} 條，電商/市場公開評價源 ${ecommerceReviewSourcesCount} 條，本地商家/服務公開評價源 ${localReviewSourcesCount} 條，區域投訴/消費者保護源 ${regionalComplaintSourcesCount} 條，用時 ${durationMs}ms`);
    const finishedBatch = finishSentimentScanBatch(batch?.id, {
      status: failures.length ? "partial" : "success",
      total,
      failureCount,
      durationMs,
    });
    const finalCollectionJobs = listSentimentCollectionJobs({ batchId: batch?.id, limit: 300 });
    const sourceExecution = buildSourceExecutionDiagnostics({
      plan,
      sourceRecords,
      explicitJobs,
      implicitAlternateJobs,
      runnableJobs,
      collectionJobs: finalCollectionJobs,
      counts,
      failures,
      sourceKeywordPlans,
      sourceBudgets,
      sourceDeepBudgets,
      sourceFailoverPlans,
      postRunFailoverPlans,
    });
    const postScanEvidenceFollowupSettings = search?.postScanEvidenceFollowup || {};
    let postScanEvidenceFollowup = {
      ok: true,
      applied: false,
      post_scan: true,
      summary: {
        created_jobs: 0,
        skipped_apply_reason: total > 0 ? "disabled" : "no-scan-results",
      },
      jobs: [],
    };
    if (total > 0 && postScanEvidenceFollowupSettings.enabled !== false) {
      try {
        postScanEvidenceFollowup = applySentimentPostScanEvidenceFollowupJobs({
          apply: true,
          batchId: finishedBatch?.id || batch?.id || 0,
          days: postScanEvidenceFollowupSettings.days || 30,
          limit: postScanEvidenceFollowupSettings.limit || 30,
          evidenceLimit: postScanEvidenceFollowupSettings.evidenceLimit || 18,
          minAverageDepth: postScanEvidenceFollowupSettings.minAverageDepth || 55,
          maxThinEvidence: postScanEvidenceFollowupSettings.maxThinEvidence || 0,
          operator: "scan-runner",
          reason: "automatic post-scan evidence depth follow-up",
        });
        if (Number(postScanEvidenceFollowup.summary?.created_jobs || 0) > 0) {
          log.info(`[CRM/Scraper] 掃描後證據補采已排隊：${postScanEvidenceFollowup.summary.created_jobs} 個任務`);
        }
      } catch (error) {
        postScanEvidenceFollowup = {
          ok: false,
          applied: false,
          post_scan: true,
          error: error?.message || String(error),
          summary: {
            created_jobs: 0,
            skipped_apply_reason: "post-scan-followup-error",
          },
          jobs: [],
        };
        log.warn(`[CRM/Scraper] 掃描後證據補采規劃失敗: ${postScanEvidenceFollowup.error}`);
      }
    }

    // 有新結果時推送通知
    if (total > 0) {
      try {
        bus.emit({
          type: "crm:sentiment-new",
          count: total,
          browserFallback: browserFallbackCount,
          taiwanNews: taiwanNewsCount,
          yahooTaiwan: yahooTaiwanCount,
          yahooJapanNews: yahooJapanNewsCount,
          naverKoreaNews: naverKoreaNewsCount,
          daumKoreaNews: daumKoreaNewsCount,
          baiduSearch: baiduSearchCount,
          baiduNews: baiduNewsCount,
          sogouSearch: sogouSearchCount,
          soSearch: soSearchCount,
          wechatPublicSearch: wechatPublicSearchCount,
          toutiaoSearch: toutiaoSearchCount,
          googleNews: googleNewsCount,
          bingNews: bingNewsCount,
          duckDuckGo: duckDuckGoCount,
          yandexSearch: yandexSearchCount,
          gdelt: gdeltCount,
          rssFeeds: rssFeedsCount,
          officialRegulatory: officialRegulatoryCount,
          legalPublicRecords: legalPublicRecordsCount,
          publicProcurementSources: publicProcurementSourcesCount,
          publicSanctionsSources: publicSanctionsSourcesCount,
          publicProductRecallSources: publicProductRecallSourcesCount,
          publicEnforcementActionSources: publicEnforcementActionSourcesCount,
          publicAdvertisingRulingsSources: publicAdvertisingRulingsSourcesCount,
          publicRegulatoryWarningLetterSources: publicRegulatoryWarningLetterSourcesCount,
          publicCompanyFilingsSources: publicCompanyFilingsSourcesCount,
          brandImpersonationSources: brandImpersonationSourcesCount,
          securityAdvisorySources: securityAdvisorySourcesCount,
          supplyChainAdvisorySources: supplyChainAdvisorySourcesCount,
          investorDiscussionSources: investorDiscussionSourcesCount,
          publicStatusPageSources: publicStatusPageSourcesCount,
          officialOwnedMediaSources: officialOwnedMediaSourcesCount,
          githubIssues: githubIssuesCount,
          gitLabIssues: gitLabIssuesCount,
          reddit: redditCount,
          hackerNews: hackerNewsCount,
          stackOverflow: stackOverflowCount,
          lemmy: lemmyCount,
          zhihuSearch: zhihuSearchCount,
          quoraSearch: quoraSearchCount,
          substackSearch: substackSearchCount,
          mediumSearch: mediumSearchCount,
          wordpressSearch: wordpressSearchCount,
          blogspotSearch: blogspotSearchCount,
          tumblrSearch: tumblrSearchCount,
          mastodon: mastodonCount,
          bluesky: blueskyCount,
          telegramPublic: telegramPublicCount,
          ptt: pttCount,
          dcard: dcardCount,
          tiebaSearch: tiebaSearchCount,
          threads: threadsCount,
          instagram: instagramCount,
          xSearch: xSearchCount,
          facebookSearch: facebookSearchCount,
          linkedinSearch: linkedinSearchCount,
          weiboSearch: weiboSearchCount,
          xiaohongshuSearch: xiaohongshuSearchCount,
          tiktokSearch: tiktokSearchCount,
          douyinSearch: douyinSearchCount,
          kuaishouSearch: kuaishouSearchCount,
          youtube: youtubeCount,
          bilibili: bilibiliCount,
          applePodcastSearch: applePodcastSearchCount,
          appStoreReviews: appStoreReviewsCount,
          googlePlayReviews: googlePlayReviewsCount,
          publicReviewSites: publicReviewSitesCount,
          verticalReviewSources: verticalReviewSourcesCount,
          employerReviewSources: employerReviewSourcesCount,
          ecommerceReviewSources: ecommerceReviewSourcesCount,
          localReviewSources: localReviewSourcesCount,
          regionalComplaintSources: regionalComplaintSourcesCount,
          negative: Number(riskRow?.negative || 0),
          highRisk: Number(riskRow?.highRisk || 0),
          events: intelligence.events.length,
          alerts: intelligence.createdAlerts,
        }, null);
      } catch { /* 靜默忽略 */ }
    }

    return {
      browserFallback: browserFallbackCount,
      taiwanNews: taiwanNewsCount,
      yahooTaiwan: yahooTaiwanCount,
      yahooJapanNews: yahooJapanNewsCount,
      naverKoreaNews: naverKoreaNewsCount,
      daumKoreaNews: daumKoreaNewsCount,
      baiduSearch: baiduSearchCount,
      baiduNews: baiduNewsCount,
      sogouSearch: sogouSearchCount,
      soSearch: soSearchCount,
      wechatPublicSearch: wechatPublicSearchCount,
      toutiaoSearch: toutiaoSearchCount,
      googleNews: googleNewsCount,
      bingNews: bingNewsCount,
      duckDuckGo: duckDuckGoCount,
      yandexSearch: yandexSearchCount,
      gdelt: gdeltCount,
      rssFeeds: rssFeedsCount,
      officialRegulatory: officialRegulatoryCount,
      legalPublicRecords: legalPublicRecordsCount,
      publicProcurementSources: publicProcurementSourcesCount,
      publicSanctionsSources: publicSanctionsSourcesCount,
      publicProductRecallSources: publicProductRecallSourcesCount,
      publicEnforcementActionSources: publicEnforcementActionSourcesCount,
      publicAdvertisingRulingsSources: publicAdvertisingRulingsSourcesCount,
      publicRegulatoryWarningLetterSources: publicRegulatoryWarningLetterSourcesCount,
      publicCompanyFilingsSources: publicCompanyFilingsSourcesCount,
      brandImpersonationSources: brandImpersonationSourcesCount,
      securityAdvisorySources: securityAdvisorySourcesCount,
      supplyChainAdvisorySources: supplyChainAdvisorySourcesCount,
      investorDiscussionSources: investorDiscussionSourcesCount,
      publicStatusPageSources: publicStatusPageSourcesCount,
      officialOwnedMediaSources: officialOwnedMediaSourcesCount,
      githubIssues: githubIssuesCount,
      gitLabIssues: gitLabIssuesCount,
      reddit: redditCount,
      hackerNews: hackerNewsCount,
      stackOverflow: stackOverflowCount,
      lemmy: lemmyCount,
      zhihuSearch: zhihuSearchCount,
      quoraSearch: quoraSearchCount,
      substackSearch: substackSearchCount,
      mediumSearch: mediumSearchCount,
      wordpressSearch: wordpressSearchCount,
      blogspotSearch: blogspotSearchCount,
      tumblrSearch: tumblrSearchCount,
      mastodon: mastodonCount,
      bluesky: blueskyCount,
      telegramPublic: telegramPublicCount,
      ptt: pttCount,
      dcard: dcardCount,
      tiebaSearch: tiebaSearchCount,
      threads: threadsCount,
      instagram: instagramCount,
      xSearch: xSearchCount,
      facebookSearch: facebookSearchCount,
      linkedinSearch: linkedinSearchCount,
      weiboSearch: weiboSearchCount,
      xiaohongshuSearch: xiaohongshuSearchCount,
      tiktokSearch: tiktokSearchCount,
      douyinSearch: douyinSearchCount,
      kuaishouSearch: kuaishouSearchCount,
      youtube: youtubeCount,
      bilibili: bilibiliCount,
      applePodcastSearch: applePodcastSearchCount,
      appStoreReviews: appStoreReviewsCount,
      googlePlayReviews: googlePlayReviewsCount,
      publicReviewSites: publicReviewSitesCount,
      verticalReviewSources: verticalReviewSourcesCount,
      employerReviewSources: employerReviewSourcesCount,
      ecommerceReviewSources: ecommerceReviewSourcesCount,
      localReviewSources: localReviewSourcesCount,
      regionalComplaintSources: regionalComplaintSourcesCount,
      total,
      negative: Number(riskRow?.negative || 0),
      highRisk: Number(riskRow?.highRisk || 0),
      events: intelligence.events.length,
      alerts: intelligence.createdAlerts,
      keywords,
      sources: plan.sources,
      activeSources: explicitJobs.map(job => job.key),
      requestedSources: plan.sources,
      disabledSources,
      mode: plan.mode,
      lane: plan.lane,
      fullSources: search.sources,
      sourceExecution,
      enrich: plan.enrich,
      proxyEnabled: search.proxyEnabled,
      failures: summarizeScanFailures(failures),
      failureCount,
      sourceHealth: getSentimentSourceHealth(),
      sourceThrottle: listSentimentSourceThrottleState({ sources: sourceRecords }),
      duration_ms: durationMs,
      searchKeywords,
      qualityFeedback: plan.qualityFeedback,
      monitoredEntityKeywords: plan.monitoredEntityKeywords,
      entityFootprintKeywords: plan.entityFootprintKeywords,
      entityTopicRecallKeywords: plan.entityTopicRecallKeywords,
      eventExpansionKeywords: plan.eventExpansionKeywords,
      sourceTrackingSignals: trackingSourceSignals,
      sourceAlertEventSignals: alertEventSourceSignals,
      sourceRealtimeHotTopicSignals: realtimeHotTopicSourceSignals,
      sourceRealtimeAnomalyWindowSignals: realtimeAnomalyWindowSourceSignals,
      sourceAnomalySignals: anomalySourceSignals,
      sourceFreeTargetCoverageSignals: freeSourceTargetCoverageSignals,
      sourceOfficialRegulatoryFollowupSignals: officialRegulatoryFollowupSourceSignals,
      sourceEvidenceGapSignals: evidenceGapSourceSignals,
      sourceSocialFollowupSignals: socialFollowupSourceSignals,
      sourceAccessBarrierAlternateSignals: accessBarrierAlternateSourceSignals,
      sourceCollectionOperationsRemediationSignals: collectionOperationsRemediationSourceSignals,
      sourcePropagationConfidenceSignals: propagationConfidenceSourceSignals,
      sourceEventClusterSignals: eventClusterSourceSignals,
      sourceEventClusterFollowupTargets: Object.fromEntries(explicitJobs.map(job => [
        job.key,
        eventClusterFollowupTargetsForSource(job.key, eventClusterSourceSignals[job.key]),
      ])),
      sourceCommercialSignals: commercialSourceSignals,
      entityTopicSourceSignals,
      sourceKeywordFamilyCoverageSignals: keywordFamilyCoverageSignals,
      sourceCoverageSignals,
      sourceRecoveryActions: Object.fromEntries(sourceRecoveryActions.entries()),
      sourceFailoverPlans: Object.fromEntries(sourceFailoverPlans.entries()),
      postRunFailoverPlans: Object.fromEntries(postRunFailoverPlans.entries()),
      sourceKeywordPlans: Object.fromEntries(sourceKeywordPlans.entries()),
      sourceBudgets: Object.fromEntries(explicitJobs.map(job => [job.key, budgetForSource(job.key)])),
      sourceDeepBudgets: Object.fromEntries(explicitJobs.map(job => [job.key, deepBudgetForSource(job.key)])),
      scanBatch: finishedBatch,
      postScanEvidenceFollowup,
      collectionJobs: finalCollectionJobs,
    };
  };
}

export function configureSentimentRunner({ bus, log, notificationSettings, searchSettings } = {}) {
  activeRunner = createScraperRunner({
    bus: safeBus(bus),
    log: log || fallbackLog(),
    notificationSettings,
    searchSettings,
  });
  return activeRunner;
}

export async function runSentimentScanNow({ reason = "manual", mode = SCAN_MODE_FAST, sources = null, days = null } = {}) {
  if (inFlight) return inFlight;
  if (!activeRunner) configureSentimentRunner();

  monitorState = { ...monitorState, running: true, lastError: null };
  inFlight = activeRunner({ mode: normalizeSentimentScanMode(mode), reason, sources })
    .then(result => {
      const scanDays = Math.max(1, Math.min(365, Number(days || 0) || 30));
      lastScanResult = { ...result, reason, days: scanDays, scanDays, finishedAt: new Date().toISOString() };
      monitorState = {
        ...monitorState,
        running: false,
        lastRun: lastScanResult,
        nextRunAt: monitorState.enabled
          ? new Date(Date.now() + monitorState.intervalMs).toISOString()
          : null,
      };
      return monitorState.lastRun;
    })
    .catch(err => {
      monitorState = {
        ...monitorState,
        running: false,
        lastError: err?.message || String(err),
        nextRunAt: monitorState.enabled
          ? new Date(Date.now() + monitorState.intervalMs).toISOString()
          : null,
      };
      throw err;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export async function executeSentimentContinuousCollectionCycle({
  mode = SCAN_MODE_FAST,
  maxSources = 8,
  retryLimit = 3,
  postScanFollowupLimit = null,
  discoveryDeepCrawl = true,
  discoveryDeepCrawlLimit = 3,
  discoveryDeepCrawlFollowupLimit = null,
  searchSettings = null,
  now = Date.now(),
  log = fallbackLog(),
} = {}) {
  const plan = planSentimentContinuousCollection({
    mode,
    searchSettings,
    maxSources,
    retryLimit: Math.max(retryLimit, 20),
    now,
  });
  const retryResult = await executeDueSentimentCollectionJobs({
    limit: retryLimit,
    now,
    searchSettings,
    log,
  });
  const readySources = plan.ready_scan_sources || [];
  const scanResult = readySources.length
    ? await runSentimentScanNow({ reason: "schedule", mode, sources: readySources })
    : null;
  const createdPostScanFollowupJobs = Number(scanResult?.postScanEvidenceFollowup?.summary?.created_jobs || 0);
  const postScanFollowupBatchId = Number(scanResult?.scanBatch?.id || 0) || null;
  const safePostScanFollowupLimit = postScanFollowupLimit === null || postScanFollowupLimit === undefined
    ? Math.min(createdPostScanFollowupJobs, Math.max(1, Math.min(5, Number(retryLimit) || 1)))
    : Math.max(0, Math.min(25, Number(postScanFollowupLimit) || 0));
  const postScanFollowupResult = createdPostScanFollowupJobs > 0 && postScanFollowupBatchId && safePostScanFollowupLimit > 0
    ? await executeDueSentimentCollectionJobs({
      limit: safePostScanFollowupLimit,
      batchId: postScanFollowupBatchId,
      postScanEvidenceFollowupsOnly: true,
      now: Date.now(),
      searchSettings,
      log,
    })
    : {
      ok: true,
      executed: 0,
      total: 0,
      events: 0,
      alerts: 0,
      jobs: [],
      reason: createdPostScanFollowupJobs > 0
        ? "post-scan-followup-execution-disabled-or-unavailable"
        : "no-post-scan-followup-jobs",
    };
  const deepCrawlPlan = plan.discovery_deep_crawl || {};
  const requestedFollowupLimit = discoveryDeepCrawlFollowupLimit === null || discoveryDeepCrawlFollowupLimit === undefined
    ? Number(deepCrawlPlan.recommended_followup_limit || 0)
    : Number(discoveryDeepCrawlFollowupLimit || 0);
  const deepCrawlResult = discoveryDeepCrawl !== false && deepCrawlPlan.should_execute
    ? await executeSentimentSourceDiscoveryDeepCrawlPlan({
      days: 14,
      limit: 80,
      minScore: deepCrawlPlan.min_score || 65,
      candidateTypes: ["rss-feed", "sitemap", "robots-sitemap", "author-profile", "related-domain", "event-cluster-followup"],
      keywords: normalizeSentimentMonitorKeywords([
        ...resolveSentimentScanKeywords(getDb()),
        ...(deepCrawlPlan.suggested_keywords || []),
      ]).slice(0, 20),
      targetLimit: Math.min(
        Number(deepCrawlPlan.target_limit || 3),
        Math.max(1, Math.min(10, Number(discoveryDeepCrawlLimit) || 3)),
      ),
      followupLimit: Math.max(0, Math.min(10, Number(requestedFollowupLimit) || 0)),
      apply: true,
    })
    : {
      ok: true,
      applied: false,
      selected_count: 0,
      fetched_count: 0,
      inserted: 0,
      updated: 0,
      skipped: [],
      failures: [],
      reason: discoveryDeepCrawl === false ? "disabled" : "no-discovery-deep-crawl-candidates",
    };
  return {
    ok: true,
    plan,
    retryResult,
    scanResult,
    postScanFollowupResult,
    deepCrawlResult,
    executed_scan_sources: readySources,
  };
}

export async function executeDueSentimentCollectionJobs({
  limit = 5,
  batchId = null,
  sourceKey = "",
  postScanEvidenceFollowupsOnly = false,
  searchSettings = null,
  now = Date.now(),
  bus = null,
  log = null,
  notificationSettings = null,
} = {}) {
  const logger = log || fallbackLog();
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 5));
  const dueJobs = listSentimentCollectionJobs({
    batchId,
    sourceKey,
    status: "pending",
    limit: Math.max(50, safeLimit * 4),
    order: "due",
  }).filter(job => {
    const scheduledAt = new Date(job.scheduled_at || job.created_at || 0).getTime();
    return Number.isFinite(scheduledAt) && scheduledAt <= Number(now)
      && (!postScanEvidenceFollowupsOnly || job.metadata?.post_scan_evidence_followup === true)
      && isExecutableCollectionJob(job);
  }).slice(0, safeLimit);
  const search = readSentimentSearchSettings(
    typeof searchSettings === "function" ? searchSettings() : searchSettings
  );
  const sourceRecords = listSentimentSources();
  const sourceRecordByKey = new Map(sourceRecords.map(source => [source.source_key, source]));
  const deepHealthSignals = deriveDeepCollectionHealthSignals(listSentimentDeepCollectionHealthProfiles({
    days: search?.collectionQualityFeedback?.days || 14,
    limit: 200,
  }));
  const entityTopicRetryRecall = search?.monitoredEntities?.enabled === false
    ? { topics: [] }
    : listSentimentEntityTopicRecallGaps({
      search,
      days: search?.collectionQualityFeedback?.days || 14,
      limit: 100,
    });
  const entityTopicRetryTrend = search?.monitoredEntities?.enabled === false
    ? { topics: [] }
    : listSentimentEntityTopicRecallTrend({
      search,
      days: Math.max(30, Number(search?.collectionQualityFeedback?.days || 14) || 14),
      bucketDays: 7,
      limit: 100,
    });
  const entityTopicRetrySignals = deriveEntityTopicSourceSignals(
    mergeEntityTopicRecallSignals(entityTopicRetryRecall, entityTopicRetryTrend)
  );
  const proxyUrl = search.proxyEnabled ? search.proxyUrl : "";
  const results = [];
  let total = 0;
  const startedAtIso = new Date(now).toISOString();
  for (const job of dueJobs) {
    const source = sourceRecordByKey.get(job.source_key);
    if (!source || source.enabled === false) {
      const message = source ? "來源已在 sentiment_sources 中停用" : "來源不存在";
      const updated = updateSentimentCollectionJob(job.id, {
        status: "disabled",
        message,
        metadata: { terminal_reason: "retry-source-disabled" },
      });
      recordSentimentScanSourceLog({
        batchId: job.batch_id,
        sourceKey: job.source_key,
        label: job.label || job.source_key,
        status: "disabled",
        message,
        metadata: { retry_job_id: job.id },
      });
      results.push(updated);
      continue;
    }
    const mode = normalizeSentimentScanMode(job.mode || SCAN_MODE_FAST);
    const query = collectionJobExecutionKeywords(job);
    const executionMetadata = collectionJobExecutionMetadata(job, query);
    const configuredBudget = job.metadata?.budget || search.collectionBudget?.[mode] || {};
    const budget = resolveSourceCollectionBudget(job.source_key, configuredBudget, {
      mode,
      keywords: query,
      source,
    });
    const configuredDeepBudget = job.metadata?.deepBudget || search.deepCollectionBudget?.[mode] || {};
    const deepBudget = resolveSourceDeepCollectionBudget(job.source_key, configuredDeepBudget, {
      mode,
      keywords: query,
      source,
      deepHealthSignal: deepHealthSignals[job.source_key],
      entityTopicSignal: entityTopicRetrySignals[job.source_key],
    });
    const cooldown = activeSourceCooldown(job.source_key, now);
    if (cooldown) {
      const message = `來源暫停中：${cooldown.reason}，約 ${formatDuration(cooldown.until - now)} 後再試`;
      const updated = updateSentimentCollectionJob(job.id, {
        status: "cooldown",
        message,
        coolingUntil: new Date(cooldown.until).toISOString(),
        metadata: { terminal_reason: "retry-source-cooldown" },
      });
      recordSentimentScanSourceLog({
        batchId: job.batch_id,
        sourceKey: job.source_key,
        label: job.label || source.label || job.source_key,
        status: "cooldown",
        message,
        coolingUntil: new Date(cooldown.until).toISOString(),
        metadata: { retry_job_id: job.id },
      });
      results.push(updated);
      continue;
    }
    const throttlePolicy = throttlePolicyForSource(job.source_key, source);
    const throttle = activeDomainThrottle(throttlePolicy, now);
    if (throttle) {
      const message = `來源域名節流中：${throttle.domain}，${throttle.reason}，約 ${formatDuration(throttle.until - now)} 後再試`;
      const updated = updateSentimentCollectionJob(job.id, {
        status: "throttled",
        message,
        coolingUntil: new Date(throttle.until).toISOString(),
        metadata: { terminal_reason: "retry-domain-throttle" },
      });
      recordSentimentScanSourceLog({
        batchId: job.batch_id,
        sourceKey: job.source_key,
        label: job.label || source.label || job.source_key,
        status: "throttled",
        message,
        coolingUntil: new Date(throttle.until).toISOString(),
        metadata: { retry_job_id: job.id, throttleDomain: throttle.domain },
      });
      results.push(updated);
      continue;
    }
    const sourceStartedAt = Date.now();
    updateSentimentCollectionJob(job.id, {
      status: "running",
      startedAt: new Date(sourceStartedAt).toISOString(),
      incrementAttempt: true,
      metadata: {
        ...executionMetadata,
        retry_consumer_started_at: new Date(sourceStartedAt).toISOString(),
        retry_budget: budget,
        retry_deep_budget: deepBudget,
      },
    });
    recordDomainThrottleStart(throttlePolicy, now);
    try {
      const sourceResult = await withSourceJobTimeout(runSingleCollectionSource(job.source_key, query, {
        search,
        source,
        mode,
        proxyUrl,
        budget,
        deepBudget,
        job,
      }), { sourceKey: job.source_key, mode });
      total += sourceResult.count;
      const sourceFailures = sourceResult.failures.map(formatSourceFailure);
      const status = sourceFailures.length ? "partial" : "success";
      const executionDiagnostics = {
        ...(sourceResult.diagnostics || {}),
        ...(evidenceCoverageFollowupDiagnostics(job, query, sourceResult, sourceFailures) || {}),
        ...(freeSourceTargetCoverageFollowupDiagnostics(job, query, sourceResult, sourceFailures) || {}),
      };
      const recoverableAccessBarrier = allFailuresAreRecoverableExternalAccessBarriers(sourceFailures, job.source_key);
      const jobMessage = recoverableAccessBarrier
        ? recoverableExternalAccessBarrierMessage(sourceFailures)
        : sourceFailures[0] || "";
      if (sourceFailures.length) {
        recordSourceFailure(job.source_key, sourceFailures);
        recordDomainThrottleFailure(throttlePolicy, sourceFailures);
        updateSentimentSourceScanState(job.source_key, {
          success: false,
          error: recoverableAccessBarrier ? "" : sourceFailures[0] || "部分重試失敗",
        });
      } else {
        recordSourceSuccess(job.source_key);
        recordDomainThrottleSuccess(throttlePolicy);
        updateSentimentSourceScanState(job.source_key, { success: true });
      }
      const updated = updateSentimentCollectionJob(job.id, {
        status,
        resultCount: sourceResult.count,
        failureCount: sourceFailures.length,
        durationMs: Date.now() - sourceStartedAt,
        message: jobMessage,
        metadata: {
          ...executionMetadata,
          terminal_reason: status === "success"
            ? "retry-source-success"
            : recoverableAccessBarrier
            ? "retry-recoverable-external-access-barrier"
            : "retry-partial-source-failures",
          failures: sourceFailures,
          recoverableAccessBarrier,
          ...(Object.keys(executionDiagnostics).length ? { diagnostics: executionDiagnostics } : {}),
        },
      });
      recordSentimentScanSourceLog({
        batchId: job.batch_id,
        sourceKey: job.source_key,
        label: job.label || source.label || job.source_key,
        status,
        count: sourceResult.count,
        failureCount: sourceFailures.length,
        durationMs: Date.now() - sourceStartedAt,
        message: jobMessage,
        metadata: {
          ...executionMetadata,
          budget,
          deepBudget,
          ...(Object.keys(executionDiagnostics).length ? { diagnostics: executionDiagnostics } : {}),
        },
      });
      results.push(updated);
    } catch (error) {
      const message = String(error?.message || error || "retry job failed");
      const recoverableAccessBarrier = isRecoverableExternalAccessBarrier(message, job.source_key);
      const displayMessage = recoverableAccessBarrier
        ? recoverableExternalAccessBarrierMessage([message])
        : message;
      recordSourceFailure(job.source_key, message);
      recordDomainThrottleFailure(throttlePolicy, message);
      updateSentimentSourceScanState(job.source_key, { success: false, error: recoverableAccessBarrier ? "" : message });
      const updated = updateSentimentCollectionJob(job.id, {
        status: recoverableAccessBarrier ? "blocked" : "failed",
        failureCount: 1,
        durationMs: Date.now() - sourceStartedAt,
        message: displayMessage,
        metadata: {
          ...executionMetadata,
          terminal_reason: recoverableAccessBarrier ? "retry-recoverable-external-access-barrier" : "retry-source-exception",
          retry_recommended: true,
          recoverableAccessBarrier,
        },
      });
      recordSentimentScanSourceLog({
        batchId: job.batch_id,
        sourceKey: job.source_key,
        label: job.label || source.label || job.source_key,
        status: recoverableAccessBarrier ? "blocked" : "failed",
        failureCount: 1,
        durationMs: Date.now() - sourceStartedAt,
        message: displayMessage,
        metadata: executionMetadata,
      });
      logger.warn(`[CRM/Scraper] retry job ${job.id} ${job.source_key} ${recoverableAccessBarrier ? "blocked" : "failed"}: ${displayMessage}`);
      results.push(updated);
    }
  }
  const intelligence = total > 0
    ? processSentimentIntelligence({
      since: startedAtIso,
      bus: safeBus(bus),
      log: logger,
      notificationSettings: typeof notificationSettings === "function" ? notificationSettings() : notificationSettings,
    })
    : { events: [], createdAlerts: 0 };
  return {
    ok: true,
    executed: results.length,
    total,
    events: intelligence.events?.length || 0,
    alerts: intelligence.createdAlerts || 0,
    jobs: results,
  };
}

export function startSentimentScheduler({ intervalMs = DEFAULT_SCAN_INTERVAL_MS, mode = SCAN_MODE_FAST, sources = null, watchEnabled = false, watchIntervalMs = 0, watchSources = null } = {}) {
  stopSentimentScheduler();
  const scanMode = normalizeSentimentScanMode(mode);
  const safeWatchIntervalMs = Math.max(60 * 1000, Math.min(60 * 60 * 1000, Number(watchIntervalMs || 0) || 0));
  const schedulerSources = Array.isArray(sources) && sources.length ? [...new Set(sources.map(source => String(source || "").trim()).filter(Boolean))] : null;
  const schedulerWatchSources = Array.isArray(watchSources) && watchSources.length ? [...new Set(watchSources.map(source => String(source || "").trim()).filter(Boolean))] : null;
  monitorState = {
    ...monitorState,
    enabled: true,
    intervalMs,
    mode: scanMode,
    sources: schedulerSources,
    watchEnabled: watchEnabled === true && safeWatchIntervalMs > 0,
    watchIntervalMs: watchEnabled === true && safeWatchIntervalMs > 0 ? safeWatchIntervalMs : 0,
    watchSources: schedulerWatchSources,
    nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
    nextWatchRunAt: watchEnabled === true && safeWatchIntervalMs > 0 ? new Date(Date.now() + safeWatchIntervalMs).toISOString() : null,
  };
  schedulerTimer = setInterval(() => {
    executeSentimentContinuousCollectionCycle({
      mode: scanMode,
      retryLimit: 3,
      maxSources: 8,
      searchSettings: schedulerSearchSettingsWithSources(schedulerSources),
      log: fallbackLog(),
    }).catch(err => {
      const message = err?.message || String(err);
      (console.warn || console.log)(`[CRM/Scraper] 連續采集週期失敗: ${message}`);
    });
  }, intervalMs);
  schedulerTimer.unref?.();
  if (monitorState.watchEnabled) {
    watchSchedulerTimer = setInterval(() => {
      runSentimentScanNow({ reason: "watch", mode: SCAN_MODE_WATCH, sources: schedulerWatchSources }).then(() => {
        monitorState = {
          ...monitorState,
          nextWatchRunAt: monitorState.watchEnabled
            ? new Date(Date.now() + monitorState.watchIntervalMs).toISOString()
            : null,
        };
      }).catch(err => {
        const message = err?.message || String(err);
        (console.warn || console.log)(`[CRM/Scraper] 高風險 watch 掃描失敗: ${message}`);
      });
    }, safeWatchIntervalMs);
    watchSchedulerTimer.unref?.();
  }
  return getSentimentMonitorStatus();
}

export function stopSentimentScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (watchSchedulerTimer) clearInterval(watchSchedulerTimer);
  schedulerTimer = null;
  watchSchedulerTimer = null;
  monitorState = { ...monitorState, enabled: false, watchEnabled: false, sources: null, watchSources: null, nextRunAt: null, nextWatchRunAt: null };
}

export function getLastSentimentScanResult() {
  return lastScanResult ? { ...lastScanResult } : null;
}

export function getSentimentMonitorStatus() {
  return {
    ...monitorState,
    running: !!inFlight || monitorState.running,
    sourceHealth: getSentimentSourceHealth(),
    sourceSchedule: listSentimentSourceSchedule(),
    sourceThrottle: listSentimentSourceThrottleState(),
  };
}
