/**
 * scrapers/public-enforcement-action-sources.js — public enforcement and complaint discovery
 *
 * Uses no-key official public endpoints to collect high-trust regulatory
 * enforcement, complaint, and market conduct signals.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, insertSentimentItem } from "../sentiment-store.js";

const execFileAsync = promisify(execFile);
const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_CFPB_COMPLAINT_PAGES = 3;
const DEFAULT_MAX_FCC_COMPLAINT_PAGES = 3;
const DEFAULT_MAX_CMS_PROVIDER_DATA_PAGES = 3;
const DEFAULT_MAX_EPA_ECHO_CASE_PAGES = 3;
const DEFAULT_MAX_ICO_ENFORCEMENT_PAGES = 3;
const DEFAULT_MAX_IRELAND_DPC_DECISION_PAGES = 3;
const DEFAULT_MAX_FRANCE_CNIL_SANCTION_PAGES = 3;
const DEFAULT_MAX_FINRA_DISCIPLINARY_ACTION_PAGES = 3;
const DEFAULT_MAX_NCUA_ADMINISTRATIVE_ORDER_PAGES = 3;
const DEFAULT_MAX_OCC_ENFORCEMENT_ACTION_PAGES = 3;
const DEFAULT_MAX_WASHINGTON_AG_DATA_BREACH_PAGES = 3;
const DEFAULT_MAX_OSHA_ESTABLISHMENT_INSPECTION_PAGES = 3;
const CFPB_COMPLAINTS_API_URL = "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/";
const CFPB_ENFORCEMENT_ACTIONS_URL = "https://www.consumerfinance.gov/enforcement/actions/";
const OCC_ENFORCEMENT_ACTION_SEARCH_URL = "https://apps.occ.gov/EASearch/";
const FCC_CONSUMER_COMPLAINTS_API_URL = "https://opendata.fcc.gov/resource/3xyp-aqkj.json";
const OSHA_ESTABLISHMENT_SEARCH_URL = "https://www.osha.gov/ords/imis/establishment.search";
const OSHA_SEVERE_INJURY_INITIAL_SEARCH_JSON_URL = "https://www.osha.gov/sites/default/files/json/InitialSearch.json";
const CMS_NURSING_HOME_DEFICIENCIES_URL = "https://data.cms.gov/provider-data/api/1/datastore/query/r5ix-sfxw/0";
const CMS_NURSING_HOME_PENALTIES_URL = "https://data.cms.gov/provider-data/api/1/datastore/query/g6vv-u9sr/0";
const HHS_OCR_BREACH_PORTAL_URL = "https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf";
const CALIFORNIA_OAG_DATA_BREACH_SEARCH_URL = "https://oag.ca.gov/privacy/databreach/list";
const WASHINGTON_AG_DATA_BREACH_NOTIFICATIONS_URL = "https://www.atg.wa.gov/data-breach-notifications";
const SEC_PRESS_RELEASES_RSS_URL = "https://www.sec.gov/news/pressreleases.rss";
const SEC_LITIGATION_RELEASES_RSS_URL = "https://www.sec.gov/enforcement-litigation/litigation-releases/rss";
const SEC_ADMINISTRATIVE_PROCEEDINGS_RSS_URL = "https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss";
const SEC_TRADING_SUSPENSIONS_RSS_URL = "https://www.sec.gov/enforcement-litigation/trading-suspensions/rss";
const CFTC_ENFORCEMENT_RSS_URL = "https://www.cftc.gov/RSS/RSSENF/rssenf.xml";
const FTC_PRESS_RELEASES_RSS_URL = "https://www.ftc.gov/feeds/press-release.xml";
const FTC_CONSUMER_PROTECTION_RSS_URL = "https://www.ftc.gov/feeds/press-release-consumer-protection.xml";
const DOJ_PRESS_RELEASES_RSS_URL = "https://www.justice.gov/news/rss?type=press_release";
const EEOC_NEWSROOM_RSS_URL = "https://www.eeoc.gov/rss/newsroom";
const FED_ENFORCEMENT_ACTIONS_RSS_URL = "https://www.federalreserve.gov/feeds/press_enforcement.xml";
const FDIC_PRESS_RELEASES_RSS_URL = "https://public.govdelivery.com/topics/USFDIC_26/feed.rss";
const FAA_PRESS_RELEASES_RSS_URL = "https://www.faa.gov/newsroom/press_releases/rss";
const UK_FCA_NEWS_RSS_URL = "https://www.fca.org.uk/news/rss.xml";
const UK_ICO_ENFORCEMENT_SEARCH_API_URL = "https://ico.org.uk/api/search";
const IRELAND_DPC_DECISIONS_URL = "https://www.dataprotection.ie/en/dpc-guidance/decisions";
const FRANCE_CNIL_SANCTIONS_URL = "https://www.cnil.fr/fr/les-sanctions-prononcees-par-la-cnil";
const FINRA_DISCIPLINARY_ACTIONS_URL = "https://www.finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions";
const HK_SFC_PRESS_RELEASES_RSS_URL = "https://www.sfc.hk/en/RSS-Feeds/Press-releases";
const HK_SFC_CIRCULARS_RSS_URL = "https://www.sfc.hk/en/RSS-Feeds/Circulars";
const ASIC_NEWSROOM_JSON_URL = "https://www.asic.gov.au/_data/mr2023";
const JAPAN_FSA_NEWS_RSS_URL = "https://www.fsa.go.jp/fsaNewsListAll_rss2.xml";
const BAFIN_MEASURES_SANCTIONS_RSS_URL = "https://www.bafin.de/EN/service/rss/_function/RSS_Massnahmen.xml?nn=187494";
const BAFIN_MEASURES_SANCTIONS_DE_RSS_URL = "https://www.bafin.de/DE/service/rss/_function/RSS_Massnahmen.xml?nn=154242";
const ACCC_NEWS_CENTRE_RSS_URL = "https://www.accc.gov.au/rss/news_centre.xml";
const EU_COMPETITION_DECISIONS_RSS_URL = "https://ec.europa.eu/newsroom/comp/feed?item_type_id=1069&lang=en&orderby=item_date";
const EU_COMPETITION_INVESTIGATIONS_RSS_URL = "https://ec.europa.eu/newsroom/comp/feed?item_type_id=1070&lang=en&orderby=item_date";
const UK_CMA_NEWS_ATOM_URL = "https://www.gov.uk/search/news-and-communications.atom?organisations[]=competition-and-markets-authority";
const CANADA_COMPETITION_BUREAU_ATOM_URL = "https://api.io.canada.ca/io-server/gc/news/en/v2?atomtitle=Competition+Bureau+Canada&dept=competitionbureau&format=atom&orderBy=desc&pick=50&publishedDate%3E=2021-07-23&sort=publishedDate";
const NCUA_ADMINISTRATIVE_ORDERS_URL = "https://ncua.gov/news/enforcement-actions/administrative-orders";
const NCUA_CALL_REPORT_LATE_FILERS_URL = "https://ncua.gov/news/enforcement-actions/call-report-cycle-late-filers-list";
const EPA_ECHO_CASE_SEARCH_URL = "https://echodata.epa.gov/echo/case_rest_services.get_cases";
const EPA_ECHO_CASE_QID_URL = "https://echodata.epa.gov/echo/case_rest_services.get_qid";
const DEFAULT_ENFORCEMENT_TARGETS = [
  { key: "cfpb_complaints", name: "CFPB Consumer Complaint Database", url: CFPB_COMPLAINTS_API_URL, kind: "consumer_complaint_api" },
  { key: "cfpb_enforcement_actions", name: "CFPB Enforcement Actions", url: CFPB_ENFORCEMENT_ACTIONS_URL, kind: "cfpb_enforcement_actions_html" },
  { key: "occ_enforcement_actions", name: "OCC Enforcement Actions Search", url: OCC_ENFORCEMENT_ACTION_SEARCH_URL, kind: "occ_enforcement_actions_html" },
  { key: "fcc_consumer_complaints", name: "FCC Consumer Complaints Data", url: FCC_CONSUMER_COMPLAINTS_API_URL, kind: "fcc_consumer_complaints_api" },
  { key: "osha_establishment_inspections", name: "OSHA Establishment Inspection Search", url: OSHA_ESTABLISHMENT_SEARCH_URL, kind: "osha_establishment_inspection_html" },
  { key: "osha_severe_injury_reports", name: "OSHA Severe Injury Reports", url: OSHA_SEVERE_INJURY_INITIAL_SEARCH_JSON_URL, kind: "osha_severe_injury_reports_json" },
  { key: "cms_nursing_home_deficiencies", name: "CMS Nursing Home Deficiencies", url: CMS_NURSING_HOME_DEFICIENCIES_URL, kind: "cms_nursing_home_deficiencies_api" },
  { key: "cms_nursing_home_penalties", name: "CMS Nursing Home Penalties", url: CMS_NURSING_HOME_PENALTIES_URL, kind: "cms_nursing_home_penalties_api" },
  { key: "hhs_ocr_breach_portal", name: "HHS OCR HIPAA Breach Portal", url: HHS_OCR_BREACH_PORTAL_URL, kind: "hhs_ocr_breach_portal_html" },
  { key: "california_oag_data_breaches", name: "California OAG Data Security Breach Notices", url: CALIFORNIA_OAG_DATA_BREACH_SEARCH_URL, kind: "california_oag_data_breach_html" },
  { key: "washington_ag_data_breaches", name: "Washington AG Data Breach Notifications", url: WASHINGTON_AG_DATA_BREACH_NOTIFICATIONS_URL, kind: "washington_ag_data_breach_html" },
  { key: "sec_press_releases", name: "SEC Press Releases", url: SEC_PRESS_RELEASES_RSS_URL, kind: "sec_press_release_rss" },
  { key: "sec_litigation_releases", name: "SEC Litigation Releases", url: SEC_LITIGATION_RELEASES_RSS_URL, kind: "sec_press_release_rss" },
  { key: "sec_administrative_proceedings", name: "SEC Administrative Proceedings", url: SEC_ADMINISTRATIVE_PROCEEDINGS_RSS_URL, kind: "sec_press_release_rss" },
  { key: "sec_trading_suspensions", name: "SEC Trading Suspensions", url: SEC_TRADING_SUSPENSIONS_RSS_URL, kind: "sec_press_release_rss" },
  { key: "cftc_enforcement_actions", name: "CFTC Enforcement Press Releases", url: CFTC_ENFORCEMENT_RSS_URL, kind: "cftc_enforcement_rss" },
  { key: "ftc_press_releases", name: "FTC Press Releases", url: FTC_PRESS_RELEASES_RSS_URL, kind: "ftc_press_release_rss" },
  { key: "ftc_consumer_protection", name: "FTC Consumer Protection Press Releases", url: FTC_CONSUMER_PROTECTION_RSS_URL, kind: "ftc_press_release_rss" },
  { key: "doj_press_releases", name: "DOJ Press Releases", url: DOJ_PRESS_RELEASES_RSS_URL, kind: "doj_press_release_rss" },
  { key: "eeoc_newsroom", name: "EEOC Newsroom", url: EEOC_NEWSROOM_RSS_URL, kind: "eeoc_newsroom_rss" },
  { key: "fed_enforcement_actions", name: "Federal Reserve Enforcement Actions", url: FED_ENFORCEMENT_ACTIONS_RSS_URL, kind: "fed_enforcement_actions_rss" },
  { key: "fdic_press_releases", name: "FDIC Press Releases", url: FDIC_PRESS_RELEASES_RSS_URL, kind: "fdic_press_release_rss" },
  { key: "faa_press_releases", name: "FAA Press Releases", url: FAA_PRESS_RELEASES_RSS_URL, kind: "faa_press_release_rss" },
  { key: "uk_fca_news", name: "UK FCA News RSS", url: UK_FCA_NEWS_RSS_URL, kind: "uk_fca_news_rss" },
  { key: "uk_ico_enforcement", name: "UK ICO Enforcement Search", url: UK_ICO_ENFORCEMENT_SEARCH_API_URL, kind: "uk_ico_enforcement_search_api" },
  { key: "ireland_dpc_decisions", name: "Ireland DPC GDPR Decisions", url: IRELAND_DPC_DECISIONS_URL, kind: "ireland_dpc_decisions_html" },
  { key: "france_cnil_sanctions", name: "France CNIL Sanctions", url: FRANCE_CNIL_SANCTIONS_URL, kind: "france_cnil_sanctions_html" },
  { key: "finra_disciplinary_actions", name: "FINRA Disciplinary Actions Online", url: FINRA_DISCIPLINARY_ACTIONS_URL, kind: "finra_disciplinary_actions_html" },
  { key: "hk_sfc_press_releases", name: "Hong Kong SFC Press Releases", url: HK_SFC_PRESS_RELEASES_RSS_URL, kind: "hk_sfc_press_release_rss" },
  { key: "hk_sfc_circulars", name: "Hong Kong SFC Circulars", url: HK_SFC_CIRCULARS_RSS_URL, kind: "hk_sfc_circular_rss" },
  { key: "asic_newsroom_enforcement", name: "ASIC Newsroom Enforcement Releases", url: ASIC_NEWSROOM_JSON_URL, kind: "asic_newsroom_json" },
  { key: "japan_fsa_news", name: "Japan Financial Services Agency News RSS", url: JAPAN_FSA_NEWS_RSS_URL, kind: "japan_fsa_news_rss" },
  { key: "bafin_measures_sanctions", name: "BaFin Measures and Sanctions RSS", url: BAFIN_MEASURES_SANCTIONS_RSS_URL, kind: "bafin_measures_sanctions_rss" },
  { key: "bafin_measures_sanctions_de", name: "BaFin Massnahmen RSS", url: BAFIN_MEASURES_SANCTIONS_DE_RSS_URL, kind: "bafin_measures_sanctions_rss" },
  { key: "accc_news_centre", name: "ACCC News Centre", url: ACCC_NEWS_CENTRE_RSS_URL, kind: "accc_news_centre_rss" },
  { key: "eu_competition_decisions", name: "European Commission Competition Decisions", url: EU_COMPETITION_DECISIONS_RSS_URL, kind: "eu_competition_decision_rss" },
  { key: "eu_competition_investigations", name: "European Commission Competition Investigations", url: EU_COMPETITION_INVESTIGATIONS_RSS_URL, kind: "eu_competition_investigation_rss" },
  { key: "uk_cma_news", name: "UK CMA News and Communications", url: UK_CMA_NEWS_ATOM_URL, kind: "uk_cma_news_atom" },
  { key: "canada_competition_bureau", name: "Competition Bureau Canada News", url: CANADA_COMPETITION_BUREAU_ATOM_URL, kind: "canada_competition_bureau_atom" },
  { key: "ncua_administrative_orders", name: "NCUA Administrative Orders", url: NCUA_ADMINISTRATIVE_ORDERS_URL, kind: "ncua_administrative_orders_html" },
  { key: "ncua_call_report_late_filers", name: "NCUA Call Report Late Filers", url: NCUA_CALL_REPORT_LATE_FILERS_URL, kind: "ncua_call_report_late_filers_html" },
  { key: "epa_echo_enforcement_cases", name: "EPA ECHO Enforcement Case Search", url: EPA_ECHO_CASE_SEARCH_URL, kind: "epa_echo_enforcement_cases_api" },
];
const DEFAULT_SEC_PRESS_RELEASE_TARGET = DEFAULT_ENFORCEMENT_TARGETS.find(target => target.key === "sec_press_releases");
const SEC_ENFORCEMENT_TERMS = [
  "charged",
  "charges",
  "settles",
  "settlement",
  "enforcement",
  "fraud",
  "misleading",
  "disclosure",
  "violation",
  "penalty",
  "litigation",
  "lawsuit",
  "suspends",
  "suspension",
  "trading suspension",
  "litigation release",
  "administrative proceeding",
  "administrative proceedings",
  "cease-and-desist",
  "行政",
  "執法",
  "处罚",
  "處罰",
  "罚款",
  "罰款",
];
const CFTC_ENFORCEMENT_TERMS = [
  "commodity futures trading commission",
  "charged",
  "charges",
  "files action",
  "orders",
  "order",
  "secures judgment",
  "court order",
  "summary judgment",
  "default judgment",
  "civil monetary penalty",
  "civil monetary penalties",
  "penalty",
  "penalties",
  "restitution",
  "disgorgement",
  "trading ban",
  "registration ban",
  "permanent injunction",
  "injunction",
  "fraud",
  "fraudulent",
  "fraud scheme",
  "commodity pool",
  "commodity pool operator",
  "commodity trading advisor",
  "futures commission merchant",
  "swap dealer",
  "swap valuation",
  "spoofing",
  "manipulation",
  "market manipulation",
  "insider trading",
  "event contracts",
  "retail foreign currency",
  "forex",
  "digital asset",
  "virtual currency",
  "whistleblower award",
  "whistleblower awards",
  "執法",
  "执法",
  "商品期货",
  "商品期貨",
  "衍生品",
  "掉期",
  "欺诈",
  "欺詐",
  "操纵",
  "操縱",
  "罚款",
  "罰款",
  "交易禁令",
  "内幕交易",
  "內幕交易",
];
const FTC_ENFORCEMENT_TERMS = [
  "ftc",
  "federal trade commission",
  "refund",
  "redress",
  "settlement",
  "order",
  "consent",
  "complaint",
  "charges",
  "charged",
  "enforcement",
  "lawsuit",
  "deceptive",
  "unfair",
  "fraud",
  "scam",
  "privacy",
  "data security",
  "misleading",
  "advertising",
  "consumer protection",
  "telemarketing",
  "robocall",
  "subscription",
  "dark pattern",
  "made in usa",
  "antitrust",
  "competition",
  "penalty",
  "civil penalty",
  "禁令",
  "和解",
  "欺騙",
  "欺骗",
  "詐騙",
  "诈骗",
  "隱私",
  "隐私",
  "不公平",
  "虛假",
  "虚假",
];
const DOJ_ENFORCEMENT_TERMS = [
  "department of justice",
  "justice department",
  "u.s. attorney",
  "charged",
  "charges",
  "indicted",
  "indictment",
  "pleaded guilty",
  "pleads guilty",
  "sentenced",
  "settlement",
  "civil settlement",
  "consent decree",
  "lawsuit",
  "complaint",
  "fraud",
  "false claims",
  "antitrust",
  "monopoly",
  "price fixing",
  "bribery",
  "corruption",
  "kickback",
  "money laundering",
  "cybercrime",
  "data breach",
  "sanctions",
  "export control",
  "consumer protection",
  "environmental",
  "health care fraud",
  "healthcare fraud",
  "opioid",
  "bankruptcy",
  "forfeiture",
  "arrest",
  "執法",
  "执法",
  "司法部",
  "起訴",
  "起诉",
  "指控",
  "判刑",
  "和解",
  "欺詐",
  "欺诈",
  "反壟斷",
  "反垄断",
];
const EEOC_ENFORCEMENT_TERMS = [
  "eeoc",
  "equal employment opportunity commission",
  "discrimination",
  "harassment",
  "retaliation",
  "lawsuit",
  "sues",
  "settle",
  "settlement",
  "consent decree",
  "pay",
  "race discrimination",
  "sex discrimination",
  "sexual harassment",
  "pregnancy discrimination",
  "disability discrimination",
  "age discrimination",
  "religious discrimination",
  "national origin",
  "hostile work environment",
  "reasonable accommodation",
  "americans with disabilities act",
  "ada",
  "title vii",
  "equal pay",
  "wrongful termination",
  "fired",
  "hiring",
  "promotion",
  "雇佣歧視",
  "雇佣歧视",
  "就業歧視",
  "就业歧视",
  "性騷擾",
  "性骚扰",
  "報復",
  "报复",
  "懷孕歧視",
  "怀孕歧视",
  "殘障歧視",
  "残障歧视",
];
const FED_ENFORCEMENT_TERMS = [
  "federal reserve",
  "federal reserve board",
  "enforcement action",
  "enforcement actions",
  "cease-and-desist",
  "civil money penalty",
  "prohibition",
  "written agreement",
  "consent order",
  "termination of enforcement",
  "bank holding company",
  "bankshares",
  "state member bank",
  "former employee",
  "unsafe or unsound",
  "bsa",
  "aml",
  "compliance",
  "fraud",
  "penalty",
  "美联储",
  "美聯儲",
  "銀行監管",
  "银行监管",
  "執法",
  "执法",
  "处罚",
  "處罰",
];
const FDIC_ENFORCEMENT_TERMS = [
  "fdic",
  "federal deposit insurance corporation",
  "enforcement actions",
  "enforcement action",
  "administrative enforcement",
  "administrative enforcement actions",
  "enforcement decisions and orders",
  "consent order",
  "orders terminating consent orders",
  "civil money penalties",
  "civil money penalty",
  "order of prohibition",
  "orders of prohibition",
  "termination of deposit insurance",
  "notice of charges",
  "prompt corrective action",
  "section 8",
  "bank",
  "individuals",
  "regulatory",
  "compliance",
  "unsafe or unsound",
  "金融存款保险",
  "存款保险",
  "銀行監管",
  "银行监管",
  "執法",
  "执法",
  "处罚",
  "處罰",
];
const FAA_ENFORCEMENT_TERMS = [
  "faa",
  "federal aviation administration",
  "civil penalty",
  "civil penalties",
  "fine",
  "fines",
  "proposes",
  "proposed fine",
  "proposed fines",
  "enforcement",
  "enforcement letter",
  "violation",
  "violations",
  "alleged",
  "safety violation",
  "safety violations",
  "careless and reckless",
  "pilot training",
  "pilot qualification",
  "airworthiness",
  "hazardous materials",
  "hazmat",
  "drone",
  "no drone zones",
  "temporary flight restrictions",
  "tfr",
  "unruly passenger",
  "intoxicated passenger",
  "maintenance",
  "repair station",
  "certificate",
  "certification",
  "航空",
  "民航",
  "罚款",
  "罰款",
  "安全违规",
  "安全違規",
  "无人机",
  "無人機",
];
const UK_FCA_ENFORCEMENT_TERMS = [
  "fca",
  "financial conduct authority",
  "warning",
  "warnings",
  "unauthorised",
  "unauthorized",
  "without authorisation",
  "without authorization",
  "financial crime",
  "fraud",
  "fraudster",
  "ponzi",
  "scam",
  "clone",
  "consumer warning",
  "misleading",
  "misled",
  "fine",
  "fines",
  "penalty",
  "confiscation order",
  "court order",
  "civil proceedings",
  "injunction",
  "administration",
  "special administrators",
  "cease",
  "requirements",
  "enforcement",
  "market abuse",
  "money laundering",
  "consumer duty",
  "广告误导",
  "廣告誤導",
  "金融犯罪",
  "诈骗",
  "詐騙",
  "庞氏",
  "龐氏",
  "未经授权",
  "未經授權",
  "罚款",
  "罰款",
];
const HK_SFC_ENFORCEMENT_TERMS = [
  "sfc",
  "securities and futures commission",
  "hong kong",
  "enforcement",
  "press release",
  "reprimands",
  "reprimanded",
  "fine",
  "fined",
  "fines",
  "disciplinary",
  "discipline",
  "prosecution",
  "sentenced",
  "jail",
  "convicted",
  "insider dealing",
  "market misconduct",
  "market manipulation",
  "fraud",
  "misconduct",
  "suspends",
  "suspended",
  "licence revoked",
  "licensed corporation",
  "asset management",
  "virtual asset",
  "stablecoin",
  "cybersecurity",
  "cyberattack",
  "account opening",
  "client assets",
  "anti-money laundering",
  "aml",
  "香港",
  "證監會",
  "证监会",
  "證券及期貨事務監察委員會",
  "证券及期货事务监察委员会",
  "執法",
  "执法",
  "罰款",
  "罚款",
  "內幕交易",
  "内幕交易",
  "市場失當行為",
  "市场失当行为",
  "虛擬資產",
  "虚拟资产",
  "網絡安全",
  "网络安全",
];
const ASIC_ENFORCEMENT_TERMS = [
  "enforcement",
  "bannings and alerts",
  "banned",
  "banning",
  "disqualified",
  "disqualifies",
  "disqualification",
  "convicted",
  "charges",
  "charged",
  "sentenced",
  "proceedings",
  "civil penalty",
  "penalty",
  "penalties",
  "infringement notice",
  "breach",
  "breached",
  "misconduct",
  "misleading",
  "false or misleading",
  "market integrity",
  "market manipulation",
  "insider trading",
  "credit licence",
  "afs licence",
  "australian financial services licence",
  "licence cancelled",
  "licence suspended",
  "court enforceable undertaking",
  "enforceable undertaking",
  "compliance review",
  "managed investment",
  "crypto",
  "investment scheme",
  "scam",
  "fraud",
  "執法",
  "执法",
  "禁令",
  "停牌",
  "取消牌照",
  "撤銷牌照",
  "罚款",
  "罰款",
  "誤導",
  "误导",
];
const JAPAN_FSA_ENFORCEMENT_TERMS = [
  "financial services agency",
  "japan fsa",
  "jfsa",
  "administrative action",
  "administrative actions",
  "administrative disposition",
  "business improvement order",
  "business suspension order",
  "order to report",
  "suspension order",
  "registration revoked",
  "revocation",
  "financial instruments and exchange act",
  "banking act",
  "payment services act",
  "crypto-asset exchange service provider",
  "unregistered",
  "surcharge",
  "penalty",
  "insider trading",
  "market manipulation",
  "false statement",
  "securities and exchange surveillance commission",
  "金融庁",
  "金融廳",
  "行政処分",
  "行政處分",
  "業務改善命令",
  "業務停止命令",
  "報告徴求命令",
  "登録取消",
  "登録取消し",
  "登録抹消",
  "課徴金",
  "課徵金",
  "納付命令",
  "勧告",
  "証券取引等監視委員会",
  "金融商品取引法",
  "金商法",
  "銀行法",
  "資金決済法",
  "暗号資産交換業者",
  "無登録",
  "無登録業者",
  "虚偽記載",
  "相場操縦",
  "インサイダー取引",
  "内部者取引",
  "罰金",
  "罚款",
  "執法",
  "执法",
];
const BAFIN_ENFORCEMENT_TERMS = [
  "bafin",
  "federal financial supervisory authority",
  "measures and sanctions",
  "measure",
  "sanction",
  "prohibited",
  "prohibits",
  "prohibition",
  "administrative fine",
  "disciplinary fine",
  "fine",
  "breach of supervisory duties",
  "contravention",
  "german securities trading act",
  "wphg",
  "german banking act",
  "kwg",
  "market abuse regulation",
  "mar",
  "german capital investment act",
  "vermanlg",
  "anti-money laundering",
  "money laundering",
  "special inspection",
  "cease",
  "unauthorised",
  "unauthorized",
  "required prospectus",
  "prospectus",
  "public offering",
  "bundesanstalt für finanzdienstleistungsaufsicht",
  "bundesanstalt fuer finanzdienstleistungsaufsicht",
  "maßnahmen",
  "massnahmen",
  "sanktionen",
  "geldbuße",
  "geldbusse",
  "bußgeld",
  "bussgeld",
  "ordnungsgeld",
  "festgesetzt",
  "untersagt",
  "untersagung",
  "verbot",
  "mängelbeseitigung",
  "maengelbeseitigung",
  "sonderbeauftragten",
  "eigenmittel",
  "geldwäsche",
  "geldwaesche",
  "terrorismusfinanzierung",
  "verstoß",
  "verstoss",
  "aufsichtspflichtverletzung",
  "wertpapierhandelsgesetz",
  "kreditwesengesetz",
  "marktmissbrauchsverordnung",
  "vermögensanlagengesetz",
  "vermoegensanlagengesetz",
  "prospekt",
  "öffentliches angebot",
  "oeffentliches angebot",
  "德国金融监管",
  "德國金融監管",
  "德国金融监管局",
  "德國金融監管局",
  "行政罚款",
  "行政罰款",
  "禁止公开发行",
  "禁止公開發行",
  "反洗钱",
  "反洗錢",
  "市场滥用",
  "市場濫用",
  "招股说明书",
  "招股說明書",
];
const ACCC_ENFORCEMENT_TERMS = [
  "accc",
  "australian competition and consumer commission",
  "court-enforceable undertaking",
  "undertaking",
  "penalties",
  "penalty",
  "infringement notice",
  "infringement notices",
  "misleading",
  "deceptive",
  "false",
  "consumer law",
  "competition law",
  "anti-competitive",
  "substantially lessening competition",
  "market power",
  "cartel",
  "scam",
  "greenwashing",
  "recall",
  "investigation",
  "enforcement",
  "compliance",
  "advertising",
  "social media",
  "digital platform",
  "pricing",
  "refund",
  "澳大利亞",
  "澳大利亚",
  "競爭",
  "竞争",
  "消費者",
  "消费者",
  "誤導",
  "误导",
  "罰款",
  "罚款",
  "執法",
  "执法",
];
const EU_COMPETITION_TERMS = [
  "commission",
  "european commission",
  "competition",
  "antitrust",
  "cartel",
  "cartels",
  "state aid",
  "merger regulation",
  "foreign subsidies",
  "digital markets act",
  "dma",
  "statement of objections",
  "statements of objections",
  "in-depth investigation",
  "opens investigation",
  "preliminary findings",
  "interim measures",
  "imposes",
  "fines",
  "fine",
  "penalty",
  "approve",
  "approves",
  "blocks",
  "commitments",
  "distort competition",
  "reduce competition",
  "subsidies",
  "eu competition rules",
  "internal market",
  "反壟斷",
  "反垄断",
  "競爭",
  "竞争",
  "歐盟",
  "欧盟",
  "數字市場法",
  "数字市场法",
  "補貼",
  "补贴",
  "罰款",
  "罚款",
];
const UK_CMA_ENFORCEMENT_TERMS = [
  "cma",
  "competition and markets authority",
  "competition",
  "consumer",
  "consumer protection",
  "investigation",
  "investigates",
  "in-depth investigation",
  "market investigation",
  "market study",
  "strategic market status",
  "conduct requirement",
  "remedies",
  "undertakings",
  "court-endorsed",
  "settlement",
  "misled consumers",
  "misleading",
  "unfair",
  "anti-competitive",
  "cartel",
  "merger",
  "phase 2",
  "penalty",
  "fine",
  "digital markets",
  "green claims",
  "英国",
  "英國",
  "竞争",
  "競爭",
  "消费者",
  "消費者",
  "调查",
  "調查",
  "误导",
  "誤導",
  "整改",
  "补救",
  "補救",
];
const CANADA_COMPETITION_BUREAU_TERMS = [
  "competition bureau",
  "competition bureau canada",
  "commissioner of competition",
  "competition tribunal",
  "competition act",
  "competitive markets",
  "competition concerns",
  "anti-competitive",
  "anticompetitive",
  "colluding",
  "collusion",
  "bid-rigging",
  "price-fixing",
  "deceptive marketing",
  "misleading advertising",
  "drip pricing",
  "fraud",
  "scam",
  "impersonation",
  "deceptive",
  "merger",
  "proposed acquisition",
  "acquisition",
  "court order",
  "court orders",
  "consent agreement",
  "agreement to protect competition",
  "investigation",
  "investigations",
  "challenge",
  "challenges",
  "penalty",
  "penalties",
  "fine",
  "fines",
  "canada",
  "加拿大",
  "競爭",
  "竞争",
  "反壟斷",
  "反垄断",
  "誤導",
  "误导",
  "詐騙",
  "诈骗",
  "合併",
  "合并",
  "收購",
  "收购",
  "調查",
  "调查",
];
const ICO_ENFORCEMENT_ROOT_PAGE_ID = 17222;

function cleanText(value = "", max = 1200) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function fetchTextWithCurlFallback(url = "", { accept = "application/json,text/plain,*/*", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const safeUrl = String(url || "").trim();
  if (!/^https:\/\//i.test(safeUrl)) throw new Error("curl fallback only supports HTTPS public sources");
  const maxSeconds = String(Math.max(1, Math.ceil(Number(timeoutMs || REQUEST_TIMEOUT_MS) / 1000)));
  const { stdout } = await execFileAsync("curl", [
    "-fsSL",
    "--max-time", maxSeconds,
    "-H", `User-Agent: ${BROWSER_USER_AGENT}`,
    "-H", `Accept: ${accept}`,
    safeUrl,
  ], {
    encoding: "utf8",
    maxBuffer: 2_000_000,
    timeout: Number(timeoutMs || REQUEST_TIMEOUT_MS) + 2000,
  });
  return String(stdout || "");
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(40, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
  };
}

function normalizeCfpbComplaintPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_CFPB_COMPLAINT_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_CFPB_COMPLAINT_PAGES;
}

function normalizeFccComplaintPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_FCC_COMPLAINT_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_FCC_COMPLAINT_PAGES;
}

function normalizeCmsProviderDataPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_CMS_PROVIDER_DATA_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_CMS_PROVIDER_DATA_PAGES;
}

function normalizeEpaEchoCasePageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_EPA_ECHO_CASE_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_EPA_ECHO_CASE_PAGES;
}

function normalizeIcoEnforcementPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_ICO_ENFORCEMENT_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_ICO_ENFORCEMENT_PAGES;
}

function normalizeIrelandDpcDecisionPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_IRELAND_DPC_DECISION_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_IRELAND_DPC_DECISION_PAGES;
}

function normalizeFranceCnilSanctionPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_FRANCE_CNIL_SANCTION_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_FRANCE_CNIL_SANCTION_PAGES;
}

function normalizeFinraDisciplinaryActionPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_FINRA_DISCIPLINARY_ACTION_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_FINRA_DISCIPLINARY_ACTION_PAGES;
}

function normalizeNcuaAdministrativeOrderPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_NCUA_ADMINISTRATIVE_ORDER_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_NCUA_ADMINISTRATIVE_ORDER_PAGES;
}

function normalizeOccEnforcementActionPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_OCC_ENFORCEMENT_ACTION_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_OCC_ENFORCEMENT_ACTION_PAGES;
}

function normalizeWashingtonAgDataBreachPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_WASHINGTON_AG_DATA_BREACH_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_WASHINGTON_AG_DATA_BREACH_PAGES;
}

function normalizeOshaEstablishmentInspectionPageBudget(budget = {}) {
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_OSHA_ESTABLISHMENT_INSPECTION_PAGES));
  return Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_OSHA_ESTABLISHMENT_INSPECTION_PAGES;
}

function normalizeDate(value = "") {
  const raw = String(value || "").trim();
  const normalized = raw
    .replace(/\s+JST\b/i, " +0900")
    .replace(/\s+-\s+(\d{1,2}:\d{2})(?::\d{2})?\s*$/i, " $1");
  const time = new Date(raw || "").getTime();
  const normalizedTime = Number.isNaN(time) ? new Date(normalized || "").getTime() : time;
  return Number.isNaN(normalizedTime) ? "" : new Date(normalizedTime).toISOString();
}

function normalizeUsDateUtc(value = "") {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return normalizeDate(value);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !day || !year) return "";
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function normalizeDayMonthYearDateUtc(value = "") {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return normalizeDate(value);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !day || !year) return "";
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function normalizeIsoDateFieldUtc(value = "") {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (!match) return normalizeDate(value);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString();
}

function normalizeEnglishDayMonthDateUtc(value = "") {
  const match = String(value || "").trim().match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (!match) return normalizeDate(value);
  const month = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].indexOf(match[2].toLowerCase());
  if (month < 0) return "";
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1]))).toISOString();
}

function normalizeTargets(targets = DEFAULT_ENFORCEMENT_TARGETS) {
  const requested = Array.isArray(targets) && targets.length ? targets : DEFAULT_ENFORCEMENT_TARGETS;
  const byKey = new Map(DEFAULT_ENFORCEMENT_TARGETS.map(target => [target.key, target]));
  return requested
    .map(target => {
      if (typeof target === "string") return byKey.get(target) || { key: target, name: target, url: target, kind: "custom" };
      return target;
    })
    .filter(target => target?.url);
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeEnforcementKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeEnforcementKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeEnforcementKeywordText(text);
  return keywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeEnforcementKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function textMatchesKeywordWithoutStopwords(text = "", keyword = "") {
  const fold = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const lower = fold(text);
  const compact = lower.replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  const raw = fold(cleanText(keyword, 180));
  const rawCompact = normalizeEnforcementKeywordText(raw);
  if (raw && lower.includes(raw)) return true;
  if (rawCompact && rawCompact.length >= 2 && normalizeEnforcementKeywordText(text).includes(rawCompact)) return true;
  const stopwords = new Set(["a", "an", "and", "or", "the", "of", "de", "des", "du", "la", "le", "les", "en", "et", "d", "l"]);
  const meaningfulNeedles = raw
    .split(/[\s,;|/()[\]{}"'`]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 3 && !stopwords.has(item));
  if (meaningfulNeedles.length > 1) {
    return meaningfulNeedles.every((needle) => {
      const normalizedNeedle = normalizeEnforcementKeywordText(needle);
      return lower.includes(needle) || (normalizedNeedle.length >= 2 && normalizeEnforcementKeywordText(text).includes(normalizedNeedle));
    });
  }
  return meaningfulNeedles.some((needle) => {
    const normalizedNeedle = normalizeEnforcementKeywordText(needle);
    return lower.includes(needle) || (normalizedNeedle.length >= 2 && normalizeEnforcementKeywordText(text).includes(normalizedNeedle));
  });
}

function enforcementRiskLevel({ title = "", content = "", issue = "", response = "", sourceKind = "" } = {}) {
  const text = `${title} ${content} ${issue} ${response} ${sourceKind}`.toLowerCase();
  if (/fraud|charged|charges|penalty|sanction|cease-and-desist|litigation|lawsuit|enforcement|settlement|redress|misleading|misled consumers|violation|unauthorized|scam|identity theft|administrative action|administrative proceeding|administrative fine|disciplinary fine|prohibited|prohibition|breach of supervisory duties|required prospectus|special inspection|business improvement order|business suspension order|order to report|registration revoked|surcharge|antitrust|anti-competitive|anticompetitive|collusion|colluding|bid-rigging|price-fixing|deceptive marketing|drip pricing|court order|court orders|court enforceable undertaking|enforceable undertaking|banned|banning|disqualified|disqualifies|disqualification|licence cancelled|licence suspended|consent agreement|competition tribunal|competition act|cartel|reprimand|reprimanded|disciplinary|prosecution|sentenced|jail|convicted|insider dealing|insider trading|market misconduct|market manipulation|commodity pool|swap dealer|swap valuation|spoofing|trading ban|registration ban|disgorgement|restitution|event contracts|virtual asset|stablecoin|cyberattack|cybersecurity|anti-money laundering|interim measures|competition rules|competition concerns|foreign subsidies|digital markets act|strategic market status|conduct requirement|remedies|phase 2|geldbuße|geldbusse|bußgeld|bussgeld|ordnungsgeld|untersagt|untersagung|mängelbeseitigung|maengelbeseitigung|sonderbeauftragten|geldwäsche|geldwaesche|aufsichtspflichtverletzung|verstoß|verstoss|marktmissbrauch|訴訟|诉讼|執法|执法|处罚|處罰|罚款|罰款|詐騙|诈骗|違規|违规|內幕交易|内幕交易|市場失當|市场失当|行政処分|行政處分|業務改善命令|業務停止命令|報告徴求命令|登録取消|課徴金|課徵金|納付命令|無登録|相場操縦|インサイダー取引|内部者取引/i.test(text)) return "high";
  if (/complaint|dispute|refund|response|investigation|regulator|監管|监管|投訴|投诉|爭議|争议|退款|調查|调查/i.test(text)) return "medium";
  return "low";
}

function numericEnforcementAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value || "").replace(/,/g, "");
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function enforcementAmountSignals(metrics = {}) {
  const amounts = [
    metrics.enforcement_amount,
    metrics.enforcement_amount_eur,
    metrics.enforcement_federal_penalty,
    metrics.penalty_amount,
    metrics.cms_penalty_amount,
    metrics.civil_money_penalty,
    metrics.consumer_redress_amount,
    metrics.disgorgement_amount,
    metrics.restitution_amount,
  ].map(numericEnforcementAmount).filter(value => Number.isFinite(value) && value > 0);
  const maxAmount = amounts.length ? Math.max(...amounts) : 0;
  if (maxAmount >= 10000000) return { amount: maxAmount, amountTier: "very_high", amountScore: 18 };
  if (maxAmount >= 1000000) return { amount: maxAmount, amountTier: "high", amountScore: 14 };
  if (maxAmount >= 100000) return { amount: maxAmount, amountTier: "material", amountScore: 10 };
  if (maxAmount > 0) return { amount: maxAmount, amountTier: "present", amountScore: 6 };
  return { amount: 0, amountTier: "none", amountScore: 0 };
}

function enforcementTermMatches(text = "", terms = []) {
  const source = normalizeEnforcementKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeEnforcementKeywordText(term);
    return needle && source.includes(needle);
  });
}

function publicEnforcementRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const metricText = Object.values(metrics)
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => cleanText(value, 400))
    .filter(Boolean)
    .join(" ");
  const text = cleanText(`${item.title || ""} ${item.content || ""} ${item.author || ""} ${metricText}`, 6000).toLowerCase();
  const { amount, amountTier, amountScore } = enforcementAmountSignals(metrics);
  const reasons = [];
  let score = metrics.source_family === "official" ? 20 : 10;
  const out = {};
  const evidenceTerms = enforcementTermMatches(text, [
    "complaint id", "complaint number", "case number", "docket", "release number", "order number", "consent order", "notice", "inspection", "breach report", "penalty amount",
    "投訴編號", "投诉编号", "案件編號", "案件编号", "案號", "案号", "命令編號", "命令编号", "檢查", "检查", "資料外洩通報", "数据泄露通报", "罰款金額", "罚款金额",
  ]);
  const stageTerms = enforcementTermMatches(text, [
    "charged", "charges", "filed", "investigation", "settlement", "consent order", "final order", "administrative proceeding", "litigation release", "order issued", "appeal",
    "指控", "起訴", "起诉", "立案", "調查", "调查", "和解", "同意命令", "最終命令", "最终命令", "行政程序", "發布命令", "发布命令", "上訴", "上诉",
  ]);
  const remedyTerms = enforcementTermMatches(text, [
    "redress", "restitution", "refund", "compensation", "disgorgement", "corrective action", "remediation", "compliance plan", "cease-and-desist", "consumer relief", "undertaking",
    "救濟", "救济", "返還", "返还", "退款", "賠償", "赔偿", "沒收", "没收", "整改", "改善措施", "合規計畫", "合规计划", "停止令", "消費者補償", "消费者补偿", "承諾書", "承诺书",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal(
    "enforcement_action_signal",
    "official enforcement/action language",
    /enforcement action|administrative action|administrative proceeding|disciplinary action|consent order|cease-and-desist|court order|sanction|penalty|charged|charges|files action|takes action|order to report|business improvement order|business suspension order|行政処分|行政處分|執法|执法|处罚|處罰/i.test(text)
      || /enforcement|action|proceeding|sanction|order|release/i.test(String(metrics.enforcement_record_type || "")),
    20,
  );
  addSignal("enforcement_penalty_signal", "penalty or sanction present", amount > 0 || /penalt|civil money penalty|monetary penalt|sanction|surcharge|disgorgement|restitution|redress|課徴金|課徵金|罚款|罰款|制裁/i.test(text), 16 + amountScore);
  addSignal("enforcement_fine_signal", "fine or monetary penalty language", /fine|fined|amende|geldbuße|geldbusse|bußgeld|bussgeld|administrative fine|monetary penalties|civil money|罚款|罰款/i.test(text), 10);
  addSignal("enforcement_injunction_signal", "injunction or cease-and-desist order", /injunction|cease-and-desist|cease and desist|restraining order|court order|prohibition order|禁止令|差止|業務停止命令/i.test(text), 12);
  addSignal("enforcement_lawsuit_signal", "lawsuit or litigation action", /lawsuit|litigation|sued|complaint charges|filed a complaint|court action|prosecution|訴訟|诉讼|起诉|起訴/i.test(text), 12);
  addSignal("enforcement_settlement_signal", "settlement or consent resolution", /settlement|settles|consent order|consent agreement|undertaking|court enforceable undertaking|enforceable undertaking|resolution|和解/i.test(text), 8);
  addSignal("enforcement_consumer_redress_signal", "consumer refund or redress impact", /refund|redress|restitution|compensation|monetary relief|consumer harm|consumer protection|misled consumers|unauthorized|deceptive|unfair|dark pattern|junk fee|overdraft|退款|赔偿|賠償|消费者|消費者/i.test(text), 12);
  addSignal("enforcement_data_privacy_signal", "privacy, data breach, or cyber issue", /privacy|data breach|personal data|gdpr|hipaa|cyberattack|cybersecurity|ransomware|breach portal|ocr breach|information security|个人信息|個人資料|数据泄露|資料外洩/i.test(text), 12);
  addSignal("enforcement_safety_signal", "workplace, aviation, healthcare, or product safety issue", /osha|inspection|severe injury|fatality|accident|aviation safety|faa|nursing home|deficienc|immediate jeopardy|health and safety|hazard|serious injury|安全|事故|伤害|傷害/i.test(text), 10);
  addSignal("enforcement_market_conduct_signal", "market conduct, fraud, disclosure, or competition issue", /fraud|misleading|misrepresentation|disclosure|market misconduct|market manipulation|insider trading|spoofing|swap dealer|commodity pool|antitrust|anti-competitive|anticompetitive|cartel|price-fixing|bid-rigging|collusion|competition|consumer financial|欺诈|欺詐|误导|誤導|垄断|壟斷|操纵|操縱|內幕交易|内幕交易/i.test(text), 18);
  addSignal("enforcement_employment_signal", "employment discrimination or labor enforcement", /eeoc|employment|discrimination|harassment|retaliation|pregnancy discrimination|wage|labor|worker|workplace rights|雇佣|僱傭|歧视|歧視/i.test(text), 8);
  addSignal("enforcement_environmental_signal", "environmental enforcement issue", /epa|environmental|pollution|clean water|clean air|rcra|cercla|hazardous waste|chemical|emissions|environment|环保|環保|污染/i.test(text), 8);
  addSignal("enforcement_criminal_signal", "criminal prosecution or conviction language", /criminal|prosecution|sentenced|convicted|jail|prison|guilty plea|indictment|felony|刑事|判刑|定罪/i.test(text), 16);
  addSignal("enforcement_license_restriction_signal", "license, registration, or trading restriction", /license suspended|licence suspended|license cancelled|licence cancelled|registration revoked|registration ban|trading ban|trading suspension|suspends trading|suspension order|prohibited from|禁止从业|禁止從業|登録取消/i.test(text), 12);
  addSignal("enforcement_disqualification_signal", "director, officer, or person disqualification", /disqualified|disqualifies|disqualification|banned from managing|banning order|prohibition from serving|director ban|禁止担任|禁止擔任/i.test(text), 12);
  addSignal("enforcement_evidence_language_signal", "case, order, inspection, notice, or amount evidence language", evidenceTerms.length > 0 || amount > 0, 10);
  addSignal("enforcement_case_stage_signal", "enforcement lifecycle or procedural stage language", stageTerms.length > 0, 10);
  addSignal("enforcement_remedy_language_signal", "redress, restitution, remediation, or cease-and-desist language", remedyTerms.length > 0, 10);

  const semanticSignals = [
    out.enforcement_action_signal,
    out.enforcement_penalty_signal,
    out.enforcement_fine_signal,
    out.enforcement_injunction_signal,
    out.enforcement_lawsuit_signal,
    out.enforcement_settlement_signal,
    out.enforcement_consumer_redress_signal,
    out.enforcement_data_privacy_signal,
    out.enforcement_safety_signal,
    out.enforcement_market_conduct_signal,
    out.enforcement_employment_signal,
    out.enforcement_environmental_signal,
    out.enforcement_criminal_signal,
    out.enforcement_license_restriction_signal,
    out.enforcement_disqualification_signal,
    out.enforcement_evidence_language_signal,
    out.enforcement_case_stage_signal,
    out.enforcement_remedy_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "enforcement_complete_action_narrative_signal",
    "complete enforcement action narrative",
    semanticSignals >= 5
      && out.enforcement_action_signal
      && (out.enforcement_penalty_signal || out.enforcement_market_conduct_signal || out.enforcement_consumer_redress_signal || out.enforcement_data_privacy_signal || out.enforcement_safety_signal)
      && (out.enforcement_evidence_language_signal || out.enforcement_case_stage_signal)
      && (out.enforcement_remedy_language_signal || out.enforcement_settlement_signal || out.enforcement_injunction_signal || out.enforcement_license_restriction_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    enforcement_risk_score: boundedScore,
    enforcement_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    enforcement_signal_count: signalFields.length,
    enforcement_semantic_signal_count: semanticSignals,
    enforcement_signal_reasons: [...new Set(reasons)].slice(0, 12),
    enforcement_evidence_terms: evidenceTerms,
    enforcement_case_stage_terms: stageTerms,
    enforcement_remedy_terms: remedyTerms,
    ...(amount > 0 ? {
      enforcement_detected_amount: amount,
      enforcement_detected_amount_tier: amountTier,
    } : {}),
  };
}

function cfpbComplaintSearchUrl(keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, from = 0 } = {}) {
  const params = new URLSearchParams({
    search_term: cleanText(keyword, 120),
    size: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    from: String(Math.max(0, Number(from) || 0)),
    sort: "created_date_desc",
  });
  return `${CFPB_COMPLAINTS_API_URL}?${params.toString()}`;
}

function cfpbEnforcementActionsSearchUrl(keyword = "") {
  const params = new URLSearchParams({ title: cleanText(keyword, 120) });
  return `${CFPB_ENFORCEMENT_ACTIONS_URL}?${params.toString()}`;
}

function occEnforcementActionSearchUrl(keyword = "", { page = null, limit = null } = {}) {
  if (page !== null || limit !== null) {
    const params = new URLSearchParams({
      q: cleanText(keyword, 120),
      pg: String(Math.max(0, Number(page) || 0)),
      pgsz: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
      isAdv: "false",
    });
    return new URL(`Search/Table?${params.toString()}`, OCC_ENFORCEMENT_ACTION_SEARCH_URL).toString();
  }
  const params = new URLSearchParams({ Search: cleanText(keyword, 120) });
  return `${OCC_ENFORCEMENT_ACTION_SEARCH_URL}?${params.toString()}`;
}

function fccConsumerComplaintSearchUrl(keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, offset = 0 } = {}) {
  const params = new URLSearchParams({
    "$q": cleanText(keyword, 120),
    "$limit": String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    "$offset": String(Math.max(0, Number(offset) || 0)),
    "$order": "ticket_created DESC",
  });
  return `${FCC_CONSUMER_COMPLAINTS_API_URL}?${params.toString()}`;
}

