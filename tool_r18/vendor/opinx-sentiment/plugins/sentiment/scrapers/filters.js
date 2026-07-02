export const RECENT_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TAIWAN_HINTS = [
  "台灣",
  "台灣",
  "台灣",
  "taiwan",
  "taipei",
  "台北",
  "台北",
  "新北",
  "桃園",
  "台中",
  "台中",
  "台南",
  "台南",
  "高雄",
  "基隆",
  "新竹",
  "苗栗",
  "彰化",
  "南投",
  "雲林",
  "雲林",
  "嘉義",
  "嘉義",
  "屏東",
  "屏東",
  "宜蘭",
  "宜蘭",
  "花蓮",
  "花蓮",
  "台東",
  "台東",
  "台東",
  "澎湖",
  "金門",
  "金門",
  "馬祖",
  "馬祖",
  "中央社",
  "自由時報",
  "聯合新聞",
  "中時",
  "公視",
  "民視",
  "三立",
  "東森",
  "TVBS",
  "ETtoday",
  "ETtoday新聞雲",
  "NOWnews",
  "NOWnews今日新聞",
  "Yahoo奇摩新聞",
  "聯合新聞網",
  "中時新聞網",
  "自由時報電子報",
  "鏡週刊",
  "風傳媒",
  "關鍵評論網",
  "上報",
  "商業周刊",
  "報導者",
  "天下雜誌",
  "今周刊",
  "財訊",
  "MoneyDJ",
  "MoneyDJ理財網",
  "鉅亨網",
  "upmedia",
  "nownews",
  "storm.mg",
  "upmedia.mg",
  "cnyes.com",
  "moneydj.com",
  "businessweekly.com.tw",
  "cw.com.tw",
  "businesstoday.com.tw",
  "wealth.com.tw",
  "PTT",
  "Dcard",
  ".tw",
];

const NON_TAIWAN_HINTS = [
  "中國大陸",
  "中國大陸",
  "大陸",
  "內地",
  "內地",
  "北京",
  "上海",
  "廣州",
  "深圳",
  "知乎",
  "百度",
  "微博",
  "抖音",
  "小紅書",
  "人民網",
  "人民網",
  "騰訊",
  "騰訊",
];

export function getRecentCutoff(now = new Date()) {
  return new Date(now.getTime() - RECENT_DAYS * MS_PER_DAY);
}

export function isRecentDate(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date >= getRecentCutoff(now) && date <= new Date(now.getTime() + 10 * 60 * 1000);
}

export function isAfterSince(value, since = "") {
  if (!since) return true;
  const date = value instanceof Date ? value : new Date(value);
  const sinceDate = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(date.getTime()) || Number.isNaN(sinceDate.getTime())) return true;
  return date >= sinceDate;
}

export function isTaiwanRelatedText(...parts) {
  const text = parts
    .filter(Boolean)
    .map(part => String(part))
    .join(" ");
  if (!text) return false;

  const lower = text.toLowerCase();
  const hasTaiwanHint = TAIWAN_HINTS.some(hint => lower.includes(hint.toLowerCase()));
  if (!hasTaiwanHint) return false;

  const hasNonTaiwanHint = NON_TAIWAN_HINTS.some(hint => lower.includes(hint.toLowerCase()));
  if (!hasNonTaiwanHint) return true;

  return /台灣|台灣|台灣|taiwan|ptt|dcard|\.tw\b/i.test(text);
}

export function isTaiwanRecentItem(item, now = new Date()) {
  return (
    isRecentDate(item?.publishedAt ?? item?.found_at, now) &&
    isTaiwanRelatedText(item?.title, item?.content, item?.description, item?.source, item?.url)
  );
}

export function getTaiwanRecentWhereClause(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const cutoff = getRecentCutoff().toISOString();
  const taiwanLike = TAIWAN_HINTS.map(() => `(${prefix}title LIKE ? OR ${prefix}content LIKE ? OR ${prefix}author LIKE ? OR ${prefix}url LIKE ?)`).join(" OR ");
  const nonTaiwanLike = NON_TAIWAN_HINTS.map(() => `(${prefix}title LIKE ? OR ${prefix}content LIKE ? OR ${prefix}author LIKE ? OR ${prefix}url LIKE ?)`).join(" OR ");
  const sql = `${prefix}published_at IS NOT NULL AND ${prefix}published_at >= ? AND (${taiwanLike}) AND NOT (${nonTaiwanLike})`;
  const params = [cutoff];

  for (const hint of TAIWAN_HINTS) {
    const value = `%${hint}%`;
    params.push(value, value, value, value);
  }
  for (const hint of NON_TAIWAN_HINTS) {
    const value = `%${hint}%`;
    params.push(value, value, value, value);
  }

  return { sql, params };
}
