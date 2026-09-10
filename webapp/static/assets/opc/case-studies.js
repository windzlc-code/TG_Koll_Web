(() => {
  const root = document.querySelector("[data-case-studies-root]");
  if (!root) return;

  const sourceCases = [
    {
      id: "gy-zzzzz",
      number: "01",
      platform: "Threads",
      username: "gy.zzzzz",
      sourceUrl: "https://www.threads.com/@gy.zzzzz",
      reportUrl: "http://47.243.99.2:8094/threads-analysis?report=tar_mtvgxqg4_543acf",
      reportApiUrls: ["/assets/opc/case-studies/tar_mtvgxqg4_543acf.json"],
      sampledAt: "2026/5/13—2026/7/26",
      followers: 767,
      recentViews: 47742,
      samplePosts: 15,
      engagement: 957,
      averageEngagement: 64,
      viewsPerFollower: 62.25,
      engagementPerThousandViews: 20.05,
      persona: "第一人称鲜明的个人品牌／生活观点型账号",
      styles: ["提问互动型", "文字简洁", "自然语句导向", "弱销售感"],
      flow: ["以真实日常切入", "用单一问题引出互动", "把高互动生活场景延展为持续内容"],
      peakHours: [
        { label: "16:00–17:00", value: 275, total: 549, posts: 2, detail: "兩篇內容合計 549 互動指數；以具體職業日常和開放式提問帶動回覆。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DYT8bXmk9uu" },
        { label: "19:00–20:00", value: 90, total: 179, posts: 2, detail: "兩篇內容合計 179 互動指數；適合以收工後的生活片段承接情緒共鳴。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DYRtXzGk-p9" },
        { label: "15:00–16:00", value: 65, total: 65, posts: 1, detail: "單篇 65 互動指數；可測試短句、食物與下班日常的輕量互動。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DbNUbmIkwnT" },
        { label: "22:00–23:00", value: 22, total: 66, posts: 3, detail: "有多篇樣本但篇均較低，先調整開頭與提問方式，再決定是否增加頻率。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DZISlozEzpE" },
        { label: "11:00–12:00", value: 20, total: 39, posts: 2, detail: "中午樣本量較小，適合做同題材的對照測試。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DYW183GE0ko" },
      ],
      daily: [
        { date: "05-13", value: 198 }, { date: "05-14", value: 536 }, { date: "05-15", value: 17 }, { date: "05-16", value: 13 },
        { date: "05-19", value: 11 }, { date: "05-27", value: 28 }, { date: "05-29", value: 15 }, { date: "06-01", value: 10 },
        { date: "06-03", value: 18 }, { date: "07-14", value: 7 }, { date: "07-22", value: 3 }, { date: "07-25", value: 65 }, { date: "07-26", value: 36 },
      ],
      monthly: [
        { month: "2026-05", posts: 9, likes: 634, replies: 92, reposts: 0, total: 818, average: 91, championUrl: "https://www.threads.com/@gy.zzzzz/post/DYT8bXmk9uu" },
        { month: "2026-06", posts: 2, likes: 17, replies: 4, reposts: 1, total: 28, average: 14, championUrl: "https://www.threads.com/@gy.zzzzz/post/DZISlozEzpE" },
        { month: "2026-07", posts: 4, likes: 97, replies: 7, reposts: 0, total: 111, average: 28, championUrl: "https://www.threads.com/@gy.zzzzz/post/DbNUbmIkwnT" },
      ],
      styleMix: [
        { name: "互动提问型", percent: 40, posts: 6, average: 112, total: 672, detail: "以問句、二選一、站隊或留言關鍵字降低回覆門檻；是本樣本最需要優先放大的內容結構。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DYT8bXmk9uu" },
        { name: "视觉展示型", percent: 20, posts: 3, average: 39, total: 116, detail: "圖片、輪播或短影片先承接情緒與場景，文字負責補充脈絡和一個明確問題。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DbPcvpCE9lj" },
        { name: "观点立场型", percent: 27, posts: 4, average: 16, total: 62, detail: "以明確判斷和生活觀察建立辨識度；需持續測試更具體的切角，避免泛泛而談。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DYhCAfzE6ZY" },
        { name: "故事叙事型", percent: 27, posts: 4, average: 16, total: 64, detail: "從真實經歷、轉折與情境開始；若篇均偏低，先替換鉤子與衝突點，而非只更換圖片。", postUrl: "https://www.threads.com/@gy.zzzzz/post/DYSHe3Jk-Gi" },
      ],
      bestPost: {
        text: "同期朋友陆续转行，自己仍在飞行工作中；以职业日常与自我提问形成真实共鸣。",
        views: 25110,
        engagement: 536,
        likes: 430,
        replies: 53,
        url: "https://www.threads.com/@gy.zzzzz/post/DYT8bXmk9uu",
      },
      mediaPosts: [],
      reportLoading: true,
      historical: [
        { title: "互動選擇", posts: 2, total: 547, average: 274, url: "https://www.threads.com/@gy.zzzzz/post/DYT8bXmk9uu" },
        { title: "生活情境", posts: 2, total: 235, average: 118, url: "https://www.threads.com/@gy.zzzzz/post/DYRtXzGk-p9" },
        { title: "穿搭／形象", posts: 3, total: 52, average: 17, url: "https://www.threads.com/@gy.zzzzz/post/DY2EAFkk6fD" },
        { title: "其他日常", posts: 8, total: 123, average: 15, url: "https://www.threads.com/@gy.zzzzz/post/DbPcvpCE9lj" },
      ],
      guidance: [
        { title: "保留真实日常", text: "从职业、通勤、下班和生活碎片切入，先让内容具备可感知的具体场景。" },
        { title: "问题只留一个", text: "在结尾保留一个自然的选择题或提问，让读者有明确而低门槛的回应入口。" },
        { title: "放大胜出时段", text: "优先在 15–20 点测试同类题材，再根据真实互动继续扩展，而不是复制原帖。" },
      ],
    },
  ];

  const copy = {
    "zh-Hans": {
      heroKicker: "VECTO CASE LIBRARY",
      heroTitle: "热门案例，拆解可复用的增长线索",
      heroCopy: "以真实公开样本复盘账号定位、内容结构、互动表现和下一步方向。案例只呈现经核对的数据，不用模板化数字填充。",
      heroNoteTitle: "案例持续收录",
      heroNoteCopy: "当前案例来自已保存的公开分析报告；新增案例会保持同一套信息结构与可比较口径。",
      switcherLabel: "热门案例",
      switcherPrefix: "案例",
      counter: (current, total) => `${current} / ${total}`,
      reportState: "公开样本分析",
      analysisTitle: "账号分析快照",
      accountMeta: (sampledAt) => `Threads · 样本期 ${sampledAt}`,
      followers: "粉丝",
      recentViews: "近期浏览",
      samplePosts: "样本帖子",
      engagement: "互动指数",
      viewsScope: "公开样本累计",
      average: (value) => `篇均 ${value}`,
      trafficKicker: "TRAFFIC BASELINE",
      trafficTitle: "账号流量基准",
      trafficIntro: "浏览量以公开可见样本累加，不将总浏览量平均分配到单篇内容。",
      viewsPerFollower: "浏览 / 粉丝",
      engagementPerThousand: "每千浏览公开互动",
      peakKicker: "PEAK WINDOWS",
      peakTitle: "高效发布时间",
      peakIntro: "按样本贴文的互动指数排序，优先用于测试同类型选题。",
      totalEngagement: "总互动指数",
      posts: (count) => `${count} 篇样本`,
      dailyKicker: "DAILY WAVE",
      dailyTitle: "每日互动波段",
      dailyIntro: "以公开样本的每日互动指数呈现趋势；柱线叠加用于识别异常峰值和可复测时段。",
      activeDays: "有样本天数",
      dailyAverage: "样本日均指数",
      peakDay: "最高互动日",
      trendTotal: "样本总互动指数",
      trendDate: "日期",
      trendValue: "互动指数",
      trendShare: "占样本比例",
      trendSignal: "数据标记",
      peakSignal: "峰值",
      normalSignal: "常规",
      monthlyKicker: "MONTHLY TABLE",
      monthlyTitle: "月度数据对照",
      monthlyIntro: "按月保留样本数量、互动构成和代表帖文，方便快速核对增长波段。",
      month: "月份",
      postCountLabel: "篇数",
      like: "点赞",
      reply: "回复",
      repost: "转发",
      total: "总指数",
      champion: "打开当月代表帖文",
      personaKicker: "PERSONA & CONTENT",
      personaTitle: "人设与内容结构",
      personaFlow: "内容转化路径",
      styleKicker: "CONTENT MIX",
      styleTitle: "内容风格构成",
      postCount: (count) => `${count} 篇`,
      styleDetails: "查看结构与代表帖文",
      mediaKicker: "VISUAL REFERENCES",
      mediaTitle: "公开帖子样本",
      mediaIntro: (count) => `本次抓取到的 ${count} 篇公开帖子均已列出；图片加载受平台时效限制，失效时仍可打开原帖查看。`,
      mediaContent: "图文内容",
      mediaMetrics: "公开数据",
      mediaSource: "原帖链接",
      samplePost: (index, hasImage) => `第 ${String(index + 1).padStart(2, "0")} 篇${hasImage ? " · 含媒体" : " · 文字帖"}`,
      mediaLoading: "正在同步本次抓取到的公开帖子…",
      mediaEmpty: "本次报告未返回公开帖子。",
      previousPage: "上一页",
      nextPage: "下一页",
      pageStatus: (current, total) => `第 ${current} / ${total} 页`,
      bestKicker: "BEST SAMPLE",
      bestTitle: "代表帖文信号",
      views: "浏览",
      interactions: "互动",
      likes: "点赞",
      replies: "回复",
      openPost: "打开原帖",
      historicalKicker: "HISTORICAL REVIEW",
      historicalTitle: "历史内容对照",
      historicalIntro: "按题材比较样本总互动和篇均表现，方便识别应放大与应修正的内容方向。",
      averageEngagementLabel: "篇均互动",
      guidanceKicker: "REUSABLE SIGNALS",
      guidanceTitle: "可复用的方法，不复制原内容",
      sourceNote: "数据来源：公开账号样本与已保存分析报告。平台可见范围、样本时间和互动口径会随报告变化；本页不代表完整账号数据。",
      openProfile: "打开账号主页",
      openOriginal: "查看原始报告",
    },
    "zh-Hant": {
      heroKicker: "VECTO CASE LIBRARY",
      heroTitle: "熱門案例，拆解可複用的成長線索",
      heroCopy: "以真實公開樣本復盤帳號定位、內容結構、互動表現和下一步方向。案例只呈現經核對的數據，不用模板化數字填充。",
      heroNoteTitle: "案例持續收錄",
      heroNoteCopy: "目前案例來自已保存的公開分析報告；新增案例會保持同一套資訊結構與可比較口徑。",
      switcherLabel: "熱門案例",
      switcherPrefix: "案例",
      counter: (current, total) => `${current} / ${total}`,
      reportState: "公開樣本分析",
      analysisTitle: "帳號分析快照",
      accountMeta: (sampledAt) => `Threads · 樣本期 ${sampledAt}`,
      followers: "粉絲",
      recentViews: "近期瀏覽",
      samplePosts: "樣本貼文",
      engagement: "互動指數",
      viewsScope: "公開樣本累計",
      average: (value) => `篇均 ${value}`,
      trafficKicker: "TRAFFIC BASELINE",
      trafficTitle: "帳號流量基準",
      trafficIntro: "瀏覽量以公開可見樣本累加，不把總瀏覽量平均分配到單篇內容。",
      viewsPerFollower: "瀏覽 / 粉絲",
      engagementPerThousand: "每千瀏覽公開互動",
      peakKicker: "PEAK WINDOWS",
      peakTitle: "高效發佈時間",
      peakIntro: "按樣本貼文的互動指數排序，優先用於測試同類型選題。",
      totalEngagement: "總互動指數",
      posts: (count) => `${count} 篇樣本`,
      dailyKicker: "DAILY WAVE",
      dailyTitle: "每日互動波段",
      dailyIntro: "以公開樣本的每日互動指數呈現趨勢；柱線疊加用於辨識異常峰值和可複測時段。",
      activeDays: "有樣本天數",
      dailyAverage: "樣本日均指數",
      peakDay: "最高互動日",
      trendTotal: "樣本總互動指數",
      trendDate: "日期",
      trendValue: "互動指數",
      trendShare: "占樣本比例",
      trendSignal: "數據標記",
      peakSignal: "峰值",
      normalSignal: "常規",
      monthlyKicker: "MONTHLY TABLE",
      monthlyTitle: "月度數據對照",
      monthlyIntro: "按月保留樣本數量、互動構成和代表貼文，方便快速核對成長波段。",
      month: "月份",
      postCountLabel: "篇數",
      like: "按讚",
      reply: "回覆",
      repost: "轉發",
      total: "總指數",
      champion: "開啟當月代表貼文",
      personaKicker: "PERSONA & CONTENT",
      personaTitle: "人設與內容結構",
      personaFlow: "內容轉化路徑",
      styleKicker: "CONTENT MIX",
      styleTitle: "內容風格構成",
      postCount: (count) => `${count} 篇`,
      styleDetails: "查看結構與代表貼文",
      mediaKicker: "VISUAL REFERENCES",
      mediaTitle: "公開貼文樣本",
      mediaIntro: (count) => `本次擷取到的 ${count} 篇公開貼文均已列出；圖片載入受平台時效限制，失效時仍可開啟原帖查看。`,
      mediaContent: "圖文內容",
      mediaMetrics: "公開數據",
      mediaSource: "原帖連結",
      samplePost: (index, hasImage) => `第 ${String(index + 1).padStart(2, "0")} 篇${hasImage ? " · 含媒體" : " · 文字貼文"}`,
      mediaLoading: "正在同步本次擷取到的公開貼文…",
      mediaEmpty: "本次報告未回傳公開貼文。",
      previousPage: "上一頁",
      nextPage: "下一頁",
      pageStatus: (current, total) => `第 ${current} / ${total} 頁`,
      bestKicker: "BEST SAMPLE",
      bestTitle: "代表貼文訊號",
      views: "瀏覽",
      interactions: "互動",
      likes: "按讚",
      replies: "回覆",
      openPost: "開啟原帖",
      historicalKicker: "HISTORICAL REVIEW",
      historicalTitle: "歷史內容對照",
      historicalIntro: "按題材比較樣本總互動和篇均表現，方便辨識應放大與應修正的內容方向。",
      averageEngagementLabel: "篇均互動",
      guidanceKicker: "REUSABLE SIGNALS",
      guidanceTitle: "可複用的方法，不複製原內容",
      sourceNote: "資料來源：公開帳號樣本與已保存分析報告。平台可見範圍、樣本時間和互動口徑會隨報告變化；本頁不代表完整帳號資料。",
      openProfile: "開啟帳號主頁",
      openOriginal: "查看原始報告",
    },
  };

  let selectedCaseId = sourceCases[0]?.id || "";
  const mediaPostsPerPage = 5;
  const mediaPostPages = new Map();
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const format = (value) => new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 1 }).format(Number(value || 0));
  const language = () => window.VectoSiteNavigation?.currentLanguage?.() === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  const labels = () => copy[language()];
  const selectedCase = () => sourceCases.find((item) => item.id === selectedCaseId) || sourceCases[0];
  const threadsIcon = () => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 9.1c.4-2.2 1.9-3.3 3.8-3.3 2.4 0 4 1.6 4 4.3 0 3.3-2.1 5.3-5.6 5.3-3.1 0-5.4-1.8-5.4-5.6 0-3.2 1.7-5.2 4.8-5.8M9.4 11.7c.4 1.2 1.4 1.8 2.8 1.8 1.9 0 3.1-1.1 3.1-3.1 0-1.7-.9-2.7-2.4-2.7-1.3 0-2.2.8-2.4 2.1M9.1 9.7h6.5"/></svg>';
  const asNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const asArray = (value) => Array.isArray(value) ? value : [];
  const asDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const dateKey = (value) => {
    const date = asDate(value);
    return date ? date.toISOString().slice(0, 10) : "";
  };
  const sampleRange = (range) => {
    const from = dateKey(range?.from);
    const to = dateKey(range?.to);
    return from && to ? `${from.replace(/-/g, "/")}—${to.replace(/-/g, "/")}` : "—";
  };
  const firstMediaUrl = (post) => {
    const mediaItem = asArray(post?.mediaItems).find((item) => typeof item === "string" || item?.url);
    if (typeof mediaItem === "string") return mediaItem;
    if (mediaItem?.url) return mediaItem.url;
    return asArray(post?.media).find((item) => typeof item === "string") || "";
  };
  const monthRowsFromPosts = (posts) => {
    const byMonth = new Map();
    asArray(posts).forEach((post) => {
      const month = dateKey(post?.publishedAt).slice(0, 7);
      if (!month) return;
      const row = byMonth.get(month) || { month, posts: 0, likes: 0, replies: 0, reposts: 0, total: 0, average: 0, championUrl: "", championScore: -1 };
      const score = asNumber(post?.engagement);
      row.posts += 1;
      row.likes += asNumber(post?.likes);
      row.replies += asNumber(post?.replies);
      row.reposts += asNumber(post?.reposts);
      row.total += score;
      if (score > row.championScore) {
        row.championScore = score;
        row.championUrl = post?.url || "";
      }
      byMonth.set(month, row);
    });
    return [...byMonth.values()].sort((left, right) => left.month.localeCompare(right.month)).map((row) => ({ ...row, average: Math.round(row.total / Math.max(1, row.posts)) }));
  };
  const normalizeReport = (caseItem, payload) => {
    const result = payload?.report?.result || payload?.result || {};
    const report = result?.report || {};
    const posts = asArray(report.posts);
    const daily = asArray(report.daily).map((day) => ({ date: dateKey(day?.date).slice(5) || String(day?.date || "—"), value: asNumber(day?.engagement) }));
    const peakHours = asArray(report.peakHours).map((hour) => {
      const matchingPost = posts.find((post) => asDate(post?.publishedAt)?.getUTCHours() === asNumber(hour?.hour));
      return {
      label: `${String(hour?.hour ?? "—").padStart(2, "0")}:00–${String((asNumber(hour?.hour) + 1) % 24).padStart(2, "0")}:00`,
      value: asNumber(hour?.averageEngagement),
      total: asNumber(hour?.engagement),
      posts: asNumber(hour?.posts),
      detail: `${asNumber(hour?.posts)} 篇公开样本，累计 ${asNumber(hour?.engagement)} 互动指数。`,
      postUrl: matchingPost?.url || "",
      };
    });
    const bestPost = report.bestPost || {};
    const mediaPosts = posts.map((post) => ({
      url: post?.url || "",
      image: firstMediaUrl(post),
      caption: String(post?.text || ""),
      date: dateKey(post?.publishedAt) || String(post?.publishedAt || "—"),
      views: asNumber(post?.views),
      interactions: asNumber(post?.engagement),
    }));
    return {
      ...caseItem,
      platform: String(result?.platform || caseItem.platform || "Threads").replace(/^./, (value) => value.toUpperCase()),
      username: String(result?.username || caseItem.username),
      sourceUrl: result?.profileUrl || caseItem.sourceUrl,
      sampledAt: sampleRange(report?.range),
      followers: asNumber(result?.followerCount),
      recentViews: asNumber(result?.recentViewCount),
      samplePosts: asNumber(report?.sampleSize || report?.totals?.posts || posts.length),
      engagement: asNumber(report?.totals?.engagement),
      averageEngagement: asNumber(report?.totals?.averageEngagement),
      viewsPerFollower: asNumber(report?.traffic?.viewsPerFollower),
      engagementPerThousandViews: asNumber(report?.traffic?.publicEngagementPerThousandViews),
      persona: result?.targetPersona || report?.persona || caseItem.persona,
      styles: asArray(report?.contentStyle).length ? report.contentStyle : caseItem.styles,
      daily: daily.length ? daily : caseItem.daily,
      peakHours: peakHours.length ? peakHours : caseItem.peakHours,
      monthly: monthRowsFromPosts(posts),
      bestPost: {
        text: bestPost?.text || caseItem.bestPost.text,
        views: asNumber(bestPost?.views),
        engagement: asNumber(bestPost?.engagement),
        likes: asNumber(bestPost?.likes),
        replies: asNumber(bestPost?.replies),
        url: bestPost?.url || caseItem.bestPost.url,
      },
      mediaPosts,
      reportLoading: false,
    };
  };
  async function loadCaseReport(caseItem, index) {
    const urls = asArray(caseItem.reportApiUrls);
    for (const url of urls) {
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "omit" });
        if (!response.ok) continue;
        sourceCases[index] = normalizeReport(caseItem, await response.json());
        if (selectedCaseId === caseItem.id) render();
        return;
      } catch (_) { /* Try the next persisted case-report snapshot. */ }
    }
    sourceCases[index] = { ...caseItem, reportLoading: false };
    if (selectedCaseId === caseItem.id) render();
  }
  function loadCaseReports() {
    sourceCases.forEach((caseItem, index) => void loadCaseReport(caseItem, index));
  }
  function render() {
    const item = selectedCase();
    if (!item) return;
    const t = labels();
    const maxHour = Math.max(1, ...item.peakHours.map((hour) => hour.value));
    const maxDaily = Math.max(1, ...item.daily.map((day) => day.value));
    const totalDaily = item.daily.reduce((sum, day) => sum + Number(day.value || 0), 0);
    const activeDaily = item.daily.filter((day) => Number(day.value || 0) > 0);
    const averageDaily = Math.round(totalDaily / Math.max(1, activeDaily.length));
    const peakDaily = activeDaily.reduce((top, day) => Number(day.value || 0) > Number(top?.value || 0) ? day : top, activeDaily[0] || item.daily[0]);
    const chartX = (index) => 54 + index * (820 / Math.max(1, item.daily.length - 1));
    const chartY = (value) => 226 - Number(value || 0) / maxDaily * 174;
    const chartPoints = item.daily.map((day, index) => `${chartX(index).toFixed(1)},${chartY(day.value).toFixed(1)}`).join(" ");
    const strongestStyle = [...item.styleMix].sort((left, right) => right.average - left.average)[0];
    const mostUsedStyle = [...item.styleMix].sort((left, right) => right.posts - left.posts)[0];
    const weakestStyle = [...item.styleMix].sort((left, right) => left.average - right.average)[0];
    const currentIndex = Math.max(0, sourceCases.findIndex((entry) => entry.id === item.id));
    const totalMediaPages = Math.max(1, Math.ceil(item.mediaPosts.length / mediaPostsPerPage));
    const currentMediaPage = Math.min(totalMediaPages, Math.max(1, Number(mediaPostPages.get(item.id) || 1)));
    const mediaPageOffset = (currentMediaPage - 1) * mediaPostsPerPage;
    const visibleMediaPosts = item.mediaPosts.slice(mediaPageOffset, mediaPageOffset + mediaPostsPerPage);
    root.innerHTML = `
      <div class="case-studies-page">
        <section class="case-studies-hero" aria-labelledby="case-studies-title">
          <div class="case-studies-shell case-studies-hero-grid">
            <div>
              <p class="case-studies-eyebrow">${t.heroKicker}</p>
              <h1 id="case-studies-title">${t.heroTitle}</h1>
              <p>${t.heroCopy}</p>
            </div>
            <aside class="case-studies-hero-note">
              <strong>${t.heroNoteTitle}</strong>
              <span>${t.heroNoteCopy}</span>
            </aside>
          </div>
        </section>
        <div class="case-study-switcher-band">
          <div class="case-studies-shell case-study-switcher" aria-label="${t.switcherLabel}">
            <span class="case-study-switcher-label">${t.switcherLabel}</span>
            <div class="case-study-pills" role="group" aria-label="${t.switcherLabel}">
              ${sourceCases.map((entry, index) => `<button class="case-study-pill" type="button" data-case-id="${esc(entry.id)}" aria-pressed="${entry.id === item.id}">${t.switcherPrefix} ${String(index + 1).padStart(2, "0")} · @${esc(entry.username)}</button>`).join("")}
            </div>
            <span class="case-study-counter">${t.counter(currentIndex + 1, sourceCases.length)}</span>
          </div>
        </div>
        <div class="case-studies-shell case-study-content">
          <section class="case-account-head" aria-labelledby="case-account-title">
            <div>
              <div class="case-account-title">
                <span class="case-platform-badge">${threadsIcon()} ${esc(item.platform)}</span>
                <h2 id="case-account-title">@${esc(item.username)}</h2>
              </div>
              <p class="case-account-meta">${t.accountMeta(item.sampledAt)}</p>
              <div class="case-account-actions">
                <a href="${esc(item.sourceUrl)}" target="_blank" rel="noreferrer">${t.openProfile} ↗</a>
                <a href="${esc(item.reportUrl)}" target="_blank" rel="noreferrer">${t.openOriginal} ↗</a>
              </div>
            </div>
            <span class="case-state-badge">${t.reportState}</span>
          </section>
          <section class="case-summary-grid" aria-label="${t.analysisTitle}">
            <article><span>${t.followers}</span><strong>${format(item.followers)}</strong><small>${item.platform}</small></article>
            <article><span>${t.recentViews}</span><strong>${format(item.recentViews)}</strong><small>${t.viewsScope}</small></article>
            <article><span>${t.samplePosts}</span><strong>${format(item.samplePosts)}</strong><small>${t.viewsScope}</small></article>
            <article><span>${t.engagement}</span><strong>${format(item.engagement)}</strong><small>${t.average(item.averageEngagement)}</small></article>
          </section>
          <section class="case-report-grid">
            <article class="case-panel">
              <p class="case-section-kicker">${t.personaKicker}</p>
              <h3>${t.personaTitle}</h3>
              <p class="case-persona-copy">${esc(item.persona)}</p>
              <div class="case-tags">${item.styles.map((style) => `<span class="case-tag">${esc(style)}</span>`).join("")}</div>
              <div class="case-flow" aria-label="${t.personaFlow}">${item.flow.map((step, index) => `<div><b>${String(index + 1).padStart(2, "0")}</b><span>${esc(step)}</span></div>`).join("")}</div>
            </article>
            <article class="case-panel">
              <p class="case-section-kicker">${t.trafficKicker}</p>
              <h3>${t.trafficTitle}</h3>
              <p class="case-panel-intro">${t.trafficIntro}</p>
              <div class="case-traffic-kpis">
                <div><span>${t.recentViews}</span><strong>${format(item.recentViews)}</strong></div>
                <div><span>${t.viewsPerFollower}</span><strong>${format(item.viewsPerFollower)}×</strong></div>
                <div><span>${t.engagementPerThousand}</span><strong>${format(item.engagementPerThousandViews)}</strong></div>
              </div>
            </article>
          </section>
          <section class="case-report-grid case-style-panel">
            <article class="case-panel">
              <p class="case-section-kicker">${t.peakKicker}</p>
              <h3>${t.peakTitle}</h3>
              <p class="case-panel-intro">${t.peakIntro}</p>
              <div class="case-hour-list"><div class="case-hour-heading" aria-hidden="true"><span>#</span><span>${t.peakTitle}</span><span>${t.totalEngagement}</span><span>${t.averageEngagementLabel}</span><span></span></div>${item.peakHours.map((hour, index) => `<details class="case-expandable case-hour-row"><summary><span class="case-hour-rank">${index + 1}</span><span class="case-hour-label">${esc(hour.label)}<small>${t.posts(hour.posts)}</small></span><span class="case-hour-track"><i style="width:${Math.max(4, Math.round(hour.value / maxHour * 100))}%"></i></span><span class="case-hour-value"><b>${format(hour.total)}</b><small>${t.average(hour.value)}</small></span><span class="case-expand-mark" aria-hidden="true">⌄</span></summary><div class="case-expand-body"><p>${esc(hour.detail)}</p>${hour.postUrl ? `<a href="${esc(hour.postUrl)}" target="_blank" rel="noreferrer">${t.openPost} ↗</a>` : ""}</div></details>`).join("")}</div>
            </article>
            <article class="case-panel">
              <p class="case-section-kicker">${t.styleKicker}</p>
              <h3>${t.styleTitle}</h3>
              <div class="case-style-summary"><span>${t.interactions}<b>${esc(strongestStyle?.name || "—")}</b><small>${t.average(strongestStyle?.average || 0)}</small></span><span>${t.samplePosts}<b>${esc(mostUsedStyle?.name || "—")}</b><small>${t.postCount(mostUsedStyle?.posts || 0)}</small></span><span>${t.guidanceTitle}<b>${esc(weakestStyle?.name || "—")}</b><small>${t.average(weakestStyle?.average || 0)}</small></span></div>
              <div class="case-style-grid">${item.styleMix.map((style) => `<details class="case-style-card"><summary><strong>${esc(style.name)}</strong><span>${format(style.percent)}%</span><small>${t.postCount(style.posts)} · ${t.average(style.average)} · ${format(style.total)} ${t.total}</small></summary><div class="case-expand-body"><p>${esc(style.detail)}</p><a href="${esc(style.postUrl)}" target="_blank" rel="noreferrer">${t.openPost} ↗</a></div></details>`).join("")}</div>
            </article>
          </section>
          <section class="case-report-grid case-style-panel">
            <article class="case-panel case-daily-panel">
              <p class="case-section-kicker">${t.dailyKicker}</p>
              <h3>${t.dailyTitle}</h3>
              <p class="case-panel-intro">${t.dailyIntro}</p>
              <div class="case-trend-kpis"><span>${t.trendTotal}<b>${format(totalDaily)}</b></span><span>${t.activeDays}<b>${format(activeDaily.length)}</b></span><span>${t.dailyAverage}<b>${format(averageDaily)}</b></span><span>${t.peakDay}<b>${esc(peakDaily?.date || "—")} · ${format(peakDaily?.value || 0)}</b></span></div>
              <div class="case-chart-wrap"><svg class="case-trend-chart" viewBox="0 0 920 310" role="img" aria-label="${t.dailyTitle}"><line x1="54" y1="226" x2="874" y2="226" class="case-chart-axis"/><line x1="54" y1="42" x2="54" y2="226" class="case-chart-axis"/>${[0, .25, .5, .75, 1].map((ratio) => { const y = 226 - ratio * 174; return `<g><line x1="54" y1="${y}" x2="874" y2="${y}" class="case-chart-gridline"/><text x="44" y="${y + 4}" text-anchor="end">${format(Math.round(maxDaily * ratio))}</text></g>`; }).join("")}${item.daily.map((day, index) => { const x = chartX(index); const y = chartY(day.value); return `<g><rect x="${(x - 6).toFixed(1)}" y="${y.toFixed(1)}" width="12" height="${Math.max(1, 226 - y).toFixed(1)}" class="case-chart-bar"><title>${esc(day.date)} · ${format(day.value)}</title></rect><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${day.value === peakDaily?.value ? 4.5 : 3}" class="case-chart-point ${day.value === peakDaily?.value ? "is-peak" : ""}"><title>${esc(day.date)} · ${format(day.value)}</title></circle><text class="case-chart-x-label" x="${x.toFixed(1)}" y="247" text-anchor="end" transform="rotate(-38 ${x.toFixed(1)} 247)">${esc(day.date)}</text></g>`; }).join("")}<polyline points="${chartPoints}" class="case-chart-line"/></svg></div>
              <div class="case-trend-table"><div class="case-trend-table-head"><span>${t.trendDate}</span><span>${t.trendValue}</span><span>${t.trendShare}</span><span>${t.trendSignal}</span></div>${item.daily.map((day) => `<div><span>${esc(day.date)}</span><b>${format(day.value)}</b><span>${Math.round(Number(day.value || 0) / Math.max(1, totalDaily) * 100)}%</span><span class="${day.value === peakDaily?.value ? "is-peak" : ""}">${day.value === peakDaily?.value ? t.peakSignal : t.normalSignal}</span></div>`).join("")}</div>
            </article>
            <article class="case-panel case-month-panel">
              <p class="case-section-kicker">${t.monthlyKicker}</p>
              <h3>${t.monthlyTitle}</h3>
              <p class="case-panel-intro">${t.monthlyIntro}</p>
              <div class="case-table-wrap"><table class="case-data-table"><thead><tr><th>${t.month}</th><th>${t.postCountLabel}</th><th>${t.like}</th><th>${t.reply}</th><th>${t.repost}</th><th>${t.total}</th><th>${t.averageEngagementLabel}</th><th></th></tr></thead><tbody>${item.monthly.map((month) => `<tr><td>${esc(month.month)}</td><td>${format(month.posts)}</td><td>${format(month.likes)}</td><td>${format(month.replies)}</td><td>${format(month.reposts)}</td><td>${format(month.total)}</td><td>${format(month.average)}</td><td><a href="${esc(month.championUrl)}" target="_blank" rel="noreferrer" aria-label="${t.champion} ${esc(month.month)}">↗</a></td></tr>`).join("")}</tbody></table></div>
            </article>
          </section>
          <section class="case-panel case-style-panel">
            <p class="case-section-kicker">${t.mediaKicker}</p>
            <h3>${t.mediaTitle}</h3>
            <p class="case-panel-intro">${item.reportLoading ? t.mediaLoading : t.mediaIntro(item.mediaPosts.length)}</p>
            <div class="case-media-table" role="table" aria-label="${t.mediaTitle}">
              <div class="case-media-table-head" role="row"><span></span><span>${t.mediaContent}</span><span>${t.mediaMetrics}</span><span>${t.mediaSource}</span></div>
              ${visibleMediaPosts.map((post, index) => {
                const hasImage = Boolean(post.image);
                const postIndex = mediaPageOffset + index;
                return `<article class="case-media-row" role="row"><div class="case-media-preview">${hasImage ? `<img src="${esc(post.image)}" alt="${esc(t.samplePost(postIndex, true))}" loading="lazy" onerror="this.closest('.case-media-row').classList.add('case-media-unavailable'); this.remove();">` : `<span class="case-media-text-plate">TEXT</span>`}</div><div class="case-media-copy"><strong>${esc(t.samplePost(postIndex, hasImage))}</strong><small>${esc(post.caption)}</small><em>${esc(post.date)}</em></div><div class="case-media-metrics"><span>${t.views} <b>${format(post.views)}</b></span><span>${t.interactions} <b>${format(post.interactions)}</b></span></div><a class="case-media-link" href="${esc(post.url)}" target="_blank" rel="noreferrer">${t.openPost} ↗</a></article>`;
              }).join("") || `<div class="case-media-empty">${item.reportLoading ? t.mediaLoading : t.mediaEmpty}</div>`}
            </div>
            ${item.mediaPosts.length > mediaPostsPerPage ? `<nav class="case-media-pagination" aria-label="${t.mediaTitle}"><button type="button" data-case-media-page="${currentMediaPage - 1}" ${currentMediaPage === 1 ? "disabled" : ""}>${t.previousPage}</button><span>${t.pageStatus(currentMediaPage, totalMediaPages)}</span><button type="button" data-case-media-page="${currentMediaPage + 1}" ${currentMediaPage === totalMediaPages ? "disabled" : ""}>${t.nextPage}</button></nav>` : ""}
          </section>
          <section class="case-panel case-style-panel">
            <p class="case-section-kicker">${t.bestKicker}</p>
            <h3>${t.bestTitle}</h3>
            <div class="case-top-post"><div class="case-top-post-index">01</div><div><p>${esc(item.bestPost.text)}</p><footer><span>${t.views} ${format(item.bestPost.views)}</span><span>${t.interactions} ${format(item.bestPost.engagement)}</span><span>${t.likes} ${format(item.bestPost.likes)}</span><span>${t.replies} ${format(item.bestPost.replies)}</span><a href="${esc(item.bestPost.url)}" target="_blank" rel="noreferrer">${t.openPost} ↗</a></footer></div></div>
          </section>
          <section class="case-panel case-style-panel">
            <p class="case-section-kicker">${t.historicalKicker}</p>
            <h3>${t.historicalTitle}</h3>
            <p class="case-panel-intro">${t.historicalIntro}</p>
            <div class="case-history-list">${item.historical.map((row, index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><strong>${esc(row.title)}</strong><small>${t.postCount(row.posts)} · ${t.total} ${format(row.total)}</small><b>${format(row.average)}<em>${t.averageEngagementLabel}</em></b><a href="${esc(row.url)}" target="_blank" rel="noreferrer">${t.openPost} ↗</a></article>`).join("")}</div>
          </section>
          <section class="case-guidance" aria-label="${t.guidanceTitle}">${item.guidance.map((guide, index) => `<article><span>0${index + 1}</span><strong>${esc(guide.title)}</strong><p>${esc(guide.text)}</p></article>`).join("")}</section>
          <p class="case-source-note">${t.sourceNote}</p>
        </div>
      </div>`;
    root.querySelectorAll("[data-case-id]").forEach((button) => button.addEventListener("click", () => {
      selectedCaseId = button.dataset.caseId || selectedCaseId;
      render();
      document.querySelector(".case-study-switcher-band")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  window.addEventListener("vecto:language-change", render);
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-case-media-page]");
    if (!button || button.disabled) return;
    mediaPostPages.set(selectedCaseId, Math.max(1, Number(button.dataset.caseMediaPage || 1)));
    render();
    document.querySelector(".case-media-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  render();
  loadCaseReports();
})();