function oshaEstablishmentSearchUrl(keyword = "", { startYear = new Date().getUTCFullYear() - 2, endYear = new Date().getUTCFullYear(), limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, page = 0 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const normalizedPage = Math.max(0, Number(page) || 0);
  const params = new URLSearchParams({
    p_logger: "1",
    establishment: cleanText(keyword, 120),
    State: "all",
    officetype: "all",
    Office: "all",
    sitezip: "",
    p_case: "all",
    p_violations_exist: "both",
    startmonth: "01",
    startday: "01",
    startyear: String(startYear),
    endmonth: "12",
    endday: "31",
    endyear: String(endYear),
    p_sort: "12",
    p_desc: "DESC",
    p_show: String(normalizedLimit),
  });
  if (normalizedPage > 0) {
    params.set("p_start", "");
    params.set("p_finish", String(normalizedPage * normalizedLimit));
    params.set("p_direction", "Next");
  }
  return `${OSHA_ESTABLISHMENT_SEARCH_URL}?${params.toString()}`;
}

function oshaSevereInjuryReportsSearchUrl() {
  return OSHA_SEVERE_INJURY_INITIAL_SEARCH_JSON_URL;
}

function cmsNursingHomeDeficiencySearchUrl(keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, offset = 0 } = {}) {
  const params = new URLSearchParams({
    "conditions[0][property]": "provider_name",
    "conditions[0][operator]": "contains",
    "conditions[0][value]": cleanText(keyword, 120),
    limit: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    offset: String(Math.max(0, Number(offset) || 0)),
  });
  return `${CMS_NURSING_HOME_DEFICIENCIES_URL}?${params.toString()}`;
}

