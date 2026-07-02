/**
 * scrapers/supply-chain-advisory-sources.js — public open-source supply-chain advisory discovery
 *
 * Uses no-key public vulnerability intelligence sources:
 * OSV.dev package vulnerability API, GitHub Global Security Advisories,
 * and public package-registry search signals.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 12;
const DEFAULT_MAX_PACKAGES_PER_KEYWORD = 8;
const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const GITHUB_ADVISORIES_URL = "https://api.github.com/advisories";
const NPM_REGISTRY_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
const CRATES_IO_SEARCH_URL = "https://crates.io/api/v1/crates";
const PYPI_PROJECT_JSON_BASE_URL = "https://pypi.org/pypi";
const RUBYGEMS_SEARCH_URL = "https://rubygems.org/api/v1/search.json";
const PACKAGIST_SEARCH_URL = "https://packagist.org/search.json";
const GO_DEPS_DEV_PACKAGE_BASE_URL = "https://api.deps.dev/v3alpha/systems/go/packages";
const MAVEN_CENTRAL_SEARCH_URL = "https://search.maven.org/solrsearch/select";
const NUGET_SEARCH_URL = "https://azuresearch-usnc.nuget.org/query";
const DOCKER_HUB_SEARCH_URL = "https://hub.docker.com/v2/search/repositories/";
const QUAY_SEARCH_URL = "https://quay.io/api/v1/find/repositories";
const DEFAULT_ECOSYSTEMS = ["npm", "PyPI", "Maven", "Go", "RubyGems", "Packagist", "crates.io", "NuGet"];
const SUPPLY_CHAIN_RISK_TERMS = [
  "security", "vulnerability", "malware", "phishing", "trojan", "stealer", "ransomware", "backdoor",
  "exploit", "credential", "token", "password", "scam", "typosquat", "impersonation",
  "漏洞", "安全", "恶意", "惡意", "木马", "木馬", "钓鱼", "釣魚", "仿冒", "后门", "後門",
];

function cleanText(value = "", max = 1200) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const maxPackages = Math.round(Number(budget.maxPackagesPerKeyword || budget.max_packages_per_keyword || DEFAULT_MAX_PACKAGES_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(30, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPackagesPerKeyword: Number.isFinite(maxPackages) ? Math.max(1, Math.min(16, maxPackages)) : DEFAULT_MAX_PACKAGES_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function keywordTokens(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  const scoped = [...raw.matchAll(/@[a-z0-9_.-]+\/[a-z0-9_.-]+/gi)].map(match => match[0].toLowerCase());
  const words = raw
    .split(/[\s,;|()[\]{}"'`]+/)
    .map(item => item.trim().replace(/^pkg:/i, ""))
    .filter(item => item.length >= 3 && /^[\w@./:+-]+$/i.test(item));
  return [...new Set([raw, compact, ...scoped, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function packageCandidatesForKeyword(keyword = "", { ecosystems = DEFAULT_ECOSYSTEMS, limit = DEFAULT_MAX_PACKAGES_PER_KEYWORD } = {}) {
  const tokens = keywordTokens(keyword).filter(token => token.length >= 3);
  const out = [];
  for (const token of tokens) {
    const name = token.replace(/^https?:\/\/[^/]+\//i, "").replace(/^github\.com\//i, "").replace(/\/+$/g, "");
    if (!name || name.length > 120) continue;
    for (const ecosystem of ecosystems) {
      out.push({ ecosystem, name });
      if (out.length >= Math.max(1, Math.min(16, Number(limit) || DEFAULT_MAX_PACKAGES_PER_KEYWORD))) return out;
    }
  }
  return out;
}

function pypiProjectCandidatesForKeyword(keyword = "", { limit = DEFAULT_MAX_PACKAGES_PER_KEYWORD } = {}) {
  const out = [];
  const seen = new Set();
  for (const token of keywordTokens(keyword)) {
    const variants = [
      token,
      token.replace(/^@([^/]+)\/(.+)$/i, "$1-$2"),
      token.replace(/^@[^/]+\//i, ""),
      token.replace(/[^a-z0-9._-]+/gi, "-"),
      token.replace(/[^a-z0-9]+/gi, ""),
    ];
    for (const variant of variants) {
      const name = cleanText(variant, 120).toLowerCase().replace(/^-+|-+$/g, "");
      if (!name || name.length < 3 || name.length > 120 || !/^[a-z0-9._-]+$/i.test(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= Math.max(1, Math.min(16, Number(limit) || DEFAULT_MAX_PACKAGES_PER_KEYWORD))) return out;
    }
  }
  return out;
}

function goModuleCandidatesForKeyword(keyword = "", { limit = DEFAULT_MAX_PACKAGES_PER_KEYWORD } = {}) {
  const tokens = keywordTokens(keyword);
  const words = cleanText(keyword, 160)
    .split(/[\s,;|()[\]{}"'`]+/)
    .map(item => item.trim().replace(/^@/, "").replace(/[^a-z0-9._/-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase())
    .filter(item => item.length >= 3);
  const out = [];
  const seen = new Set();
  const add = (value = "") => {
    const name = cleanText(value, 180).toLowerCase().replace(/\/+$/g, "");
    if (!name || name.length < 5 || name.length > 180 || !/^[a-z0-9._~/-]+$/i.test(name)) return false;
    if (seen.has(name)) return false;
    seen.add(name);
    out.push(name);
    return out.length >= Math.max(1, Math.min(16, Number(limit) || DEFAULT_MAX_PACKAGES_PER_KEYWORD));
  };
  if (words.length >= 2) {
    const owner = words[0].replace(/\/.*$/g, "");
    const repo = words.slice(1, 4).join("-").replace(/\/+/g, "-");
    const compactRepo = words.slice(1, 4).join("").replace(/\/+/g, "");
    if (owner && repo && add(`github.com/${owner}/${repo}`)) return out;
    if (owner && compactRepo && add(`github.com/${owner}/${compactRepo}`)) return out;
  }
  for (const token of tokens) {
    const normalized = token
      .replace(/^https?:\/\//i, "")
      .replace(/^github\.com\//i, "")
      .replace(/^@/, "")
      .replace(/[^a-z0-9._~/-]+/gi, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized) continue;
    if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(normalized) && add(normalized)) return out;
    if (normalized.includes("/") && add(`github.com/${normalized}`)) return out;
    if (add(`github.com/${normalized}`)) return out;
  }
  return out;
}

function textMatchesKeyword(text = "", keyword = "", packages = []) {
  const lower = String(text || "").toLowerCase();
  if (keywordTokens(keyword).some(token => token.length >= 3 && lower.includes(token))) return true;
  return packages.some(pkg => pkg?.name && lower.includes(String(pkg.name).toLowerCase()));
}

function supplyChainKeywordMatchSource(item = {}, keyword = "") {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return "";
  const metrics = item.metrics || {};
  const fields = [
    { name: "title", value: item.title },
    { name: "content", value: item.content },
    { name: "url", value: item.url },
    { name: "advisory_id", value: metrics.advisory_id },
    { name: "cve_id", value: metrics.cve_id },
    { name: "aliases", value: Array.isArray(metrics.aliases) ? metrics.aliases.join(" ") : "" },
    { name: "registry_package_name", value: metrics.registry_package_name },
    { name: "package_name", value: metrics.package_name },
    { name: "package_description", value: metrics.package_description },
    { name: "package_keywords", value: Array.isArray(metrics.package_keywords) ? metrics.package_keywords.join(" ") : "" },
    { name: "affected_packages", value: Array.isArray(metrics.affected_packages) ? metrics.affected_packages.map(pkg => `${pkg.ecosystem || ""} ${pkg.name || ""}`).join(" ") : "" },
  ];
  for (const field of fields) {
    const value = String(field.value || "").toLowerCase();
    if (tokens.some(token => token.length >= 3 && value.includes(token))) return field.name;
  }
  return "source_search";
}

function withSupplyChainDiagnostics(items = [], { keyword = "", rawResultCount = 0 } = {}) {
  return items.map(item => ({
    ...item,
    metrics: {
      ...(item.metrics || {}),
      supply_chain_search_raw_result_count: Math.max(0, Number(rawResultCount) || 0),
      supply_chain_matched_keyword: cleanText(keyword, 160),
      supply_chain_keyword_match_source: supplyChainKeywordMatchSource(item, keyword),
    },
  }));
}

function osvQueryBody({ ecosystem, name }) {
  return {
    package: {
      ecosystem,
      name,
    },
  };
}

function githubAdvisorySearchUrl(keyword = "", { perPage = 20 } = {}) {
  const params = new URLSearchParams({
    query: cleanText(keyword, 120),
    per_page: String(Math.max(1, Math.min(100, Number(perPage) || 20))),
    sort: "updated",
    direction: "desc",
  });
  return `${GITHUB_ADVISORIES_URL}?${params.toString()}`;
}

function npmRegistrySearchUrl(keyword = "", { size = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  const params = new URLSearchParams({
    text: cleanText(keyword, 120),
    size: String(Math.max(1, Math.min(50, Number(size) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
  });
  return `${NPM_REGISTRY_SEARCH_URL}?${params.toString()}`;
}

function cratesIoSearchUrl(keyword = "", { perPage = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  const params = new URLSearchParams({
    q: cleanText(keyword, 120),
    page: "1",
    per_page: String(Math.max(1, Math.min(50, Number(perPage) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
  });
  return `${CRATES_IO_SEARCH_URL}?${params.toString()}`;
}

function rubygemsSearchUrl(keyword = "") {
  const params = new URLSearchParams({
    query: cleanText(keyword, 120),
  });
  return `${RUBYGEMS_SEARCH_URL}?${params.toString()}`;
}

function packagistSearchUrl(keyword = "", { perPage = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  const params = new URLSearchParams({
    q: cleanText(keyword, 120),
    per_page: String(Math.max(1, Math.min(50, Number(perPage) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
  });
  return `${PACKAGIST_SEARCH_URL}?${params.toString()}`;
}

function mavenCentralSearchUrl(keyword = "", { rows = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  const params = new URLSearchParams({
    q: cleanText(keyword, 120),
    rows: String(Math.max(1, Math.min(50, Number(rows) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    wt: "json",
  });
  return `${MAVEN_CENTRAL_SEARCH_URL}?${params.toString()}`;
}

function nugetSearchUrl(keyword = "", { take = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  const params = new URLSearchParams({
    q: cleanText(keyword, 120),
    take: String(Math.max(1, Math.min(50, Number(take) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    prerelease: "true",
    semVerLevel: "2.0.0",
  });
  return `${NUGET_SEARCH_URL}?${params.toString()}`;
}

function dockerHubSearchUrl(keyword = "", { pageSize = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  const params = new URLSearchParams({
    query: cleanText(keyword, 120),
    page_size: String(Math.max(1, Math.min(50, Number(pageSize) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
  });
  return `${DOCKER_HUB_SEARCH_URL}?${params.toString()}`;
}

function quaySearchUrl(keyword = "", { pageSize = DEFAULT_MAX_ITEMS_PER_KEYWORD } = {}) {
  const params = new URLSearchParams({
    query: cleanText(keyword, 120),
    page: "1",
    includeUsage: "true",
    page_size: String(Math.max(1, Math.min(50, Number(pageSize) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
  });
  return `${QUAY_SEARCH_URL}?${params.toString()}`;
}

function pypiProjectJsonUrl(name = "") {
  return `${PYPI_PROJECT_JSON_BASE_URL}/${encodeURIComponent(cleanText(name, 160))}/json`;
}

function goDepsDevPackageUrl(name = "") {
  return `${GO_DEPS_DEV_PACKAGE_BASE_URL}/${encodeURIComponent(cleanText(name, 180))}`;
}

function normalizeSupplyChainAdvisoryDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeSupplyChainAdvisoryDedupeUrl(embedded);
    }
    url.hash = "";
    for (const param of [
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
    ]) {
      url.searchParams.delete(param);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("#")[0].trim();
  }
}

function supplyChainAdvisoryDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const registryPackage = cleanText(metrics.registry_package_name || "", 220).toLowerCase();
  if (registryPackage && metrics.package_registry === "npm") return `npm:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "crates.io") return `crate:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "PyPI") return `pypi:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "RubyGems") return `gem:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "Packagist") return `composer:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "Go") return `go:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "Maven Central") return `maven:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "NuGet") return `nuget:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "Docker Hub") return `docker:${registryPackage}`;
  if (registryPackage && metrics.package_registry === "Quay.io") return `quay:${registryPackage}`;
  const ids = [
    metrics.advisory_id,
    metrics.cve_id,
    ...(Array.isArray(metrics.aliases) ? metrics.aliases : []),
  ].map(value => cleanText(value, 80).toUpperCase()).filter(Boolean);
  const ghsa = ids.find(value => /^GHSA-/i.test(value));
  if (ghsa) return `ghsa:${ghsa}`;
  const cve = ids.find(value => /^CVE-\d{4}-\d{4,}$/i.test(value));
  if (cve) return `cve:${cve}`;
  const osv = ids.find(value => /^OSV-/i.test(value) || /^PYSEC-|^RUSTSEC-|^GO-/i.test(value));
  if (osv) return `osv:${osv}`;
  return normalizeSupplyChainAdvisoryDedupeUrl(item.url || "");
}

function packageRegistryRiskLevel({ name = "", description = "", keywords = [], downloads = 0, insecure = false, yanked = false } = {}) {
  const text = `${name} ${description} ${(Array.isArray(keywords) ? keywords : []).join(" ")}`.toLowerCase();
  if (insecure) return "high";
  if (yanked && /login|verify|secure|support|wallet|payment|auth|token|claim/i.test(text)) return "high";
  if (yanked) return "medium";
  if (SUPPLY_CHAIN_RISK_TERMS.some(term => text.includes(String(term).toLowerCase()))) return "medium";
  if (Number(downloads) <= 10 && /login|verify|secure|support|wallet|payment|auth|token|claim/i.test(text)) return "medium";
  return "low";
}

function severityRank(value = "") {
  const key = String(value || "").toLowerCase();
  if (key === "critical") return 4;
  if (key === "high") return 3;
  if (key === "medium" || key === "moderate") return 2;
  if (key === "low") return 1;
  return 0;
}

function advisoryRiskLevel({ severity = "", cvssScore = 0 } = {}) {
  if (Number(cvssScore) >= 9 || severityRank(severity) >= 4) return "high";
  if (Number(cvssScore) >= 7 || severityRank(severity) >= 3) return "medium";
  return "low";
}

function packageSensitiveTermSignal({ name = "", description = "", keywords = [] } = {}) {
  const text = `${name} ${description} ${(Array.isArray(keywords) ? keywords : []).join(" ")}`.toLowerCase();
  return /login|verify|secure|support|wallet|payment|auth|token|claim|credential|password|session|cookie|oauth|sso|支付|付款|钱包|錢包|登录|登入|驗證|验证|憑證|凭证|密碼|密码/.test(text);
}

function supplyChainRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function supplyChainRiskSignals({
  title = "",
  content = "",
  severity = "",
  cvssScore = 0,
  affectedPackages = [],
  packageName = "",
  ecosystem = "",
  keywords = [],
  downloads = 0,
  recentDownloads = 0,
  yanked = false,
  insecure = false,
  deprecated = false,
  verified = null,
  official = null,
  fixedVersionCount = 0,
  versionCount = 0,
  container = false,
  maintainerCount = 0,
  repositoryUrl = "",
  homepageUrl = "",
  installScript = false,
  postInstallScript = false,
  newPackage = false,
  abandoned = false,
  expectRepositoryMetadata = false,
} = {}) {
  const affectedCount = Array.isArray(affectedPackages) ? affectedPackages.length : 0;
  const fixedCount = Number(fixedVersionCount || 0) || (Array.isArray(affectedPackages)
    ? affectedPackages.reduce((sum, pkg) => sum + (Array.isArray(pkg.fixed) ? pkg.fixed.length : pkg.firstPatchedVersion ? 1 : 0), 0)
    : 0);
  const totalDownloads = Math.max(0, Number(downloads || 0), Number(recentDownloads || 0));
  const sensitive = packageSensitiveTermSignal({ name: packageName || title, description: content, keywords });
  const text = `${title} ${content} ${packageName} ${ecosystem} ${(Array.isArray(keywords) ? keywords : []).join(" ")}`.toLowerCase();
  const maliciousLanguage = /malware|trojan|backdoor|stealer|phishing|typosquat|dependency confusion|protestware|sabotage|credential theft|token theft|恶意|惡意|木马|木馬|后门|後門|釣魚|钓鱼|仿冒|依赖混淆|依賴混淆/.test(text);
  const dependencyConfusion = /dependency confusion|namespace confusion|typosquat|brandjacking|impersonation|依赖混淆|依賴混淆|仿冒/.test(text);
  const critical = Number(cvssScore || 0) >= 9 || severityRank(severity) >= 4;
  const highSeverity = critical || Number(cvssScore || 0) >= 7 || severityRank(severity) >= 3;
  const lowAdoptionSensitive = sensitive && totalDownloads > 0 && totalDownloads <= 50;
  const unverifiedPublisher = verified === false;
  const unofficialContainer = container && official === false;
  const singleMaintainer = Number(maintainerCount || 0) === 1;
  const noRepository = expectRepositoryMetadata && !cleanText(repositoryUrl || "", 900) && !cleanText(homepageUrl || "", 900);
  const installHook = installScript || postInstallScript || /postinstall|preinstall|install script|lifecycle script|安裝腳本|安装脚本/.test(text);
  const freshOrAbandoned = newPackage || abandoned || /new package|recently published|abandoned|unmaintained|no longer maintained|deprecated|新套件|新包|棄用|弃用|停止維護|停止维护/.test(text);
  const termMatches = (terms = []) => terms.filter(term => {
    const needle = cleanText(term, 160).toLowerCase();
    return needle && text.includes(needle);
  });
  const evidenceTerms = termMatches([
    "cve", "ghsa", "osv", "advisory", "cvss", "critical", "proof of concept", "poc", "exploit", "malware", "trojan", "backdoor", "stealer",
    "漏洞", "公告", "安全公告", "利用", "惡意", "恶意", "木馬", "木马", "後門", "后门",
  ]);
  const impactTerms = termMatches([
    "affected package", "affected packages", "dependency", "transitive", "container", "image", "downloads", "popular", "supply chain", "credential", "token", "payment", "login",
    "受影響套件", "受影响包", "依賴", "依赖", "傳遞依賴", "传递依赖", "容器", "下載", "下载", "供應鏈", "供应链", "憑證", "凭证", "令牌", "支付", "登入", "登录",
  ]);
  const remediationTerms = termMatches([
    "fixed", "patched", "upgrade", "update", "mitigation", "workaround", "yanked", "deprecated", "remove package", "rotate token", "rotate credentials",
    "修復", "修复", "補丁", "补丁", "升級", "升级", "更新", "緩解", "缓解", "下架", "棄用", "弃用", "移除套件", "移除包", "輪換憑證", "轮换凭证",
  ]);
  const exploitTerms = termMatches([
    "exploit", "exploited", "proof of concept", "poc", "remote code execution", "credential theft", "token theft", "steals token", "postinstall", "preinstall", "install script",
    "利用", "已被利用", "遠端代碼執行", "远程代码执行", "憑證竊取", "凭证窃取", "令牌竊取", "令牌窃取", "安裝腳本", "安装脚本",
  ]);
  const evidenceSignal = evidenceTerms.length > 0 || highSeverity || maliciousLanguage;
  const impactScopeSignal = impactTerms.length > 0 || affectedCount > 0 || totalDownloads >= 1000 || container;
  const remediationSignal = remediationTerms.length > 0 || fixedCount > 0 || yanked || deprecated;
  const exploitSignal = exploitTerms.length > 0 || installHook || maliciousLanguage;
  const reasons = [];
  if (critical) reasons.push("critical-advisory");
  else if (highSeverity) reasons.push("high-severity-advisory");
  if (affectedCount >= 2) reasons.push("multi-package-impact");
  if (fixedCount > 0) reasons.push("patched-version-available");
  if (fixedCount === 0 && affectedCount > 0) reasons.push("no-fixed-version-observed");
  if (maliciousLanguage) reasons.push("malicious-package-language");
  if (dependencyConfusion) reasons.push("dependency-confusion-or-typosquat");
  if (sensitive) reasons.push("sensitive-package-keywords");
  if (lowAdoptionSensitive) reasons.push("low-download-sensitive-package");
  if (yanked) reasons.push("yanked-package");
  if (insecure) reasons.push("registry-insecure-flag");
  if (deprecated) reasons.push("deprecated-package");
  if (unverifiedPublisher) reasons.push("unverified-publisher");
  if (unofficialContainer) reasons.push("unofficial-container-image");
  if (singleMaintainer) reasons.push("single-maintainer-package");
  if (noRepository) reasons.push("missing-repository-homepage");
  if (installHook) reasons.push("install-script-execution");
  if (freshOrAbandoned) reasons.push("new-or-abandoned-package");
  if (evidenceSignal) reasons.push("supply-chain-evidence-language");
  if (impactScopeSignal) reasons.push("supply-chain-impact-scope");
  if (remediationSignal) reasons.push("supply-chain-remediation-state");
  if (exploitSignal) reasons.push("supply-chain-exploitability-language");
  const semanticSignals = [
    critical || highSeverity,
    affectedCount > 0,
    fixedCount > 0,
    maliciousLanguage,
    dependencyConfusion,
    sensitive,
    lowAdoptionSensitive,
    yanked,
    insecure,
    deprecated,
    unverifiedPublisher,
    unofficialContainer,
    singleMaintainer,
    noRepository,
    installHook,
    freshOrAbandoned,
    evidenceSignal,
    impactScopeSignal,
    remediationSignal,
    exploitSignal,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 6
    && (critical || highSeverity || maliciousLanguage || dependencyConfusion)
    && impactScopeSignal
    && (remediationSignal || fixedCount > 0 || yanked)
    && (evidenceSignal || exploitSignal);
  const score = Math.min(100, Math.max(0,
    (critical ? 30 : highSeverity ? 20 : 0)
    + Math.min(16, affectedCount * 4)
    + (fixedCount > 0 ? 6 : affectedCount > 0 ? 10 : 0)
    + (maliciousLanguage ? 22 : 0)
    + (dependencyConfusion ? 18 : 0)
    + (sensitive ? 10 : 0)
    + (lowAdoptionSensitive ? 14 : 0)
    + (yanked ? 18 : 0)
    + (insecure ? 24 : 0)
    + (deprecated ? 10 : 0)
    + (unverifiedPublisher ? 8 : 0)
    + (unofficialContainer ? 8 : 0)
    + (singleMaintainer ? 6 : 0)
    + (noRepository ? 6 : 0)
    + (installHook ? 16 : 0)
    + (freshOrAbandoned ? 8 : 0)
    + (evidenceSignal ? 6 : 0)
    + (impactScopeSignal ? 6 : 0)
    + (remediationSignal ? 5 : 0)
    + (exploitSignal ? 8 : 0)
    + (completeNarrative ? 8 : 0)
  ));
  return {
    supply_chain_affected_package_count: affectedCount,
    supply_chain_fixed_version_count: fixedCount,
    supply_chain_sensitive_package_signal: sensitive ? 1 : 0,
    supply_chain_malicious_language_signal: maliciousLanguage ? 1 : 0,
    supply_chain_dependency_confusion_signal: dependencyConfusion ? 1 : 0,
    supply_chain_low_download_sensitive_signal: lowAdoptionSensitive ? 1 : 0,
    supply_chain_yanked_signal: yanked ? 1 : 0,
    supply_chain_insecure_registry_signal: insecure ? 1 : 0,
    supply_chain_deprecated_signal: deprecated ? 1 : 0,
    supply_chain_unverified_publisher_signal: unverifiedPublisher ? 1 : 0,
    supply_chain_unofficial_container_signal: unofficialContainer ? 1 : 0,
    supply_chain_single_maintainer_signal: singleMaintainer ? 1 : 0,
    supply_chain_missing_repository_signal: noRepository ? 1 : 0,
    supply_chain_install_script_signal: installHook ? 1 : 0,
    supply_chain_new_or_abandoned_signal: freshOrAbandoned ? 1 : 0,
    supply_chain_high_severity_signal: highSeverity ? 1 : 0,
    supply_chain_evidence_language_signal: evidenceSignal ? 1 : 0,
    supply_chain_impact_scope_signal: impactScopeSignal ? 1 : 0,
    supply_chain_remediation_signal: remediationSignal ? 1 : 0,
    supply_chain_exploitability_signal: exploitSignal ? 1 : 0,
    supply_chain_complete_security_narrative_signal: completeNarrative ? 1 : 0,
    supply_chain_semantic_signal_count: semanticSignals,
    supply_chain_evidence_terms: evidenceTerms,
    supply_chain_impact_terms: impactTerms,
    supply_chain_remediation_terms: remediationTerms,
    supply_chain_exploit_terms: exploitTerms,
    supply_chain_risk_score: score,
    supply_chain_risk_bucket: supplyChainRiskBucket(score),
    supply_chain_signal_count: reasons.length,
    supply_chain_signal_reasons: reasons,
  };
}

function highestSeverity(...values) {
  return values.flat().map(item => cleanText(item || "", 40)).filter(Boolean).sort((a, b) => severityRank(b) - severityRank(a))[0] || "";
}

function cvssFromOsv(vuln = {}) {
  const severity = Array.isArray(vuln.severity) ? vuln.severity : [];
  const cvss = severity.find(item => /CVSS/i.test(item.type || ""));
  const scoreMatch = String(cvss?.score || "").match(/CVSS:[^ ]+/i);
  return {
    vector: cleanText(scoreMatch?.[0] || cvss?.score || "", 200),
    score: 0,
  };
}

function affectedPackagesFromOsv(vuln = {}) {
  return (Array.isArray(vuln.affected) ? vuln.affected : []).map(item => ({
    ecosystem: cleanText(item.package?.ecosystem || "", 80),
    name: cleanText(item.package?.name || "", 160),
    ranges: (Array.isArray(item.ranges) ? item.ranges : []).map(range => cleanText(range.type || "", 40)).filter(Boolean),
    fixed: (Array.isArray(item.ranges) ? item.ranges : [])
      .flatMap(range => Array.isArray(range.events) ? range.events : [])
      .map(event => cleanText(event.fixed || "", 80))
      .filter(Boolean)
      .slice(0, 10),
  })).filter(item => item.name).slice(0, 20);
}

export function parseOsvVulnerabilities(payload, keyword = "", { packageHint = null, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.vulns) ? payload.vulns : [];
  const out = [];
  const seen = new Set();
  for (const vuln of rows) {
    const id = cleanText(vuln.id || "", 80);
    const aliases = Array.isArray(vuln.aliases) ? vuln.aliases.map(item => cleanText(item, 80)).filter(Boolean) : [];
    const summary = cleanText(vuln.summary || vuln.details || "", 900);
    const publishedAt = normalizeDate(vuln.published || vuln.modified);
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const affectedPackages = affectedPackagesFromOsv(vuln);
    const packageText = affectedPackages.map(item => `${item.ecosystem} ${item.name}`).join(" ");
    if (!textMatchesKeyword([id, aliases.join(" "), summary, packageText].join(" "), keyword, packageHint ? [packageHint] : [])) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const severity = highestSeverity(vuln.database_specific?.severity, vuln.ecosystem_specific?.severity);
    const cvss = cvssFromOsv(vuln);
    const title = `OSV supply-chain advisory: ${id}`;
    const content = [
      summary,
      affectedPackages.length ? `Affected packages: ${affectedPackages.map(item => `${item.ecosystem}/${item.name}`).join(", ")}.` : "",
      aliases.length ? `Aliases: ${aliases.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
    const riskSignals = supplyChainRiskSignals({
      title,
      content,
      severity,
      cvssScore: cvss.score,
      affectedPackages,
      packageName: packageHint?.name || affectedPackages[0]?.name || "",
      ecosystem: packageHint?.ecosystem || affectedPackages[0]?.ecosystem || "",
    });
    out.push({
      url: id ? `https://osv.dev/vulnerability/${encodeURIComponent(id)}` : "https://osv.dev/list",
      title,
      content,
      author: "OSV.dev",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel: advisoryRiskLevel({ severity, cvssScore: cvss.score }),
      metrics: {
        source: "osv_dev",
        source_family: "security",
        source_kind: "open_source_supply_chain_advisory",
        collection_mode: "osv_query_api",
        advisory_id: id,
        aliases,
        ecosystem: cleanText(packageHint?.ecosystem || affectedPackages[0]?.ecosystem || "", 80),
        package_name: cleanText(packageHint?.name || affectedPackages[0]?.name || "", 160),
        affected_packages: affectedPackages,
        severity,
        cvss_vector: cvss.vector,
        published_at: publishedAt,
        modified_at: normalizeDate(vuln.modified || ""),
        source_weight_tier: "open-source-vulnerability",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

function affectedPackagesFromGithub(advisory = {}) {
  return (Array.isArray(advisory.vulnerabilities) ? advisory.vulnerabilities : []).map(item => ({
    ecosystem: cleanText(item.package?.ecosystem || item.ecosystem || "", 80),
    name: cleanText(item.package?.name || item.package_name || "", 160),
    vulnerableVersionRange: cleanText(item.vulnerable_version_range || "", 180),
    firstPatchedVersion: cleanText(item.first_patched_version?.identifier || "", 80),
  })).filter(item => item.name).slice(0, 20);
}

export function parseGithubSecurityAdvisories(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const advisory of rows) {
    const ghsaId = cleanText(advisory.ghsa_id || advisory.ghsaId || "", 80);
    const cveId = cleanText(advisory.cve_id || advisory.cveId || "", 80);
    const summary = cleanText(advisory.summary || advisory.description || "", 900);
    const publishedAt = normalizeDate(advisory.published_at || advisory.publishedAt || advisory.updated_at);
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const affectedPackages = affectedPackagesFromGithub(advisory);
    const packageText = affectedPackages.map(item => `${item.ecosystem} ${item.name}`).join(" ");
    if (!textMatchesKeyword([ghsaId, cveId, summary, packageText].join(" "), keyword, affectedPackages)) continue;
    const dedupeKey = ghsaId || cveId || summary;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const severity = cleanText(advisory.severity || "", 40);
    const cvssScore = Number(advisory.cvss?.score || 0);
    const title = `GitHub supply-chain advisory: ${ghsaId || cveId || cleanText(summary, 80)}`;
    const content = [
      summary,
      affectedPackages.length ? `Affected packages: ${affectedPackages.map(item => `${item.ecosystem}/${item.name}`).join(", ")}.` : "",
      cveId ? `CVE: ${cveId}.` : "",
    ].filter(Boolean).join(" ");
    const riskSignals = supplyChainRiskSignals({
      title,
      content,
      severity,
      cvssScore,
      affectedPackages,
      packageName: affectedPackages[0]?.name || "",
      ecosystem: affectedPackages[0]?.ecosystem || "",
    });
    out.push({
      url: advisory.html_url || advisory.url || (ghsaId ? `https://github.com/advisories/${encodeURIComponent(ghsaId)}` : GITHUB_ADVISORIES_URL),
      title,
      content,
      author: "GitHub Security Advisory Database",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel: advisoryRiskLevel({ severity, cvssScore }),
      metrics: {
        source: "github_security_advisories",
        source_family: "security",
        source_kind: "open_source_supply_chain_advisory",
        collection_mode: "github_global_advisories_public_rest",
        advisory_id: ghsaId,
        cve_id: cveId,
        ecosystem: cleanText(affectedPackages[0]?.ecosystem || "", 80),
        package_name: cleanText(affectedPackages[0]?.name || "", 160),
        affected_packages: affectedPackages,
        severity,
        cvss_score: Number.isFinite(cvssScore) ? cvssScore : 0,
        cvss_vector: cleanText(advisory.cvss?.vector_string || advisory.cvss?.vectorString || "", 200),
        published_at: publishedAt,
        updated_at: normalizeDate(advisory.updated_at || ""),
        source_weight_tier: "open-source-vulnerability",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parseNpmRegistrySearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.objects) ? payload.objects : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const pkg = row.package || row;
    const name = cleanText(pkg.name || "", 220);
    const description = cleanText(pkg.description || "", 900);
    const version = cleanText(pkg.version || "", 80);
    const publishedAt = normalizeDate(pkg.date || row.updated || payload?.time || "");
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const keywords = (Array.isArray(pkg.keywords) ? pkg.keywords : [])
      .map(item => cleanText(item, 80))
      .filter(Boolean)
      .slice(0, 30);
    const maintainers = (Array.isArray(pkg.maintainers) ? pkg.maintainers : [])
      .map(item => cleanText(item.username || item.name || item.email || "", 120))
      .filter(Boolean)
      .slice(0, 20);
    const publisher = cleanText(pkg.publisher?.username || pkg.publisher?.name || pkg.publisher?.email || "", 120);
    const repositoryUrl = cleanText(pkg.links?.repository || "", 900);
    const homepageUrl = cleanText(pkg.links?.homepage || "", 900);
    const monthlyDownloads = Number(row.downloads?.monthly || 0);
    const weeklyDownloads = Number(row.downloads?.weekly || 0);
    const insecure = Number(row.flags?.insecure || 0) > 0 || row.flags?.insecure === true;
    const haystack = [name, description, keywords.join(" "), publisher, maintainers.join(" ")].join(" ");
    if (!name || !textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const riskLevel = packageRegistryRiskLevel({ name, description, keywords, downloads: weeklyDownloads || monthlyDownloads, insecure });
    const npmUrl = cleanText(pkg.links?.npm || "", 900) || `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
    const riskSignals = supplyChainRiskSignals({
      title: `npm package registry signal: ${name}`,
      content: description,
      packageName: name,
      ecosystem: "npm",
      keywords,
      downloads: monthlyDownloads,
      recentDownloads: weeklyDownloads,
      insecure,
      maintainerCount: maintainers.length,
      repositoryUrl,
      homepageUrl,
      expectRepositoryMetadata: true,
    });
    out.push({
      url: npmUrl,
      title: `npm package registry signal: ${name}`,
      content: [
        description,
        version ? `Version: ${version}.` : "",
        monthlyDownloads ? `Monthly downloads: ${monthlyDownloads}.` : "",
        weeklyDownloads ? `Weekly downloads: ${weeklyDownloads}.` : "",
        keywords.length ? `Keywords: ${keywords.join(", ")}.` : "",
        publisher ? `Publisher: ${publisher}.` : "",
        repositoryUrl ? `Repository: ${repositoryUrl}.` : "",
        homepageUrl ? `Homepage: ${homepageUrl}.` : "",
        insecure ? "npm search flags this package as insecure." : "",
      ].filter(Boolean).join(" "),
      author: publisher || maintainers[0] || "npm Registry",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel,
      evidenceType: "package_registry_signal",
      metrics: {
        source: "npm_registry_search",
        source_family: "security",
        source_kind: "public_package_registry_signal",
        collection_mode: "npm_registry_public_search_json",
        package_registry: "npm",
        registry_package_name: name,
        package_name: name,
        ecosystem: "npm",
        package_version: version,
        package_description: description,
        package_keywords: keywords,
        package_publisher: publisher,
        package_maintainers: maintainers,
        package_maintainer_count: maintainers.length,
        package_repository_url: repositoryUrl,
        package_homepage_url: homepageUrl,
        npm_monthly_downloads: Number.isFinite(monthlyDownloads) ? monthlyDownloads : 0,
        npm_weekly_downloads: Number.isFinite(weeklyDownloads) ? weeklyDownloads : 0,
        npm_dependents: cleanText(row.dependents || "", 80),
        npm_search_score: Number(row.searchScore || 0),
        npm_score_final: Number(row.score?.final || 0),
        npm_score_popularity: Number(row.score?.detail?.popularity || 0),
        npm_score_quality: Number(row.score?.detail?.quality || 0),
        npm_score_maintenance: Number(row.score?.detail?.maintenance || 0),
        npm_flag_insecure: insecure,
        source_weight_tier: "package-registry-signal",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parseCratesIoSearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.crates) ? payload.crates : [];
  const out = [];
  const seen = new Set();
  for (const crate of rows) {
    const name = cleanText(crate.name || crate.id || "", 220);
    const description = cleanText(crate.description || "", 900);
    const publishedAt = normalizeDate(crate.updated_at || crate.created_at || "");
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const keywords = (Array.isArray(crate.keywords) ? crate.keywords : [])
      .map(item => cleanText(item, 80))
      .filter(Boolean)
      .slice(0, 30);
    const categories = (Array.isArray(crate.categories) ? crate.categories : [])
      .map(item => cleanText(item, 80))
      .filter(Boolean)
      .slice(0, 30);
    const repository = cleanText(crate.repository || "", 900);
    const homepage = cleanText(crate.homepage || "", 900);
    const documentation = cleanText(crate.documentation || "", 900);
    const haystack = [name, description, keywords.join(" "), categories.join(" "), repository, homepage, documentation].join(" ");
    if (!name || !textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const downloads = Number(crate.downloads || 0);
    const recentDownloads = Number(crate.recent_downloads || 0);
    const yanked = crate.yanked === true;
    const version = cleanText(crate.default_version || crate.newest_version || crate.max_version || crate.max_stable_version || "", 80);
    const riskLevel = packageRegistryRiskLevel({
      name,
      description,
      keywords: [...keywords, ...categories],
      downloads: recentDownloads || downloads,
      yanked,
    });
    const riskSignals = supplyChainRiskSignals({
      title: `crates.io package registry signal: ${name}`,
      content: description,
      packageName: name,
      ecosystem: "crates.io",
      keywords: [...keywords, ...categories],
      downloads,
      recentDownloads,
      yanked,
      versionCount: Number(crate.num_versions || 0),
      repositoryUrl: repository,
      homepageUrl: homepage,
      expectRepositoryMetadata: true,
    });
    out.push({
      url: `https://crates.io/crates/${encodeURIComponent(name)}`,
      title: `crates.io package registry signal: ${name}`,
      content: [
        description,
        version ? `Version: ${version}.` : "",
        Number.isFinite(downloads) && downloads ? `Downloads: ${downloads}.` : "",
        Number.isFinite(recentDownloads) && recentDownloads ? `Recent downloads: ${recentDownloads}.` : "",
        keywords.length ? `Keywords: ${keywords.join(", ")}.` : "",
        categories.length ? `Categories: ${categories.join(", ")}.` : "",
        repository ? `Repository: ${repository}.` : "",
        yanked ? "crates.io marks this crate as yanked." : "",
      ].filter(Boolean).join(" "),
      author: "crates.io",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel,
      evidenceType: "package_registry_signal",
      metrics: {
        source: "crates_io_search",
        source_family: "security",
        source_kind: "public_package_registry_signal",
        collection_mode: "crates_io_public_search_json",
        package_registry: "crates.io",
        registry_package_name: name,
        package_name: name,
        ecosystem: "crates.io",
        package_version: version,
        package_description: description,
        package_keywords: keywords,
        crate_categories: categories,
        crate_downloads: Number.isFinite(downloads) ? downloads : 0,
        crate_recent_downloads: Number.isFinite(recentDownloads) ? recentDownloads : 0,
        crate_num_versions: Number(crate.num_versions || 0),
        crate_exact_match: crate.exact_match === true,
        crate_yanked: yanked,
        crate_trustpub_only: crate.trustpub_only === true,
        crate_homepage: homepage,
        crate_documentation: documentation,
        crate_repository: repository,
        source_weight_tier: "package-registry-signal",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parsePypiProjectJson(payload, keyword = "", { since = "" } = {}) {
  const info = payload?.info || {};
  const name = cleanText(info.name || "", 220);
  if (!name) return [];
  const urls = Array.isArray(payload?.urls) ? payload.urls : [];
  const releases = payload?.releases && typeof payload.releases === "object" ? payload.releases : {};
  const latestUpload = urls
    .map(file => normalizeDate(file.upload_time_iso_8601 || file.upload_time || ""))
    .filter(Boolean)
    .sort()
    .at(-1) || "";
  if (!isAfterSince(latestUpload || new Date().toISOString(), since)) return [];
  const summary = cleanText(info.summary || "", 900);
  const description = cleanText(info.description || "", 1200);
  const version = cleanText(info.version || "", 80);
  const keywords = cleanText(info.keywords || "", 500)
    .split(/[,;\s]+/)
    .map(item => cleanText(item, 80))
    .filter(Boolean)
    .slice(0, 30);
  const classifiers = (Array.isArray(info.classifiers) ? info.classifiers : [])
    .map(item => cleanText(item, 140))
    .filter(Boolean)
    .slice(0, 40);
    const projectUrls = info.project_urls && typeof info.project_urls === "object" ? info.project_urls : {};
    const projectUrlValues = Object.values(projectUrls).map(item => cleanText(item, 900)).filter(Boolean).slice(0, 20);
    const author = cleanText(info.author || info.author_email || info.maintainer || info.maintainer_email || "", 180);
    const repositoryUrl = cleanText(projectUrls.Repository || projectUrls.Source || projectUrls.SourceCode || projectUrls["Source Code"] || "", 900);
    const homePage = cleanText(info.home_page || projectUrls.Homepage || repositoryUrl || "", 900);
  const yanked = urls.some(file => file?.yanked === true);
  const haystack = [
    name,
    summary,
    description,
    keywords.join(" "),
    classifiers.join(" "),
    author,
    homePage,
    projectUrlValues.join(" "),
  ].join(" ");
  if (!textMatchesKeyword(haystack, keyword)) return [];
  const riskLevel = packageRegistryRiskLevel({
    name,
    description: `${summary} ${description}`,
    keywords: [...keywords, ...classifiers],
    downloads: 0,
    yanked,
  });
  const riskSignals = supplyChainRiskSignals({
    title: `PyPI package registry signal: ${name}`,
    content: `${summary} ${description}`,
    packageName: name,
    ecosystem: "PyPI",
    keywords: [...keywords, ...classifiers],
    yanked,
    versionCount: Object.keys(releases).length,
    repositoryUrl,
    homepageUrl: homePage,
    expectRepositoryMetadata: true,
  });
  return withSupplyChainDiagnostics([{
    url: `https://pypi.org/project/${encodeURIComponent(name)}/`,
    title: `PyPI package registry signal: ${name}`,
    content: [
      summary,
      version ? `Version: ${version}.` : "",
      latestUpload ? `Latest upload: ${latestUpload}.` : "",
      keywords.length ? `Keywords: ${keywords.join(", ")}.` : "",
      classifiers.length ? `Classifiers: ${classifiers.slice(0, 8).join(", ")}.` : "",
      homePage ? `Homepage: ${homePage}.` : "",
      yanked ? "PyPI marks at least one current file as yanked." : "",
    ].filter(Boolean).join(" "),
    author: author || "PyPI",
    publishedAt: latestUpload || new Date().toISOString(),
    riskLevel,
    evidenceType: "package_registry_signal",
    metrics: {
      source: "pypi_project_json",
      source_family: "security",
      source_kind: "public_package_registry_signal",
      collection_mode: "pypi_project_public_json",
      package_registry: "PyPI",
      registry_package_name: name,
      package_name: name,
      ecosystem: "PyPI",
      package_version: version,
      package_description: summary || cleanText(description, 900),
      package_keywords: keywords,
      pypi_classifiers: classifiers,
      pypi_author: author,
      pypi_license: cleanText(info.license || "", 300),
      pypi_requires_python: cleanText(info.requires_python || "", 120),
      pypi_project_urls: projectUrls,
      pypi_home_page: homePage,
      pypi_repository_url: repositoryUrl,
      pypi_file_count: urls.length,
      pypi_release_count: Object.keys(releases).length,
      pypi_yanked: yanked,
      pypi_latest_upload: latestUpload,
      source_weight_tier: "package-registry-signal",
      ...riskSignals,
    },
  }], { keyword, rawResultCount: urls.length || Object.keys(releases).length || 1 });
}

export function parseRubyGemsSearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const gem of rows) {
    const name = cleanText(gem.name || "", 220);
    const version = cleanText(gem.version || "", 80);
    const description = cleanText(gem.info || "", 900);
    const publishedAt = normalizeDate(gem.version_created_at || gem.updated_at || "");
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const authors = cleanText(gem.authors || "", 300);
    const licenses = (Array.isArray(gem.licenses) ? gem.licenses : [])
      .map(item => cleanText(item, 80))
      .filter(Boolean)
      .slice(0, 20);
    const projectUri = cleanText(gem.project_uri || "", 900);
    const gemUri = cleanText(gem.gem_uri || "", 900);
    const homepageUri = cleanText(gem.homepage_uri || "", 900);
    const sourceCodeUri = cleanText(gem.source_code_uri || "", 900);
    const documentationUri = cleanText(gem.documentation_uri || "", 900);
    const wikiUri = cleanText(gem.wiki_uri || "", 900);
    const downloads = Number(gem.downloads || 0);
    const versionDownloads = Number(gem.version_downloads || 0);
    const haystack = [
      name,
      description,
      authors,
      licenses.join(" "),
      projectUri,
      gemUri,
      homepageUri,
      sourceCodeUri,
      documentationUri,
      wikiUri,
    ].join(" ");
    if (!name || !textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const riskLevel = packageRegistryRiskLevel({
      name,
      description,
      keywords: licenses,
      downloads: versionDownloads || downloads,
    });
    const riskSignals = supplyChainRiskSignals({
      title: `RubyGems package registry signal: ${name}`,
      content: description,
      packageName: name,
      ecosystem: "RubyGems",
      keywords: licenses,
      downloads,
      recentDownloads: versionDownloads,
      maintainerCount: authors ? authors.split(/[,;]/).map(item => item.trim()).filter(Boolean).length : 0,
      repositoryUrl: sourceCodeUri,
      homepageUrl: homepageUri,
      expectRepositoryMetadata: true,
    });
    out.push({
      url: projectUri || `https://rubygems.org/gems/${encodeURIComponent(name)}`,
      title: `RubyGems package registry signal: ${name}`,
      content: [
        description,
        version ? `Version: ${version}.` : "",
        Number.isFinite(downloads) && downloads ? `Downloads: ${downloads}.` : "",
        Number.isFinite(versionDownloads) && versionDownloads ? `Version downloads: ${versionDownloads}.` : "",
        authors ? `Authors: ${authors}.` : "",
        licenses.length ? `Licenses: ${licenses.join(", ")}.` : "",
        homepageUri ? `Homepage: ${homepageUri}.` : "",
        sourceCodeUri ? `Source: ${sourceCodeUri}.` : "",
      ].filter(Boolean).join(" "),
      author: authors || "RubyGems",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel,
      evidenceType: "package_registry_signal",
      metrics: {
        source: "rubygems_search",
        source_family: "security",
        source_kind: "public_package_registry_signal",
        collection_mode: "rubygems_public_search_json",
        package_registry: "RubyGems",
        registry_package_name: name,
        package_name: name,
        ecosystem: "RubyGems",
        package_version: version,
        package_description: description,
        package_keywords: licenses,
        rubygems_authors: authors,
        rubygems_downloads: Number.isFinite(downloads) ? downloads : 0,
        rubygems_version_downloads: Number.isFinite(versionDownloads) ? versionDownloads : 0,
        rubygems_project_uri: projectUri,
        rubygems_gem_uri: gemUri,
        rubygems_homepage_uri: homepageUri,
        rubygems_source_code_uri: sourceCodeUri,
        rubygems_documentation_uri: documentationUri,
        rubygems_wiki_uri: wikiUri,
        source_weight_tier: "package-registry-signal",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parsePackagistSearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const pkg of rows) {
    const name = cleanText(pkg.name || "", 220);
    const description = cleanText(pkg.description || "", 900);
    const repository = cleanText(pkg.repository || "", 900);
    const url = cleanText(pkg.url || "", 900) || (name ? `https://packagist.org/packages/${encodeURIComponent(name)}` : "");
    const downloads = Number(pkg.downloads || 0);
    const favers = Number(pkg.favers || 0);
    const haystack = [name, description, repository, url].join(" ");
    if (!name || !textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const riskLevel = packageRegistryRiskLevel({
      name,
      description,
      downloads,
    });
    const riskSignals = supplyChainRiskSignals({
      title: `Packagist package registry signal: ${name}`,
      content: description,
      packageName: name,
      ecosystem: "Packagist",
      downloads,
      recentDownloads: favers,
      repositoryUrl: repository,
      homepageUrl: url,
      expectRepositoryMetadata: true,
    });
    out.push({
      url,
      title: `Packagist package registry signal: ${name}`,
      content: [
        description,
        Number.isFinite(downloads) && downloads ? `Downloads: ${downloads}.` : "",
        Number.isFinite(favers) && favers ? `Favers: ${favers}.` : "",
        repository ? `Repository: ${repository}.` : "",
      ].filter(Boolean).join(" "),
      author: "Packagist",
      publishedAt: new Date().toISOString(),
      riskLevel,
      evidenceType: "package_registry_signal",
      metrics: {
        source: "packagist_search",
        source_family: "security",
        source_kind: "public_package_registry_signal",
        collection_mode: "packagist_public_search_json",
        package_registry: "Packagist",
        registry_package_name: name,
        package_name: name,
        ecosystem: "Packagist",
        package_description: description,
        package_keywords: [],
        packagist_downloads: Number.isFinite(downloads) ? downloads : 0,
        packagist_favers: Number.isFinite(favers) ? favers : 0,
        packagist_repository: repository,
        packagist_url: url,
        packagist_total_results: Number(payload?.total || 0),
        source_weight_tier: "package-registry-signal",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parseMavenCentralSearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
  const out = [];
  const seen = new Set();
  for (const doc of rows) {
    const group = cleanText(doc.g || "", 180);
    const artifact = cleanText(doc.a || "", 180);
    const id = cleanText(doc.id || [group, artifact].filter(Boolean).join(":"), 260);
    const latestVersion = cleanText(doc.latestVersion || "", 100);
    const packaging = cleanText(doc.p || "", 40);
    const repositoryId = cleanText(doc.repositoryId || "", 80);
    const timestamp = Number(doc.timestamp || 0);
    const publishedAt = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : "";
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const extensions = (Array.isArray(doc.ec) ? doc.ec : [])
      .map(item => cleanText(item, 80))
      .filter(Boolean)
      .slice(0, 40);
    const textFields = (Array.isArray(doc.text) ? doc.text : [])
      .map(item => cleanText(item, 120))
      .filter(Boolean)
      .slice(0, 40);
    const haystack = [id, group, artifact, latestVersion, packaging, repositoryId, extensions.join(" "), textFields.join(" ")].join(" ");
    if (!id || !textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const riskLevel = packageRegistryRiskLevel({
      name: id,
      description: `${group} ${artifact} ${packaging}`,
      keywords: extensions,
    });
    const packagePath = id.includes(":") ? id.replace(":", "/") : id;
    const riskSignals = supplyChainRiskSignals({
      title: `Maven Central package registry signal: ${id}`,
      content: `${group} ${artifact} ${packaging}`,
      packageName: id,
      ecosystem: "Maven",
      keywords: extensions,
      versionCount: Number(doc.versionCount || 0),
    });
    out.push({
      url: `https://central.sonatype.com/artifact/${encodeURIComponent(group)}/${encodeURIComponent(artifact)}`,
      title: `Maven Central package registry signal: ${id}`,
      content: [
        `Package: ${id}.`,
        "Ecosystem: Maven Central.",
        keyword ? `Matched monitored keyword: ${cleanText(keyword, 160)}.` : "",
        latestVersion ? `Latest version: ${latestVersion}.` : "",
        publishedAt ? `Latest timestamp: ${publishedAt}.` : "",
        Number(doc.versionCount || 0) ? `Version count: ${Number(doc.versionCount || 0)}.` : "",
        packaging ? `Packaging: ${packaging}.` : "",
        repositoryId ? `Repository: ${repositoryId}.` : "",
        extensions.length ? `Artifacts: ${extensions.slice(0, 10).join(", ")}.` : "",
      ].filter(Boolean).join(" "),
      author: "Maven Central",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel,
      evidenceType: "package_registry_signal",
      metrics: {
        source: "maven_central_search",
        source_family: "security",
        source_kind: "public_package_registry_signal",
        collection_mode: "maven_central_public_search_json",
        package_registry: "Maven Central",
        registry_package_name: id,
        package_name: id,
        ecosystem: "Maven",
        package_version: latestVersion,
        package_description: `${group}:${artifact}`,
        package_keywords: extensions,
        maven_group_id: group,
        maven_artifact_id: artifact,
        maven_packaging: packaging,
        maven_repository_id: repositoryId,
        maven_latest_timestamp: publishedAt,
        maven_version_count: Number(doc.versionCount || 0),
        maven_extensions: extensions,
        maven_text_fields: textFields,
        maven_total_results: Number(payload?.response?.numFound || 0),
        maven_package_path: packagePath,
        source_weight_tier: "package-registry-signal",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parseNugetSearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const out = [];
  const seen = new Set();
  for (const pkg of rows) {
    const id = cleanText(pkg.id || pkg.title || "", 220);
    const version = cleanText(pkg.version || "", 100);
    const description = cleanText(pkg.description || pkg.summary || "", 900);
    const authors = (Array.isArray(pkg.authors) ? pkg.authors : [pkg.authors])
      .map(item => cleanText(item, 120))
      .filter(Boolean)
      .slice(0, 20);
    const tags = (Array.isArray(pkg.tags) ? pkg.tags : String(pkg.tags || "").split(/\s+/))
      .map(item => cleanText(item, 80))
      .filter(Boolean)
      .slice(0, 30);
    const versions = (Array.isArray(pkg.versions) ? pkg.versions : [])
      .map(item => ({
        version: cleanText(item.version || "", 80),
        downloads: Number(item.downloads || 0),
      }))
      .filter(item => item.version)
      .slice(0, 40);
    const projectUrl = cleanText(pkg.projectUrl || "", 900);
    const registration = cleanText(pkg.registration || "", 900);
    const iconUrl = cleanText(pkg.iconUrl || "", 900);
    const licenseUrl = cleanText(pkg.licenseUrl || "", 900);
    const publishedAt = normalizeDate(pkg.published || pkg.created || "");
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const haystack = [
      id,
      version,
      description,
      authors.join(" "),
      tags.join(" "),
      projectUrl,
      registration,
    ].join(" ");
    if (!id || !textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const totalDownloads = Number(pkg.totalDownloads || 0);
    const verified = pkg.verified === true;
    const riskLevel = packageRegistryRiskLevel({
      name: id,
      description,
      keywords: tags,
      downloads: totalDownloads,
    });
    const riskSignals = supplyChainRiskSignals({
      title: `NuGet package registry signal: ${id}`,
      content: description,
      packageName: id,
      ecosystem: "NuGet",
      keywords: tags,
      downloads: totalDownloads,
      verified,
      versionCount: versions.length,
      repositoryUrl: projectUrl,
      homepageUrl: projectUrl,
      expectRepositoryMetadata: true,
    });
    out.push({
      url: `https://www.nuget.org/packages/${encodeURIComponent(id)}`,
      title: `NuGet package registry signal: ${id}`,
      content: [
        `Package: ${id}.`,
        "Ecosystem: NuGet.",
        keyword ? `Matched monitored keyword: ${cleanText(keyword, 160)}.` : "",
        description,
        version ? `Latest version: ${version}.` : "",
        publishedAt ? `Published: ${publishedAt}.` : "",
        Number.isFinite(totalDownloads) && totalDownloads ? `Total downloads: ${totalDownloads}.` : "",
        authors.length ? `Authors: ${authors.join(", ")}.` : "",
        tags.length ? `Tags: ${tags.join(", ")}.` : "",
        verified ? "NuGet marks this package as verified." : "",
        projectUrl ? `Project: ${projectUrl}.` : "",
      ].filter(Boolean).join(" "),
      author: authors.join(", ") || "NuGet",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel,
      evidenceType: "package_registry_signal",
      metrics: {
        source: "nuget_search",
        source_family: "security",
        source_kind: "public_package_registry_signal",
        collection_mode: "nuget_public_search_json",
        package_registry: "NuGet",
        registry_package_name: id,
        package_name: id,
        ecosystem: "NuGet",
        package_version: version,
        package_description: description,
        package_keywords: tags,
        nuget_authors: authors,
        nuget_total_downloads: Number.isFinite(totalDownloads) ? totalDownloads : 0,
        nuget_verified: verified,
        nuget_versions: versions,
        nuget_version_count: versions.length,
        nuget_project_url: projectUrl,
        nuget_registration: registration,
        nuget_icon_url: iconUrl,
        nuget_license_url: licenseUrl,
        nuget_total_hits: Number(payload?.totalHits || 0),
        source_weight_tier: "package-registry-signal",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parseDockerHubSearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const repo of rows) {
    const repoName = cleanText(repo.repo_name || [repo.namespace, repo.name].filter(Boolean).join("/") || "", 220);
    const namespace = cleanText(repo.namespace || repo.user || repoName.split("/")[0] || "", 120);
    const name = cleanText(repo.name || repoName.split("/").pop() || "", 160);
    const description = cleanText(repo.short_description || repo.description || "", 900);
    const publishedAt = normalizeDate(repo.last_updated || repo.updated_at || "");
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const haystack = [
      repoName,
      namespace,
      name,
      description,
      repo.is_official ? "official" : "",
      repo.is_automated ? "automated" : "",
    ].join(" ");
    if (!repoName || !textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(repoName.toLowerCase())) continue;
    seen.add(repoName.toLowerCase());
    const pullCount = Number(repo.pull_count || 0);
    const starCount = Number(repo.star_count || 0);
    const official = repo.is_official === true;
    const automated = repo.is_automated === true;
    const riskLevel = packageRegistryRiskLevel({
      name: repoName,
      description,
      keywords: [official ? "official" : "", automated ? "automated" : ""].filter(Boolean),
      downloads: pullCount,
    });
    const riskSignals = supplyChainRiskSignals({
      title: `Docker Hub container registry signal: ${repoName}`,
      content: description,
      packageName: repoName,
      ecosystem: "Docker Hub",
      keywords: [official ? "official" : "", automated ? "automated" : ""].filter(Boolean),
      downloads: pullCount,
      recentDownloads: starCount,
      official,
      container: true,
    });
    out.push({
      url: `https://hub.docker.com/r/${encodeURIComponent(repoName).replace(/%2F/gi, "/")}`,
      title: `Docker Hub container registry signal: ${repoName}`,
      content: [
        `Repository: ${repoName}.`,
        "Ecosystem: Docker Hub.",
        keyword ? `Matched monitored keyword: ${cleanText(keyword, 160)}.` : "",
        description,
        Number.isFinite(pullCount) && pullCount ? `Pulls: ${pullCount}.` : "",
        Number.isFinite(starCount) && starCount ? `Stars: ${starCount}.` : "",
        publishedAt ? `Last updated: ${publishedAt}.` : "",
        official ? "Docker Hub marks this repository as official." : "",
        automated ? "Docker Hub marks this repository as automated." : "",
      ].filter(Boolean).join(" "),
      author: namespace || "Docker Hub",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel,
      evidenceType: "package_registry_signal",
      metrics: {
        source: "docker_hub_search",
        source_family: "security",
        source_kind: "public_container_registry_signal",
        collection_mode: "docker_hub_public_search_json",
        package_registry: "Docker Hub",
        registry_package_name: repoName,
        package_name: repoName,
        ecosystem: "Docker Hub",
        package_description: description,
        package_keywords: [official ? "official" : "", automated ? "automated" : ""].filter(Boolean),
        docker_namespace: namespace,
        docker_repository_name: name,
        docker_repo_name: repoName,
        docker_pull_count: Number.isFinite(pullCount) ? pullCount : 0,
        docker_star_count: Number.isFinite(starCount) ? starCount : 0,
        docker_is_official: official,
        docker_is_automated: automated,
        docker_last_updated: publishedAt,
        docker_total_results: Number(payload?.count || 0),
        source_weight_tier: "package-registry-signal",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parseQuaySearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const repo of rows) {
    if (repo?.kind && repo.kind !== "repository") continue;
    const namespace = cleanText(repo.namespace?.name || repo.namespace || "", 120);
    const name = cleanText(repo.name || "", 160);
    const repoName = cleanText([namespace, name].filter(Boolean).join("/") || repo.name || "", 220);
    const description = cleanText(repo.description || "", 900);
    const modifiedSeconds = Number(repo.last_modified || 0);
    const publishedAt = normalizeDate(Number.isFinite(modifiedSeconds) && modifiedSeconds ? modifiedSeconds * 1000 : "");
    if (!isAfterSince(publishedAt || new Date().toISOString(), since)) continue;
    const isPublic = repo.is_public === true;
    const haystack = [
      repoName,
      namespace,
      name,
      description,
      isPublic ? "public" : "",
    ].join(" ");
    if (!repoName || !textMatchesKeyword(haystack, keyword)) continue;
    if (seen.has(repoName.toLowerCase())) continue;
    seen.add(repoName.toLowerCase());
    const stars = Number(repo.stars || 0);
    const popularity = Number(repo.popularity || 0);
    const riskLevel = packageRegistryRiskLevel({
      name: repoName,
      description,
      keywords: [isPublic ? "public" : ""].filter(Boolean),
      downloads: popularity,
    });
    const riskSignals = supplyChainRiskSignals({
      title: `Quay.io container registry signal: ${repoName}`,
      content: description,
      packageName: repoName,
      ecosystem: "Quay.io",
      keywords: [isPublic ? "public" : ""].filter(Boolean),
      downloads: popularity,
      recentDownloads: stars,
      container: true,
    });
    out.push({
      url: `https://quay.io/repository/${encodeURIComponent(repoName).replace(/%2F/gi, "/")}`,
      title: `Quay.io container registry signal: ${repoName}`,
      content: [
        `Repository: ${repoName}.`,
        "Ecosystem: Quay.io.",
        keyword ? `Matched monitored keyword: ${cleanText(keyword, 160)}.` : "",
        description,
        Number.isFinite(popularity) && popularity ? `Popularity: ${popularity}.` : "",
        Number.isFinite(stars) && stars ? `Stars: ${stars}.` : "",
        publishedAt ? `Last modified: ${publishedAt}.` : "",
        isPublic ? "Quay.io marks this repository as public." : "",
      ].filter(Boolean).join(" "),
      author: namespace || "Quay.io",
      publishedAt: publishedAt || new Date().toISOString(),
      riskLevel,
      evidenceType: "package_registry_signal",
      metrics: {
        source: "quay_search",
        source_family: "security",
        source_kind: "public_container_registry_signal",
        collection_mode: "quay_public_search_json",
        package_registry: "Quay.io",
        registry_package_name: repoName,
        package_name: repoName,
        ecosystem: "Quay.io",
        package_description: description,
        package_keywords: [isPublic ? "public" : ""].filter(Boolean),
        quay_namespace: namespace,
        quay_repository_name: name,
        quay_repo_name: repoName,
        quay_is_public: isPublic,
        quay_stars: Number.isFinite(stars) ? stars : 0,
        quay_popularity: Number.isFinite(popularity) ? popularity : 0,
        quay_last_modified: publishedAt,
        quay_has_additional_results: payload?.has_additional === true,
        quay_page: Number(payload?.page || 0),
        quay_page_size: Number(payload?.page_size || rows.length || 0),
        source_weight_tier: "package-registry-signal",
        ...riskSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return withSupplyChainDiagnostics(out, { keyword, rawResultCount: rows.length });
}

export function parseGoDepsDevPackage(payload, keyword = "", { since = "" } = {}) {
  const packageKey = payload?.packageKey || {};
  const name = cleanText(packageKey.name || "", 220);
  if (!name) return [];
  const versions = Array.isArray(payload?.versions) ? payload.versions : [];
  const defaultVersion = versions.find(item => item?.isDefault) || versions[versions.length - 1] || {};
  const latestByTime = [...versions]
    .filter(item => item?.publishedAt)
    .sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime())
    .at(-1) || defaultVersion;
  const version = cleanText(defaultVersion.versionKey?.version || latestByTime.versionKey?.version || "", 80);
  const latestVersion = cleanText(latestByTime.versionKey?.version || version, 80);
  const publishedAt = normalizeDate(defaultVersion.publishedAt || latestByTime.publishedAt || "");
  const latestPublishedAt = normalizeDate(latestByTime.publishedAt || defaultVersion.publishedAt || "");
  if (!isAfterSince(latestPublishedAt || publishedAt || new Date().toISOString(), since)) return [];
  const purl = cleanText(defaultVersion.purl || latestByTime.purl || "", 220);
  const deprecated = defaultVersion.isDeprecated === true || latestByTime.isDeprecated === true;
  const deprecatedReason = cleanText(defaultVersion.deprecatedReason || latestByTime.deprecatedReason || "", 500);
  const haystack = [name, version, latestVersion, purl, deprecatedReason].join(" ");
  if (!textMatchesKeyword(haystack, keyword)) return [];
  const riskLevel = packageRegistryRiskLevel({
    name,
    description: deprecatedReason,
    keywords: deprecated ? ["deprecated"] : [],
  });
  const riskSignals = supplyChainRiskSignals({
    title: `Go module registry signal: ${name}`,
    content: deprecatedReason,
    packageName: name,
    ecosystem: "Go",
    keywords: deprecated ? ["deprecated"] : [],
    deprecated,
    versionCount: versions.length,
  });
  return withSupplyChainDiagnostics([{
    url: `https://pkg.go.dev/${encodeURIComponent(name).replace(/%2F/gi, "/")}`,
    title: `Go module registry signal: ${name}`,
    content: [
      `Module: ${name}.`,
      "Ecosystem: Go.",
      keyword ? `Matched monitored keyword: ${cleanText(keyword, 160)}.` : "",
      "Public deps.dev Go module metadata for package registry monitoring.",
      version ? `Default version: ${version}.` : "",
      latestVersion && latestVersion !== version ? `Latest observed version: ${latestVersion}.` : "",
      latestPublishedAt ? `Latest published: ${latestPublishedAt}.` : "",
      versions.length ? `Observed versions: ${versions.length}.` : "",
      deprecated ? `Deprecated: ${deprecatedReason || "true"}.` : "",
      purl ? `PURL: ${purl}.` : "",
    ].filter(Boolean).join(" "),
    author: "deps.dev",
    publishedAt: latestPublishedAt || publishedAt || new Date().toISOString(),
    riskLevel,
    evidenceType: "package_registry_signal",
    metrics: {
      source: "go_deps_dev_package",
      source_family: "security",
      source_kind: "public_package_registry_signal",
      collection_mode: "deps_dev_go_package_public_json",
      package_registry: "Go",
      registry_package_name: name,
      package_name: name,
      ecosystem: "Go",
      package_version: version,
      package_description: deprecatedReason,
      package_keywords: deprecated ? ["deprecated"] : [],
      go_module_version_count: versions.length,
      go_module_latest_version: latestVersion,
      go_module_latest_published_at: latestPublishedAt,
      go_module_default_version: version,
      go_module_default_published_at: publishedAt,
      go_module_purl: purl,
      go_module_deprecated: deprecated,
      go_module_deprecated_reason: deprecatedReason,
      source_weight_tier: "package-registry-signal",
      ...riskSignals,
    },
  }], { keyword, rawResultCount: versions.length || 1 });
}

async function insertSupplyChainItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = supplyChainAdvisoryDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const risk = item.riskLevel || assessRiskLevel({ title: item.title, content: item.content, sentiment });
    const result = insertSentimentItem({
      platform: "supply_chain_advisory_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment: sentiment === "positive" ? "neutral" : sentiment,
      risk_level: risk,
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      raw_html: "",
      source_key: "supplyChainAdvisorySources",
      evidence: {
        evidence_type: item.evidenceType || "supply_chain_security_advisory",
        metrics: {
          ...(item.metrics || {}),
          supply_chain_advisory_canonical_dedupe_key: dedupeKey,
          supply_chain_advisory_search_scan_dedupe_key: dedupeKey,
          ...(attribution.length ? {
            failover_attribution: attribution,
            failover_from_sources: failoverFromSources,
          } : {}),
        },
      },
      source_type: "scraper",
      allow_external_risk_level: true,
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeSupplyChainAdvisorySources(keywords, { proxyUrl = "", budget = {}, since = "", domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(normalizedKeywords, SEARCH_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const packageHints = packageCandidatesForKeyword(keyword, { limit: normalizedBudget.maxPackagesPerKeyword });
      for (const packageHint of packageHints) {
        if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        const res = await fetchPublicSource(OSV_QUERY_URL, {
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(osvQueryBody(packageHint)),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `osv:${packageHint.ecosystem}:${packageHint.name}`, message: httpFailure(res) });
          continue;
        }
        const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
        const items = parseOsvVulnerabilities(await res.json(), keyword, { packageHint, limit: remaining, since });
        inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(githubAdvisorySearchUrl(keyword, { perPage: Math.min(30, normalizedBudget.maxItemsPerKeyword - inserted) }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parseGithubSecurityAdvisories(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "github-security-advisories", message: httpFailure(res) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const pypiCandidates = pypiProjectCandidatesForKeyword(keyword, { limit: normalizedBudget.maxPackagesPerKeyword });
        for (const candidate of pypiCandidates) {
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
          const res = await fetchPublicSource(pypiProjectJsonUrl(candidate), {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "application/json",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (res.ok) {
            const items = parsePypiProjectJson(await res.json(), keyword, { since });
            inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          } else if (res.status !== 404) {
            failures.push({ keyword, target: `pypi-project:${candidate}`, message: httpFailure(res) });
          }
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(npmRegistrySearchUrl(keyword, { size: Math.min(30, normalizedBudget.maxItemsPerKeyword - inserted) }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parseNpmRegistrySearchResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "npm-registry-search", message: httpFailure(res) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(rubygemsSearchUrl(keyword), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parseRubyGemsSearchResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "rubygems-search", message: httpFailure(res) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(packagistSearchUrl(keyword, { perPage: Math.min(30, normalizedBudget.maxItemsPerKeyword - inserted) }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parsePackagistSearchResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "packagist-search", message: httpFailure(res) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(mavenCentralSearchUrl(keyword, { rows: Math.min(30, normalizedBudget.maxItemsPerKeyword - inserted) }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parseMavenCentralSearchResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "maven-central-search", message: httpFailure(res) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(nugetSearchUrl(keyword, { take: Math.min(30, normalizedBudget.maxItemsPerKeyword - inserted) }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parseNugetSearchResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "nuget-search", message: httpFailure(res) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(dockerHubSearchUrl(keyword, { pageSize: Math.min(30, normalizedBudget.maxItemsPerKeyword - inserted) }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parseDockerHubSearchResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "docker-hub-search", message: httpFailure(res) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(quaySearchUrl(keyword, { pageSize: Math.min(30, normalizedBudget.maxItemsPerKeyword - inserted) }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parseQuaySearchResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "quay-search", message: httpFailure(res) });
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const goCandidates = goModuleCandidatesForKeyword(keyword, { limit: normalizedBudget.maxPackagesPerKeyword });
        for (const candidate of goCandidates) {
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
          const res = await fetchPublicSource(goDepsDevPackageUrl(candidate), {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "application/json",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (res.ok) {
            const items = parseGoDepsDevPackage(await res.json(), keyword, { since });
            inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          } else if (res.status !== 404) {
            failures.push({ keyword, target: `go-deps-dev-package:${candidate}`, message: httpFailure(res) });
          }
        }
      }
      if (inserted < normalizedBudget.maxItemsPerKeyword) {
        const res = await fetchPublicSource(cratesIoSearchUrl(keyword, { perPage: Math.min(30, normalizedBudget.maxItemsPerKeyword - inserted) }), {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          const items = parseCratesIoSearchResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword - inserted, since });
          inserted += await insertSupplyChainItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } else {
          failures.push({ keyword, target: "crates-io-search", message: httpFailure(res) });
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: "supply-chain-advisory", message });
      console.warn(`[CRM/SupplyChainAdvisory] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  OSV_QUERY_URL,
  GITHUB_ADVISORIES_URL,
  NPM_REGISTRY_SEARCH_URL,
  CRATES_IO_SEARCH_URL,
  PYPI_PROJECT_JSON_BASE_URL,
  RUBYGEMS_SEARCH_URL,
  PACKAGIST_SEARCH_URL,
  GO_DEPS_DEV_PACKAGE_BASE_URL,
  MAVEN_CENTRAL_SEARCH_URL,
  NUGET_SEARCH_URL,
  DOCKER_HUB_SEARCH_URL,
  QUAY_SEARCH_URL,
  DEFAULT_ECOSYSTEMS,
  SUPPLY_CHAIN_RISK_TERMS,
  normalizeBudget,
  packageCandidatesForKeyword,
  pypiProjectCandidatesForKeyword,
  goModuleCandidatesForKeyword,
  osvQueryBody,
  githubAdvisorySearchUrl,
  npmRegistrySearchUrl,
  cratesIoSearchUrl,
  rubygemsSearchUrl,
  packagistSearchUrl,
  mavenCentralSearchUrl,
  nugetSearchUrl,
  dockerHubSearchUrl,
  quaySearchUrl,
  pypiProjectJsonUrl,
  goDepsDevPackageUrl,
  normalizeSupplyChainAdvisoryDedupeUrl,
  supplyChainAdvisoryDedupeKey,
  advisoryRiskLevel,
  packageRegistryRiskLevel,
  packageSensitiveTermSignal,
  supplyChainRiskBucket,
  supplyChainRiskSignals,
  supplyChainKeywordMatchSource,
  withSupplyChainDiagnostics,
  parseOsvVulnerabilities,
  parseGithubSecurityAdvisories,
  parseNpmRegistrySearchResults,
  parseCratesIoSearchResults,
  parsePypiProjectJson,
  parseRubyGemsSearchResults,
  parsePackagistSearchResults,
  parseMavenCentralSearchResults,
  parseNugetSearchResults,
  parseDockerHubSearchResults,
  parseQuaySearchResults,
  parseGoDepsDevPackage,
};