function cmsNursingHomePenaltySearchUrl(keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, offset = 0 } = {}) {
  const params = new URLSearchParams({
    "conditions[0][property]": "provider_name",
    "conditions[0][operator]": "contains",
    "conditions[0][value]": cleanText(keyword, 120),
    limit: String(Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    offset: String(Math.max(0, Number(offset) || 0)),
  });
  return `${CMS_NURSING_HOME_PENALTIES_URL}?${params.toString()}`;
}

function hhsOcrBreachPortalSearchUrl() {
  return HHS_OCR_BREACH_PORTAL_URL;
}

function californiaOagDataBreachSearchUrl(keyword = "") {
  const params = new URLSearchParams({
    field_sb24_org_name_value: cleanText(keyword, 120),
  });
  return `${CALIFORNIA_OAG_DATA_BREACH_SEARCH_URL}?${params.toString()}`;
}

function washingtonAgDataBreachSearchUrl(keyword = "", { page = 0 } = {}) {
  const params = new URLSearchParams({
    keys: cleanText(keyword, 120),
  });
  const normalizedPage = Math.max(0, Number(page) || 0);
  if (normalizedPage > 0) params.set("page", String(normalizedPage));
  return `${WASHINGTON_AG_DATA_BREACH_NOTIFICATIONS_URL}?${params.toString()}`;
}

function ukIcoEnforcementSearchBody(keyword = "", { pageNumber = 1, order = "newest" } = {}) {
  return {
    filters: [],
    pageNumber: Math.max(1, Number(pageNumber) || 1),
    order: cleanText(order, 40) || "newest",
    rootPageId: ICO_ENFORCEMENT_ROOT_PAGE_ID,
    term: cleanText(keyword, 120),
  };
}

function irelandDpcDecisionsSearchUrl(keyword = "", { page = 0 } = {}) {
  const params = new URLSearchParams({ search: cleanText(keyword, 120) });
  const normalizedPage = Math.max(0, Number(page) || 0);
  if (normalizedPage > 0) params.set("page", String(normalizedPage));
  return `${IRELAND_DPC_DECISIONS_URL}?${params.toString()}`;
}

function franceCnilSanctionsSearchUrl(keyword = "", { page = 0 } = {}) {
  const params = new URLSearchParams({ search: cleanText(keyword, 120) });
  const normalizedPage = Math.max(0, Number(page) || 0);
  if (normalizedPage > 0) params.set("page", String(normalizedPage));
  return `${FRANCE_CNIL_SANCTIONS_URL}?${params.toString()}`;
}

function finraDisciplinaryActionsSearchUrl(keyword = "", { page = 0 } = {}) {
  const params = new URLSearchParams({ search: cleanText(keyword, 120) });
  const normalizedPage = Math.max(0, Number(page) || 0);
  if (normalizedPage > 0) params.set("page", String(normalizedPage));
  return `${FINRA_DISCIPLINARY_ACTIONS_URL}?${params.toString()}`;
}

function ncuaAdministrativeOrdersSearchUrl(keyword = "", { page = 0 } = {}) {
  const params = new URLSearchParams({
    sort: "date",
    dir: "desc",
    sq: cleanText(keyword, 120),
  });
  const normalizedPage = Math.max(0, Number(page) || 0);
  if (normalizedPage > 0) params.set("page", String(normalizedPage));
  return `${NCUA_ADMINISTRATIVE_ORDERS_URL}?${params.toString()}#results`;
}

function ncuaCallReportLateFilersSearchUrl() {
  return NCUA_CALL_REPORT_LATE_FILERS_URL;
}

function epaEchoCaseSearchUrl(keyword = "") {
  const params = new URLSearchParams({
    output: "JSON",
    p_case_summary: cleanText(keyword, 120),
    p_case_summary_type: "CONTAINS",
    p_case_sens_flg: "N",
  });
  return `${EPA_ECHO_CASE_SEARCH_URL}?${params.toString()}`;
}

function epaEchoCaseQidUrl(qid = "", { page = 1 } = {}) {
  const params = new URLSearchParams({
    output: "JSON",
    qid: cleanText(qid, 80),
    pageno: String(Math.max(1, Number(page) || 1)),
  });
  return `${EPA_ECHO_CASE_QID_URL}?${params.toString()}`;
}

function normalizeCfpbComplaint(row = {}, keyword = "") {
  const source = row?._source || row || {};
  const complaintId = cleanText(source.complaint_id || source.complaintId || row?._id, 80);
  const company = cleanText(source.company, 220);
  const product = cleanText(source.product, 220);
  const issue = cleanText(source.issue, 260);
  const subIssue = cleanText(source.sub_issue, 260);
  const narrative = cleanText(source.complaint_what_happened, 1200);
  const response = cleanText(source.company_response || source.company_public_response, 360);
  const state = cleanText(source.state, 40);
  const submittedVia = cleanText(source.submitted_via, 80);
  const searchable = [complaintId, company, product, issue, subIssue, narrative, response, state, submittedVia].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(source.date_received || source.date_sent_to_company) || new Date().toISOString();
  return {
    url: complaintId
      ? `https://www.consumerfinance.gov/data-research/consumer-complaints/search/detail/${encodeURIComponent(complaintId)}`
      : "https://www.consumerfinance.gov/data-research/consumer-complaints/",
    title: `CFPB consumer complaint: ${company || keyword}${issue ? ` - ${issue}` : ""}`,
    content: [
      product ? `Product: ${product}.` : "",
      issue ? `Issue: ${issue}.` : "",
      subIssue ? `Sub-issue: ${subIssue}.` : "",
      narrative,
      response ? `Company response: ${response}.` : "",
      state ? `State: ${state}.` : "",
      submittedVia ? `Submitted via: ${submittedVia}.` : "",
    ].filter(Boolean).join(" "),
    author: "Consumer Financial Protection Bureau",
    publishedAt,
    riskLevel: enforcementRiskLevel({ issue, content: narrative, response, sourceKind: "consumer complaint" }),
    metrics: {
      source: "cfpb_complaints_api",
      source_family: "official",
      source_kind: "public_consumer_complaint",
      collection_mode: "cfpb_public_complaints_json",
      enforcement_record_source: "CFPB Consumer Complaint Database",
      enforcement_record_type: "consumer-complaint",
      complaint_id: complaintId,
      complaint_company: company,
      complaint_product: product,
      complaint_issue: issue,
      complaint_sub_issue: subIssue,
      complaint_state: state,
      complaint_company_response: response,
      complaint_submitted_via: submittedVia,
      source_weight_tier: "official-enforcement-complaint",
    },
  };
}

function parseCfpbComplaintResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.hits?.hits) ? payload.hits.hits : Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeCfpbComplaint(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.complaint_id || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countCfpbComplaintRawResults(payload = {}) {
  const rows = Array.isArray(payload?.hits?.hits) ? payload.hits.hits : Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  return rows.length;
}

function cfpbEnforcementActionCards(html = "") {
  const out = [];
  const source = String(html || "");
  const sectionMatch = source.match(/data-cy=["']filterable-list-results["'][\s\S]*?<\/section>/i);
  const body = sectionMatch ? sectionMatch[0] : source;
  const articleRegex = /<article\b[^>]*class=["'][^"']*\bo-post-preview\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = articleRegex.exec(body)) !== null) {
    const block = match[1] || "";
    const link = firstHref((block.match(/<h3\b[^>]*class=["'][^"']*\bo-post-preview__title\b[^"']*["'][^>]*>[\s\S]*?<\/h3>/i) || [])[0] || block);
    const dateMatch = block.match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>([\s\S]*?)<\/time>/i) || [];
    const filedDate = cleanText(dateMatch[1] || "", 80);
    const filedDateLabel = cleanText(dateMatch[2] || "", 80);
    const description = cleanText((block.match(/<div\b[^>]*class=["'][^"']*\bo-post-preview__description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "", 1800);
    if (link.url || link.text) out.push({ url: link.url, title: link.text, filedDate, filedDateLabel, description, block });
  }
  return out;
}

function cfpbEnforcementActionRiskLevel({ title = "", description = "" } = {}) {
  const text = `${title} ${description}`.toLowerCase();
  if (/complaint|consent order|order|proposed consent order|civil money penalty|penalt|redress|refund|illegal|violat|deceptive|unfair|abusive|discriminat|fraud|unauthori|credit reporting|debt collection|mortgage|student loan|payday|remittance|military lending|junk fee|overdraft|foreclosure/i.test(text)) return "high";
  if (/bureau filed|bureau issued|enforcement|consumer financial|settlement|supervision/i.test(text)) return "medium";
  return "low";
}

function normalizeCfpbEnforcementAction(card = {}, keyword = "") {
  const title = cleanText(card.title, 360);
  const description = cleanText(card.description, 1800);
  const url = absoluteUrl(card.url, CFPB_ENFORCEMENT_ACTIONS_URL);
  const actionId = cleanText((url.match(/\/enforcement\/actions\/([^/?#]+)\/?/i) || [])[1] || "", 160);
  const searchable = [actionId, title, description, card.filedDateLabel, url].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeIsoDateFieldUtc(card.filedDate) || normalizeDate(card.filedDateLabel) || new Date().toISOString();
  return {
    url: url || CFPB_ENFORCEMENT_ACTIONS_URL,
    title: `CFPB enforcement action: ${title || keyword}`,
    content: [
      title ? `Title: ${title}.` : "",
      description,
      card.filedDateLabel ? `Date filed: ${card.filedDateLabel}.` : "",
      actionId ? `Action ID: ${actionId}.` : "",
    ].filter(Boolean).join(" "),
    author: "Consumer Financial Protection Bureau",
    publishedAt,
    riskLevel: cfpbEnforcementActionRiskLevel({ title, description }),
    metrics: {
      source: "cfpb_enforcement_actions",
      source_family: "official",
      source_kind: "public_consumer_financial_enforcement_action",
      collection_mode: "cfpb_public_enforcement_actions_html",
      enforcement_record_source: "CFPB Enforcement Actions",
      enforcement_record_type: "cfpb-consumer-financial-enforcement-action",
      enforcement_document_number: actionId,
      enforcement_title: title,
      enforcement_action_date: card.filedDateLabel,
      enforcement_description: description,
      enforcement_detail_url: url,
      source_weight_tier: "official-consumer-financial-enforcement",
    },
  };
}

function parseCfpbEnforcementActionResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const card of cfpbEnforcementActionCards(html)) {
    const item = normalizeCfpbEnforcementAction(card, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_document_number || item.url || [item.title, item.publishedAt].filter(Boolean).join(":");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeFccConsumerComplaint(row = {}, keyword = "") {
  const complaintId = cleanText(row.id, 80);
  const issueType = cleanText(row.issue_type, 140);
  const method = cleanText(row.method, 180);
  const issue = cleanText(row.issue, 260);
  const callType = cleanText(row.type_of_call_or_messge, 180);
  const callerId = cleanText(row.caller_id_number, 80);
  const advertiserPhone = cleanText(row.advertiser_business_phone_number, 80);
  const goodsServices = cleanText(row.type_of_property_goods_or_services, 260);
  const city = cleanText(row.city, 220);
  const state = cleanText(row.state, 60);
  const zip = cleanText(row.zip, 40);
  const searchable = [complaintId, issueType, method, issue, callType, callerId, advertiserPhone, goodsServices, city, state, zip].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.ticket_created || row.date_created || row.issue_date) || new Date().toISOString();
  return {
    url: complaintId ? `https://opendata.fcc.gov/d/3xyp-aqkj?row_id=${encodeURIComponent(complaintId)}` : "https://opendata.fcc.gov/Consumer/Consumer-Complaints-Data/3xyp-aqkj",
    title: `FCC consumer complaint: ${issueType || "communications"}${issue ? ` - ${issue}` : ""}`,
    content: [
      issueType ? `Form: ${issueType}.` : "",
      method ? `Method: ${method}.` : "",
      issue ? `Issue: ${issue}.` : "",
      callType ? `Call/message type: ${callType}.` : "",
      goodsServices && goodsServices !== "None" ? `Goods/services: ${goodsServices}.` : "",
      callerId && callerId !== "None" ? `Caller ID number: ${callerId}.` : "",
      advertiserPhone && advertiserPhone !== "None" ? `Advertiser business phone: ${advertiserPhone}.` : "",
      city ? `City/location field: ${city}.` : "",
      state ? `State: ${state}.` : "",
      zip ? `ZIP: ${zip}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Federal Communications Commission",
    publishedAt,
    riskLevel: enforcementRiskLevel({ issue, content: `${issueType} ${method} ${callType} ${goodsServices}`, sourceKind: "fcc consumer complaint" }),
    metrics: {
      source: "fcc_consumer_complaints_api",
      source_family: "official",
      source_kind: "public_consumer_complaint",
      collection_mode: "fcc_public_consumer_complaints_socrata_json",
      enforcement_record_source: "FCC Consumer Complaints Data",
      enforcement_record_type: "consumer-complaint",
      complaint_id: complaintId,
      complaint_category: "communications",
      complaint_issue_type: issueType,
      complaint_method: method,
      complaint_issue: issue,
      complaint_call_or_message_type: callType,
      complaint_caller_id_number: callerId,
      complaint_advertiser_business_phone_number: advertiserPhone,
      complaint_goods_or_services: goodsServices,
      complaint_state: state,
      complaint_zip: zip,
      source_weight_tier: "official-enforcement-complaint",
    },
  };
}

function parseFccConsumerComplaintResults(payload = [], keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeFccConsumerComplaint(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.complaint_id || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countFccConsumerComplaintRawResults(payload = []) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return rows.length;
}

function htmlTableRows(html = "") {
  const out = [];
  const source = String(html || "");
  const tableMatch = source.match(/<table[^>]*>[\s\S]*?<th[^>]*>\s*Activity\s*<\/th>[\s\S]*?<\/table>/i);
  if (!tableMatch) return out;
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(tableMatch[0])) !== null) {
    const rowHtml = match[1] || "";
    if (/<th\b/i.test(rowHtml)) continue;
    const cells = [];
    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1] || "");
    }
    if (cells.length) out.push({ cells, rowHtml });
  }
  return out;
}

function tableCellBlocks(rowHtml = "") {
  return [...String(rowHtml || "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1] || "");
}

function firstHref(cellHtml = "") {
  const match = String(cellHtml || "").match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  return {
    url: cleanText(match?.[1] || "", 900),
    text: cleanText(match?.[2] || "", 120),
  };
}

function absoluteUrl(value = "", base = "https://apps.occ.gov/EASearch/") {
  try {
    return value ? new URL(value, base).toString() : "";
  } catch {
    return cleanText(value, 900);
  }
}

function normalizePublicEnforcementDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizePublicEnforcementDedupeUrl(embedded);
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

function publicEnforcementDedupeKey(item = {}) {
  const urlKey = normalizePublicEnforcementDedupeUrl(item.url || "");
  if (urlKey) return urlKey;
  const metrics = item.metrics || {};
  const source = cleanText(metrics.source || metrics.enforcement_record_source || "public-enforcement", 120).toLowerCase();
  const ids = [
    metrics.complaint_id,
    metrics.enforcement_case_number,
    metrics.enforcement_activity_id,
    metrics.enforcement_docket_number,
    metrics.enforcement_start_doc_id,
    metrics.enforcement_order_url,
    metrics.penalty_charter_number && [metrics.penalty_year, metrics.penalty_quarter, metrics.penalty_charter_number, metrics.penalty_amount].filter(Boolean).join(":"),
    metrics.deficiency_provider_id && [metrics.deficiency_provider_id, metrics.deficiency_inspection_date, metrics.deficiency_tag].filter(Boolean).join(":"),
    metrics.penalty_provider_id && [metrics.penalty_provider_id, metrics.penalty_date, metrics.penalty_type, metrics.penalty_amount].filter(Boolean).join(":"),
    metrics.breach_name && [metrics.breach_name, metrics.breach_report_date, metrics.breach_individuals_affected].filter(Boolean).join(":"),
    metrics.injury_report_key,
  ].map(value => cleanText(value || "", 260)).filter(Boolean);
  if (ids.length) return `${source}:${ids[0]}`.toLowerCase();
  return [source, cleanText(item.title || "", 220), cleanText(item.publishedAt || "", 80)].filter(Boolean).join(":").toLowerCase();
}

function publicEnforcementKeywordMatchSource(item = {}, keyword = "") {
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["record_source", item.metrics?.enforcement_record_source],
    ["record_type", item.metrics?.enforcement_record_type],
    ["document_number", item.metrics?.enforcement_document_number],
    ["company", item.metrics?.company || item.metrics?.company_name || item.metrics?.provider_name || item.metrics?.facility_name],
  ];
  return fields.find(([, value]) => textMatchesKeyword(value, keyword))?.[0] || "search_query";
}

function publicEnforcementKeywordDiagnostics(item = {}, keyword = "") {
  return {
    public_enforcement_matched_keyword: cleanText(keyword, 160),
    public_enforcement_keyword_match_source: publicEnforcementKeywordMatchSource(item, keyword),
  };
}

function occEnforcementRows(html = "") {
  const out = [];
  const source = String(html || "");
  const tableMatch = source.match(/<table[^>]*class=["'][^"']*\bstacked-table\b[^"']*["'][^>]*>[\s\S]*?<\/table>/i)
    || source.match(/<table[^>]*>[\s\S]*?<th[^>]*>\s*Institution\s*<\/th>[\s\S]*?<\/table>/i);
  if (!tableMatch) return out;
  const rowRegex = /<tr\b[^>]*class=["'][^"']*\bshow-results\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(tableMatch[0])) !== null) {
    const rowHtml = match[1] || "";
    const cells = tableCellBlocks(rowHtml);
    if (cells.length) out.push({ cells, rowHtml });
  }
  return out;
}

function occEnforcementRiskLevel({ actionType = "", amount = "", subjectMatters = "", docketNumber = "" } = {}) {
  const penaltyAmount = Number(String(amount || "").replace(/[^0-9.-]/g, ""));
  const text = `${actionType} ${subjectMatters} ${docketNumber}`.toLowerCase();
  if ((Number.isFinite(penaltyAmount) && penaltyAmount >= 100000)
    || /\bcmp\b|civil money penalty|c&d|cease-and-desist|prohibition|pc&d|bsa|aml|unsafe|unsound|fraud|consumer|compliance|penalty|罚款|罰款|禁止令|反洗錢|反洗钱/i.test(text)) {
    return "high";
  }
  if ((Number.isFinite(penaltyAmount) && penaltyAmount > 0) || /\bfa\b|formal agreement|consent order|agreement|协议|協議|和解/i.test(text)) return "medium";
  return "low";
}

function normalizeOccEnforcementAction(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const institution = cleanText(cells[0], 260);
  const charterNumber = cleanText(cells[1], 80);
  const company = cleanText(cells[2], 260);
  const individual = cleanText(cells[3], 180);
  const location = cleanText(cells[4], 180);
  const actionType = cleanText(cells[5], 160);
  const actionTypeDescription = cleanText((cells[5] || "").match(/title=["']([^"']+)["']/i)?.[1] || "", 220);
  const amount = cleanText(cells[6], 80);
  const startDate = cleanText(cells[7], 80);
  const startDoc = firstHref(cells[8]);
  const terminationDate = cleanText(cells[9], 80);
  const terminationDoc = firstHref(cells[10]);
  const docketNumber = cleanText(cells[11], 120);
  const subjectMatters = cleanText(cells[12], 400);
  const party = institution || company || individual || cleanText(keyword, 120);
  const searchable = [party, charterNumber, location, actionType, actionTypeDescription, amount, startDate, docketNumber, subjectMatters].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(startDate) || new Date().toISOString();
  const startDocUrl = absoluteUrl(startDoc.url);
  const terminationDocUrl = absoluteUrl(terminationDoc.url);
  const url = startDocUrl || terminationDocUrl || OCC_ENFORCEMENT_ACTION_SEARCH_URL;
  return {
    url,
    title: `OCC enforcement action: ${party}${actionType ? ` - ${actionType}` : ""}${amount && amount !== "$0" ? ` - ${amount}` : ""}`,
    content: [
      party ? `Party: ${party}.` : "",
      institution ? `Institution: ${institution}.` : "",
      company ? `Company: ${company}.` : "",
      individual ? `Individual: ${individual}.` : "",
      charterNumber ? `Charter number: ${charterNumber}.` : "",
      location ? `Location: ${location}.` : "",
      actionType ? `Action type: ${actionType}${actionTypeDescription ? ` (${actionTypeDescription})` : ""}.` : "",
      amount ? `Amount: ${amount}.` : "",
      startDate ? `Start date: ${startDate}.` : "",
      docketNumber ? `Docket number: ${docketNumber}.` : "",
      subjectMatters ? `Subject matters: ${subjectMatters}.` : "",
      terminationDate ? `Termination date: ${terminationDate}.` : "",
    ].filter(Boolean).join(" "),
    author: "Office of the Comptroller of the Currency",
    publishedAt,
    riskLevel: occEnforcementRiskLevel({ actionType: `${actionType} ${actionTypeDescription}`, amount, subjectMatters, docketNumber }),
    metrics: {
      source: "occ_enforcement_actions",
      source_family: "official",
      source_kind: "public_financial_regulatory_enforcement_action",
      collection_mode: "occ_public_enforcement_actions_html",
      enforcement_record_source: "OCC Enforcement Actions Search",
      enforcement_record_type: "bank-regulatory-enforcement-action",
      enforcement_party: party,
      enforcement_institution: institution,
      enforcement_charter_number: charterNumber,
      enforcement_company: company,
      enforcement_individual: individual,
      enforcement_location: location,
      enforcement_action_type: actionType,
      enforcement_action_type_description: actionTypeDescription,
      enforcement_amount: amount,
      enforcement_start_date: startDate,
      enforcement_start_doc_url: startDocUrl,
      enforcement_start_doc_id: startDoc.text,
      enforcement_termination_date: terminationDate,
      enforcement_termination_doc_url: terminationDocUrl,
      enforcement_termination_doc_id: terminationDoc.text,
      enforcement_docket_number: docketNumber,
      enforcement_subject_matters: subjectMatters,
      source_weight_tier: "official-bank-enforcement-action",
    },
  };
}

function parseOccEnforcementActionResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of occEnforcementRows(html)) {
    const item = normalizeOccEnforcementAction(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_start_doc_url
      || [item.metrics.enforcement_docket_number, item.metrics.enforcement_action_type, item.metrics.enforcement_party, item.metrics.enforcement_start_date].filter(Boolean).join(":")
      || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function htmlRowsFromTable(html = "", tablePattern = /<table\b[\s\S]*?<\/table>/i) {
  const source = String(html || "");
  const tableMatch = source.match(tablePattern);
  if (!tableMatch) return [];
  const out = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(tableMatch[0])) !== null) {
    const rowHtml = match[1] || "";
    if (/<th\b/i.test(rowHtml)) continue;
    const cells = tableCellBlocks(rowHtml);
    if (cells.length) out.push({ cells, rowHtml });
  }
  return out;
}

function countOccEnforcementActionRawRows(html = "") {
  return occEnforcementRows(html).length;
}

function ncuaAdministrativeOrderRows(html = "") {
  return htmlRowsFromTable(html, /<table[^>]*id=["']edit-searchresults["'][\s\S]*?<\/table>/i);
}

function ncuaLateFilerRows(html = "") {
  const tables = String(html || "").match(/<table\b[\s\S]*?<\/table>/gi) || [];
  const table = tables.find(block => /Credit Union|Charter|Penalty|Year|Quarter/i.test(block) && !/Total Assessed by year and quarter/i.test(block)) || "";
  return htmlRowsFromTable(table, /<table\b[\s\S]*?<\/table>/i);
}

function ncuaEnforcementRiskLevel({ orderType = "", amount = "", relationship = "" } = {}) {
  const penaltyAmount = Number(String(amount || "").replace(/[^0-9.-]/g, ""));
  const text = `${orderType} ${relationship}`.toLowerCase();
  if ((Number.isFinite(penaltyAmount) && penaltyAmount >= 10000)
    || /prohibition|cease and desist|cease-and-desist|civil money|unsafe|unsound|criminal|convicted|fraud|breach|fiduciary|禁止|禁令|欺诈|欺詐/i.test(text)) {
    return "high";
  }
  if ((Number.isFinite(penaltyAmount) && penaltyAmount > 0) || /consent|administrative order|late filer|former employee|former institution-affiliated/i.test(text)) return "medium";
  return "low";
}

function normalizeNcuaAdministrativeOrder(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const docketNumber = cleanText(cells[0], 120);
  const orderHref = cleanText((cells[0] || "").match(/href=["']([^"']+)["']/i)?.[1] || "", 600);
  const nameRelationship = cleanText(cells[1], 260);
  const [partyName = "", relationship = ""] = cleanText(cells[1], 260).split(/\s{2,}| Former | Institution-|Affiliated/).length > 1
    ? [cleanText(cells[1], 180).replace(/\s+(Former|Institution-|Affiliated).*$/i, ""), cleanText(cells[1], 180).replace(/^.*?(Former|Institution-|Affiliated)/i, "$1")]
    : [nameRelationship, ""];
  const institution = cleanText(cells[2], 260);
  const city = cleanText(cells[3], 120);
  const state = cleanText(cells[4], 40);
  const year = cleanText(cells[5], 40);
  const searchable = [docketNumber, nameRelationship, partyName, relationship, institution, city, state, year].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(year ? `${year}-01-01T00:00:00Z` : "") || new Date().toISOString();
  const url = orderHref ? absoluteUrl(orderHref, "https://ncua.gov/news/enforcement-actions/administrative-orders") : NCUA_ADMINISTRATIVE_ORDERS_URL;
  return {
    url,
    title: `NCUA administrative order: ${institution || partyName || keyword}${docketNumber ? ` - ${docketNumber}` : ""}`,
    content: [
      docketNumber ? `Docket number: ${docketNumber}.` : "",
      partyName ? `Name: ${partyName}.` : "",
      relationship ? `Relationship: ${relationship}.` : nameRelationship ? `Name and relationship: ${nameRelationship}.` : "",
      institution ? `Institution: ${institution}.` : "",
      [city, state].filter(Boolean).length ? `Location: ${[city, state].filter(Boolean).join(", ")}.` : "",
      year ? `Year: ${year}.` : "",
      "NCUA administrative orders may include cease-and-desist orders, prohibition orders, notices of prohibition, consent orders, and civil money penalty orders.",
    ].filter(Boolean).join(" "),
    author: "National Credit Union Administration",
    publishedAt,
    riskLevel: ncuaEnforcementRiskLevel({ orderType: "administrative order prohibition cease and desist civil money penalty", relationship: nameRelationship }),
    metrics: {
      source: "ncua_administrative_orders",
      source_family: "official",
      source_kind: "public_financial_regulatory_enforcement_action",
      collection_mode: "ncua_public_administrative_orders_html",
      enforcement_record_source: "NCUA Administrative Orders",
      enforcement_record_type: "credit-union-administrative-order",
      enforcement_docket_number: docketNumber,
      enforcement_party: partyName || nameRelationship,
      enforcement_relationship: relationship || nameRelationship,
      enforcement_institution: institution,
      enforcement_location_city: city,
      enforcement_location_state: state,
      enforcement_year: year,
      enforcement_order_url: url,
      source_weight_tier: "official-credit-union-enforcement-action",
    },
  };
}

function parseNcuaAdministrativeOrderResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of ncuaAdministrativeOrderRows(html)) {
    const item = normalizeNcuaAdministrativeOrder(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_docket_number || item.url || item.title;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countNcuaAdministrativeOrderRawRows(html = "") {
  return ncuaAdministrativeOrderRows(html).length;
}

function normalizeNcuaLateFiler(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const year = cleanText(cells[0], 40);
  const quarter = cleanText(cells[1], 40);
  const creditUnion = cleanText(cells[2], 260);
  const charterNumber = cleanText(cells[3], 80);
  const city = cleanText(cells[4], 120);
  const state = cleanText(cells[5], 40);
  const assessedAmount = cleanText(cells[6], 80);
  const waiver = cleanText(cells[7], 80);
  const searchable = [year, quarter, creditUnion, charterNumber, city, state, assessedAmount, waiver].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(year ? `${year}-01-01T00:00:00Z` : "") || new Date().toISOString();
  return {
    url: `${NCUA_CALL_REPORT_LATE_FILERS_URL}#${encodeURIComponent([year, quarter, charterNumber, creditUnion].filter(Boolean).join("-"))}`,
    title: `NCUA call report late filer penalty: ${creditUnion || keyword}${assessedAmount ? ` - ${assessedAmount}` : ""}`,
    content: [
      creditUnion ? `Credit union: ${creditUnion}.` : "",
      charterNumber ? `Charter number: ${charterNumber}.` : "",
      [city, state].filter(Boolean).length ? `Location: ${[city, state].filter(Boolean).join(", ")}.` : "",
      year ? `Year: ${year}.` : "",
      quarter ? `Quarter: ${quarter}.` : "",
      assessedAmount ? `Civil money penalty assessed: ${assessedAmount}.` : "",
      waiver ? `Waiver: ${waiver}.` : "",
    ].filter(Boolean).join(" "),
    author: "National Credit Union Administration",
    publishedAt,
    riskLevel: ncuaEnforcementRiskLevel({ orderType: "call report late filer civil money penalty", amount: assessedAmount }),
    metrics: {
      source: "ncua_call_report_late_filers",
      source_family: "official",
      source_kind: "public_financial_regulatory_penalty",
      collection_mode: "ncua_public_call_report_late_filers_html",
      enforcement_record_source: "NCUA Call Report Late Filers",
      enforcement_record_type: "credit-union-call-report-late-filer-penalty",
      penalty_credit_union: creditUnion,
      penalty_charter_number: charterNumber,
      penalty_city: city,
      penalty_state: state,
      penalty_year: year,
      penalty_quarter: quarter,
      penalty_amount: assessedAmount,
      penalty_waiver: waiver,
      source_weight_tier: "official-credit-union-penalty",
    },
  };
}

function parseNcuaLateFilerResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of ncuaLateFilerRows(html)) {
    const item = normalizeNcuaLateFiler(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = [item.metrics.penalty_year, item.metrics.penalty_quarter, item.metrics.penalty_charter_number, item.metrics.penalty_amount].filter(Boolean).join(":") || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function epaEchoResults(payload = {}) {
  return payload?.Results || payload?.results || payload || {};
}

function parseEpaEchoCaseSearchResults(payload = {}) {
  const results = epaEchoResults(payload);
  const error = cleanText(results?.Error?.ErrorMessage || results?.error?.message || "", 400);
  const queryId = cleanText(results?.QueryID || results?.QueryId || results?.query_id || "", 80);
  const cases = Array.isArray(results?.Cases) ? results.Cases : Array.isArray(results?.cases) ? results.cases : [];
  return {
    queryId,
    queryRows: cleanText(results?.QueryRows || results?.query_rows || "", 80),
    error,
    cases,
    metrics: {
      epa_echo_query_rows: cleanText(results?.QueryRows || "", 80),
      epa_echo_judicial_rows: cleanText(results?.JDCRows || "", 80),
      epa_echo_administrative_formal_rows: cleanText(results?.AFRRows || "", 80),
      epa_echo_federal_penalty_rows: cleanText(results?.FedPenRows || "", 80),
      epa_echo_sep_rows: cleanText(results?.SEPRows || "", 80),
      epa_echo_criminal_rows: cleanText(results?.CriminalRows || "", 80),
      epa_echo_rcra_rows: cleanText(results?.RCRARows || "", 80),
      epa_echo_cwa_rows: cleanText(results?.CWARows || "", 80),
      epa_echo_caa_rows: cleanText(results?.CAARows || "", 80),
      epa_echo_epcra_rows: cleanText(results?.EPCRARows || "", 80),
      epa_echo_cercla_rows: cleanText(results?.CERCLARows || "", 80),
      epa_echo_fifra_rows: cleanText(results?.FIFRARows || "", 80),
      epa_echo_tsca_rows: cleanText(results?.TSCARows || "", 80),
    },
  };
}

function moneyAmount(value = "") {
  const n = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function epaEchoCaseRiskLevel(row = {}) {
  const penalty = moneyAmount(row.FedPenalty || row.fed_penalty);
  const compliance = moneyAmount(row.TotalCompActionAmt || row.total_comp_action_amt);
  const costRecovery = moneyAmount(row.CostRecovery || row.cost_recovery);
  const text = [
    row.CaseCategoryDesc,
    row.CaseStatusDesc,
    row.PrimaryLaw,
    row.EnfOutcome,
    row.CivilCriminalIndicator,
    row.CaseName,
  ].join(" ").toLowerCase();
  if (String(row.CivilCriminalIndicator || "").toUpperCase() === "CR" || /criminal|prosecution|judicial|cercla|rcra|caa|fifra|tsca|penalty|final order/i.test(text)) {
    if (penalty >= 100000 || compliance >= 100000 || costRecovery >= 100000 || /criminal|judicial|cercla|rcra|caa|fifra|tsca/i.test(text)) return "high";
  }
  if (penalty > 0 || compliance > 0 || costRecovery > 0 || /administrative|final order|settlement|closed|enforcement/i.test(text)) return "medium";
  return "low";
}

function normalizeEpaEchoCase(row = {}, keyword = "", { queryId = "", summaryMetrics = {} } = {}) {
  const caseNumber = cleanText(row.CaseNumber || row.case_number, 120);
  const caseName = cleanText(row.CaseName || row.case_name, 320);
  const caseCategory = cleanText(row.CaseCategoryDesc || row.case_category_desc, 160);
  const caseStatus = cleanText(row.CaseStatusDesc || row.case_status_desc, 160);
  const docketNumber = cleanText(row.CourtDocketNumber || row.DOJDocketNmbr || row.court_docket_number || row.doj_docket_number, 160);
  const primaryLaw = cleanText(row.PrimaryLaw || row.primary_law, 120);
  const primarySection = cleanText(row.PrimarySection || row.primary_section, 120);
  const dateFiled = cleanText(row.DateFiled || row.date_filed, 80);
  const settlementDate = cleanText(row.SettlementDate || row.settlement_date, 80);
  const dateClosed = cleanText(row.DateClosed || row.date_closed, 80);
  const fedPenalty = cleanText(row.FedPenalty || row.fed_penalty, 80);
  const sepCost = cleanText(row.SEPCost || row.sep_cost, 80);
  const totalCompActionAmt = cleanText(row.TotalCompActionAmt || row.total_comp_action_amt, 80);
  const costRecovery = cleanText(row.CostRecovery || row.cost_recovery, 80);
  const naics = cleanText(row.PrimaryNAICSCode || row.primary_naics_code, 80);
  const activityId = cleanText(row.ActivityID || row.ActivityId || row.activity_id, 120);
  const prosecutionSummaryId = cleanText(row.ProsecutionSummaryID || row.ProsecutionSummaryId || row.prosecution_summary_id, 120);
  const civilCriminalIndicator = cleanText(row.CivilCriminalIndicator || row.civil_criminal_indicator, 40);
  const enforcementOutcome = cleanText(row.EnfOutcome || row.enf_outcome, 220);
  const lead = cleanText(row.Lead || row.lead, 80);
  const searchable = [caseNumber, caseName, caseCategory, caseStatus, docketNumber, primaryLaw, primarySection, enforcementOutcome, naics, activityId, prosecutionSummaryId].join(" ");
  if (!caseName || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(dateFiled || settlementDate || dateClosed) || new Date().toISOString();
  const url = activityId
    ? `https://echo.epa.gov/enforcement-case-report?activity_id=${encodeURIComponent(activityId)}`
    : prosecutionSummaryId
      ? `https://echo.epa.gov/criminal-case-report?id=${encodeURIComponent(prosecutionSummaryId)}`
      : `${EPA_ECHO_CASE_SEARCH_URL}#${encodeURIComponent(caseNumber || caseName)}`;
  return {
    url,
    title: `EPA ECHO enforcement case: ${caseName}${primaryLaw ? ` - ${primaryLaw}` : ""}${fedPenalty && fedPenalty !== "$0.00" ? ` - ${fedPenalty}` : ""}`,
    content: [
      caseNumber ? `Case number: ${caseNumber}.` : "",
      caseName ? `Case name: ${caseName}.` : "",
      caseCategory ? `Case category: ${caseCategory}.` : "",
      caseStatus ? `Case status: ${caseStatus}.` : "",
      docketNumber ? `Docket number: ${docketNumber}.` : "",
      [primaryLaw, primarySection].filter(Boolean).length ? `Primary law/section: ${[primaryLaw, primarySection].filter(Boolean).join(" ")}.` : "",
      dateFiled ? `Date filed: ${dateFiled}.` : "",
      settlementDate ? `Settlement date: ${settlementDate}.` : "",
      dateClosed ? `Date closed: ${dateClosed}.` : "",
      fedPenalty ? `Federal penalty: ${fedPenalty}.` : "",
      sepCost ? `Supplemental environmental project cost: ${sepCost}.` : "",
      totalCompActionAmt ? `Total compliance action amount: ${totalCompActionAmt}.` : "",
      costRecovery ? `Cost recovery: ${costRecovery}.` : "",
      enforcementOutcome ? `Enforcement outcome: ${enforcementOutcome}.` : "",
      civilCriminalIndicator ? `Civil/criminal indicator: ${civilCriminalIndicator}.` : "",
      lead ? `Lead: ${lead}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Environmental Protection Agency ECHO",
    publishedAt,
    riskLevel: epaEchoCaseRiskLevel(row),
    metrics: {
      source: "epa_echo_enforcement_cases",
      source_family: "official",
      source_kind: "public_environmental_enforcement_case",
      collection_mode: "epa_echo_public_case_search_json",
      enforcement_record_source: "EPA ECHO Enforcement Case Search",
      enforcement_record_type: String(civilCriminalIndicator).toUpperCase() === "CR" ? "environmental-criminal-enforcement-case" : "environmental-civil-enforcement-case",
      enforcement_case_number: caseNumber,
      enforcement_case_name: caseName,
      enforcement_case_category: caseCategory,
      enforcement_case_status: caseStatus,
      enforcement_docket_number: docketNumber,
      enforcement_primary_law: primaryLaw,
      enforcement_primary_section: primarySection,
      enforcement_date_filed: dateFiled,
      enforcement_settlement_date: settlementDate,
      enforcement_date_closed: dateClosed,
      enforcement_federal_penalty: fedPenalty,
      enforcement_sep_cost: sepCost,
      enforcement_total_compliance_action_amount: totalCompActionAmt,
      enforcement_cost_recovery: costRecovery,
      enforcement_primary_naics_code: naics,
      enforcement_activity_id: activityId,
      enforcement_prosecution_summary_id: prosecutionSummaryId,
      enforcement_civil_criminal_indicator: civilCriminalIndicator,
      enforcement_outcome: enforcementOutcome,
      enforcement_lead: lead,
      epa_echo_query_id: queryId,
      ...summaryMetrics,
      source_weight_tier: "official-environmental-enforcement-case",
    },
  };
}

function parseEpaEchoCaseQidResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "", queryId = "", summaryMetrics = {} } = {}) {
  const results = epaEchoResults(payload);
  const rows = Array.isArray(results?.Cases) ? results.Cases : Array.isArray(results?.cases) ? results.cases : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeEpaEchoCase(row, keyword, { queryId: queryId || cleanText(results?.QueryID || results?.QueryId || "", 80), summaryMetrics });
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_case_number || item.metrics.enforcement_activity_id || item.metrics.enforcement_prosecution_summary_id || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countEpaEchoCaseRawResults(payload = {}) {
  const results = epaEchoResults(payload);
  const rows = Array.isArray(results?.Cases) ? results.Cases : Array.isArray(results?.cases) ? results.cases : Array.isArray(payload) ? payload : [];
  return rows.length;
}

function hhsOcrBreachRows(html = "") {
  const out = [];
  const source = String(html || "");
  const tableMatch = source.match(/<div[^>]*id=["']ocrForm:reportResultTable["'][\s\S]*?<tbody[^>]*id=["']ocrForm:reportResultTable_data["'][^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tableMatch) return out;
  const rowRegex = /<tr\b[^>]*data-rk=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(tableMatch[1] || "")) !== null) {
    const rowKey = cleanText(match[1], 80);
    const rowHtml = match[2] || "";
    const cells = [];
    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) cells.push(cellMatch[1] || "");
    if (cells.length) out.push({ rowKey, cells, rowHtml });
  }
  return out;
}

function extractOshaLabel(html = "", label = "", max = 500) {
  const escaped = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(html || "").match(new RegExp(`<strong>\\s*${escaped}\\s*<\\/strong>\\s*:\\s*([\\s\\S]*?)(?=<\\/p>|<\\/div>|<p>|<strong>|<hr>|$)`, "i"));
  return cleanText(match?.[1] || "", max);
}

function parseOshaInspectionDetail(html = "") {
  const source = String(html || "");
  const caseStatus = cleanText((source.match(/<strong>\s*Case Status:\s*([^<]+)<\/strong>/i) || [])[1] || "", 120);
  const office = cleanText((source.match(/Inspection Information\s*-\s*Office:\s*([^<]+)<\/strong>/i) || [])[1] || "", 220);
  const siteAddress = extractOshaLabel(source, "Site Address", 500);
  const mailingAddress = extractOshaLabel(source, "Mailing Address", 500);
  const unionStatus = extractOshaLabel(source, "Union Status", 120);
  const sic = extractOshaLabel(source, "SIC", 120);
  const naics = extractOshaLabel(source, "NAICS", 220);
  const inspectionType = extractOshaLabel(source, "Inspection Type", 120);
  const scope = extractOshaLabel(source, "Scope", 120);
  const advancedNotice = extractOshaLabel(source, "Advanced Notice", 80);
  const ownership = extractOshaLabel(source, "Ownership", 120);
  const safetyHealth = extractOshaLabel(source, "Safety/Health", 120);
  const closeConference = extractOshaLabel(source, "Close Conference", 120);
  const emphasis = extractOshaLabel(source, "Emphasis", 180);
  const caseClosed = extractOshaLabel(source, "Case Closed", 120);
  const relatedActivities = [];
  const relatedMatch = source.match(/<caption[^>]*>\s*Related Activity\s*<\/caption>[\s\S]*?<\/table>/i);
  if (relatedMatch) {
    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(relatedMatch[0])) !== null) {
      const rowHtml = rowMatch[1] || "";
      if (/<th\b/i.test(rowHtml)) continue;
      const cells = [];
      const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) cells.push(cleanText(cellMatch[1], 120));
      if (cells.length) {
        relatedActivities.push({
          type: cells[0] || "",
          activity_number: cells[1] || "",
          safety: cells[2] || "",
          health: cells[3] || "",
        });
      }
    }
  }
  return {
    case_status: caseStatus,
    office,
    site_address: siteAddress,
    mailing_address: mailingAddress,
    union_status: unionStatus,
    sic,
    naics,
    inspection_type: inspectionType,
    scope,
    advanced_notice: advancedNotice,
    ownership,
    safety_health: safetyHealth,
    close_conference: closeConference,
    emphasis,
    case_closed: caseClosed,
    related_activities: relatedActivities,
  };
}

function oshaInspectionRiskLevel({ inspectionType = "", violations = "", establishment = "" } = {}) {
  const text = `${inspectionType} ${violations} ${establishment}`.toLowerCase();
  const violationCount = Number(String(violations || "").replace(/[^0-9.]/g, ""));
  if (/fatal|catastrophe|accident|death|amputation|hospital|severe|死亡|事故|重傷|严重|嚴重/i.test(text)) return "high";
  if (Number.isFinite(violationCount) && violationCount > 0) return "high";
  if (/complaint|referral|follow-up|monitoring|投訴|投诉|舉報|举报/i.test(text)) return "medium";
  return "low";
}

function normalizeOshaInspection(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const activity = cleanText(cells[2], 80);
  const activityHref = cleanText((cells[2] || "").match(/href=["']([^"']+)["']/i)?.[1] || "", 500);
  const openedAtRaw = cleanText(cells[3], 80);
  const rid = cleanText(cells[4], 80);
  const state = cleanText(cells[5], 40);
  const inspectionType = cleanText(cells[6], 120);
  const scope = cleanText(cells[7], 120);
  const sic = cleanText(cells[8], 80);
  const naics = cleanText(cells[9], 80);
  const violations = cleanText(cells[10], 80);
  const establishment = cleanText(cells[11], 260);
  const searchable = [activity, rid, state, inspectionType, scope, sic, naics, violations, establishment].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(openedAtRaw) || new Date().toISOString();
  const detailUrl = activityHref
    ? new URL(activityHref, "https://www.osha.gov/ords/imis/").toString()
    : activity
      ? `https://www.osha.gov/ords/imis/establishment.inspection_detail?id=${encodeURIComponent(activity)}`
      : OSHA_ESTABLISHMENT_SEARCH_URL;
  return {
    url: detailUrl,
    title: `OSHA workplace inspection: ${establishment || keyword}${inspectionType ? ` - ${inspectionType}` : ""}`,
    content: [
      activity ? `Activity number: ${activity}.` : "",
      openedAtRaw ? `Date opened: ${openedAtRaw}.` : "",
      state ? `State: ${state}.` : "",
      inspectionType ? `Inspection type: ${inspectionType}.` : "",
      scope ? `Scope: ${scope}.` : "",
      violations && violations !== "\u00a0" ? `Violations: ${violations}.` : "",
      sic ? `SIC: ${sic}.` : "",
      naics ? `NAICS: ${naics}.` : "",
      rid ? `RID: ${rid}.` : "",
      establishment ? `Establishment: ${establishment}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Occupational Safety and Health Administration",
    publishedAt,
    riskLevel: oshaInspectionRiskLevel({ inspectionType, violations, establishment }),
    metrics: {
      source: "osha_establishment_inspections",
      source_family: "official",
      source_kind: "public_regulatory_inspection",
      collection_mode: "osha_public_establishment_inspection_html",
      enforcement_record_source: "OSHA Establishment Inspection Search",
      enforcement_record_type: "workplace-safety-inspection",
      inspection_activity_number: activity,
      inspection_rid: rid,
      inspection_state: state,
      inspection_type: inspectionType,
      inspection_scope: scope,
      inspection_sic: sic,
      inspection_naics: naics,
      inspection_violations: violations,
      inspection_establishment: establishment,
      source_weight_tier: "official-regulatory-inspection",
    },
  };
}

function parseOshaInspectionResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of htmlTableRows(html)) {
    const item = normalizeOshaInspection(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.inspection_activity_number || item.url || item.title;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countOshaInspectionRawRows(html = "") {
  return htmlTableRows(html).length;
}

async function mergeOshaInspectionDetailsForItems(items = [], proxyUrl = "") {
  if (!Array.isArray(items) || !items.length) return [];
  return mapWithConcurrency(items, SEARCH_CONCURRENCY, async (item) => {
    try {
      const detailRes = await fetchPublicSource(item.url, {
        headers: { "User-Agent": USER_AGENT, "Accept": "text/html,text/plain,*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!detailRes.ok) return item;
      return mergeOshaInspectionDetail(item, parseOshaInspectionDetail(await detailRes.text()));
    } catch {
      return item;
    }
  });
}

function oshaSevereInjuryRiskLevel() {
  return "high";
}

function normalizeOshaSevereInjuryReport(row = {}, keyword = "") {
  const employer = cleanText(row.employer, 260);
  const eventDate = cleanText(row.event_date, 80);
  const city = cleanText(row.city, 160);
  const state = cleanText(row.state, 120);
  const primaryNaics = cleanText(row.primary_naics, 80);
  const searchable = [employer, city, state, primaryNaics, eventDate].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(eventDate) || new Date().toISOString();
  const reportKey = [employer, eventDate, city, state, primaryNaics].filter(Boolean).join(":");
  return {
    url: "https://www.osha.gov/severe-injury-reports",
    title: `OSHA severe injury report: ${employer || keyword}${city || state ? ` - ${[city, state].filter(Boolean).join(", ")}` : ""}`,
    content: [
      employer ? `Employer: ${employer}.` : "",
      eventDate ? `Event date: ${eventDate}.` : "",
      city || state ? `Location: ${[city, state].filter(Boolean).join(", ")}.` : "",
      primaryNaics ? `Primary NAICS: ${primaryNaics}.` : "",
      "Source record is an OSHA severe injury report covering hospitalizations, amputations, and losses of an eye reported by employers.",
    ].filter(Boolean).join(" "),
    author: "U.S. Occupational Safety and Health Administration",
    publishedAt,
    riskLevel: oshaSevereInjuryRiskLevel(),
    metrics: {
      source: "osha_severe_injury_reports",
      source_family: "official",
      source_kind: "public_workplace_safety_severe_injury_report",
      collection_mode: "osha_public_severe_injury_initial_search_json",
      enforcement_record_source: "OSHA Severe Injury Reports",
      enforcement_record_type: "osha-severe-injury-report",
      injury_report_key: reportKey,
      injury_employer: employer,
      injury_event_date: eventDate,
      injury_city: city,
      injury_state: state,
      injury_primary_naics: primaryNaics,
      source_weight_tier: "official-workplace-safety-severe-injury-report",
    },
  };
}

function parseOshaSevereInjuryReportResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.datatableData)
    ? payload.datatableData
    : Array.isArray(payload?.initialData?.datatableData)
      ? payload.initialData.datatableData
      : Array.isArray(payload)
        ? payload
        : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeOshaSevereInjuryReport(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.injury_report_key || [item.title, item.publishedAt].filter(Boolean).join(":");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function hhsOcrBreachRiskLevel({ individualsAffected = "", breachType = "", informationLocation = "" } = {}) {
  const affected = Number(String(individualsAffected || "").replace(/[^0-9.-]/g, ""));
  const text = `${breachType} ${informationLocation}`.toLowerCase();
  if ((Number.isFinite(affected) && affected >= 100000) || /hacking|it incident|network server|ransomware|cyber|unauthorized access|入侵|駭客|黑客|勒索/i.test(text)) return "high";
  if ((Number.isFinite(affected) && affected >= 10000) || /theft|loss|email|improper disposal|unauthorized/i.test(text)) return "medium";
  return "low";
}

function normalizeHhsOcrBreach(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const rowKey = cleanText(row.rowKey, 80);
  const coveredEntity = cleanText(cells[1], 260);
  const state = cleanText(cells[2], 40);
  const entityType = cleanText(cells[3], 140);
  const individualsAffected = cleanText(cells[4], 80);
  const submissionDate = cleanText(cells[5], 80);
  const breachType = cleanText(cells[6], 260);
  const informationLocation = cleanText(cells[7], 260);
  const businessAssociatePresent = cleanText(cells[8], 40);
  const webDescription = cleanText(cells[9], 1200);
  const searchable = [rowKey, coveredEntity, state, entityType, individualsAffected, submissionDate, breachType, informationLocation, businessAssociatePresent, webDescription].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(submissionDate) || new Date().toISOString();
  return {
    url: `${HHS_OCR_BREACH_PORTAL_URL}#${encodeURIComponent(rowKey || coveredEntity || keyword)}`,
    title: `HHS OCR HIPAA breach: ${coveredEntity || keyword}${breachType ? ` - ${breachType}` : ""}`,
    content: [
      coveredEntity ? `Covered entity: ${coveredEntity}.` : "",
      state ? `State: ${state}.` : "",
      entityType ? `Covered entity type: ${entityType}.` : "",
      individualsAffected ? `Individuals affected: ${individualsAffected}.` : "",
      submissionDate ? `Breach submission date: ${submissionDate}.` : "",
      breachType ? `Type of breach: ${breachType}.` : "",
      informationLocation ? `Location of breached information: ${informationLocation}.` : "",
      businessAssociatePresent ? `Business associate present: ${businessAssociatePresent}.` : "",
      webDescription,
    ].filter(Boolean).join(" "),
    author: "U.S. Department of Health and Human Services Office for Civil Rights",
    publishedAt,
    riskLevel: hhsOcrBreachRiskLevel({ individualsAffected, breachType, informationLocation }),
    metrics: {
      source: "hhs_ocr_breach_portal",
      source_family: "official",
      source_kind: "public_healthcare_data_breach",
      collection_mode: "hhs_ocr_public_breach_portal_html",
      enforcement_record_source: "HHS OCR HIPAA Breach Portal",
      enforcement_record_type: "healthcare-data-breach",
      breach_record_id: rowKey,
      breach_covered_entity: coveredEntity,
      breach_state: state,
      breach_entity_type: entityType,
      breach_individuals_affected: individualsAffected,
      breach_submission_date: submissionDate,
      breach_type: breachType,
      breach_information_location: informationLocation,
      breach_business_associate_present: businessAssociatePresent,
      breach_web_description: webDescription,
      source_weight_tier: "official-healthcare-data-breach",
    },
  };
}

function parseHhsOcrBreachPortalResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of hhsOcrBreachRows(html)) {
    const item = normalizeHhsOcrBreach(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.breach_record_id || [item.metrics.breach_covered_entity, item.metrics.breach_submission_date, item.metrics.breach_type].filter(Boolean).join(":") || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function californiaOagDataBreachRows(html = "") {
  const out = [];
  const source = String(html || "");
  const tableMatch = source.match(/<table[^>]*class=["'][^"']*\bviews-table\b[^"']*["'][^>]*>[\s\S]*?<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tableMatch) return out;
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(tableMatch[1] || "")) !== null) {
    const rowHtml = match[1] || "";
    const cells = [];
    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) cells.push(cellMatch[1] || "");
    if (cells.length >= 3) out.push({ cells, rowHtml });
  }
  return out;
}

function normalizeCaliforniaOagDataBreach(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const orgLink = firstHref(cells[0] || "");
  const organization = cleanText(orgLink.text || cells[0], 300);
  const breachDate = cleanText(cells[1], 260);
  const reportedDate = cleanText(cells[2], 80);
  const detailUrl = absoluteUrl(orgLink.url, CALIFORNIA_OAG_DATA_BREACH_SEARCH_URL);
  const noticeId = cleanText((detailUrl.match(/\/(sb24-\d+)(?:[/?#]|$)/i) || [])[1] || "", 80);
  const breachIsoDates = [...String(cells[1] || "").matchAll(/content=["']([^"']+)["']/gi)]
    .map(match => normalizeDate(match[1]))
    .filter(Boolean);
  const searchable = [noticeId, organization, breachDate, reportedDate, detailUrl].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeUsDateUtc(reportedDate) || breachIsoDates[0] || new Date().toISOString();
  return {
    url: detailUrl || CALIFORNIA_OAG_DATA_BREACH_SEARCH_URL,
    title: `California OAG data breach notice: ${organization || keyword}`,
    content: [
      organization ? `Organization: ${organization}.` : "",
      breachDate ? `Date(s) of breach: ${breachDate}.` : "",
      reportedDate ? `Reported date: ${reportedDate}.` : "",
      noticeId ? `Notice ID: ${noticeId}.` : "",
    ].filter(Boolean).join(" "),
    author: "California Department of Justice Office of the Attorney General",
    publishedAt,
    riskLevel: "high",
    metrics: {
      source: "california_oag_data_breaches",
      source_family: "official",
      source_kind: "public_data_breach_notification",
      collection_mode: "california_oag_public_data_breach_html",
      enforcement_record_source: "California OAG Data Security Breach Notices",
      enforcement_record_type: "state-data-breach-notification",
      breach_notice_id: noticeId,
      breach_organization: organization,
      breach_dates: breachDate,
      breach_reported_date: reportedDate,
      breach_detail_url: detailUrl,
      source_weight_tier: "official-state-data-breach",
    },
  };
}

function parseCaliforniaOagDataBreachResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of californiaOagDataBreachRows(html)) {
    const item = normalizeCaliforniaOagDataBreach(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.breach_notice_id || [item.metrics.breach_organization, item.metrics.breach_reported_date].filter(Boolean).join(":") || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function washingtonAgDataBreachRows(html = "") {
  const out = [];
  const source = String(html || "");
  const tableMatch = source.match(/<table[^>]*>[\s\S]*?Date Reported[\s\S]*?Organization Name[\s\S]*?Information Compromised[\s\S]*?<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tableMatch) return out;
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(tableMatch[1] || "")) !== null) {
    const rowHtml = match[1] || "";
    const cells = tableCellBlocks(rowHtml);
    if (cells.length >= 5) out.push({ cells, rowHtml });
  }
  return out;
}

function washingtonAgBreachRiskLevel({ affected = "", compromised = "" } = {}) {
  const affectedCount = Number(String(affected || "").replace(/[^0-9]/g, ""));
  const text = String(compromised || "").toLowerCase();
  if ((Number.isFinite(affectedCount) && affectedCount >= 10000)
    || /social security|ssn|driver|passport|financial|banking|username|password|security question|medical|health insurance|protected health information|full date of birth/i.test(text)) {
    return "high";
  }
  if ((Number.isFinite(affectedCount) && affectedCount >= 500) || /name|email|address|date of birth/i.test(text)) return "medium";
  return "low";
}

function normalizeWashingtonAgDataBreach(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const reportedDate = cleanText(cells[0], 80);
  const organizationLink = firstHref(cells[1] || "");
  const organization = cleanText(organizationLink.text || cells[1], 300);
  const breachDate = cleanText(cells[2], 220);
  const affected = cleanText(cells[3], 80);
  const compromised = cleanText(cells[4], 700);
  const noticeUrl = absoluteUrl(organizationLink.url, WASHINGTON_AG_DATA_BREACH_NOTIFICATIONS_URL);
  const noticeId = cleanText((noticeUrl.match(/\/(Breach[A-Z]?\d+\.pdf)(?:[?#]|$)/i) || [])[1] || "", 120);
  const searchable = [noticeId, organization, breachDate, affected, compromised, noticeUrl].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate((String(cells[0] || "").match(/datetime=["']([^"']+)["']/i) || [])[1] || "") || normalizeUsDateUtc(reportedDate) || new Date().toISOString();
  return {
    url: noticeUrl || WASHINGTON_AG_DATA_BREACH_NOTIFICATIONS_URL,
    title: `Washington AG data breach notice: ${organization || keyword}`,
    content: [
      organization ? `Organization: ${organization}.` : "",
      breachDate ? `Date of breach: ${breachDate}.` : "",
      reportedDate ? `Date reported: ${reportedDate}.` : "",
      affected ? `Number of Washingtonians affected: ${affected}.` : "",
      compromised ? `Information compromised: ${compromised}.` : "",
      noticeId ? `Notice document: ${noticeId}.` : "",
    ].filter(Boolean).join(" "),
    author: "Washington State Office of the Attorney General",
    publishedAt,
    riskLevel: washingtonAgBreachRiskLevel({ affected, compromised }),
    metrics: {
      source: "washington_ag_data_breaches",
      source_family: "official",
      source_kind: "public_data_breach_notification",
      collection_mode: "washington_ag_public_data_breach_html",
      enforcement_record_source: "Washington AG Data Breach Notifications",
      enforcement_record_type: "state-data-breach-notification",
      breach_notice_id: noticeId,
      breach_name: organization,
      breach_organization: organization,
      breach_dates: breachDate,
      breach_reported_date: reportedDate,
      breach_individuals_affected: affected,
      breach_information_compromised: compromised,
      breach_detail_url: noticeUrl,
      breach_state: "WA",
      source_weight_tier: "official-state-data-breach",
    },
  };
}

function parseWashingtonAgDataBreachResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of washingtonAgDataBreachRows(html)) {
    const item = normalizeWashingtonAgDataBreach(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.breach_notice_id || [item.metrics.breach_organization, item.metrics.breach_reported_date, item.metrics.breach_individuals_affected].filter(Boolean).join(":") || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countWashingtonAgDataBreachRawRows(html = "") {
  return washingtonAgDataBreachRows(html).length;
}

function cmsDeficiencyRiskLevel({ scopeSeverity = "", category = "", description = "", complaint = "", infectionControl = "" } = {}) {
  const code = String(scopeSeverity || "").trim().toUpperCase();
  const text = `${category} ${description} ${complaint} ${infectionControl}`.toLowerCase();
  if (/^[JKL]$/.test(code)) return "high";
  if (/death|abuse|neglect|accident|injur|infection|elopement|immediate jeopardy|serious|死亡|虐待|忽視|忽视|感染|事故|受傷|受伤/i.test(text)) return "high";
  if (/^[GHI]$/.test(code) || String(complaint || "").toUpperCase() === "Y" || String(infectionControl || "").toUpperCase() === "Y") return "medium";
  return "low";
}

function normalizeCmsNursingHomeDeficiency(row = {}, keyword = "") {
  const ccn = cleanText(row.cms_certification_number_ccn, 80);
  const provider = cleanText(row.provider_name, 260);
  const address = cleanText(row.provider_address, 260);
  const city = cleanText(row.citytown, 120);
  const state = cleanText(row.state, 40);
  const zip = cleanText(row.zip_code, 40);
  const surveyDate = cleanText(row.survey_date, 80);
  const surveyType = cleanText(row.survey_type, 120);
  const category = cleanText(row.deficiency_category, 300);
  const tag = cleanText(row.deficiency_tag_number, 80);
  const description = cleanText(row.deficiency_description, 1200);
  const scopeSeverity = cleanText(row.scope_severity_code, 40);
  const corrected = cleanText(row.deficiency_corrected, 160);
  const correctionDate = cleanText(row.correction_date, 80);
  const cycle = cleanText(row.inspection_cycle, 40);
  const standardDeficiency = cleanText(row.standard_deficiency, 20);
  const complaintDeficiency = cleanText(row.complaint_deficiency, 20);
  const infectionDeficiency = cleanText(row.infection_control_inspection_deficiency, 20);
  const citationIdr = cleanText(row.citation_under_idr, 20);
  const citationIidr = cleanText(row.citation_under_iidr, 20);
  const location = cleanText(row.location, 360);
  const processingDate = cleanText(row.processing_date, 80);
  const searchable = [ccn, provider, address, city, state, zip, surveyType, category, tag, description, scopeSeverity, corrected, location].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(processingDate || surveyDate || correctionDate) || new Date().toISOString();
  const titleBits = [provider || keyword, tag ? `F${tag}` : "", category].filter(Boolean);
  return {
    url: ccn ? `https://data.cms.gov/provider-data/dataset/r5ix-sfxw?provider_name=${encodeURIComponent(provider || keyword)}` : "https://data.cms.gov/provider-data/dataset/r5ix-sfxw",
    title: `CMS nursing home deficiency: ${titleBits.join(" - ")}`,
    content: [
      ccn ? `CMS Certification Number: ${ccn}.` : "",
      provider ? `Provider: ${provider}.` : "",
      [address, city, state, zip].filter(Boolean).length ? `Location: ${[address, city, state, zip].filter(Boolean).join(", ")}.` : "",
      surveyDate ? `Survey date: ${surveyDate}.` : "",
      surveyType ? `Survey type: ${surveyType}.` : "",
      category ? `Deficiency category: ${category}.` : "",
      tag ? `Deficiency tag: ${tag}.` : "",
      description,
      scopeSeverity ? `Scope/severity: ${scopeSeverity}.` : "",
      corrected ? `Corrected: ${corrected}.` : "",
      correctionDate ? `Correction date: ${correctionDate}.` : "",
      complaintDeficiency ? `Complaint deficiency: ${complaintDeficiency}.` : "",
      infectionDeficiency ? `Infection control deficiency: ${infectionDeficiency}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Centers for Medicare & Medicaid Services",
    publishedAt,
    riskLevel: cmsDeficiencyRiskLevel({ scopeSeverity, category, description, complaint: complaintDeficiency, infectionControl: infectionDeficiency }),
    metrics: {
      source: "cms_nursing_home_deficiencies",
      source_family: "official",
      source_kind: "public_healthcare_regulatory_deficiency",
      collection_mode: "cms_public_provider_data_json",
      enforcement_record_source: "CMS Nursing Home Deficiencies",
      enforcement_record_type: "healthcare-regulatory-deficiency",
      deficiency_ccn: ccn,
      deficiency_provider_name: provider,
      deficiency_provider_address: address,
      deficiency_city: city,
      deficiency_state: state,
      deficiency_zip: zip,
      deficiency_survey_date: surveyDate,
      deficiency_survey_type: surveyType,
      deficiency_category: category,
      deficiency_tag_number: tag,
      deficiency_description: description,
      deficiency_scope_severity_code: scopeSeverity,
      deficiency_corrected: corrected,
      deficiency_correction_date: correctionDate,
      deficiency_inspection_cycle: cycle,
      deficiency_standard: standardDeficiency,
      deficiency_complaint: complaintDeficiency,
      deficiency_infection_control: infectionDeficiency,
      deficiency_citation_under_idr: citationIdr,
      deficiency_citation_under_iidr: citationIidr,
      deficiency_location: location,
      deficiency_processing_date: processingDate,
      source_weight_tier: "official-healthcare-deficiency",
    },
  };
}

function parseCmsNursingHomeDeficiencyResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeCmsNursingHomeDeficiency(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = [item.metrics.deficiency_ccn, item.metrics.deficiency_survey_date, item.metrics.deficiency_tag_number, item.metrics.deficiency_scope_severity_code].filter(Boolean).join(":") || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countCmsProviderDataRawResults(payload = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  return rows.length;
}

function cmsPenaltyRiskLevel({ penaltyType = "", fineAmount = "", paymentDenialDays = "" } = {}) {
  const type = String(penaltyType || "").toLowerCase();
  const amount = Number(String(fineAmount || "").replace(/[^0-9.-]/g, ""));
  const denialDays = Number(String(paymentDenialDays || "").replace(/[^0-9.-]/g, ""));
  if (type.includes("payment denial") || (Number.isFinite(denialDays) && denialDays >= 30) || (Number.isFinite(amount) && amount >= 100000)) return "high";
  if ((Number.isFinite(denialDays) && denialDays > 0) || (Number.isFinite(amount) && amount >= 10000)) return "medium";
  return "low";
}

function normalizeCmsNursingHomePenalty(row = {}, keyword = "") {
  const ccn = cleanText(row.cms_certification_number_ccn, 80);
  const provider = cleanText(row.provider_name, 260);
  const address = cleanText(row.provider_address, 260);
  const city = cleanText(row.citytown, 120);
  const state = cleanText(row.state, 40);
  const zip = cleanText(row.zip_code, 40);
  const penaltyDate = cleanText(row.penalty_date, 80);
  const penaltyType = cleanText(row.penalty_type, 160);
  const fineAmount = cleanText(row.fine_amount, 80);
  const paymentDenialStart = cleanText(row.payment_denial_start_date, 80);
  const paymentDenialDays = cleanText(row.payment_denial_length_in_days, 80);
  const location = cleanText(row.location, 360);
  const processingDate = cleanText(row.processing_date, 80);
  const searchable = [ccn, provider, address, city, state, zip, penaltyDate, penaltyType, fineAmount, paymentDenialStart, paymentDenialDays, location].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(processingDate || penaltyDate || paymentDenialStart) || new Date().toISOString();
  const penaltyBits = [
    provider || keyword,
    penaltyType,
    fineAmount ? `$${fineAmount}` : "",
    paymentDenialDays ? `${paymentDenialDays} payment-denial days` : "",
  ].filter(Boolean);
  return {
    url: ccn ? `https://data.cms.gov/provider-data/dataset/g6vv-u9sr?provider_name=${encodeURIComponent(provider || keyword)}` : "https://data.cms.gov/provider-data/dataset/g6vv-u9sr",
    title: `CMS nursing home penalty: ${penaltyBits.join(" - ")}`,
    content: [
      ccn ? `CMS Certification Number: ${ccn}.` : "",
      provider ? `Provider: ${provider}.` : "",
      [address, city, state, zip].filter(Boolean).length ? `Location: ${[address, city, state, zip].filter(Boolean).join(", ")}.` : "",
      penaltyDate ? `Penalty date: ${penaltyDate}.` : "",
      penaltyType ? `Penalty type: ${penaltyType}.` : "",
      fineAmount ? `Fine amount: ${fineAmount}.` : "",
      paymentDenialStart ? `Payment denial start date: ${paymentDenialStart}.` : "",
      paymentDenialDays ? `Payment denial length in days: ${paymentDenialDays}.` : "",
    ].filter(Boolean).join(" "),
    author: "U.S. Centers for Medicare & Medicaid Services",
    publishedAt,
    riskLevel: cmsPenaltyRiskLevel({ penaltyType, fineAmount, paymentDenialDays }),
    metrics: {
      source: "cms_nursing_home_penalties",
      source_family: "official",
      source_kind: "public_healthcare_regulatory_penalty",
      collection_mode: "cms_public_provider_data_json",
      enforcement_record_source: "CMS Nursing Home Penalties",
      enforcement_record_type: "healthcare-regulatory-penalty",
      penalty_ccn: ccn,
      penalty_provider_name: provider,
      penalty_provider_address: address,
      penalty_city: city,
      penalty_state: state,
      penalty_zip: zip,
      penalty_date: penaltyDate,
      penalty_type: penaltyType,
      penalty_fine_amount: fineAmount,
      penalty_payment_denial_start_date: paymentDenialStart,
      penalty_payment_denial_length_in_days: paymentDenialDays,
      penalty_location: location,
      penalty_processing_date: processingDate,
      source_weight_tier: "official-healthcare-penalty",
    },
  };
}

function parseCmsNursingHomePenaltyResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeCmsNursingHomePenalty(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = [item.metrics.penalty_ccn, item.metrics.penalty_date, item.metrics.penalty_type, item.metrics.penalty_fine_amount, item.metrics.penalty_payment_denial_start_date].filter(Boolean).join(":") || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function parseIcoMetaData(meta = "") {
  const parts = cleanText(meta, 400).split(",").map(part => cleanText(part, 120)).filter(Boolean);
  return {
    date: parts[0] || "",
    types: parts.slice(1, Math.max(1, parts.length - 1)),
    sector: parts.length > 2 ? parts[parts.length - 1] : "",
  };
}

function icoEnforcementRiskLevel({ title = "", description = "", types = [], sector = "" } = {}) {
  const text = `${title} ${description} ${types.join(" ")} ${sector}`.toLowerCase();
  if (/monetary penalt|fine|penalty|£|gbp|uk gdpr|gdpr|article 5|article 6|article 8|article 32|article 35|pecr|cyber|security fail|data subject|exfiltrat|personal data|children|child|unsolicited|direct marketing|spam|scam|complaints|enforcement notice|reprimand|prosecution|criminal/i.test(text)) return "high";
  if (/privacy|data protection|marketing|telecoms|online technology|investigation|contravention|infringement/i.test(text)) return "medium";
  return "low";
}

function normalizeIcoEnforcementResult(row = {}, keyword = "") {
  const id = cleanText(row.id, 80);
  const title = cleanText(row.title, 320);
  const description = cleanText(row.description, 1800);
  const meta = parseIcoMetaData(row.filterItemMetaData || "");
  const url = absoluteUrl(cleanText(row.url, 900), "https://ico.org.uk/action-weve-taken/enforcement/");
  const searchable = [id, title, description, meta.date, meta.types.join(" "), meta.sector, url].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.createdDateTime) || normalizeDate(meta.date) || new Date().toISOString();
  const recordType = meta.types.map(type => type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean).join("+") || "ico-enforcement-action";
  return {
    url: url || "https://ico.org.uk/action-weve-taken/enforcement/",
    title: `UK ICO enforcement action: ${title || keyword}`,
    content: [
      title ? `Title: ${title}.` : "",
      meta.types.length ? `Action type: ${meta.types.join(", ")}.` : "",
      meta.sector ? `Sector: ${meta.sector}.` : "",
      meta.date ? `Action date: ${meta.date}.` : "",
      description,
    ].filter(Boolean).join(" "),
    author: "UK Information Commissioner's Office",
    publishedAt,
    riskLevel: icoEnforcementRiskLevel({ title, description, types: meta.types, sector: meta.sector }),
    metrics: {
      source: "uk_ico_enforcement",
      source_family: "official",
      source_kind: "public_privacy_data_protection_enforcement",
      collection_mode: "uk_ico_public_enforcement_search_api",
      enforcement_record_source: "UK ICO Enforcement Search",
      enforcement_record_type: `uk-ico-${recordType}`,
      enforcement_document_number: id,
      enforcement_title: title,
      enforcement_action_types: meta.types,
      enforcement_sector: meta.sector,
      enforcement_action_date: meta.date,
      enforcement_description: description,
      enforcement_detail_url: url,
      source_weight_tier: "official-uk-privacy-data-protection-enforcement",
    },
  };
}

function parseIcoEnforcementResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeIcoEnforcementResult(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_document_number || item.url || [item.title, item.publishedAt].filter(Boolean).join(":");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countIcoEnforcementRawResults(payload = {}) {
  return Array.isArray(payload?.results) ? payload.results.length : Array.isArray(payload) ? payload.length : 0;
}

function icoEnforcementHasMore(payload = {}, page = 1) {
  const pagination = payload?.pagination || {};
  if (pagination.hasMore === true) return true;
  const totalPages = Number(pagination.totalPages || pagination.total_pages || 0);
  if (Number.isFinite(totalPages) && totalPages > 0) return Number(page) < totalPages;
  return false;
}

function irelandDpcDecisionCards(html = "") {
  const source = String(html || "");
  const titleMatches = [...source.matchAll(/<a\b[^>]+href=["']([^"']*\/en\/dpc-guidance\/decisions\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => ({
      index: match.index || 0,
      href: cleanText(match[1], 900),
      title: cleanText(match[2], 360),
    }))
    .filter(match => match.title && !/^see more information$/i.test(match.title));
  const out = [];
  for (let i = 0; i < titleMatches.length; i += 1) {
    const current = titleMatches[i];
    const next = titleMatches[i + 1];
    const blockStart = Math.max(0, source.lastIndexOf("<div class=\"views-col", current.index));
    const blockEnd = next ? Math.max(current.index + 1, source.lastIndexOf("<div class=\"views-col", next.index)) : source.length;
    const block = source.slice(blockStart >= 0 ? blockStart : current.index, blockEnd > current.index ? blockEnd : source.length);
    out.push({ ...current, block });
  }
  return out;
}

function irelandDpcDecisionRiskLevel({ title = "", summary = "", articles = [], tags = [] } = {}) {
  const text = `${title} ${summary} ${articles.join(" ")} ${tags.join(" ")}`.toLowerCase();
  if (/article\s*(5|6|9|13|14|25|30|32|33|34|35|44|45|46)|data breach|personal data breach|security|transfers?|cross border|inquiry|final decision|reprimand|administrative fine|fine|gdpr|children|child|tiktok|meta|linkedin|whatsapp|facebook/i.test(text)) return "high";
  if (/data protection|commission|decision|article|private company|public sector|law enforcement|complaint/i.test(text)) return "medium";
  return "low";
}

function normalizeIrelandDpcDecision(card = {}, keyword = "") {
  const title = cleanText(card.title, 360);
  const detailUrl = absoluteUrl(card.href, IRELAND_DPC_DECISIONS_URL);
  const decisionId = cleanText((detailUrl.match(/\/decisions\/([^/?#]+)(?:[/?#]|$)/i) || [])[1] || "", 160);
  const summary = cleanText((card.block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "", 1600);
  const tagMatches = [...String(card.block || "").matchAll(/<a\b[^>]+href=["'][^"']*decision_tags=[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => cleanText(match[1], 120))
    .filter(Boolean);
  const articleSection = (String(card.block || "").match(/Article\(s\):\s*<\/span>([\s\S]*?)(?:<div\b[^>]*>\s*<a\b[^>]+href=["'][^"']+#read-full-decision|<\/div>\s*<\/div>)/i) || [])[1] || "";
  const articles = [...articleSection.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => cleanText(match[1], 40))
    .filter(value => /^\d+[a-z]?$/i.test(value));
  const actionDate = cleanText((summary.match(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i) || [])[0] || "", 80);
  const searchable = [decisionId, title, summary, tagMatches.join(" "), articles.join(" "), detailUrl].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeEnglishDayMonthDateUtc(actionDate) || new Date().toISOString();
  return {
    url: detailUrl || IRELAND_DPC_DECISIONS_URL,
    title: `Ireland DPC GDPR decision: ${title || keyword}`,
    content: [
      title ? `Title: ${title}.` : "",
      summary,
      tagMatches.length ? `Decision tags: ${tagMatches.join(", ")}.` : "",
      articles.length ? `GDPR Article(s): ${articles.join(", ")}.` : "",
      actionDate ? `Decision date: ${actionDate}.` : "",
      decisionId ? `Decision ID: ${decisionId}.` : "",
    ].filter(Boolean).join(" "),
    author: "Ireland Data Protection Commission",
    publishedAt,
    riskLevel: irelandDpcDecisionRiskLevel({ title, summary, articles, tags: tagMatches }),
    metrics: {
      source: "ireland_dpc_decisions",
      source_family: "official",
      source_kind: "public_privacy_data_protection_enforcement",
      collection_mode: "ireland_dpc_public_decisions_html",
      enforcement_record_source: "Ireland DPC GDPR Decisions",
      enforcement_record_type: "ireland-dpc-gdpr-decision",
      enforcement_document_number: decisionId,
      enforcement_title: title,
      enforcement_articles: articles,
      enforcement_tags: tagMatches,
      enforcement_action_date: actionDate,
      enforcement_summary: summary,
      enforcement_detail_url: detailUrl,
      source_weight_tier: "official-eu-privacy-data-protection-enforcement",
    },
  };
}

function parseIrelandDpcDecisionResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const card of irelandDpcDecisionCards(html)) {
    const item = normalizeIrelandDpcDecision(card, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_document_number || item.url || [item.title, item.publishedAt].filter(Boolean).join(":");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countIrelandDpcDecisionRawCards(html = "") {
  return irelandDpcDecisionCards(html).length;
}

function franceCnilSanctionRows(html = "") {
  const out = [];
  const source = String(html || "");
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const rowHtml = match[1] || "";
    const cells = tableCellBlocks(rowHtml);
    if (cells.length >= 4 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cleanText(cells[0], 80))) {
      out.push({ cells, rowHtml });
    }
  }
  return out;
}

function parseCnilEuroAmount(value = "") {
  const text = cleanText(value, 260)
    .toLowerCase()
    .replace(/\u202f|\u00a0/g, " ")
    .replace(/,/g, ".");
  const match = text.match(/(\d+(?:[\s.]\d{3})*(?:\.\d+)?)\s*(millions?|milliards?|k|€|euros?)/i);
  if (!match) return null;
  const number = Number(String(match[1] || "").replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, ""));
  if (!Number.isFinite(number)) return null;
  const unit = match[2] || "";
  if (/milliard/i.test(unit)) return Math.round(number * 1_000_000_000);
  if (/million/i.test(unit)) return Math.round(number * 1_000_000);
  if (/^k$/i.test(unit)) return Math.round(number * 1_000);
  return Math.round(number);
}

function franceCnilSanctionRiskLevel({ breachTopic = "", sanction = "" } = {}) {
  const text = `${breachTopic} ${sanction}`.toLowerCase();
  const amount = parseCnilEuroAmount(sanction);
  if ((Number.isFinite(amount) && amount >= 100000)
    || /amende|injonction|astreinte|violation|défaut de sécurité|defaut de securite|cookies|prospection|consentement|droit d'accès|droit d'acces|violation de données|violation de donnees|données de santé|donnees de sante|base légale|base legale|biométr|biometr|géolocalisation|geolocalisation|reconnaissance faciale/i.test(text)) {
    return "high";
  }
  if (/rappel à l'ordre|rappel a l'ordre|coopération|cooperation|information des personnes|registre|conservation|minimisation|exactes/i.test(text)) return "medium";
  return "low";
}

function normalizeFranceCnilSanction(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const decisionDate = cleanText(cells[0], 80);
  const subject = cleanText(cells[1], 420);
  const breachTopic = cleanText(cells[2], 700);
  const sanctionLink = firstHref(cells[3] || "");
  const sanction = cleanText(sanctionLink.text || cells[3], 700);
  const documentUrl = absoluteUrl(sanctionLink.url, FRANCE_CNIL_SANCTIONS_URL);
  const documentNumber = cleanText((documentUrl.match(/\/cnil\/id\/([^/?#]+)/i) || [])[1] || "", 120);
  const amountEur = parseCnilEuroAmount(sanction);
  const searchable = [documentNumber, subject, breachTopic, sanction, documentUrl].join(" ");
  if (!textMatchesKeywordWithoutStopwords(searchable, keyword)) return null;
  const publishedAt = normalizeDayMonthYearDateUtc(decisionDate) || new Date().toISOString();
  return {
    url: documentUrl || FRANCE_CNIL_SANCTIONS_URL,
    title: `France CNIL sanction: ${subject || keyword}${sanction ? ` - ${sanction}` : ""}`,
    content: [
      subject ? `Subject: ${subject}.` : "",
      breachTopic ? `Breach topic: ${breachTopic}.` : "",
      decisionDate ? `Decision date: ${decisionDate}.` : "",
      sanction ? `Sanction: ${sanction}.` : "",
      documentNumber ? `Document number: ${documentNumber}.` : "",
    ].filter(Boolean).join(" "),
    author: "Commission Nationale de l'Informatique et des Libertes",
    publishedAt,
    riskLevel: franceCnilSanctionRiskLevel({ breachTopic, sanction }),
    metrics: {
      source: "france_cnil_sanctions",
      source_family: "official",
      source_kind: "public_privacy_data_protection_enforcement",
      collection_mode: "france_cnil_public_sanctions_html",
      enforcement_record_source: "France CNIL Sanctions",
      enforcement_record_type: "france-cnil-sanction",
      enforcement_document_number: documentNumber,
      enforcement_title: subject,
      enforcement_action_date: decisionDate,
      enforcement_breach_topic: breachTopic,
      enforcement_sanction: sanction,
      enforcement_amount_eur: amountEur,
      enforcement_detail_url: documentUrl,
      source_weight_tier: "official-fr-privacy-data-protection-enforcement",
    },
  };
}

function parseFranceCnilSanctionResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of franceCnilSanctionRows(html)) {
    const item = normalizeFranceCnilSanction(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_document_number || [item.metrics.enforcement_title, item.metrics.enforcement_action_date, item.metrics.enforcement_sanction].filter(Boolean).join(":") || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countFranceCnilSanctionRawRows(html = "") {
  return franceCnilSanctionRows(html).length;
}

function finraDisciplinaryActionRows(html = "") {
  const out = [];
  const source = String(html || "");
  const tableMatch = source.match(/<table[^>]*>[\s\S]*?view-field-fda-attachment-file-media[\s\S]*?<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)
    || source.match(/<table[^>]*>[\s\S]*?field-fda-document-type-tax[\s\S]*?<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
  const body = tableMatch ? tableMatch[1] || "" : source;
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(body)) !== null) {
    const rowHtml = match[1] || "";
    if (!/view-field-fda-attachment-file-media|field-fda-document-type-tax|view-field-core-official-dt/i.test(rowHtml)) continue;
    const cells = tableCellBlocks(rowHtml);
    if (cells.length >= 5) out.push({ cells, rowHtml });
  }
  return out;
}

function finraDisciplinaryActionRiskLevel({ summary = "", documentType = "" } = {}) {
  const text = `${summary} ${documentType}`.toLowerCase();
  if (/letter of acceptance|waiver|consent|\bawc\b|complaint|decision|settlement|barred|suspended|fine|fined|restitution|disgorgement|censure|undertaking|sanction|violation|violations|fraud|misrepresent|unsuitable|anti-money laundering|supervision|best interest|reg bi|churning|unauthorized|market manipulation/i.test(text)) return "high";
  if (/disciplinary|respondent|department of enforcement|finra rule|code of procedure/i.test(text)) return "medium";
  return "low";
}

function normalizeFinraDisciplinaryAction(row = {}, keyword = "") {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  const documentLink = firstHref(cells[0] || "");
  const documentNumber = cleanText(documentLink.text || cells[0], 120);
  const documentUrl = absoluteUrl(documentLink.url, FINRA_DISCIPLINARY_ACTIONS_URL);
  const summary = cleanText(cells[1], 1800);
  const documentType = cleanText(cells[2], 220);
  const subject = cleanText(cells[3], 420);
  const officialDate = cleanText(cells[4], 80);
  const searchable = [documentNumber, summary, documentType, subject, officialDate, documentUrl].join(" ");
  if (!textMatchesKeyword(searchable, keyword)) return null;
  const party = subject || cleanText(keyword, 120);
  const publishedAt = normalizeUsDateUtc(officialDate) || new Date().toISOString();
  return {
    url: documentUrl || FINRA_DISCIPLINARY_ACTIONS_URL,
    title: `FINRA disciplinary action: ${party}${documentNumber ? ` - ${documentNumber}` : ""}`,
    content: [
      party ? `Subject: ${party}.` : "",
      documentType ? `Document type: ${documentType}.` : "",
      officialDate ? `Official date: ${officialDate}.` : "",
      documentNumber ? `Document number: ${documentNumber}.` : "",
      summary,
    ].filter(Boolean).join(" "),
    author: "Financial Industry Regulatory Authority",
    publishedAt,
    riskLevel: finraDisciplinaryActionRiskLevel({ summary, documentType }),
    metrics: {
      source: "finra_disciplinary_actions",
      source_family: "official",
      source_kind: "public_securities_self_regulatory_enforcement_action",
      collection_mode: "finra_public_disciplinary_actions_html",
      enforcement_record_source: "FINRA Disciplinary Actions Online",
      enforcement_record_type: "finra-disciplinary-action",
      enforcement_document_number: documentNumber,
      enforcement_title: party,
      enforcement_action_date: officialDate,
      enforcement_document_type: documentType,
      enforcement_subject: subject,
      enforcement_summary: summary,
      enforcement_detail_url: documentUrl,
      source_weight_tier: "official-us-securities-self-regulatory-enforcement",
    },
  };
}

function parseFinraDisciplinaryActionResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of finraDisciplinaryActionRows(html)) {
    const item = normalizeFinraDisciplinaryAction(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_document_number || item.url || [item.title, item.publishedAt].filter(Boolean).join(":");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countFinraDisciplinaryActionRawRows(html = "") {
  return finraDisciplinaryActionRows(html).length;
}

function mergeOshaInspectionDetail(item = {}, detail = {}) {
  if (!item || !detail || !Object.values(detail).some(value => Array.isArray(value) ? value.length : Boolean(value))) return item;
  const metrics = {
    ...(item.metrics || {}),
    inspection_case_status: detail.case_status || "",
    inspection_office: detail.office || "",
    inspection_site_address: detail.site_address || "",
    inspection_mailing_address: detail.mailing_address || "",
    inspection_union_status: detail.union_status || "",
    inspection_naics_detail: detail.naics || "",
    inspection_sic_detail: detail.sic || "",
    inspection_advanced_notice: detail.advanced_notice || "",
    inspection_ownership: detail.ownership || "",
    inspection_safety_health: detail.safety_health || "",
    inspection_close_conference: detail.close_conference || "",
    inspection_emphasis: detail.emphasis || "",
    inspection_case_closed: detail.case_closed || "",
    inspection_related_activities: detail.related_activities || [],
  };
  const content = [
    item.content,
    detail.case_status ? `Case status: ${detail.case_status}.` : "",
    detail.office ? `Office: ${detail.office}.` : "",
    detail.site_address ? `Site address: ${detail.site_address}.` : "",
    detail.union_status ? `Union status: ${detail.union_status}.` : "",
    detail.ownership ? `Ownership: ${detail.ownership}.` : "",
    detail.safety_health ? `Safety/Health: ${detail.safety_health}.` : "",
    detail.related_activities?.length ? `Related activities: ${detail.related_activities.map(activity => [activity.type, activity.activity_number, activity.safety ? `Safety ${activity.safety}` : "", activity.health ? `Health ${activity.health}` : ""].filter(Boolean).join(" ")).join("; ")}.` : "",
  ].filter(Boolean).join(" ");
  return {
    ...item,
    content,
    ai_summary: content,
    metrics,
  };
}

function rssItems(xml = "") {
  const source = String(xml || "");
  const out = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(source)) !== null) {
    const block = match[1] || "";
    const read = (tag) => cleanText((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")) || [])[1] || "", tag === "description" ? 1600 : 400);
    out.push({
      title: read("title"),
      link: cleanText((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || "", 900),
      description: read("description"),
      pubDate: read("pubDate") || read("dc:date"),
      category: read("category"),
    });
  }
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRegex.exec(source)) !== null) {
    const block = match[1] || "";
    const read = (tag, max = 400) => cleanText((block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")) || [])[1] || "", max);
    const link = cleanText(
      (block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i) || [])[1]
      || (block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i) || [])[1]
      || read("link", 900),
      900,
    );
    const category = cleanText(
      (block.match(/<category\b[^>]*(?:label|term)=["']([^"']+)["'][^>]*\/?>/i) || [])[1] || "",
      120,
    );
    out.push({
      title: read("title"),
      link,
      description: read("summary", 1600) || read("content", 1600),
      pubDate: read("updated") || read("published"),
      category,
    });
  }
  return out;
}

function secPressReleaseSearchUrl() {
  return SEC_PRESS_RELEASES_RSS_URL;
}

function regulatoryPressReleaseSearchUrl(target = {}) {
  const targetKey = cleanText(target?.key || "", 120);
  if (targetKey === "accc_news_centre" || target?.kind === "accc_news_centre_rss") {
    const params = new URLSearchParams({
      type: "accc_news",
      view_args: "accc_news",
      items_per_page: "50",
    });
    return `${target?.url || ACCC_NEWS_CENTRE_RSS_URL}?${params.toString()}`;
  }
  return target?.url || SEC_PRESS_RELEASES_RSS_URL;
}

function normalizeRegulatoryPressRelease(row = {}, keyword = "", target = DEFAULT_SEC_PRESS_RELEASE_TARGET) {
  const isCftc = target?.kind === "cftc_enforcement_rss" || String(target?.key || "").startsWith("cftc_");
  const isFtc = target?.kind === "ftc_press_release_rss" || String(target?.key || "").startsWith("ftc_");
  const isDoj = target?.kind === "doj_press_release_rss" || String(target?.key || "").startsWith("doj_");
  const isEeoc = target?.kind === "eeoc_newsroom_rss" || String(target?.key || "").startsWith("eeoc_");
  const isFed = target?.kind === "fed_enforcement_actions_rss" || String(target?.key || "").startsWith("fed_");
  const isFdic = target?.kind === "fdic_press_release_rss" || String(target?.key || "").startsWith("fdic_");
  const isFaa = target?.kind === "faa_press_release_rss" || String(target?.key || "").startsWith("faa_");
  const isUkFca = target?.kind === "uk_fca_news_rss" || String(target?.key || "").startsWith("uk_fca_");
  const isHkSfc = target?.kind === "hk_sfc_press_release_rss"
    || target?.kind === "hk_sfc_circular_rss"
    || String(target?.key || "").startsWith("hk_sfc_");
  const isHkSfcCircular = target?.kind === "hk_sfc_circular_rss" || String(target?.key || "") === "hk_sfc_circulars";
  const isAccc = target?.kind === "accc_news_centre_rss" || String(target?.key || "").startsWith("accc_");
  const isEuCompetition = target?.kind === "eu_competition_decision_rss"
    || target?.kind === "eu_competition_investigation_rss"
    || String(target?.key || "").startsWith("eu_competition_");
  const isEuCompetitionInvestigation = target?.kind === "eu_competition_investigation_rss" || String(target?.key || "") === "eu_competition_investigations";
  const isUkCma = target?.kind === "uk_cma_news_atom" || String(target?.key || "").startsWith("uk_cma_");
  const isCanadaCompetition = target?.kind === "canada_competition_bureau_atom" || String(target?.key || "").startsWith("canada_competition_");
  const isJapanFsa = target?.kind === "japan_fsa_news_rss" || String(target?.key || "").startsWith("japan_fsa_");
  const isBafin = target?.kind === "bafin_measures_sanctions_rss" || String(target?.key || "").startsWith("bafin_");
  const title = cleanText(row.title, 360);
  const content = cleanText(row.description, 1200);
  const url = cleanText(row.link, 900) || target?.url || "https://www.sec.gov/news/pressreleases.rss";
  const searchable = [title, content, row.category].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const terms = isHkSfc ? HK_SFC_ENFORCEMENT_TERMS : isBafin ? BAFIN_ENFORCEMENT_TERMS : isJapanFsa ? JAPAN_FSA_ENFORCEMENT_TERMS : isCanadaCompetition ? CANADA_COMPETITION_BUREAU_TERMS : isUkCma ? UK_CMA_ENFORCEMENT_TERMS : isEuCompetition ? EU_COMPETITION_TERMS : isAccc ? ACCC_ENFORCEMENT_TERMS : isUkFca ? UK_FCA_ENFORCEMENT_TERMS : isFaa ? FAA_ENFORCEMENT_TERMS : isFdic ? FDIC_ENFORCEMENT_TERMS : isFed ? FED_ENFORCEMENT_TERMS : isEeoc ? EEOC_ENFORCEMENT_TERMS : isDoj ? DOJ_ENFORCEMENT_TERMS : isFtc ? FTC_ENFORCEMENT_TERMS : isCftc ? CFTC_ENFORCEMENT_TERMS : SEC_ENFORCEMENT_TERMS;
  if (!terms.some(term => searchable.toLowerCase().includes(term.toLowerCase()))) return null;
  const publishedAt = normalizeDate(row.pubDate) || new Date().toISOString();
  const agency = isHkSfc ? "Hong Kong Securities and Futures Commission" : isBafin ? "Federal Financial Supervisory Authority (BaFin)" : isJapanFsa ? "Japan Financial Services Agency" : isCanadaCompetition ? "Competition Bureau Canada" : isUkCma ? "UK Competition and Markets Authority" : isUkFca ? "UK Financial Conduct Authority" : isEuCompetition ? "European Commission Directorate-General for Competition" : isAccc ? "Australian Competition and Consumer Commission" : isFaa ? "U.S. Federal Aviation Administration" : isFdic ? "Federal Deposit Insurance Corporation" : isFed ? "Board of Governors of the Federal Reserve System" : isEeoc ? "U.S. Equal Employment Opportunity Commission" : isDoj ? "U.S. Department of Justice" : isFtc ? "U.S. Federal Trade Commission" : isCftc ? "U.S. Commodity Futures Trading Commission" : "U.S. Securities and Exchange Commission";
  const targetKey = cleanText(target?.key || "", 120);
  const sourceName = cleanText(target?.name || (isHkSfc ? isHkSfcCircular ? "Hong Kong SFC Circulars" : "Hong Kong SFC Press Releases" : isBafin ? "BaFin Measures and Sanctions RSS" : isJapanFsa ? "Japan Financial Services Agency News RSS" : isCanadaCompetition ? "Competition Bureau Canada News" : isUkCma ? "UK CMA News and Communications" : isUkFca ? "UK FCA News RSS" : isFaa ? "FAA Press Releases" : isFdic ? "FDIC Press Releases" : isFed ? "Federal Reserve Enforcement Actions" : isEeoc ? "EEOC Newsroom" : isDoj ? "DOJ Press Releases" : isFtc ? "FTC Press Releases" : isCftc ? "CFTC Enforcement Press Releases" : "SEC Press Releases"), 120);
  const recordType = isUkCma
    ? "uk-cma-competition-consumer-release"
    : isCftc
    ? "cftc-commodities-derivatives-enforcement-release"
    : isBafin
    ? "bafin-financial-measure-or-sanction"
    : isJapanFsa
    ? "japan-fsa-financial-administrative-action"
    : isCanadaCompetition
    ? "canada-competition-consumer-release"
    : isHkSfc
    ? isHkSfcCircular ? "hk-sfc-regulatory-circular" : "hk-sfc-enforcement-or-market-release"
    : isUkFca
    ? "uk-fca-financial-conduct-release"
    : isFaa
    ? "faa-aviation-safety-enforcement-release"
    : isEuCompetition
    ? isEuCompetitionInvestigation ? "eu-competition-investigation-release" : "eu-competition-decision-release"
    : isAccc
    ? "accc-competition-consumer-enforcement-release"
    : isFdic
    ? "fdic-enforcement-or-bank-regulatory-release"
    : isFed
    ? "federal-reserve-enforcement-action"
    : isEeoc
    ? "eeoc-employment-discrimination-release"
    : isDoj
    ? "doj-press-release"
    : isFtc
    ? "ftc-consumer-protection-or-competition-release"
    : targetKey === "sec_litigation_releases"
      ? "sec-litigation-release"
      : targetKey === "sec_administrative_proceedings"
        ? "sec-administrative-proceeding"
        : targetKey === "sec_trading_suspensions"
          ? "sec-trading-suspension"
          : "sec-enforcement-or-market-conduct-release";
  const source = isHkSfc ? targetKey || (isHkSfcCircular ? "hk_sfc_circulars" : "hk_sfc_press_releases") : isBafin ? targetKey || "bafin_measures_sanctions" : isJapanFsa ? targetKey || "japan_fsa_news" : isCanadaCompetition ? targetKey || "canada_competition_bureau" : isUkCma ? targetKey || "uk_cma_news" : isUkFca ? targetKey || "uk_fca_news" : isFaa ? targetKey || "faa_press_releases" : isEuCompetition ? targetKey || (isEuCompetitionInvestigation ? "eu_competition_investigations" : "eu_competition_decisions") : isAccc ? targetKey || "accc_news_centre" : isFdic ? targetKey || "fdic_press_releases" : isFed ? targetKey || "fed_enforcement_actions" : isEeoc ? targetKey || "eeoc_newsroom" : isDoj ? targetKey || "doj_press_releases" : isFtc ? targetKey || "ftc_press_releases" : isCftc ? targetKey || "cftc_enforcement_actions" : targetKey || "sec_press_releases";
  const titlePrefix = isUkCma
    ? "UK CMA competition/consumer enforcement release"
    : isCftc
    ? "CFTC commodities/derivatives enforcement release"
    : isBafin
    ? "BaFin financial measure/sanction"
    : isJapanFsa
    ? "Japan FSA financial administrative action"
    : isCanadaCompetition
    ? "Canada Competition Bureau competition/consumer release"
    : isHkSfc
    ? isHkSfcCircular ? "Hong Kong SFC regulatory circular" : "Hong Kong SFC enforcement/market release"
    : isUkFca
    ? "UK FCA financial conduct release"
    : isFaa
    ? "FAA aviation safety/enforcement release"
    : isEuCompetition
    ? isEuCompetitionInvestigation ? "EU competition investigation" : "EU competition decision"
    : isAccc
    ? "ACCC competition/consumer enforcement release"
    : isFdic
    ? "FDIC enforcement/bank regulatory release"
    : isFed
    ? "Federal Reserve enforcement action"
    : isEeoc
    ? "EEOC employment enforcement release"
    : isDoj
    ? "DOJ press release"
    : isFtc
    ? "FTC enforcement/consumer protection release"
    : targetKey === "sec_litigation_releases"
      ? "SEC litigation release"
      : targetKey === "sec_administrative_proceedings"
        ? "SEC administrative proceeding"
        : targetKey === "sec_trading_suspensions"
          ? "SEC trading suspension"
          : "SEC enforcement/market conduct release";
  return {
	    url,
	    title: `${titlePrefix}: ${title}`,
	    content,
    author: agency,
    publishedAt,
    riskLevel: enforcementRiskLevel({ title, content, sourceKind: isHkSfc ? "hong kong sfc securities futures enforcement reprimand fine insider dealing market misconduct virtual asset cybersecurity circular" : isBafin ? "bafin german financial supervisory authority administrative fine prohibition anti-money laundering market abuse regulation prospectus securities trading act banking act" : isJapanFsa ? "japan financial services agency administrative action business improvement order business suspension order surcharge insider trading market manipulation crypto-asset exchange unregistered" : isCanadaCompetition ? "canada competition bureau competition tribunal competition act deceptive marketing merger court order investigation consumer protection" : isUkCma ? "uk competition markets authority cma investigation consumer competition remedies conduct requirement market study merger" : isUkFca ? "uk financial conduct authority fca warning unauthorised financial crime fraud enforcement consumer protection" : isFaa ? "faa federal aviation administration civil penalty fine aviation safety enforcement pilot qualification airworthiness hazmat drone tfr violation" : isEuCompetition ? "european commission competition antitrust merger state aid investigation decision" : isAccc ? "accc competition consumer enforcement release" : isFdic ? "fdic enforcement bank regulatory release" : isFed ? "federal reserve enforcement action" : isEeoc ? "eeoc employment enforcement release" : isDoj ? "doj press release" : isFtc ? "ftc press release" : isCftc ? "cftc commodities futures derivatives enforcement fraud spoofing commodity pool swap dealer trading ban restitution penalty" : "sec press release" }),
    metrics: {
      source,
      source_family: "official",
      source_kind: "public_enforcement_action",
      collection_mode: isHkSfc ? isHkSfcCircular ? "hk_sfc_public_circulars_rss" : "hk_sfc_public_press_releases_rss" : isBafin ? targetKey === "bafin_measures_sanctions_de" ? "bafin_public_measures_sanctions_de_rss" : "bafin_public_measures_sanctions_rss" : isJapanFsa ? "japan_fsa_public_news_rss" : isCanadaCompetition ? "canada_competition_bureau_public_atom" : isUkCma ? "uk_cma_public_govuk_atom" : isUkFca ? "uk_fca_public_news_rss" : isFaa ? "faa_public_press_release_rss" : isEuCompetition ? isEuCompetitionInvestigation ? "eu_competition_public_investigation_rss" : "eu_competition_public_decision_rss" : isAccc ? "accc_public_news_centre_rss" : isFdic ? "fdic_public_press_release_rss" : isFed ? "fed_public_enforcement_actions_rss" : isEeoc ? "eeoc_public_newsroom_rss" : isDoj ? "doj_public_press_release_rss" : isFtc ? "ftc_public_press_release_rss" : isCftc ? "cftc_public_enforcement_rss" : "sec_public_press_release_rss",
      enforcement_record_source: sourceName,
      enforcement_record_type: recordType,
      enforcement_release_category: cleanText(row.category, 120),
      source_weight_tier: isFdic || isFed ? "official-bank-enforcement-action" : isHkSfc ? isHkSfcCircular ? "official-hk-securities-regulatory-circular" : "official-hk-securities-enforcement" : isBafin ? "official-de-financial-markets-enforcement" : isJapanFsa ? "official-jp-financial-markets-enforcement" : isCanadaCompetition ? "official-canada-competition-consumer-enforcement" : isUkCma ? "official-uk-competition-consumer-enforcement" : isUkFca ? "official-uk-financial-conduct-enforcement" : isFaa ? "official-aviation-safety-enforcement" : isEuCompetition ? "official-eu-competition-enforcement" : isAccc ? "official-competition-consumer-enforcement" : isCftc ? "official-us-commodities-derivatives-enforcement" : "official-enforcement-action",
    },
  };
}

function normalizeSecPressRelease(row = {}, keyword = "") {
  return normalizeRegulatoryPressRelease(row, keyword, DEFAULT_SEC_PRESS_RELEASE_TARGET);
}

function parseSecPressReleaseResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  return parseRegulatoryPressReleaseResults(xml, keyword, { target: DEFAULT_SEC_PRESS_RELEASE_TARGET, limit, since });
}

function parseRegulatoryPressReleaseResults(xml = "", keyword = "", { target = DEFAULT_SEC_PRESS_RELEASE_TARGET, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rssItems(xml)) {
    const item = normalizeRegulatoryPressRelease(row, keyword, target);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function arrayText(value = [], max = 240) {
  return cleanText(Array.isArray(value) ? value.join(", ") : value, max);
}

function normalizeAsicNewsroomRelease(row = {}, keyword = "", target = {}) {
  const title = cleanText(row.name || row.title, 420);
  const description = cleanText(row.metaDescription || row.description || row.summary, 1400);
  const summary = cleanText(row.summary, 1400);
  const subjects = arrayText(row.metaSubject, 260);
  const functions = arrayText(row.metaFunction, 160);
  const type = arrayText(row.metaType, 120);
  const audience = arrayText(row.metaAudience, 160);
  const documentNumber = cleanText(row.documentNumber, 80);
  const searchable = [title, description, summary, subjects, functions, type, audience, documentNumber].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  if (!ASIC_ENFORCEMENT_TERMS.some(term => searchable.toLowerCase().includes(term.toLowerCase()))) return null;
  const rawUrl = cleanText(row.url, 900);
  const url = rawUrl.startsWith("http")
    ? rawUrl
    : rawUrl.startsWith("/")
      ? `https://www.asic.gov.au${rawUrl}`
      : `${target?.url || ASIC_NEWSROOM_JSON_URL}#${encodeURIComponent(documentNumber || title)}`;
  const publishedAt = normalizeDate(row.publishedDate || row.dateCreated || row.createDate || row.updateDate) || new Date().toISOString();
  const recordType = functions.toLowerCase().includes("enforcement")
    ? "asic-financial-markets-enforcement-release"
    : "asic-regulatory-newsroom-release";
  return {
    url,
    title: `ASIC financial/company enforcement release: ${title}`,
    content: [
      documentNumber ? `Document number: ${documentNumber}.` : "",
      description || summary,
      subjects ? `Subjects: ${subjects}.` : "",
      functions ? `Functions: ${functions}.` : "",
      type ? `Type: ${type}.` : "",
      audience ? `Audience: ${audience}.` : "",
    ].filter(Boolean).join(" "),
    author: "Australian Securities and Investments Commission",
    publishedAt,
    riskLevel: enforcementRiskLevel({
      title,
      content: [description, summary, subjects, functions, type, audience].join(" "),
      sourceKind: "asic australian securities investments commission financial services companies markets enforcement banning disqualified penalty breach misconduct licence court enforceable undertaking",
    }),
    metrics: {
      source: cleanText(target?.key || "asic_newsroom_enforcement", 120),
      source_family: "official",
      source_kind: "public_enforcement_action",
      collection_mode: "asic_public_newsroom_json",
      enforcement_record_source: cleanText(target?.name || "ASIC Newsroom Enforcement Releases", 120),
      enforcement_record_type: recordType,
      enforcement_release_category: [subjects, functions, type].filter(Boolean).join(" | "),
      enforcement_document_number: documentNumber,
      enforcement_subjects: subjects,
      enforcement_functions: functions,
      enforcement_audience: audience,
      source_weight_tier: "official-au-financial-markets-enforcement",
    },
  };
}

function parseAsicNewsroomResults(payload = [], keyword = "", { target = {}, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const item = normalizeAsicNewsroomRelease(row, keyword, target);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = item.metrics.enforcement_document_number || item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertEnforcementItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = publicEnforcementDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const result = insertSentimentItem({
      platform: "public_enforcement_action_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment: sentiment === "positive" ? "neutral" : sentiment,
      risk_level: item.riskLevel || "medium",
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      raw_html: "",
      source_key: "publicEnforcementActionSources",
      evidence: {
        evidence_type: "public_enforcement_or_complaint_record",
        metrics: {
          ...(item.metrics || {}),
          ...publicEnforcementRiskSignals(item),
          ...publicEnforcementKeywordDiagnostics(item, keyword),
          public_enforcement_canonical_dedupe_key: dedupeKey,
          public_enforcement_search_scan_dedupe_key: dedupeKey,
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

export async function scrapePublicEnforcementActionSources(keywords, { proxyUrl = "", budget = {}, since = "", targets = DEFAULT_ENFORCEMENT_TARGETS, domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const maxCfpbComplaintPages = normalizeCfpbComplaintPageBudget(budget);
  const maxFccComplaintPages = normalizeFccComplaintPageBudget(budget);
  const maxCmsProviderDataPages = normalizeCmsProviderDataPageBudget(budget);
  const maxEpaEchoCasePages = normalizeEpaEchoCasePageBudget(budget);
  const maxIcoEnforcementPages = normalizeIcoEnforcementPageBudget(budget);
  const maxIrelandDpcDecisionPages = normalizeIrelandDpcDecisionPageBudget(budget);
  const maxFranceCnilSanctionPages = normalizeFranceCnilSanctionPageBudget(budget);
  const maxFinraDisciplinaryActionPages = normalizeFinraDisciplinaryActionPageBudget(budget);
  const maxNcuaAdministrativeOrderPages = normalizeNcuaAdministrativeOrderPageBudget(budget);
  const maxOccEnforcementActionPages = normalizeOccEnforcementActionPageBudget(budget);
  const maxWashingtonAgDataBreachPages = normalizeWashingtonAgDataBreachPageBudget(budget);
  const maxOshaEstablishmentInspectionPages = normalizeOshaEstablishmentInspectionPageBudget(budget);
  const normalizedTargets = normalizeTargets(targets);
  const tasks = [];
  for (const keyword of normalizedKeywords) {
    for (const target of normalizedTargets) tasks.push({ keyword, target });
  }
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    const failures = [];
    let inserted = 0;
    try {
      const isCfpb = target.kind === "consumer_complaint_api" || target.key === "cfpb_complaints";
      const isCfpbEnforcementActions = target.kind === "cfpb_enforcement_actions_html" || target.key === "cfpb_enforcement_actions";
      const isOcc = target.kind === "occ_enforcement_actions_html" || target.key === "occ_enforcement_actions";
      const isFcc = target.kind === "fcc_consumer_complaints_api" || target.key === "fcc_consumer_complaints";
      const isOsha = target.kind === "osha_establishment_inspection_html" || target.key === "osha_establishment_inspections";
      const isOshaSevereInjury = target.kind === "osha_severe_injury_reports_json" || target.key === "osha_severe_injury_reports";
      const isCms = target.kind === "cms_nursing_home_deficiencies_api" || target.key === "cms_nursing_home_deficiencies";
      const isCmsPenalty = target.kind === "cms_nursing_home_penalties_api" || target.key === "cms_nursing_home_penalties";
      const isHhsOcrBreach = target.kind === "hhs_ocr_breach_portal_html" || target.key === "hhs_ocr_breach_portal";
      const isCaliforniaOagDataBreach = target.kind === "california_oag_data_breach_html" || target.key === "california_oag_data_breaches";
      const isWashingtonAgDataBreach = target.kind === "washington_ag_data_breach_html" || target.key === "washington_ag_data_breaches";
      const isNcuaAdministrativeOrders = target.kind === "ncua_administrative_orders_html" || target.key === "ncua_administrative_orders";
      const isNcuaLateFilers = target.kind === "ncua_call_report_late_filers_html" || target.key === "ncua_call_report_late_filers";
      const isEpaEchoCases = target.kind === "epa_echo_enforcement_cases_api" || target.key === "epa_echo_enforcement_cases";
      const isAsicNewsroom = target.kind === "asic_newsroom_json" || target.key === "asic_newsroom_enforcement";
      const isIcoEnforcement = target.kind === "uk_ico_enforcement_search_api" || target.key === "uk_ico_enforcement";
      const isIrelandDpcDecisions = target.kind === "ireland_dpc_decisions_html" || target.key === "ireland_dpc_decisions";
      const isFranceCnilSanctions = target.kind === "france_cnil_sanctions_html" || target.key === "france_cnil_sanctions";
      const isFinraDisciplinaryActions = target.kind === "finra_disciplinary_actions_html" || target.key === "finra_disciplinary_actions";
      const isCmsJson = isCms || isCmsPenalty;
      let url = regulatoryPressReleaseSearchUrl(target);
      if (isCfpb) url = cfpbComplaintSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword });
      else if (isCfpbEnforcementActions) url = cfpbEnforcementActionsSearchUrl(keyword);
      else if (isOcc) url = occEnforcementActionSearchUrl(keyword);
      else if (isFcc) url = fccConsumerComplaintSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword });
      else if (isOsha) url = oshaEstablishmentSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword });
      else if (isOshaSevereInjury) url = oshaSevereInjuryReportsSearchUrl();
      else if (isCms) url = cmsNursingHomeDeficiencySearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword });
      else if (isCmsPenalty) url = cmsNursingHomePenaltySearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword });
      else if (isHhsOcrBreach) url = hhsOcrBreachPortalSearchUrl();
      else if (isCaliforniaOagDataBreach) url = californiaOagDataBreachSearchUrl(keyword);
      else if (isWashingtonAgDataBreach) url = washingtonAgDataBreachSearchUrl(keyword);
      else if (isNcuaAdministrativeOrders) url = ncuaAdministrativeOrdersSearchUrl(keyword);
      else if (isNcuaLateFilers) url = ncuaCallReportLateFilersSearchUrl();
      else if (isEpaEchoCases) url = epaEchoCaseSearchUrl(keyword);
      else if (isIcoEnforcement) url = UK_ICO_ENFORCEMENT_SEARCH_API_URL;
      else if (isIrelandDpcDecisions) url = irelandDpcDecisionsSearchUrl(keyword);
      else if (isFranceCnilSanctions) url = franceCnilSanctionsSearchUrl(keyword);
      else if (isFinraDisciplinaryActions) url = finraDisciplinaryActionsSearchUrl(keyword);
      const requestInit = isIcoEnforcement ? {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,text/plain,*/*",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(ukIcoEnforcementSearchBody(keyword)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      } : {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": isCfpb || isFcc || isOshaSevereInjury || isCmsJson || isEpaEchoCases || isAsicNewsroom ? "application/json,text/plain,*/*" : "application/rss+xml,text/html,text/xml,text/plain,*/*",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      };
      if (isIcoEnforcement) {
        for (let page = 1; page <= maxIcoEnforcementPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const pageRes = await fetchPublicSource(url, {
            method: "POST",
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "application/json,text/plain,*/*",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(ukIcoEnforcementSearchBody(keyword, { pageNumber: page })),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const payload = await pageRes.json();
          const rawResultCount = countIcoEnforcementRawResults(payload);
          const items = parseIcoEnforcementResults(payload, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              ico_search_page: page,
              ico_search_raw_result_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || !icoEnforcementHasMore(payload, page)) break;
        }
        return { inserted, failures };
      }
      if (isOcc) {
        for (let page = 0; page < maxOccEnforcementActionPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const pageUrl = occEnforcementActionSearchUrl(keyword, { page, limit: normalizedBudget.maxItemsPerKeyword });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const html = await pageRes.text();
          const rawResultCount = countOccEnforcementActionRawRows(html);
          const items = parseOccEnforcementActionResults(html, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              occ_search_page: page + 1,
              occ_search_raw_action_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isIrelandDpcDecisions) {
        for (let page = 0; page < maxIrelandDpcDecisionPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const pageUrl = irelandDpcDecisionsSearchUrl(keyword, { page });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const html = await pageRes.text();
          const rawResultCount = countIrelandDpcDecisionRawCards(html);
          const items = parseIrelandDpcDecisionResults(html, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              ireland_dpc_search_page: page + 1,
              ireland_dpc_search_raw_decision_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isFranceCnilSanctions) {
        for (let page = 0; page < maxFranceCnilSanctionPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const pageUrl = franceCnilSanctionsSearchUrl(keyword, { page });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const html = await pageRes.text();
          const rawResultCount = countFranceCnilSanctionRawRows(html);
          const items = parseFranceCnilSanctionResults(html, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              france_cnil_search_page: page + 1,
              france_cnil_search_raw_sanction_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isFinraDisciplinaryActions) {
        for (let page = 0; page < maxFinraDisciplinaryActionPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const pageUrl = finraDisciplinaryActionsSearchUrl(keyword, { page });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const html = await pageRes.text();
          const rawResultCount = countFinraDisciplinaryActionRawRows(html);
          const items = parseFinraDisciplinaryActionResults(html, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              finra_search_page: page + 1,
              finra_search_raw_action_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isNcuaAdministrativeOrders) {
        for (let page = 0; page < maxNcuaAdministrativeOrderPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const pageUrl = ncuaAdministrativeOrdersSearchUrl(keyword, { page });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const html = await pageRes.text();
          const rawResultCount = countNcuaAdministrativeOrderRawRows(html);
          const items = parseNcuaAdministrativeOrderResults(html, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              ncua_admin_order_search_page: page + 1,
              ncua_admin_order_search_raw_order_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isWashingtonAgDataBreach) {
        for (let page = 0; page < maxWashingtonAgDataBreachPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const pageUrl = washingtonAgDataBreachSearchUrl(keyword, { page });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const html = await pageRes.text();
          const rawResultCount = countWashingtonAgDataBreachRawRows(html);
          const items = parseWashingtonAgDataBreachResults(html, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              washington_ag_data_breach_search_page: page + 1,
              washington_ag_data_breach_search_raw_notice_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isOsha) {
        for (let page = 0; page < maxOshaEstablishmentInspectionPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const pageUrl = oshaEstablishmentSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword, page });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const html = await pageRes.text();
          const rawResultCount = countOshaInspectionRawRows(html);
          const items = await mergeOshaInspectionDetailsForItems(parseOshaInspectionResults(html, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              osha_inspection_search_page: page + 1,
              osha_inspection_search_raw_result_count: rawResultCount,
            },
          })), proxyUrl);
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isEpaEchoCases) {
        const searchRes = await fetchPublicSource(url, requestInit, proxyUrl);
        if (!searchRes.ok) {
          failures.push({ keyword, target: target.key || target.url, message: httpFailure(searchRes) });
          return { inserted, failures };
        }
        const search = parseEpaEchoCaseSearchResults(await searchRes.json());
        if (search.error) throw new Error(search.error);
        if (search.queryId) {
          for (let page = 1; page <= maxEpaEchoCasePages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
            const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
            if (remaining <= 0) break;
            let payload;
            if (page === 1 && search.cases.length) {
              payload = { Results: { Cases: search.cases, QueryID: search.queryId } };
            } else {
              const qidRes = await fetchPublicSource(epaEchoCaseQidUrl(search.queryId, { page }), {
                headers: { "User-Agent": USER_AGENT, "Accept": "application/json,text/plain,*/*" },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              }, proxyUrl);
              if (!qidRes.ok) {
                failures.push({ keyword, target: target.key || target.url, message: httpFailure(qidRes) });
                break;
              }
              payload = await qidRes.json();
            }
            const rawResultCount = countEpaEchoCaseRawResults(payload);
            const items = parseEpaEchoCaseQidResults(payload, keyword, { limit: remaining, since, queryId: search.queryId, summaryMetrics: search.metrics }).map(item => ({
              ...item,
              metrics: {
                ...(item.metrics || {}),
                epa_echo_qid_page: page,
                epa_echo_qid_raw_case_count: rawResultCount,
              },
            }));
            inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
            if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
          }
        } else if (search.cases.length) {
          const payload = { Results: { Cases: search.cases, QueryID: search.queryId } };
          const rawResultCount = countEpaEchoCaseRawResults(payload);
          const items = parseEpaEchoCaseQidResults(payload, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since, queryId: search.queryId, summaryMetrics: search.metrics }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              epa_echo_qid_page: 1,
              epa_echo_qid_raw_case_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        }
        return { inserted, failures };
      }
      if (isCfpb) {
        for (let page = 0; page < maxCfpbComplaintPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const from = page * normalizedBudget.maxItemsPerKeyword;
          const pageUrl = cfpbComplaintSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword, from });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const payload = await pageRes.json();
          const rawResultCount = countCfpbComplaintRawResults(payload);
          const items = parseCfpbComplaintResults(payload, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              cfpb_complaint_search_page: page + 1,
              cfpb_complaint_search_from: from,
              cfpb_complaint_search_raw_result_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isFcc) {
        for (let page = 0; page < maxFccComplaintPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const offset = page * normalizedBudget.maxItemsPerKeyword;
          const pageUrl = fccConsumerComplaintSearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword, offset });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const payload = await pageRes.json();
          const rawResultCount = countFccConsumerComplaintRawResults(payload);
          const items = parseFccConsumerComplaintResults(payload, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              fcc_complaint_search_page: page + 1,
              fcc_complaint_search_offset: offset,
              fcc_complaint_search_raw_result_count: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      if (isCms || isCmsPenalty) {
        for (let page = 0; page < maxCmsProviderDataPages && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const remaining = Math.max(0, normalizedBudget.maxItemsPerKeyword - inserted);
          if (remaining <= 0) break;
          const offset = page * normalizedBudget.maxItemsPerKeyword;
          const pageUrl = isCms
            ? cmsNursingHomeDeficiencySearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword, offset })
            : cmsNursingHomePenaltySearchUrl(keyword, { limit: normalizedBudget.maxItemsPerKeyword, offset });
          const pageRes = await fetchPublicSource(pageUrl, requestInit, proxyUrl);
          if (!pageRes.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(pageRes) });
            break;
          }
          const payload = await pageRes.json();
          const rawResultCount = countCmsProviderDataRawResults(payload);
          const parser = isCms ? parseCmsNursingHomeDeficiencyResults : parseCmsNursingHomePenaltyResults;
          const metricPrefix = isCms ? "cms_deficiency" : "cms_penalty";
          const items = parser(payload, keyword, { limit: remaining, since }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              [`${metricPrefix}_search_page`]: page + 1,
              [`${metricPrefix}_search_offset`]: offset,
              [`${metricPrefix}_search_raw_result_count`]: rawResultCount,
            },
          }));
          inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          if (!rawResultCount || rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
        }
        return { inserted, failures };
      }
      const res = await fetchPublicSource(url, {
        ...requestInit,
      }, proxyUrl);
      let fallbackText = "";
      if (!res.ok) {
        if (isOshaSevereInjury && !proxyUrl && [403, 406].includes(Number(res.status))) {
          try {
            fallbackText = await fetchTextWithCurlFallback(url, { accept: "application/json,text/plain,*/*" });
          } catch (fallbackErr) {
            failures.push({ keyword, target: target.key || target.url, message: `${httpFailure(res)}; curl fallback failed: ${formatSourceError(fallbackErr, proxyUrl)}` });
          }
        } else {
          failures.push({ keyword, target: target.key || target.url, message: httpFailure(res) });
        }
      }
      if (res.ok || fallbackText) {
        let items = [];
        if (isCfpbEnforcementActions) {
          items = parseCfpbEnforcementActionResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isOcc) {
          items = parseOccEnforcementActionResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isNcuaAdministrativeOrders) {
          items = parseNcuaAdministrativeOrderResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isNcuaLateFilers) {
          items = parseNcuaLateFilerResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isEpaEchoCases) {
          const search = parseEpaEchoCaseSearchResults(await res.json());
          if (search.error) throw new Error(search.error);
          if (search.cases.length) {
            items = parseEpaEchoCaseQidResults({ Results: { Cases: search.cases, QueryID: search.queryId } }, keyword, { limit: normalizedBudget.maxItemsPerKeyword, since, queryId: search.queryId, summaryMetrics: search.metrics });
          } else if (search.queryId) {
            const qidRes = await fetchPublicSource(epaEchoCaseQidUrl(search.queryId), {
              headers: { "User-Agent": USER_AGENT, "Accept": "application/json,text/plain,*/*" },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }, proxyUrl);
            if (!qidRes.ok) failures.push({ keyword, target: target.key || target.url, message: httpFailure(qidRes) });
            else items = parseEpaEchoCaseQidResults(await qidRes.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since, queryId: search.queryId, summaryMetrics: search.metrics });
          }
        } else if (isAsicNewsroom) {
          items = parseAsicNewsroomResults(await res.json(), keyword, { target, limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isIcoEnforcement) {
          items = parseIcoEnforcementResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isIrelandDpcDecisions) {
          items = parseIrelandDpcDecisionResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isFranceCnilSanctions) {
          items = parseFranceCnilSanctionResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isFinraDisciplinaryActions) {
          items = parseFinraDisciplinaryActionResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isOsha) {
          items = parseOshaInspectionResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isOshaSevereInjury) {
          items = parseOshaSevereInjuryReportResults(fallbackText ? JSON.parse(fallbackText) : await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isHhsOcrBreach) {
          items = parseHhsOcrBreachPortalResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isCaliforniaOagDataBreach) {
          items = parseCaliforniaOagDataBreachResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isWashingtonAgDataBreach) {
          items = parseWashingtonAgDataBreachResults(await res.text(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isCms) {
          items = parseCmsNursingHomeDeficiencyResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isCmsPenalty) {
          items = parseCmsNursingHomePenaltyResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isFcc) {
          items = parseFccConsumerComplaintResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else if (isCfpb) {
          items = parseCfpbComplaintResults(await res.json(), keyword, { limit: normalizedBudget.maxItemsPerKeyword, since });
        } else {
          items = parseRegulatoryPressReleaseResults(await res.text(), keyword, { target, limit: normalizedBudget.maxItemsPerKeyword, since });
        }
        if (isOsha && items.length) {
          items = await mergeOshaInspectionDetailsForItems(items, proxyUrl);
        }
        inserted += await insertEnforcementItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target?.key || "public-enforcement", message });
      console.warn(`[CRM/PublicEnforcementAction] 抓取失敗 target=${target?.key || "unknown"} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  CFPB_COMPLAINTS_API_URL,
  CFPB_ENFORCEMENT_ACTIONS_URL,
  OCC_ENFORCEMENT_ACTION_SEARCH_URL,
  FCC_CONSUMER_COMPLAINTS_API_URL,
  OSHA_ESTABLISHMENT_SEARCH_URL,
  OSHA_SEVERE_INJURY_INITIAL_SEARCH_JSON_URL,
  CMS_NURSING_HOME_DEFICIENCIES_URL,
  CMS_NURSING_HOME_PENALTIES_URL,
  HHS_OCR_BREACH_PORTAL_URL,
  CALIFORNIA_OAG_DATA_BREACH_SEARCH_URL,
  WASHINGTON_AG_DATA_BREACH_NOTIFICATIONS_URL,
  SEC_PRESS_RELEASES_RSS_URL,
  SEC_LITIGATION_RELEASES_RSS_URL,
  SEC_ADMINISTRATIVE_PROCEEDINGS_RSS_URL,
  SEC_TRADING_SUSPENSIONS_RSS_URL,
  CFTC_ENFORCEMENT_RSS_URL,
  FTC_PRESS_RELEASES_RSS_URL,
  FTC_CONSUMER_PROTECTION_RSS_URL,
  DOJ_PRESS_RELEASES_RSS_URL,
  EEOC_NEWSROOM_RSS_URL,
  FED_ENFORCEMENT_ACTIONS_RSS_URL,
  FDIC_PRESS_RELEASES_RSS_URL,
  FAA_PRESS_RELEASES_RSS_URL,
  UK_FCA_NEWS_RSS_URL,
  UK_ICO_ENFORCEMENT_SEARCH_API_URL,
  IRELAND_DPC_DECISIONS_URL,
  FRANCE_CNIL_SANCTIONS_URL,
  FINRA_DISCIPLINARY_ACTIONS_URL,
  HK_SFC_PRESS_RELEASES_RSS_URL,
  HK_SFC_CIRCULARS_RSS_URL,
  ASIC_NEWSROOM_JSON_URL,
  JAPAN_FSA_NEWS_RSS_URL,
  BAFIN_MEASURES_SANCTIONS_RSS_URL,
  BAFIN_MEASURES_SANCTIONS_DE_RSS_URL,
	  ACCC_NEWS_CENTRE_RSS_URL,
  EU_COMPETITION_DECISIONS_RSS_URL,
  EU_COMPETITION_INVESTIGATIONS_RSS_URL,
  UK_CMA_NEWS_ATOM_URL,
  CANADA_COMPETITION_BUREAU_ATOM_URL,
  NCUA_ADMINISTRATIVE_ORDERS_URL,
  NCUA_CALL_REPORT_LATE_FILERS_URL,
  EPA_ECHO_CASE_SEARCH_URL,
  EPA_ECHO_CASE_QID_URL,
  DEFAULT_ENFORCEMENT_TARGETS,
  DEFAULT_MAX_CFPB_COMPLAINT_PAGES,
  DEFAULT_MAX_FCC_COMPLAINT_PAGES,
  DEFAULT_MAX_CMS_PROVIDER_DATA_PAGES,
  DEFAULT_MAX_EPA_ECHO_CASE_PAGES,
  DEFAULT_MAX_ICO_ENFORCEMENT_PAGES,
  DEFAULT_MAX_IRELAND_DPC_DECISION_PAGES,
  DEFAULT_MAX_FRANCE_CNIL_SANCTION_PAGES,
  DEFAULT_MAX_FINRA_DISCIPLINARY_ACTION_PAGES,
  DEFAULT_MAX_NCUA_ADMINISTRATIVE_ORDER_PAGES,
  DEFAULT_MAX_OCC_ENFORCEMENT_ACTION_PAGES,
  DEFAULT_MAX_WASHINGTON_AG_DATA_BREACH_PAGES,
  DEFAULT_MAX_OSHA_ESTABLISHMENT_INSPECTION_PAGES,
  SEC_ENFORCEMENT_TERMS,
  CFTC_ENFORCEMENT_TERMS,
  FTC_ENFORCEMENT_TERMS,
  DOJ_ENFORCEMENT_TERMS,
  EEOC_ENFORCEMENT_TERMS,
  FED_ENFORCEMENT_TERMS,
	  FDIC_ENFORCEMENT_TERMS,
  FAA_ENFORCEMENT_TERMS,
	  UK_FCA_ENFORCEMENT_TERMS,
  HK_SFC_ENFORCEMENT_TERMS,
  ASIC_ENFORCEMENT_TERMS,
  JAPAN_FSA_ENFORCEMENT_TERMS,
  BAFIN_ENFORCEMENT_TERMS,
	  ACCC_ENFORCEMENT_TERMS,
  EU_COMPETITION_TERMS,
  UK_CMA_ENFORCEMENT_TERMS,
  CANADA_COMPETITION_BUREAU_TERMS,
  ICO_ENFORCEMENT_ROOT_PAGE_ID,
  normalizeEnforcementKeywordText,
  textMatchesKeyword,
  textMatchesKeywordWithoutStopwords,
  normalizeBudget,
  normalizeCfpbComplaintPageBudget,
  normalizeFccComplaintPageBudget,
  normalizeCmsProviderDataPageBudget,
  normalizeEpaEchoCasePageBudget,
  normalizeIcoEnforcementPageBudget,
  normalizeIrelandDpcDecisionPageBudget,
  normalizeFranceCnilSanctionPageBudget,
  normalizeFinraDisciplinaryActionPageBudget,
  normalizeNcuaAdministrativeOrderPageBudget,
  normalizeOccEnforcementActionPageBudget,
  normalizeWashingtonAgDataBreachPageBudget,
  normalizeOshaEstablishmentInspectionPageBudget,
  normalizeTargets,
  fetchTextWithCurlFallback,
  normalizePublicEnforcementDedupeUrl,
  publicEnforcementDedupeKey,
  publicEnforcementKeywordMatchSource,
  publicEnforcementKeywordDiagnostics,
  publicEnforcementRiskSignals,
  cfpbComplaintSearchUrl,
  cfpbEnforcementActionsSearchUrl,
  occEnforcementActionSearchUrl,
  ncuaAdministrativeOrdersSearchUrl,
  ncuaCallReportLateFilersSearchUrl,
  epaEchoCaseSearchUrl,
  epaEchoCaseQidUrl,
  fccConsumerComplaintSearchUrl,
  oshaEstablishmentSearchUrl,
  oshaSevereInjuryReportsSearchUrl,
  cmsNursingHomeDeficiencySearchUrl,
  cmsNursingHomePenaltySearchUrl,
  hhsOcrBreachPortalSearchUrl,
  californiaOagDataBreachSearchUrl,
  washingtonAgDataBreachSearchUrl,
  ukIcoEnforcementSearchBody,
  irelandDpcDecisionsSearchUrl,
  franceCnilSanctionsSearchUrl,
  finraDisciplinaryActionsSearchUrl,
  secPressReleaseSearchUrl,
  regulatoryPressReleaseSearchUrl,
  enforcementRiskLevel,
  cfpbEnforcementActionRiskLevel,
  occEnforcementRiskLevel,
  ncuaEnforcementRiskLevel,
  epaEchoCaseRiskLevel,
  oshaInspectionRiskLevel,
  oshaSevereInjuryRiskLevel,
  hhsOcrBreachRiskLevel,
  cmsDeficiencyRiskLevel,
  cmsPenaltyRiskLevel,
  icoEnforcementRiskLevel,
  irelandDpcDecisionRiskLevel,
  franceCnilSanctionRiskLevel,
  finraDisciplinaryActionRiskLevel,
  parseCfpbComplaintResults,
  countCfpbComplaintRawResults,
  parseCfpbEnforcementActionResults,
  parseOccEnforcementActionResults,
  countOccEnforcementActionRawRows,
  parseNcuaAdministrativeOrderResults,
  countNcuaAdministrativeOrderRawRows,
  parseNcuaLateFilerResults,
  parseEpaEchoCaseSearchResults,
  parseEpaEchoCaseQidResults,
  countEpaEchoCaseRawResults,
  parseFccConsumerComplaintResults,
  countFccConsumerComplaintRawResults,
  parseOshaInspectionDetail,
  parseOshaInspectionResults,
  countOshaInspectionRawRows,
  parseOshaSevereInjuryReportResults,
  parseHhsOcrBreachPortalResults,
  parseCaliforniaOagDataBreachResults,
  parseWashingtonAgDataBreachResults,
  countWashingtonAgDataBreachRawRows,
  mergeOshaInspectionDetail,
  parseCmsNursingHomeDeficiencyResults,
  countCmsProviderDataRawResults,
  parseCmsNursingHomePenaltyResults,
  parseIcoEnforcementResults,
  countIcoEnforcementRawResults,
  icoEnforcementHasMore,
  parseIrelandDpcDecisionResults,
  countIrelandDpcDecisionRawCards,
  parseFranceCnilSanctionResults,
  countFranceCnilSanctionRawRows,
  countFinraDisciplinaryActionRawRows,
  parseFinraDisciplinaryActionResults,
  parseSecPressReleaseResults,
  parseRegulatoryPressReleaseResults,
  parseAsicNewsroomResults,
};
