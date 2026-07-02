// 短劇創作各階段 Prompt 模板
// 從 short-drama 倉庫提取並最佳化

import type { DramaSetup, EpisodeEntry } from "@/types/drama";
import { usesJinjunyaFreeContentStyle } from "@/lib/workflow-personas";

/** 目標市場描述與創作語言指令 */
function getMarketDirective(setup: DramaSetup): string {
  const market = setup.targetMarket || "cn";
  if (market === "jp") {
    return `## 🌏 目標市場：日本
- **創作言語：日本語** —— すべての出力は日本語で記述すること。
- **美學傾向**：物哀（もののあわれ）、幽玄（ゆうげん）、侘び寂び（わびさび）
- **敘事スタイル**：內向的で繊細な感情描寫を重視。キャラクターの內面獨白と微妙な関係変化に注力。餘白を多用し、直敘よりも暗示を優先。テンポは緩やかでも感情密度は高く保つ。
- **文化適応**：キャラクター名・場面設定・社會関係・敬語體系は日本文化に準拠すること。中國語表現の直訳を避ける。`;
  }
  if (market === "west") {
    return `## 🌏 Target Market: Western (US/EU) — Overseas AI Short Drama Production Spec

- **Writing Language: English** — All output must be written in English.

### Topic Selection (IP-driven, blockbuster-oriented)
Preferred genres for the Western market:
1. **Fantasy/Supernatural** — Zombies, witches, werewolves, vampires, gender-swap, beastkin, merfolk, mythological figures (visual spectacle priority)
2. **Alpha-male archetypes** — Mafia boss, professor, CEO, athlete, firefighter (masculine hormone appeal)
3. **Classic adaptations** — Grimm fairy tales, mythology, Western film/TV IP reboots
4. **Period settings** — Western royal court, hit long-drama adaptations
5. **Sci-fi / Post-apocalyptic** — Sci-fi, dystopian, interstellar (strong visual impact)

### Micro-Innovation Design
- Build on a proven core hook, then apply **character-concept inversion** or **setting transplant**.
- Transplant plot beats from hit series into the current drama with local adaptation.

### Story Outline & Episode Structure Rules
- Novel adaptations → target **60 episodes**; original concepts → target **50 episodes** (unless user specifies otherwise).
- The outline MUST distribute content across the classic **4-act structure** (起承轉合) with proper pacing — alternate tension and relief, never rush the entire arc flat.
- Each episode outline must satisfy the macro rhythm while distributing plot beats evenly.

### Localization Iron Rules (MANDATORY)
- ⛔ **NO non-American place names** — replace with fictional city names.
- ⛔ **NO non-American character profiles** — names, backgrounds, appearances, and body types must feel authentically Western/American.
- ⛔ **NO non-American cultural elements** — no Eastern fortune-telling, Eastern traditions, Eastern philosophical framing.
- ⛔ **NO real person names, real place names, real brand names, or real product names** — use fictional or lightly altered versions.
- All character bios MUST include **bilingual names** (Chinese + English).

### Character Requirements
- **Character bio**: background story, full name, age, role positioning (lead / supporting / antagonist), personality, backstory.
- **Character portrait** (if visual capability exists): physical appearance, attire, distinctive features.

### Per-Episode Checklist (Quality Gate)
| Check Item | Requirement | Diagnostic | Script Annotation |
|---|---|---|---|
| **3-Second Hook** | Every episode must have a visual or audio explosive moment (can be anywhere in the episode) | Does the audience stop scrolling immediately? | 🔵 Mark BLUE |
| **Completion Bait** | Ending MUST have a strong cliffhanger / suspense | Will the user enter the next episode? | 🔴 Mark RED |
| **Interaction Rate** | Dialogue / visuals must contain debate-triggering moments (controversial dialogue, actions) | Can it trigger comments, shares, likes? | 🟢 Mark GREEN |
| **Scene Actions** | Each episode ≥ 2 scenes | Are scene-action descriptions rich enough? | — |
| **Dialogue Limits** | Total dialogue per episode ≤ 40s reading time; single line ≤ 12s | One shot = dialogue + action within 10-15s? | — |
| **Conflict** | Every episode MUST have at least one climax / reversal | Is the plot tension sustained? | — |
| **Emotional Expression** | Dialogue must be direct, simple; NO euphemisms or subtext | Is the dialogue punchy? | — |
| **Word Count** | Each episode ≥ 800 words, covering ≥ 2 scenes | — | — |
| **Episode Duration** | Target 60 seconds per episode | If final cut deviates >60s significantly, add/trim content | — |

### Title & Naming
- Each drama must provide **at least 2 English title candidates** upon outline submission.
- Drama titles should be concise and memorable.

### Style & Narrative
- Hollywood high-concept format. Think YA blockbusters — punchy hooks, visceral stakes, propulsive pacing.
- External conflict drives internal change. Favor direct plot propulsion, satisfying twists, and "page-turner" cliffhangers.
- Lean into spectacle and wish-fulfillment.`;
  }
  if (market === "kr") {
    return `## 🌏 목표 시장: 한국
- **창작 언어: 한국어** — 모든 출력은 한국어로 작성할 것.
- **미학 경향**: 한국 드라마(K-Drama) 특유의 섬세한 감정선과 운명적 서사. 캐릭터 간의 밀고 당기는 관계 역학, 비밀과 오해에서 비롯된 갈등, 그리고 극적인 반전(plot twist)을 중시.
- **서사 스타일**: 감정의 밀도를 높이되 전개는 긴박하게 유지. 주인공의 성장과 복수·사랑·운명의 교차를 핵심 축으로 삼는다. "밀당"과 "떡밥 회수"를 구조적으로 설계. 시청자의 감정 이입과 공감을 최우선.
- **문화 적응**: 캐릭터명·장소·사회관계·존대어 체계는 한국 문화에 부합해야 한다. 재벌·신분 격차·가족 갈등 등 한국 드라마 특유의 소재를 적극 활용.`;
  }
  if (market === "sea") {
    return `## 🌏 Target Market: Southeast Asia
- **Writing Language: English** — All output must be written in English (universally accessible across SEA markets).
- **Style**: Melodramatic storytelling with high emotional stakes. Blend family honor, social class conflict, and passionate romance. Think Philippine teleserye or Thai lakorn intensity — every emotion is felt deeply and expressed openly.
- **Narrative approach**: Strong moral undercurrents with clear hero/villain dynamics. Favor rags-to-riches arcs, family loyalty vs. personal desire, and justice prevailing after prolonged suffering. Heavy use of dramatic irony and coincidence as plot devices.
- **Cultural fit**: Reflect Southeast Asian social dynamics — extended family hierarchy, economic disparity, spiritual/superstitious elements. Names and settings should feel authentic to a multi-cultural SEA audience.`;
  }
  return `## 🌏 目標市場：華語（中文）
- **創作語言：中文** —— 全部輸出內容使用中文撰寫。
- 符合華語短劇平台的節奏與審美。`;
}

/** 非中文市場的雙語對話規則（附加到 getMarketDirective 輸出之後） */
function getBilingualDialogueRule(setup: DramaSetup): string {
  const market = setup.targetMarket || "cn";
  if (market === "cn") return "";
  const langMap: Record<string, string> = {
    jp: "日文",
    west: "英文",
    kr: "韓文",
    sea: "英文",
  };
  const lang = langMap[market] || "英文";
  return `

## ⚠️ 語言輸出鐵律（最高優先順序）
- **所有非對話內容**（創作方案、角色檔案、分集目錄、單集細綱、場景描寫、動作描寫、鏡頭指示、旁白等）**必須使用中文撰寫**，無論目標市場是什麼。
- **人物對話內容使用${lang}**，每句對話後緊跟小括號中文翻譯。
- 格式示例：
  角色名：（動作/語氣描寫）What are you staring at?
  （看什麼看？）
- 旁白也遵循此規則：旁白使用${lang}，後附中文翻譯。
- 此規則覆蓋上方市場指令中的語言要求。`;
}

function getFullMarketDirective(setup: DramaSetup): string {
  return getMarketDirective(setup) + getBilingualDialogueRule(setup);
}

type RegionalFlavorPack = {
  label: string;
  platforms: string[];
  scenes: string[];
  slang: string[];
  humanBeats: string[];
  avoid: string[];
};

const REGIONAL_FLAVOR_PACKS: Record<string, RegionalFlavorPack> = {
  cn: {
    label: "中國大陸",
    platforms: ["抖音", "小紅書", "微博", "B站", "微信朋友圈", "本機生活群"],
    scenes: ["早八地鐵", "下班擠電梯", "外賣到了但還在開會", "小區門口取快遞", "奶茶第二杯半價", "週末商場排隊"],
    slang: ["繃不住", "誰懂啊", "有一說一", "我直接", "真的會謝", "狠狠拿捏", "包的", "這誰頂得住", "笑發財了", "懂的都懂"],
    humanBeats: ["一句小吐槽接一個具體動作", "把朋友/同事/家人的一句話寫進去", "用省略號表現猶豫或無語", "先說當下場景，再丟擲真實反應"],
    avoid: ["年度總結腔", "知識付費海報腔", "過度正能量", "把熱梗堆成清單"],
  },
  cn_tw: {
    label: "台灣",
    platforms: ["Threads", "Dcard", "PTT", "IG 限動", "LINE 群組"],
    scenes: ["小七取冰美式", "全家等包裹", "捷運上滑手機", "騎機車等紅燈", "夜市買鹹酥雞", "手搖飲半糖微冰", "尾牙抽獎", "中秋烤肉"],
    slang: ["欸", "齁", "有夠", "真的假的", "笑死", "是在哈囉", "先不要", "我就問", "懂的都懂", "不要鬧", "蛤", "超派"],
    humanBeats: ["像在 Threads 發一段剛發生的小事", "可以寫媽媽/同事/店員的一句短對話", "用台式停頓和自嘲，不要太工整", "讓一句口頭禪像順手講出來"],
    avoid: ["大陸梗", "港式用語", "教科書繁體", "每句都硬塞台味詞"],
  },
  cn_hk: {
    label: "香港",
    platforms: ["Threads", "LIHKG", "IG Story", "WhatsApp group", "YouTube 留言區"],
    scenes: ["港鐵迫到冇位企", "茶餐廳叫凍檸茶", "八達通差少少唔夠錢", "屋苑樓下等外賣", "返工趕巴士", "放工打邊爐", "出糧前望住戶口"],
    slang: ["好chur", "hea", "冇眼睇", "唔係喎", "係咁先", "搞唔掂", "頂唔順", "笑死", "cls", "即刻", "痴線", "攰到傻"],
    humanBeats: ["一句廣東話口頭反應配一個生活細節", "可以中英夾雜但要像香港人自然講", "用短句和反問做港式節奏", "把同事/朋友 WhatsApp 式對話寫進去"],
    avoid: ["台灣語氣詞", "大陸熱梗", "普通話直譯粵語", "過度書面繁體"],
  },
  cn_mo: {
    label: "澳門",
    platforms: ["Threads", "IG Story", "Facebook 群組", "WhatsApp group"],
    scenes: ["輕軌轉車", "官也街買葡撻", "路氹返工", "茶餐廳飲奶茶", "巴士等到懷疑人生", "賭場附近人潮", "街坊店買宵夜"],
    slang: ["唔係掛", "幾好笑", "頂唔順", "冇眼睇", "好攰", "係咁先", "chill 下", "笑死", "得閒飲茶"],
    humanBeats: ["把澳門小城熟人社會的距離感寫出來", "用街坊、茶記、巴士這類具體場景落地", "口語自然貼近廣東話，但不要變成香港地名", "偶爾帶葡式生活細節"],
    avoid: ["香港地名替代澳門", "台灣用語", "大陸熱梗", "硬塞葡語詞"],
  },
  sg: {
    label: "新加坡",
    platforms: ["TikTok", "Instagram Story", "Telegram group", "Reddit Singapore", "WhatsApp group"],
    scenes: ["MRT 早高峰", "hawker centre 排隊買飯", "kopitiam 點 kopi", "HDB 樓下等 Grab", "FairPrice 買菜", "下雨忘記帶傘", "加班後吃 supper"],
    slang: ["lah", "lor", "leh", "wah", "shiok", "bojio", "paiseh", "can or not", "blur like sotong", "steady"],
    humanBeats: ["用 Singlish 的尾音做口氣，不要整段變成方言教學", "把天氣、MRT、hawker 這類日常放進一句抱怨或笑點", "像朋友群聊天一樣短促直接", "可以用家庭群/同事群的對話感"],
    avoid: ["過度美式俚語", "馬來西亞地名亂入", "把 lah/lor 每句都放", "正式公文英語"],
  },
  my: {
    label: "馬來西亞",
    platforms: ["TikTok", "Instagram", "Facebook 群組", "WhatsApp group", "小紅書馬來西亞"],
    scenes: ["mamak 檔喝 teh tarik", "Grab 司機繞路", "Pasar malam 買宵夜", "KL 塞車", "買 nasi lemak", "月底看 e-wallet", "Hari Raya 前後聚餐"],
    slang: ["lah", "lor", "meh", "alamak", "walao eh", "jialat", "syok", "can ah", "bojio", "steady"],
    humanBeats: ["混合中文/英文/Manglish 但保持自然", "把吃飯、塞車、Grab、e-wallet 寫成小情緒", "像朋友邊吃邊吐槽，不要像旅遊介紹", "可以有家人催促或朋友互虧的一句話"],
    avoid: ["新加坡場景替代馬來西亞", "純美式英語", "把多語混成看不懂", "硬講國家介紹"],
  },
  jp: {
    label: "日本",
    platforms: ["X", "LINE", "Instagram ストーリー", "TikTok", "YouTube コメント"],
    scenes: ["コンビニで新作スイーツを見る", "満員電車で片手だけ空いてる", "仕事帰りに駅のホームでぼーっとする", "ドラッグストアで迷う", "推し活のグッズ開封", "雨の日のビニール傘", "深夜にカップ麵"],
    slang: ["それな", "ガチ", "エモい", "草", "尊い", "沼", "無理すぎ", "ワンチャン", "優勝", "しんどい", "秒で", "あるある"],
    humanBeats: ["一文を少し短く切って餘白を作る", "自分ツッコミや小さな獨り言を入れる", "推し・仕事帰り・コンビニなど具體物から感情に入る", "敬語とタメ口は人設に合わせて混ぜすぎない"],
    avoid: ["中國語直訳", "説明文みたいな長文", "古いネットスラングの連発", "句點だらけの文章"],
  },
  kr: {
    label: "한국",
    platforms: ["Instagram Story", "YouTube 댓글", "Naver Cafe", "KakaoTalk", "X"],
    scenes: ["퇴근길 지하철", "편의점 신상 먹어보기", "카페에서 노트북 켜기", "배달앱 보다가 포기", "올리브영 세일", "비 오는 날 우산 두고 옴", "치킨 시키기 전 단톡방"],
    slang: ["대박", "헐", "ㅇㅈ", "ㅋㅋ", "ㅠㅠ", "갓생", "존맛", "꿀잼", "레전드", "현타", "킹받네", "손민수"],
    humanBeats: ["짧은 감탄사로 시작하거나 끝내기", "친구/단톡방 대화처럼 자연스럽게 끊기", "퇴근길·편의점·카페 같은 구체 장면에서 감정을 꺼내기", "존댓말/반말은 인설에 맞춰 일관되게"],
    avoid: ["중국어 직역", "너무 딱딱한 보고서 말투", "유행어 도배", "일본식 표현 섞기"],
  },
  th: {
    label: "泰國",
    platforms: ["TikTok", "Instagram", "LINE group", "Facebook Page", "X"],
    scenes: ["BTS/MRT 等車", "7-Eleven 買冰飲", "夜市吃烤串", "GrabBike 趕路", "Songkran 前後出門", "下雨季堵車", "咖啡店躲熱"],
    slang: ["555", "sabuy sabuy", "jing jing", "mai pen rai", "narak", "mood mak", "ปัง", "โอ้โห"],
    humanBeats: ["用輕鬆、帶笑的語氣寫日常小麻煩", "把天氣熱、塞車、便利店、夜市寫進反應裡", "可以有 LINE 群或朋友一句短回覆", "泰文詞少量點綴即可"],
    avoid: ["把泰國寫成泛東南亞", "過度美式 slang", "宗教/王室敏感玩笑", "泰文詞堆砌"],
  },
  in: {
    label: "印度",
    platforms: ["Instagram Reels", "WhatsApp group", "YouTube Shorts", "X", "Reddit India"],
    scenes: ["chai break", "metro 通勤", "auto 司機砍價", "Swiggy/Zomato 點餐", "family WhatsApp group", "cricket match day", "monsoon traffic"],
    slang: ["yaar", "arre", "bhai", "jugaad", "full paisa vasool", "scene kya hai", "too good", "lowkey", "bro", "sorted"],
    humanBeats: ["把家庭群、通勤、外賣、板球這些日常當情緒入口", "可以自然混 Hindi-English，但不要影響可讀性", "像朋友發 Reels caption，不要像文化介紹", "用一句自嘲讓語氣落地"],
    avoid: ["把印度寫成單一刻板印象", "宗教/族群敏感玩笑", "過度美式", "長篇說教"],
  },
  us: {
    label: "美國",
    platforms: ["TikTok", "Instagram", "X", "Reddit", "group chat"],
    scenes: ["drive-thru coffee run", "Target run", "Trader Joe's checkout", "rent due reminder", "office Slack ping", "Sunday grocery trip", "doomscrolling before bed", "Costco sample line"],
    slang: ["lowkey", "no cap", "it's giving", "rent free", "main character energy", "not me", "be so for real", "delulu", "girl math", "I can't", "the way I"],
    humanBeats: ["Start from a tiny inconvenience, then make the emotional turn", "Use contractions and group-chat rhythm", "Let the punchline feel slightly messy, not polished", "A one-line friend reply can make it feel lived-in"],
    avoid: ["LinkedIn thought-leader voice", "translated Chinese idioms", "corporate wellness slogans", "slang overload"],
  },
  uk: {
    label: "英國",
    platforms: ["TikTok", "Instagram", "X", "WhatsApp group", "Reddit UK"],
    scenes: ["Tesco meal deal", "Tube delays", "pub after work", "rain before leaving the house", "queueing for coffee", "council tax reminder", "train strikes"],
    slang: ["mate", "proper", "bit grim", "can't be arsed", "peak", "cheeky", "sorted", "innit", "that's mad", "fuming"],
    humanBeats: ["Use dry humour and understatement", "Make the scene feel like a WhatsApp rant", "Anchor jokes in weather, commuting, pub, queues", "Keep slang age-appropriate"],
    avoid: ["American slang as default", "royal/tea stereotypes every time", "overly formal BBC tone", "forced innit"],
  },
  au: {
    label: "澳洲",
    platforms: ["TikTok", "Instagram", "Facebook group", "WhatsApp group", "Reddit Australia"],
    scenes: ["servo coffee", "Coles/Woolies checkout", "train running late", "beach after work", "Bunnings snag", "rent inspection", "hot day with no parking"],
    slang: ["mate", "arvo", "reckon", "heaps", "no worries", "keen", "bogan", "suss", "fair dinkum", "too easy"],
    humanBeats: ["Casual understatement with one concrete local object", "Use workday/weather/rent as relatable friction", "Make it sound like a text to a mate", "A short self-roast works well"],
    avoid: ["US default slang", "tourism-brochure Australia", "overusing mate", "formal essay tone"],
  },
  ca: {
    label: "加拿大",
    platforms: ["TikTok", "Instagram", "X", "Reddit Canada", "group chat"],
    scenes: ["Tim Hortons run", "snow slush commute", "TTC/SkyTrain delay", "grocery sticker shock", "rent viewing", "Costco trip", "long weekend plans"],
    slang: ["eh", "loonie", "toonie", "double-double", "brutal", "for real", "lowkey", "I can't", "buddy", "sorry but"],
    humanBeats: ["Pair politeness with a small complaint", "Use weather, groceries, rent, transit as lived-in anchors", "Group-chat English over polished essay English", "Let humour come from understatement"],
    avoid: ["US-only references as default", "maple-syrup clichés", "too much eh", "corporate caption voice"],
  },
  ph: {
    label: "菲律賓",
    platforms: ["TikTok", "Facebook", "Instagram", "Messenger group chat", "X"],
    scenes: ["jeepney/Grab commute", "Jollibee craving", "sari-sari store run", "family group chat", "payday mall trip", "rainy season traffic", "videoke night"],
    slang: ["grabe", "charot", "lodi", "kilig", "petmalu", "sana all", "nakakaloka", "bes", "huy", "angas"],
    humanBeats: ["Warm, expressive, family/group-chat energy", "Use one Taglish phrase naturally", "Put traffic, food, payday, family chat into a quick reaction", "A playful punchline should feel friendly"],
    avoid: ["Pure American slang", "flattening Filipino culture into generic SEA", "too many Tagalog words at once", "formal essay tone"],
  },
  id: {
    label: "印尼",
    platforms: ["TikTok", "Instagram", "WhatsApp group", "X", "YouTube Shorts"],
    scenes: ["ojol ride", "warung lunch", "Indomaret/Alfamart stop", "macet after work", "kopi susu order", "Ramadan buka puasa", "family WhatsApp chat"],
    slang: ["wkwk", "gue/aku", "banget", "anjir", "mantap", "ngab", "auto", "mager", "gabut", "bestie"],
    humanBeats: ["Use Bahasa/English mix sparingly and naturally", "Anchor in food, traffic, ojol, family chat", "Short emotional reactions beat long explanations", "A tiny self-roast makes it human"],
    avoid: ["Generic SEA without Indonesian details", "too much profanity", "US slang overload", "tourist-guide tone"],
  },
  vn: {
    label: "越南",
    platforms: ["TikTok", "Facebook", "Zalo group", "Instagram", "YouTube Shorts"],
    scenes: ["xe ôm/GrabBike 通勤", "cà phê sữa đá", "路邊攤吃 phở/bánh mì", "family Zalo group", "雨季堵車", "下班買水果", "Tết 前後聚會"],
    slang: ["trời ơi", "xịn", "đỉnh", "hết cứu", "lụm", "chill", "khum", "haha", "quê xỉu"],
    humanBeats: ["用食物、機車、Zalo 家庭群、雨季作生活錨點", "越南語詞只少量點綴", "像朋友發短狀態，不像城市介紹", "可以用一句家庭群式吐槽"],
    avoid: ["把越南寫成泛東南亞", "過度美式", "越南語堆砌", "觀光宣傳腔"],
  },
  west: {
    label: "歐美英語區",
    platforms: ["TikTok", "Instagram", "X", "Reddit", "group chat"],
    scenes: ["coffee run", "commute delay", "rent reminder", "grocery checkout", "work Slack ping", "late-night scrolling", "weekend errands"],
    slang: ["lowkey", "no cap", "it's giving", "rent free", "not me", "be so for real", "main character energy", "I can't"],
    humanBeats: ["Use contractions, fragments, and tiny everyday stakes", "Write like a group-chat caption", "Let jokes come from a real inconvenience", "Keep slang calibrated to persona age"],
    avoid: ["corporate influencer voice", "translated Chinese rhythm", "slang stuffing", "perfect essay structure"],
  },
  sea: {
    label: "東南亞英語區",
    platforms: ["TikTok", "Instagram", "Facebook groups", "WhatsApp/LINE group", "YouTube Shorts"],
    scenes: ["Grab ride", "night market food", "7-Eleven stop", "rainy commute", "family group chat", "payday dinner", "festival planning"],
    slang: ["lah", "lor", "wah", "shiok", "bojio", "can ah", "alamak", "steady"],
    humanBeats: ["Warm, community-first, chatty rhythm", "Use food, weather, commute, family chat as anchors", "Add only one or two local particles", "Keep humour friendly and lived-in"],
    avoid: ["overly American slang", "generic travel-guide SEA", "particle spam", "formal business English"],
  },
};

export function resolvePromptLocaleKey(setup: DramaSetup, characters = ""): string {
  const market = setup.targetMarket || "cn";
  if (market === "cn" && setup.chineseScript === "traditional") {
    const regionHint = (setup as any)._regionHint as string | undefined;
    if (regionHint === "hk") return "cn_hk";
    if (regionHint === "mo") return "cn_mo";
    if (regionHint === "tw") return "cn_tw";

    const combinedText = [characters, setup.personaDescription || "", setup.contentTheme || "", setup.personaNationality || ""].join(" ");
    if (/港幣|港元|HK\$|香港|港鐵|MPF|強積金|廣東話|粵語/.test(combinedText)) return "cn_hk";
    if (/澳幣|澳門元|MOP\$|澳門|路氹|葡撻/.test(combinedText)) return "cn_mo";
    return "cn_tw";
  }
  if (market === "cn") return "cn";
  return market;
}

export function inferRegionalFlavorKey(setup: DramaSetup, localeKey: string): string {
  const regionHint = (setup as any)._regionHint as string | undefined;
  if (regionHint === "tw") return "cn_tw";
  if (regionHint === "hk") return "cn_hk";
  if (regionHint === "mo") return "cn_mo";

  const text = `${setup.personaNationality || ""} ${setup.personaDescription || ""} ${setup.contentTheme || ""}`.toLowerCase();
  const aliases: Array<[string, RegExp]> = [
    ["cn_tw", /台灣|台灣|taiwan|\btw\b/],
    ["cn_hk", /香港|hong\s*kong|\bhk\b/],
    ["cn_mo", /澳門|澳門|macau|macao|\bmo\b/],
    ["cn", /中國大陸|中國大陸|大陸|mainland|china/],
    ["sg", /新加坡|singapore|\bsg\b/],
    ["my", /馬來西亞|馬來西亞|malaysia|\bmy\b/],
    ["jp", /日本|japan|\bjp\b/],
    ["kr", /韓國|韓國|korea|\bkr\b/],
    ["th", /泰國|泰國|thailand|thai/],
    ["in", /印度|india|indian/],
    ["us", /美國|美國|united states|usa|u\.s\.|\bus\b/],
    ["uk", /英國|英國|united kingdom|britain|\buk\b/],
    ["au", /澳洲|澳大利亞|澳大利亞|australia|\bau\b/],
    ["ca", /加拿大|canada|\bca\b/],
    ["ph", /菲律賓|菲律賓|philippines|filipino|\bph\b/],
    ["id", /印尼|印度尼西亞|印度尼西亞|indonesia|\bid\b/],
    ["vn", /越南|vietnam|\bvn\b/],
  ];

  const matched = aliases.find(([, pattern]) => pattern.test(text));
  if (matched) return matched[0];
  if (REGIONAL_FLAVOR_PACKS[localeKey]) return localeKey;
  if (setup.targetMarket === "west") return "west";
  if (setup.targetMarket === "sea") return "sea";
  if (setup.targetMarket === "jp") return "jp";
  if (setup.targetMarket === "kr") return "kr";
  return "cn";
}

function buildRegionalFlavorDirective(
  setup: DramaSetup,
  localeKey: string,
  mode: "profile" | "post",
): string {
  const flavorKey = inferRegionalFlavorKey(setup, localeKey);
  const pack = REGIONAL_FLAVOR_PACKS[flavorKey] || REGIONAL_FLAVOR_PACKS[localeKey] || REGIONAL_FLAVOR_PACKS.cn;
  const selectedRegion = setup.personaNationality || pack.label;
  const usageRule = mode === "profile"
    ? "生成的人設檔案必須沉澱為可複用的地區素材庫，不要只寫一句“符合當地習慣”"
    : "每篇至少自然使用 1 個當地生活細節；可再選 1 個口頭禪/網路梗，但不要為了炫技硬塞";

  return `## 地區煙火氣素材庫（${pack.label}）
- 目前選擇地區：${selectedRegion}
- 常見平台/語境：${pack.platforms.join("、")}
- 生活場景素材池：${pack.scenes.join("、")}
- 本機口頭禪/網路梗素材池：${pack.slang.join("、")}
- 真人節奏參考：${pack.humanBeats.join("；")}
- 避免寫法：${pack.avoid.join("、")}
- 使用規則：${usageRule}
- 重要：素材池是“可選食材”，不是清單。每條只挑最貼目前內容的 1-2 個點，寫得像本人順手說出來`;
}

function buildHumanVoiceDirective(isSimpleStyle: boolean): string {
  if (isSimpleStyle) return "";
  return `## 真人口吻硬約束（去 AI 腔，必須執行）
- 每條內容都要有一個具體生活動作/物件/地點，再接一個當下反應；不要只寫觀點和結論
- 可以寫碎句、停頓、括號裡的小吐槽、朋友/家人/同事的一句短對話，讓節奏像真實發文
- 如果出現對話，使用“我媽：…… / 我：……”或聊天群式短句，不要寫成採訪稿、客服話術或短劇台詞
- 允許一點不完美：小猶豫、小抱怨、小自嘲、突然想起來的補充，都比工整排比更像真人
- 禁止 AI 腔：作為一個、總而言之、在這個時代、不得不說、值得我們思考、提升幸福感、治癒自己、讓生活更美好、每個人都應該、真正的意義、情緒價值拉滿
- 禁止每條都用同一種開頭、同一種結尾、同一種互動提問；不要把俚語/熱梗堆成展示櫃`;
}

function buildPersonaToneDirective(setup: DramaSetup, mode: "profile" | "post"): string {
  const personaTypes = setup.genres?.join(" + ") || setup.personaName || "目前人設";
  const professionalRule = mode === "profile"
    ? "若帳號屬於財經、職場、健康、美容、教育、心理、學習、營養、攝影、育兒等經驗/專業型人設，檔案裡必須寫清“專業表達邊界”：怎麼把建議講得像真人，但不犧牲可信度"
    : "若帳號屬於財經、職場、健康、美容、教育、心理、學習、營養、攝影、育兒等經驗/專業型人設，每篇至少給出一個具體判斷依據、經驗邊界、操作步驟或注意事項";

  return `## 人設腔調與專業度平衡（必須執行）
- 目前人設：${personaTypes}
- 每條內容都必須優先貼合這個人設的身份、性格、表達習慣和過往檔案；同一地區的人設也不能寫成同一種口吻
- 貼近生活是表達方式，不是降低可信度；可以口語、可以有梗，但不能為了像真人而變得低俗、油滑、空洞或地域刻板
- 俚語/熱梗只負責語氣和親近感，不能替代資訊量；讀者看完仍要知道“為什麼/怎麼做/要注意什麼”
- ${professionalRule}
- 情緒型/生活型人設也要保留觀察力：用具體細節、真實關係和小判斷支撐情緒，不要只喊口號`;
}

/** 創作方案 Prompt */
export function buildCreativePlanPrompt(setup: DramaSetup): string {
  const genreStr = setup.genres.length > 0 ? setup.genres.join(" + ") : "待定";
  return `你是一位專業的微短劇編劇，精通短影片平台的爆款短劇創作方法論。

${getFullMarketDirective(setup)}

## 目前專案設定
- 題材組合：${genreStr}
- 人設性格：${setup.personaPersonality || ""}
- 人設性別：${setup.personaGender || "不限"}
- 表述習慣：${setup.personaStyle || ""}
- 篇幅字數：${setup.totalEpisodes}字
${setup.customTopic ? `- 補充描述：${setup.customTopic}` : ""}

## 參考知識：節奏曲線
微短劇節奏公式：緊張蓄力 → 爽點釋放 → 短暫喘息 → 新一輪蓄力
四段式結構：
- 起勢段（前15%集數）：建立世界觀和人物關係，製造第一個爽點
- 攀升段（15-45%）：衝突升級，多條線並行推進
- 風暴段（45-80%）：高潮迭起，反轉頻出
- 決戰段（最後20%）：終極對決，結局收束

## 參考知識：付費卡點設計
三大設計原則：情緒峰值原則、懸念未解原則、沉沒成本原則
黃金卡點位置：
- 首個卡點：第8-12集（最強懸念）
- 第二卡點：第18-25集（身份揭露/反轉）
- 第三卡點：第35-45集（感情線高潮）
- 終極卡點：倒數3-5集（終極對決前）
付費卡點總佔比 10-15%

## 參考知識：爽點矩陣
5大爽點型別：身份碾壓、逆襲打臉、甜寵撒糖、虐心催淚、懸疑反轉
爽點本質：壓抑 → 釋放。壓抑越深，釋放越爽。

## 你的任務
請生成完整的創作方案，包含以下 8 個板塊：

1. **劇名備選**（3個），每個附一句話說明
2. **時空背景**：時代、地點、社會環境、階層關係
3. **一句話故事線** + **核心衝突**
4. **三幕結構拆解**：
   - 第一幕（建置）：集數範圍、核心事件、人物關係建立
   - 第二幕（對抗）：集數範圍、衝突升級、轉折點
   - 第三幕（高潮/結局）：集數範圍、終極對決、結局處理
5. **全劇節奏波形描述**：標註高潮點、低谷點位置
6. **付費卡點規劃**：具體集數 + 卡點型別 + 懸念設計
7. **爽感矩陣**：規劃全劇各類爽點分佈和配比
8. **結局設計**：主線結局 + 感情線結局 + 伏筆回收

用 Markdown 格式輸出，清晰分割槽。`;
}

/** 角色開發 / 人設開發 Prompt */
export function buildCharactersPrompt(setup: DramaSetup, creativePlan: string): string {
  const profileLocaleKey = resolvePromptLocaleKey(setup);
  const regionalFlavorDirective = buildRegionalFlavorDirective(setup, profileLocaleKey, "profile");
  const personaToneDirective = buildPersonaToneDirective(setup, "profile");

  // Social media persona mode
  if (setup.personaName) {
    return `你是一位專業的社媒內容策劃師。

## 人設基礎資訊
- 名稱：${setup.personaName}
- 簡介：${setup.personaDescription || ""}
- 性格標籤：${setup.personalityTags || ""}
- 內容主題：${setup.contentTheme || ""}
- 文章版型：${setup.postFormat || ""}

${regionalFlavorDirective}
${personaToneDirective}

## 你的任務
請深化以上人設，生成完整的人設檔案，包含：

1. **人設核心定位**：一句話概括這個帳號的核心價值主張
2. **語言風格指南**：
   - 常用句式和語氣詞
   - 標誌性表達方式
   - 禁用詞彙（不符合人設的表達）
   - 本機口頭禪/網路梗：必須來自上方地區素材庫，寫出 8-12 個適合該人設順手使用的表達，並說明適用場景
   - 去 AI 腔規則：列出該人設絕對不會說的空泛句式
3. **內容方向細化**：
   - 5-8個具體的內容方向/話題
   - 每個方向的典型場景舉例
   - 每個方向至少綁定一個當地生活場景或平台語境
4. **互動策略**：
   - 迴文風格（符合人設的回覆方式）
   - 引導關注的話術
5. **人設禁區**：哪些內容/行為會破壞人設

用 Markdown 格式輸出，簡潔實用。`;
  }

  // Persona type mode (selected from GENRES list)
  const personaTypes = setup.genres.join(" + ");
  if (personaTypes) {
    const marketLabel = {
      cn: "華語受眾", jp: "日本受眾", west: "歐美受眾", kr: "韓國受眾", sea: "東南亞受眾"
    }[setup.targetMarket] || setup.targetMarket;

    return `你是一位專業的社媒內容策劃師。

## 帳號人設型別
${personaTypes}

## 目標群體
${marketLabel}

## 創作設定
- 人設性格：${setup.personaPersonality || ""}
- 人設性別：${setup.personaGender || "不限"}
- 人設國籍/地區：${setup.personaNationality || "未指定"}
- 表述習慣：${setup.personaStyle || ""}
${setup.customTopic ? `- 補充要求：${setup.customTopic}` : ""}

${regionalFlavorDirective}
${personaToneDirective}

## 你的任務
請為「${personaTypes}」型別的社交媒體帳號生成完整的人設檔案，包含：

1. **人設核心定位**：帳號的核心價值主張和差異化定位
2. **典型人物畫像**：年齡、背景、生活狀態、性格特點（需符合「${setup.personaPersonality || ""}」性格和「${setup.personaGender || "不限"}」性別設定）
3. **語言風格指南**：
   - 常用句式、語氣詞、口頭禪（需體現「${setup.personaStyle || ""}」的表述習慣）
   - 標誌性表達方式（貼近生活、有辨識度）
   - 若已指定人設國籍/地區，則貨幣、地名、制度、節日、平台、口語都必須符合當地習慣；即使參考內容出現其他地區元素，也只能改寫吸收，不能原樣照搬
   - 本機口頭禪/網路梗：從上方地區素材庫中挑出 8-12 個適合該人設的表達，說明適合在什麼情緒/場景下使用
   - 禁用 AI 腔：列出該人設不會說的空泛句式和過度總結表達
4. **內容方向**：8-10個具體話題方向，每個附帶1個示例標題
   - 每個話題方向都要綁定一個當地生活場景、平台語境或熟人關係細節
5. **爆款內容公式**：適合該人設的高互動內容結構
6. **互動話術**：評論區回覆風格和引導關注的方式

用 Markdown 格式輸出，簡潔實用。`;
  }

  // Original drama mode fallback
  const genreStr = setup.genres.join(" + ");
  return `你是一位專業的微短劇編劇。

${getFullMarketDirective(setup)}

## 目前專案
- 題材：${genreStr}
- 受眾：${setup.personaGender || setup.audience || ""}
- 基調：${setup.personaStyle || setup.tone || ""}
- 總集數：${setup.totalEpisodes}集

## 已有創作方案
${creativePlan}

## 參考知識：四層反派體系
反派設計三原則：可恨原則、可信原則、遞進原則
- 第一層·小反派（前15%集數）：身份不高的小人物，囂張但無實力，被打臉後迅速退場
- 第二層·中反派（前2/3集數）：有一定權勢的對手，能給主角造成真正威脅
- 第三層·大反派（中後期）：終極Boss，實力和資源遠超主角
- 第四層·隱藏反派（後1/3揭露）：身邊最信任的人，反轉衝擊力最大

## 你的任務
生成完整角色體系，包含：

1. **主要角色檔案**（每個角色包含）：
   - 姓名、年齡、外貌特徵（2-3句）
   - 性格關鍵詞（3-5個）
   - 公開身份 vs 真實身份
   - 核心動機
   - 爽點功能（承擔什麼爽點）
   - 口頭禪或語言特徵
   - 人物弧光（從開始到結局的變化軌跡）

2. **角色關係圖**（使用 Mermaid graph TD 格式輸出，用中文標註關係型別）

請在 \`\`\`mermaid 和 \`\`\` 之間輸出關係圖程式碼，示例：
\`\`\`mermaid
graph TD
    A[蘇念·女主] -->|暗戀| B[陸景琛·男主]
    B -->|保護| A
    C[趙婉兒·反派] -->|嫉妒| A
    D[陸母] -->|反對| A
\`\`\`

3. **感情線弧線**：男女主關係發展的關鍵節點（標註集數）

4. **四層反派體系**：
   - 每層反派的身份、動機、行為模式、擊敗/揭露過程

5. **關鍵互動場景預設**：
   - 第一次衝突場景
   - 身份揭露場景
   - 感情轉折場景
   - 終極對決場景

用 Markdown 格式輸出。`;
}

/** 分集目錄 Prompt */
export function buildDirectoryPrompt(setup: DramaSetup, creativePlan: string, characters: string): string {
  return `你是一位專業的微短劇編劇。

${getFullMarketDirective(setup)}

## 已有創作方案
${creativePlan}

## 已有角色檔案
${characters}

## 參考知識：鉤子設計
5種鉤子型別：
- 懸念鉤（20-30%）：丟擲關鍵疑問，答案留到下集
- 反轉鉤（5-15%）：在觀眾以為知道答案時，突然推翻
- 情緒鉤（30-40%）：把情緒推到頂點然後截斷
- 資訊鉤（10-20%）：釋放一個關鍵資訊，但只給一半
- 危機鉤（10-20%）：主角陷入即時危險

## 參考知識：節奏曲線
四段式結構（${setup.totalEpisodes}集）：
- 起勢段（約前${Math.round(setup.totalEpisodes * 0.15)}集）
- 攀升段（約${Math.round(setup.totalEpisodes * 0.15) + 1}-${Math.round(setup.totalEpisodes * 0.45)}集）
- 風暴段（約${Math.round(setup.totalEpisodes * 0.45) + 1}-${Math.round(setup.totalEpisodes * 0.8)}集）
- 決戰段（約${Math.round(setup.totalEpisodes * 0.8) + 1}-${setup.totalEpisodes}集）

## 你的任務
生成完整的 ${setup.totalEpisodes} 集分集目錄。

每集一行，格式：
第{N}集：{集標題} —— {核心衝突或爽點一句話描述} [鉤子型別] [情緒:X] {標記}

標記說明：
- 🔥 關鍵劇情集（重大轉折、揭秘），佔比 25-35%
- ⚡ 高潮卡點集（情緒最高峰、終極對決、命運轉折等全劇最震撼的高潮時刻），佔比 10-15%
- 💰 付費卡點集（付費牆位置，懸念最強、觀眾最不願意離開的時刻），佔比 10-15%
- 一集可以同時標多個標記（如 🔥⚡💰）
- 無標記 = 常規推進集
- [情緒:X]：標註該集的情緒強度（1-5），1=平穩鋪墊，2=小波瀾，3=中等緊張，4=高潮激烈，5=極致爆發

要求：
- 必須覆蓋全部 ${setup.totalEpisodes} 集
- 前 10 集必須包含至少 3 個 🔥
- 💰 付費卡點建議分佈在以下位置：
  · 第8-12集（首個付費卡點，最強懸念）
  · 第18-25集（身份揭露/反轉）
  · 第35-45集（感情線高潮）
  · 倒數3-5集（終極對決前）
- ⚡ 高潮卡點集中在全劇 10-15%，鎖定在敘事高峰期
- 目錄必須體現三幕結構的節奏變化
- 每集標註鉤子型別（懸念鉤/反轉鉤/情緒鉤/資訊鉤/危機鉤）
- 每集標註情緒強度[情緒:1-5]
- 按段落分組顯示（起勢段/攀升段/風暴段/決戰段）

**嚴格格式要求**：每一行必須嚴格按照以下格式輸出，不要偏離：
第{N}集：{集標題} —— {描述} [{鉤子型別}鉤] [情緒:{1-5}] {標記}
例如：第1集：命運序章 —— 女主初入公司遭受冷遇 [懸念鉤] [情緒:2] 🔥
不要使用其他分隔符（如"-"或"："代替"——"），不要省略集數編號"第N集："的格式。

  末尾附統計資訊：🔥數量、⚡數量、💰數量、各鉤子型別佔比。`;
}

/** 單集細綱生成 Prompt（批次） */
export function buildOutlinePrompt(
  setup: DramaSetup,
  creativePlan: string,
  characters: string,
  episodes: { number: number; title: string; summary: string; hookType: string }[],
  allDirectoryRaw: string,
): string {
  const epList = episodes
    .map((ep) => `第${ep.number}集：${ep.title} —— ${ep.summary} [${ep.hookType}]`)
    .join("\n");

  const rangeLabel = episodes.length === 1
    ? `第${episodes[0].number}集`
    : `第${episodes[0].number}-${episodes[episodes.length - 1].number}集`;

  return `你是一位專業的微短劇編劇。

${getFullMarketDirective(setup)}

## 已有創作方案
${creativePlan}

## 已有角色檔案
${characters}

## 完整分集目錄（供參考節奏上下文）
${allDirectoryRaw}

## 你的任務
為以下集數生成**單集細綱**（${rangeLabel}，共${episodes.length}集）。

需要生成細綱的集數：
${epList}

## 細綱要求
1. 每集細綱約 300 字左右
2. 需要在滿足大綱節奏的基礎上，合理分配本集的劇情節奏
3. 細綱內容應包含：
   - 本集核心事件與衝突
   - 主要場景轉換（列出 3-5 個關鍵場景）
   - 人物情感走向與變化
   - 本集結尾鉤子的具體設計
   - 與前後集的劇情銜接點
4. 注意整體節奏的連貫性，前後集之間要有因果關係

## 輸出格式
嚴格按以下格式輸出，每集之間用空行分隔：

【第{N}集細綱】{集標題}
{細綱內容，約300字，分段落書寫}

---

【第{N+1}集細綱】{集標題}
{細綱內容}

不要輸出其他多餘內容。`;
}

/** 取得市場對應的劇本格式模板 */
function getScriptFormatTemplate(setup: DramaSetup, episodeNumber: number, hookType: string): string {
  const market = setup.targetMarket || "cn";

  if (market === "jp") {
    return `## 指令碼フォーマット（日本市場向け）

\`\`\`
# 第${episodeNumber}話

# ${episodeNumber}-1 {時間帯} {屋內/屋外} {場所}

出演人物：{人物リスト}

△{情景描寫 — 季節感・空気感を重視}

△{人物の所作・微細な表情変化}

**{キャラクター名}**（{口調/動作指示}）：{台詞}

△{象徴的ディテール — 物哀の瞬間}

♪ 音楽：{和楽器・アンビエント系の雰囲気}

# ${episodeNumber}-2 {時間帯} {屋內/屋外} {場所}

出演人物：{人物リスト}

……以下同形式……

---

> 🎣 引き：{餘韻と暗示}
> 📺 次回予告：{次話の核心}
\`\`\`

## 品質基準
- 各話 3-5 シーン
- 各話 800文字以上
- シーン番號は ${episodeNumber}-1, ${episodeNumber}-2 形式で通し番號
- △で全ての描寫・動作・ト書きを開始
- 台詞は獨立行に記載
- 物哀・餘韻を意識した描寫を各シーンに1箇所以上
- 結末は${hookType || "餘韻"}で締める`;
  }

  if (market === "west") {
    return `## Script Format (Western Market — Overseas AI Short Drama Spec)

\`\`\`
# Episode ${episodeNumber}

# ${episodeNumber}-1 {TIME (DAY/NIGHT/DAWN/DUSK)} {INT./EXT.} {LOCATION}

Characters: {character list}

△{3-SECOND HOOK — visual/audio explosive moment to stop scrolling}
△{Character action — body language, tension}

{CHARACTER NAME}: ({tone/action direction}) {Dialogue}

△{Key detail — plot-critical visual}

# ${episodeNumber}-2 {TIME} {INT./EXT.} {LOCATION}

Characters: {character list}

△{Scene description…}

……continue same format……
\`\`\`

## Quality Standards (Per-Episode Checklist)
- **Minimum 2 scenes** per episode, recommended 3-5
- **Minimum 800 words** per episode
- Scene numbers use \`${episodeNumber}-1, ${episodeNumber}-2\` format
- △ prefix for ALL descriptive/action/direction text (no space after △)
- Dialogue on separate lines: \`CHARACTER: (direction) dialogue\` — no quotes, no bold
- 🔵 **3-Second Hook**: Mark the hook moment in BLUE annotation
- 🔴 **Completion Bait**: End with strong cliffhanger, mark in RED annotation
- 🟢 **Interaction Trigger**: Include debate-worthy line, mark in GREEN annotation
- End with a strong ${hookType || "cliffhanger"} hook
- ⛔ NO real names, real places, real brands — all must be fictional`;
  }

  if (market === "kr") {
    return `## 대본 형식 (한국 시장)

\`\`\`
# 제${episodeNumber}화

# ${episodeNumber}-1 {시간} {실내/실외} {장소}

등장인물: {인물 목록}

△{장면 묘사 — 분위기와 공간감}
△{인물의 표정·동작 — 감정 변화에 집중}

{캐릭터명}: ({말투/동작 지시}) {대사}

△{핵심 디테일 — 감정 폭발의 순간}

# ${episodeNumber}-2 {시간} {실내/실외} {장소}

등장인물: {인물 목록}

……이하 동일 형식……
\`\`\`

## 품질 기준
- 각 화 3-5개 씬, 최소 800자 이상
- 씬 번호는 \`${episodeNumber}-1, ${episodeNumber}-2\` 형식
- △로 모든 묘사/동작/지시문 시작 (△ 뒤 공백 없음)
- 대사는 별도 행: \`캐릭터명: (지시) 대사\` — 따옴표·볼드 없음
- 감정 밀당과 반전을 각 씬에 배치
- 결말은 ${hookType || "클리프행어"}로 마무리`;
  }

  if (market === "sea") {
    return `## Script Format (Southeast Asian Market)

\`\`\`
# Episode ${episodeNumber}

# ${episodeNumber}-1 {TIME} {INT./EXT.} {LOCATION}

Characters: {character list}

△{Scene description — lush, atmospheric, emotionally charged}
△{Character interaction — body language conveying unspoken tension}

{CHARACTER NAME}: ({tone/action direction}) {Dialogue}

△{Emotional reaction — tears, rage, revelation}

# ${episodeNumber}-2 {TIME} {INT./EXT.} {LOCATION}

Characters: {character list}

……continue same format……
\`\`\`

## Quality Standards
- 3-5 scenes per episode, minimum 800 words
- Scene numbers use \`${episodeNumber}-1, ${episodeNumber}-2\` format
- △ prefix for ALL descriptive/action/direction text (no space after △)
- Dialogue on separate lines: \`CHARACTER: (direction) dialogue\` — no quotes, no bold
- Maximize emotional intensity — confrontation, confession, betrayal moments
- End with a powerful ${hookType || "dramatic revelation"} hook`;
  }

  // 國內預設
  return `## 劇本格式要求（華語模式）

**嚴格遵循以下格式規範，不得偏離：**

### 場次編號規則
- 場次編號採用"集數-場次序號"格式，如第${episodeNumber}集的場次依次為 ${episodeNumber}-1、${episodeNumber}-2、${episodeNumber}-3……
- 每個場次標題格式：\`# ${episodeNumber}-{N} {時間} {內/外} {地點}\`，其中 {N} 為該集內的場次序號

### 格式模板

\`\`\`
# 第${episodeNumber}集

# ${episodeNumber}-1 {時間（日/夜/清晨/黃昏等）} {內/外} {地點}

出場人物：{人物A}，{人物B}，{人物C}

△{場景描寫與人物動作描寫。所有非台詞的敘述性內容（包括場景描寫、動作描寫、神態描寫、鏡頭指示等）都必須以△開頭。}

{角色名}：（{語氣/動作指示}）{台詞內容}

△{後續動作或場景描寫，繼續以△開頭。}

{角色名}：（{語氣/動作指示}）{台詞內容}

△{更多動作/描寫。}

# ${episodeNumber}-2 {時間} {內/外} {地點}

出場人物：{人物列表}

△{場景描寫……}

……以此類推……
\`\`\`

### 關鍵格式規則（必須嚴格執行）

1. **△符號**：僅用於描寫性文字（場景、動作、神態、鏡頭方向等），△緊跟文字內容，中間無空格。**對話和旁白前絕對不加△**
2. **人物對話**：台詞必須單獨成行，格式為 \`角色名：（語氣/動作指示）台詞內容\`，不加引號，不加粗。旁白格式為 \`旁白：內容\`，旁白屬於台詞類別，不加△
3. **場次編號**：使用 \`# ${episodeNumber}-{N}\` 格式，N從1開始遞增
4. **出場人物**：每個場次開頭必須列出 \`出場人物：\` 並用逗號分隔
5. **集標題**：首行為 \`# 第${episodeNumber}集\`，不附加集標題

## 質量要求
- 每集 3-5 個場次
- 每集至少 800 字
- 台詞帶語氣或動作指示（用圓括號包裹）
- 結尾必須有懸念鉤子（${hookType || "懸念鉤"}）`;
}

/** 根據單集時長計算△、台詞、場景數量及字數約束 */
export function getDurationConstraints(durationSeconds: number): {
  triangleMin: number; triangleMax: number; maxDialogues: number;
  sceneMin: number; sceneMax: number;
  cjkWordsMin: number; cjkWordsMax: number;
  latinWordsMin: number; latinWordsMax: number;
  label: string;
} {
  const segments = Math.ceil(durationSeconds / 30);

  // 場景數量：60s→2~3, 90s→3~5, 120s→4~6
  let sceneMin: number, sceneMax: number;
  if (durationSeconds <= 60) { sceneMin = 2; sceneMax = 3; }
  else if (durationSeconds <= 90) { sceneMin = 3; sceneMax = 5; }
  else if (durationSeconds <= 120) { sceneMin = 4; sceneMax = 6; }
  else { sceneMin = Math.round(durationSeconds / 30); sceneMax = Math.round(durationSeconds / 20); }

  return {
    triangleMin: segments * 9,
    triangleMax: segments * 11,
    maxDialogues: segments * 4,
    sceneMin,
    sceneMax,
    cjkWordsMin: segments * 300,
    cjkWordsMax: segments * 400,
    latinWordsMin: segments * 800,
    latinWordsMax: segments * 1200,
    label: `${durationSeconds}秒`,
  };
}

/** 分集撰寫 Prompt */
export function buildEpisodePrompt(
  setup: DramaSetup,
  characters: string,
  directory: EpisodeEntry[],
  episodeNumber: number,
  previousEpisodes: string,
  nextEpisodes?: string,
  customInstruction?: string,
  durationSeconds?: number,
): string {
  const ep = directory.find((e) => e.number === episodeNumber);
  const prevEp = directory.find((e) => e.number === episodeNumber - 1);
  const nextEp = directory.find((e) => e.number === episodeNumber + 1);
  const isFirstEp = episodeNumber === 1;

  return `你是一位專業的微短劇編劇。

${getFullMarketDirective(setup)}

## 專案設定
- 題材：${setup.genres.join(" + ")}
- 基調：${setup.personaStyle || setup.tone || ""}
- 總集數：${setup.totalEpisodes}

## 角色檔案（摘要）
${characters.slice(0, 3000)}

## 目前集資訊
- 第 ${episodeNumber} 集：${ep?.title || ""}
- 梗概：${ep?.summary || ""}
- 鉤子型別：${ep?.hookType || ""}
- ${ep?.isKey ? "🔥 關鍵劇情集" : ""}${ep?.isClimax ? " ⚡ 高潮卡點集" : ""}
${prevEp ? `- 上一集：第${prevEp.number}集 ${prevEp.title} —— ${prevEp.summary}` : ""}
${nextEp ? `- 下一集：第${nextEp.number}集 ${nextEp.title} —— ${nextEp.summary}` : ""}

${previousEpisodes ? `## 前集回顧\n${previousEpisodes.slice(-2000)}` : ""}
${nextEpisodes ? `\n## 後續集回顧\n${nextEpisodes.slice(-2000)}` : ""}

${isFirstEp ? `## 重要：開篇黃金法則
- 第1秒：畫面衝擊或懸念丟擲
- 第3秒：核心衝突或身份反差建立
- 第5秒：觀眾必須產生"接下來會怎樣"的好奇心
- 前30秒必須完成：建立核心衝突、展示主角處境、丟擲第一個鉤子
- 禁止：大段旁白、慢節奏空鏡、流水賬、平鋪直敘` : ""}

${getScriptFormatTemplate(setup, episodeNumber, ep?.hookType || "")}

${durationSeconds ? (() => {
  const c = getDurationConstraints(durationSeconds);
  const isCJK = ['cn', 'jp', 'kr'].includes(setup.targetMarket);
  return `## 單集時長與內容量約束（${c.label}）
- 本集目標時長：${c.label}
- 場景數量：${c.sceneMin}~${c.sceneMax} 個場景（每個場景以 # 集數-場次 格式標註）
- △（描寫/動作/鏡頭指示）數量：${c.triangleMin}~${c.triangleMax} 個（△僅用於非台詞的敘述性內容，不包括任何對話和旁白）
- 台詞總數（含旁白）：不超過 ${c.maxDialogues} 句
- 全集總字數：${isCJK ? `${c.cjkWordsMin}~${c.cjkWordsMax} 箇中文字` : `${c.latinWordsMin}~${c.latinWordsMax} 個英文單詞`}（每30秒約${isCJK ? '300~400中文字' : '800~1200英文單詞'}）
- 每30秒對應 9~11 個△描寫和最多 4 句台詞（旁白算作台詞，不算△）
- 嚴格區分：△ = 場景描寫、動作描寫、神態描寫、鏡頭指示；台詞 = 角色對話 + 旁白（旁白格式：旁白：內容）
- 對話和旁白前絕對不能加△符號
- 嚴格控制內容密度，不要超出或不足上述範圍`;
})() : ""}

- 確保角色行為與檔案一致
- 確保劇情推進與分集目錄一致

${customInstruction ? `\n## 使用者重寫指令\n${customInstruction}\n請在撰寫時重點體現以上指令要求。\n` : ""}
請直接輸出完整的第 ${episodeNumber} 集劇本。`;
}

/** 單場次重寫 Prompt */
export function buildSceneRegenPrompt(
  setup: DramaSetup,
  characters: string,
  episodeNumber: number,
  episodeContent: string,
  sceneIndex: number,
  sceneContent: string,
  customInstruction?: string,
): string {
  const instructionBlock = customInstruction
    ? `\n\n## 使用者重寫指令\n${customInstruction}\n請在重寫時重點體現以上指令要求，但不得違反下方"連貫性鐵律"。`
    : "";

  // --- Extract adjacent scenes as anchors ---
  const sceneRegex = /^(#\s*\d+-\d+\s+.*)$|^(##\s*場次.*)$/gm;
  const matches = [...episodeContent.matchAll(sceneRegex)];
  const extractScene = (idx: number): string | null => {
    if (idx < 0 || idx >= matches.length) return null;
    const start = matches[idx].index!;
    const end = idx + 1 < matches.length ? matches[idx + 1].index! : episodeContent.length;
    return episodeContent.slice(start, end).trim();
  };

  const prevScene = extractScene(sceneIndex - 1);
  const nextScene = extractScene(sceneIndex + 1);

  const anchorBlock = [
    prevScene
      ? `### 前一場次（場次${sceneIndex}）— 劇情錨點\n${prevScene}\n\n**銜接約束**：重寫後的場次開頭必須自然承接上述場次的結尾狀態（角色位置、情緒、已知資訊）。`
      : `（本場次為該集首場，需承接集標題/前情提要中的狀態。）`,
    nextScene
      ? `### 後一場次（場次${sceneIndex + 2}）— 劇情錨點\n${nextScene}\n\n**銜接約束**：重寫後的場次結尾必須保證後續場次的開頭仍然成立（角色去向、情緒轉折、資訊揭示均不可斷裂）。`
      : `（本場次為該集末場，結尾需保留原有的懸念/鉤子設計。）`,
  ].join("\n\n");

  return `你是一位專業的微短劇編劇，擅長在不改變核心劇情的前提下提升場次的表現力。

${getFullMarketDirective(setup)}

## 專案設定
- 題材：${setup.genres.join(" + ")}
- 基調：${setup.personaStyle || setup.tone || ""}

## 角色檔案（摘要）
${characters.slice(0, 2000)}

## 目前集完整內容
${episodeContent}

---

## 前後場次劇情錨點
${anchorBlock}
${instructionBlock}

---

## 連貫性鐵律（最高優先順序）

1. **核心劇情不可變更**：本場次的關鍵事件（資訊揭示、角色決策、衝突升級/降級）必須與原場次完全一致。禁止新增、刪除或替換任何影響後續劇情的事件。
2. **角色情感弧線約束**：
   - 場次開頭的角色情緒狀態必須匹配前一場次（或集開頭）的結束狀態；
   - 場次結尾的角色情緒狀態必須能自然過渡到後一場次（或集結尾懸念）的起始狀態；
   - 角色在本場次中的情緒變化軌跡（如：隱忍→爆發、懷疑→確認）必須保持原有方向，僅允許在表達強度上調整。
3. **結尾狀態銜接檢查**：重寫完成後，自檢以下三項，若任一項不滿足則必須修正：
   - ✅ 角色的物理位置與後續場次一致
   - ✅ 已揭示/未揭示的資訊與後續場次一致
   - ✅ 角色間關係狀態（敵對/信任/誤解等）與後續場次一致
4. **禁止跨場次副作用**：不得引入新角色、新道具、新地點，除非原場次中已存在。

---

## 你的任務
請重新撰寫上述第 ${episodeNumber} 集中的 **場次${sceneIndex + 1}** 部分。

原場次內容：
${sceneContent}

**允許最佳化的維度**：
- 台詞的表現力與潛台詞層次
- 鏡頭語言（△ 景別切換、運鏡節奏）
- 場景氛圍描寫與感官細節
- 節奏感（停頓、沉默、反應鏡頭的運用）
- ♪ 音效/音樂提示的精準度

**輸出格式要求**：
- 使用與原文相同的格式（場景描述、△ 鏡頭、角色台詞、♪ 音樂等）
- 僅輸出該場次的內容，不要輸出其他場次
- 不要輸出自檢過程，僅輸出最終場次內容

請直接輸出重寫後的場次內容。`;
}

/** 匯出整合 Prompt */
export function buildExportPrompt(
  setup: DramaSetup,
  dramaTitle: string,
  creativePlan: string,
  characters: string,
  episodes: { number: number; title: string; content: string }[],
): string {
  return `你是一位專業編輯。請將以下創作內容整合為一份完整、排版規範的劇本檔案。

${getFullMarketDirective(setup)}

## 元資訊
- 劇名：${dramaTitle}
- 題材：${setup.genres.join(" + ")}
- 總集數：${setup.totalEpisodes}集
- 已完成：${episodes.length}集
- 目標受眾：${setup.personaGender || setup.audience || ""}
- 故事基調：${setup.personaStyle || setup.tone || ""}

## 創作方案摘要
${creativePlan.slice(0, 1500)}

## 角色表摘要
${characters.slice(0, 1500)}

## 分集劇本
${episodes.map((ep) => `### 第${ep.number}集：${ep.title}\n${ep.content}`).join("\n\n---\n\n")}

請輸出整合後的完整劇本檔案，格式規範，包含以下結構：

1. **封面資訊**（劇名、題材、集數、受眾、基調）
2. **角色表**（從角色檔案中提取，列表形式：角色名 | 身份 | 性格關鍵詞 | 功能定位）
3. **場景清單**（從各集劇本中提取所有出現過的場景/地點，去重後列出）
4. **配樂提示表**（從各集劇本中提取所有 ♪ 音樂提示，標註對應集數和場次）
5. **分集劇本**（完整保留各集內容，統一格式）`;
}

/** 合規審核 Prompt - 支援文字審核和情節審核兩種模式 */
export function buildCompliancePrompt(
  setup: DramaSetup,
  creativePlan: string,
  characters: string,
  episodes: { number: number; title: string; content: string }[],
  reviewMode: "text" | "script" = "text",
): string {
  const market = setup.targetMarket || "cn";
  const episodesSample = episodes
    .sort((a, b) => a.number - b.number)
    .map((ep) => `### 第${ep.number}集：${ep.title}\n${ep.content.slice(0, 1500)}`)
    .join("\n\n---\n\n");

  if (reviewMode === "script") {
    // 情節審核模式：文字+畫面雙重審查
    return `你是一位資深的短劇內容合規審核專家，執行**最徹底的合規審查**。

${getFullMarketDirective(setup)}

## 專案資訊
- 題材：${setup.genres.join(" + ")}
- 受眾：${setup.personaGender || setup.audience || ""}
- 基調：${setup.personaStyle || setup.tone || ""}
- 總集數：${setup.totalEpisodes}
- 已完成：${episodes.length}集

## 創作方案摘要
${creativePlan.slice(0, 1000)}

## 角色檔案摘要
${characters.slice(0, 1000)}

## 劇本內容
${episodesSample}

---

## 審核要求

你需要進行**雙重審查**：檢查文字層面和畫面表現層面的合規風險。

### 第一重：文字違規檢查

檢查字面上的違規內容：

1. **激烈衝突文字**
   - 描寫身體損傷的文字
   - 描寫衝突過程的文字
   - 描寫激烈對抗的文字

2. **版權問題**
   - 直接引用受版權保護的歌詞、台詞、小說
   - 明顯抄襲知名IP的角色、情節

3. **敏感親密文字**
   - 過度暴露的描寫
   - 不當行為描寫

### 第二重：畫面違規檢查

從畫面呈現角度審查整個情節段落：

1. **激烈衝突情節風險**
   - 肢體衝突情節：打鬥、摔打等
   - 傷害呈現情節：受傷場景
   - 強對抗情節：威脅等

2. **親密情節風險**
   - 親密接觸情節：吻戲、擁抱等
   - 身體呈現情節：更衣、沐浴等
   - 曖昧氛圍情節：調情等

3. **其他情節風險**
   - 未成年人參與的敏感場景
   - 不良行為展示
   - 其他違規內容

## 輸出格式

使用以下標記標註風險：

- ⛔ 紅線問題（必須修改）
- ⚠️ 高風險內容（建議修改）
- ℹ️ 最佳化建議（可選修改）

**標記規則：**

**文字違規**：標記完整句子
- 示例：⛔【他的胸口被刺穿，染紅了整件襯衫。】

**畫面違規**：標記整個風險段落
- 示例：⛔【他猛地將她推倒，雙手掐住她的脖子...（整段完整文字）】

## 輸出結構

1. **合規總評**
2. **文字違規檢測**
3. **畫面違規檢測**
4. **風險彙總**
5. **修改建議**

用 Markdown 格式輸出。`;
  }

  // 文字審核模式
  return `你是一位資深的短劇內容合規審核專家，精通各類內容監管法規與平台規範。

${getFullMarketDirective(setup)}

## 專案資訊
- 題材：${setup.genres.join(" + ")}
- 受眾：${setup.personaGender || setup.audience || ""}
- 基調：${setup.personaStyle || setup.tone || ""}
- 總集數：${setup.totalEpisodes}
- 已完成：${episodes.length}集

## 創作方案摘要
${creativePlan.slice(0, 1000)}

## 角色檔案摘要
${characters.slice(0, 1000)}

## 劇本內容
${episodesSample}

---

## 審核要求

請對以下三個維度進行合規審查：

### 一、激烈衝突內容
檢查字面上的激烈衝突描寫：
- 描寫身體損傷的文字
- 描寫衝突過程的文字
- 描寫激烈對抗行為的文字
- 輕度肢體衝突可標記為最佳化建議

### 二、版權問題
檢查是否存在：
- 直接引用受版權保護的作品內容
- 明顯模仿知名IP的角色、情節設定
- 未授權使用品牌名稱

### 三、敏感親密內容
檢查字面上的敏感親密描寫：
- 過度暴露的描寫
- 不當行為描寫
- 一般親吻擁抱可標記為最佳化建議

## 輸出格式

使用以下標記標註問題嚴重程度：
- ⛔ 紅線問題（必須修改）
- ⚠️ 高風險內容（建議修改）
- ℹ️ 最佳化建議（可選修改）

輸出結構：
1. **合規總評**：一段話總結合規狀態
2. **激烈衝突檢測**：逐項檢查結果
3. **版權問題排查**：逐項檢查結果
4. **敏感內容檢測**：逐項檢查結果
5. **問題清單彙總**：按嚴重程度排序
6. **修改建議**：針對每個問題的具體修改方案

**標記規則：**

標記**整句話或整個分鏡片段**：
- 紅線問題：⛔【包含風險內容的完整句子】
- 高風險內容：⚠️【包含風險內容的完整句子】
- 最佳化建議：ℹ️【包含風險內容的完整句子】

用 Markdown 格式輸出，清晰分割槽。`;
}

/** 質量自檢 Prompt */
export function buildReviewPrompt(
  setup: DramaSetup,
  characters: string,
  directory: EpisodeEntry[],
  episodeNumber: number,
  episodeContent: string,
  prevEpisodeContent?: string,
  nextEpisodeContent?: string,
): string {
  const genreStr = setup.genres.join(" + ");
  const epEntry = directory.find((d) => d.number === episodeNumber);

  return `你是一位資深短劇質檢編輯，精通微短劇的創作標準和行業規範。

${getFullMarketDirective(setup)}

## 任務
對以下第 ${episodeNumber} 集劇本進行五維度質量評分和審查。

## 專案資訊
- 題材：${genreStr}
- 受眾：${setup.personaGender || setup.audience || ""}
- 基調：${setup.personaStyle || setup.tone || ""}
- 結局：${setup.ending || ""}
- 總集數：${setup.totalEpisodes}
${epEntry ? `- 本集標題：${epEntry.title}\n- 本集概要：${epEntry.summary}\n- 鉤子型別：${epEntry.hookType}${epEntry.isKey ? "\n- 🔥 關鍵集" : ""}${epEntry.isClimax ? "\n- ⚡ 高潮卡點" : ""}` : ""}

## 角色檔案（摘要）
${characters.slice(0, 2000)}

${prevEpisodeContent ? `## 上一集內容（末尾片段）\n${prevEpisodeContent.slice(-600)}\n` : ""}
${nextEpisodeContent ? `## 下一集內容（開頭片段）\n${nextEpisodeContent.slice(0, 600)}\n` : ""}

## 待審查劇本
${episodeContent}

---

## 評分要求

請嚴格按照以下五個維度評分（每項 1-10 分），並輸出 **嚴格的 JSON 格式**：

\`\`\`json
{
  "scores": {
    "rhythm": { "score": 8, "comment": "評價說明" },
    "satisfaction": { "score": 7, "comment": "評價說明" },
    "dialogue": { "score": 9, "comment": "評價說明" },
    "format": { "score": 9, "comment": "評價說明" },
    "continuity": { "score": 9, "comment": "評價說明" }
  },
  "total": 42,
  "grade": "優良",
  "highlights": ["亮點1", "亮點2", "亮點3"],
  "issues": [
    { "level": "⛔", "description": "阻斷性問題描述" },
    { "level": "⚠️", "description": "建議修改描述" },
    { "level": "ℹ️", "description": "微調建議描述" }
  ],
  "suggestions": ["修訂建議1", "修訂建議2"]
}
\`\`\`

### 維度說明
| 維度 | 評價標準 |
|------|----------|
| rhythm（節奏） | 場景切換節奏、資訊密度、前30秒入戲、末尾鉤子 |
| satisfaction（爽點） | 爽感要素密度、情緒高潮設計、觀眾滿足感 |
| dialogue（台詞） | 人物語言個性化、金句設計、畫外音使用 |
| format（格式） | 鏡頭語言規範（△全景/中景/特寫）、配樂提示♪、場景頭標註、角色標註 |
| continuity（連貫性） | 與角色檔案一致、與前後集銜接、伏筆回收 |

### 評級標準
| 總分 | 評級 |
|------|------|
| 45-50 | 卓越 |
| 38-44 | 優良 |
| 30-37 | 合格 |
| 25-29 | 需改進 |
| <25 | 需重寫 |

**只輸出 JSON，不要輸出其他任何內容。**`;
}

/** 結構轉換 Prompt（同款創作模式） */
export function buildStructureTransformPrompt(
  setup: DramaSetup,
  referenceScript: string,
  frameworkStyle: string,
  transformMarket?: string,
): string {
  const styles = frameworkStyle ? frameworkStyle.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : [];
  const keepOriginal = styles.length === 0;
  const styleLabel = keepOriginal ? "原劇型別" : styles.join("、");
  // 允許在轉換步驟臨時切換目標市場
  const effectiveMarket = transformMarket || setup.targetMarket || "cn";
  const marketSetup = { ...setup, targetMarket: effectiveMarket };

  if (keepOriginal) {
    return `你是一位專業的微短劇改編編劇，擅長在保留原劇型別的基礎上進行適度洗稿。

${getFullMarketDirective(marketSetup)}

## 你的任務
對以下參考劇本進行**保持原劇型別的改編**：不改變故事型別/世界觀/時代背景，僅對人物、場景、道具進行改名，整體洗稿程度約60%。

## 轉換原則
1. **保持原劇型別**：世界觀、時代背景、社會體系、權力結構、文化元素與原劇本一致，不做風格置換
2. **改名置換**：
   - 人物姓名 → 更換為同風格的新名字
   - 場景名稱 → 更換為同型別的新場景
   - 道具/物品 → 更換為同功能的新道具
3. **洗稿約60%**：保留核心情節骨架和關鍵轉折，對錶述、細節、對話進行約60%的改寫，避免照抄原文

## 參考劇本結構
${referenceScript}

## 輸出要求
請生成完整的創作方案，包含以下板塊：

1. **劇名備選**（3個），每個附一句話說明
2. **時空背景**：與原劇本一致的型別設定（簡要說明）
3. **一句話故事線** + **核心衝突**
4. **情節對照表**：原文核心情節 → 改編後對應情節（逐條對照，體現改名與洗稿）
5. **三幕結構拆解**：
   - 第一幕（建置）：集數範圍、核心事件
   - 第二幕（對抗）：集數範圍、衝突升級
   - 第三幕（高潮/結局）：集數範圍、終極對決
6. **人物/場景/道具改名對照**：原文 → 改編後（確保全面置換）
7. **付費卡點規劃**：具體集數 + 卡點型別
8. **結局設計**

總集數：${setup.totalEpisodes}集
用 Markdown 格式輸出，清晰分割槽。`;
  }

  const styleRef = styles.length === 2
    ? `「${styles[0]}」與「${styles[1]}」融合`
    : `「${styleLabel}」`;

  return `你是一位專業的微短劇改編編劇，擅長將不同風格的故事進行框架轉換。

${getFullMarketDirective(marketSetup)}

## 你的任務
將以下參考劇本的敘事結構轉換為${styleRef}風格的創作方案。

## 轉換原則
1. **保留核心情節骨架**：主要矛盾衝突、人物關係拓撲、關鍵轉折點必須保留
2. **風格全面置換**：世界觀、時代背景、社會體系、權力結構、文化元素全部替換為${styleRef}設定
3. **等價替換法則**：
   - 原文中的社會階層 → ${styleRef}對應的等級體系
   - 原文中的權力機制 → ${styleRef}對應的權力形式
   - 原文中的情感表達 → ${styleRef}對應的情感方式
4. **強化風格特色**：加入${styleLabel}風格特有的元素、術語、場景設定

## 參考劇本結構
${referenceScript}

## 輸出要求
請生成完整的創作方案，包含以下板塊：

1. **劇名備選**（3個），每個附一句話說明
2. **時空背景**：轉換後的時代、地點、社會環境、體系設定
3. **一句話故事線** + **核心衝突**
4. **情節對照表**：原文核心情節 → 轉換後對應情節（逐條對照）
5. **三幕結構拆解**：
   - 第一幕（建置）：集數範圍、核心事件
   - 第二幕（對抗）：集數範圍、衝突升級
   - 第三幕（高潮/結局）：集數範圍、終極對決
6. **${styleLabel}特色元素清單**：本風格必須包含的標誌性場景/設定/術語
7. **付費卡點規劃**：具體集數 + 卡點型別
8. **結局設計**

總集數：${setup.totalEpisodes}集
用 Markdown 格式輸出，清晰分割槽。`;
}

/** 角色轉換 Prompt（同款創作模式） */
export function buildCharacterTransformPrompt(
  setup: DramaSetup,
  referenceScript: string,
  frameworkStyle: string,
  structureTransform: string,
): string {
  const styles = frameworkStyle ? frameworkStyle.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : [];
  const keepOriginal = styles.length === 0;
  const styleLabel = keepOriginal ? "原劇型別" : styles.join("、");

  if (keepOriginal) {
    return `你是一位專業的微短劇改編編劇。

${getFullMarketDirective(setup)}

## 你的任務
基於已完成的結構轉換方案，將原文中的角色體系進行**改名置換**：保持原劇型別與身份設定，僅更換人物姓名及少量描述表述。

## 轉換原則
1. **角色關係拓撲不變**：主角、對手、盟友、隱藏反派的關係結構保持一致
2. **身份與型別不變**：職業/身份、能力/特長、社會層級與原劇本一致
3. **改名置換**：角色姓名 → 更換為同風格的新名字
4. **性格核心保留**：角色的核心動機、性格特徵、人物弧光保持一致

## 原文劇本
${referenceScript}

## 已完成的結構轉換方案
${structureTransform}

## 輸出要求
生成完整角色體系，包含：

1. **角色對照表**：原文角色 → 改編角色（逐一對照，體現改名）
2. **主要角色檔案**（每個角色包含）：
   - 姓名、年齡、外貌特徵（2-3句）
   - 性格關鍵詞（3-5個）
   - 公開身份 vs 真實身份
   - 核心動機
   - 爽點功能
   - 口頭禪或語言特徵
   - 人物弧光
3. **角色關係圖**（使用 Mermaid graph TD 格式輸出）

請在 \`\`\`mermaid 和 \`\`\` 之間輸出關係圖程式碼。

4. **感情線弧線**：關係發展的關鍵節點（標註集數）
5. **四層反派體系**

用 Markdown 格式輸出。`;
  }

  return `你是一位專業的微短劇改編編劇。

${getFullMarketDirective(setup)}

## 你的任務
基於已完成的結構轉換方案，將原文中的角色體系轉換為「${styleLabel}」風格。

## 轉換原則
1. **角色關係拓撲不變**：主角、對手、盟友、隱藏反派的關係結構保持一致
2. **身份風格置換**：
   - 角色姓名 → 符合${styleLabel}風格的名字
   - 職業/身份 → ${styleLabel}對應的身份設定
   - 能力/特長 → ${styleLabel}體系下的對應能力
3. **性格核心保留**：角色的核心動機、性格特徵、人物弧光保持一致
4. **風格化表達**：口頭禪、語言特徵適配${styleLabel}風格

## 原文劇本
${referenceScript}

## 已完成的結構轉換方案
${structureTransform}

## 輸出要求
生成完整角色體系，包含：

1. **角色對照表**：原文角色 → 轉換角色（逐一對照）
2. **主要角色檔案**（每個角色包含）：
   - 姓名、年齡、外貌特徵（2-3句）
   - 性格關鍵詞（3-5個）
   - 公開身份 vs 真實身份
   - 核心動機
   - 爽點功能
   - 口頭禪或語言特徵
   - 人物弧光
3. **角色關係圖**（使用 Mermaid graph TD 格式輸出）

請在 \`\`\`mermaid 和 \`\`\` 之間輸出關係圖程式碼。

4. **感情線弧線**：關係發展的關鍵節點（標註集數）
5. **四層反派體系**

用 Markdown 格式輸出。`;
}

/** 短文撰寫 Prompt（300-500字） */
export function buildShortArticlePrompt(
  setup: DramaSetup,
  characters: string,
  customInstruction?: string,
): string {
  const genreStr = setup.genres.join(" + ");
  return `你是一位專業的微短劇編劇。

${getMarketDirective(setup)}

## 專案設定
- 題材：${genreStr}
- 受眾：${setup.personaGender || setup.audience || ""}
- 基調：${setup.personaStyle || setup.tone || ""}
- 結局：${setup.ending || ""}
${setup.customTopic ? `- 創作要求：${setup.customTopic}` : ""}

## 角色檔案（摘要）
${characters.slice(0, 2000)}

## 你的任務
請根據以上專案設定和角色檔案，撰寫一篇**300到500字**的短文。

要求：
- 字數嚴格控制在 300~500 字之間
- 內容完整，有開頭、發展、結尾
- 情節緊湊，突出核心衝突或情感爽點
- 語言生動，符合題材基調
- 直接輸出正文，不需要標題或額外說明

${customInstruction ? `## 使用者指令\n${customInstruction}\n` : ""}請直接輸出短文正文。`;
}

/** 短文批次生成 Prompt */
export function buildSocialPostsPrompt(
  setup: DramaSetup,
  characters: string,
  count: number,
  customInstruction?: string,
  existingCount = 0,
  memory?: string,
  recentPosts?: string[],
  todayNews?: string,
  memeImageItems?: Array<{ url: string; context: string; source: string }>,
  priorityInstruction?: string,
): string {
  // Derive word count range from totalEpisodes setting
  // undefined or 0 = auto (no word count constraint)
  const base = setup.totalEpisodes;
  const customMax = (setup as any)._customMaxWords as number | undefined;
  // Check tweet style — "simple" uses fixed template format
  const isSimpleStyle = typeof localStorage !== "undefined" && localStorage.getItem("persona_tweet_style") === "simple";
  let wordRange: string;
  if (!base) wordRange = "";  // auto — no constraint
  else if (base === 50) wordRange = "50~150字";
  else if (base === 150) wordRange = "150~300字";
  else if (base === 300) wordRange = "300~500字";
  else if (base === 500) wordRange = "500~800字";
  else if (base === 800) wordRange = "800~1000字";
  else if (base > 0) {
    const max = customMax && customMax > base ? customMax : Math.round(base * 1.3);
    wordRange = `${base}~${max}字`;
  } else {
    wordRange = "";
  }

  const personaTypes = setup.genres?.join(" + ") || "";
  const isPersonaMode = !!setup.personaName;
  const useJinjunyaFreeHookStyle = usesJinjunyaFreeContentStyle(setup);

  // Language directive based on target market
  const market = setup.targetMarket || "cn";
  const langMap: Record<string, string> = {
    cn: setup.chineseScript === "traditional" ? "繁體中文（台灣/香港用語，使用繁體字）" : "簡體中文",
    jp: "日本語",
    west: "English",
    kr: "한국어",
    sea: "English",
  };
  const outputLang = langMap[market] || "簡體中文";

  // Per-market localization rules injected into the prompt
  const localeRules: Record<string, string> = {
    cn_tw: `**台灣在地化（必須執行）：**
- 用字：繁體字，台灣慣用詞（捷運、機車、便當、健保、夜市、手搖飲、滷肉飯、悠遊卡）
- 貨幣：台幣（NT$、新台幣），例：「NT$500」「一千塊台幣」
- 語氣：台灣年輕人口語，常用「欸」「啊」「喔」「齁」「超」「根本」「真的假的」「有夠」「爆幹」（視人設調整）
- 標點：用「！」「？」「⋯⋯」，**結尾不加句號**
- 文字風格：精簡有力，每句話去掉多餘的字，直接說重點
- 文化參照：台灣時事、台劇、PTT/Dcard 用語、台灣節慶（中秋烤肉、尾牙、春酒）
- 禁止：大陸網路用語（「666」「yyds」「絕絕子」「內卷」換成台灣說法）、句尾句號`,

    cn_hk: `**香港在地化（必須執行）：**
- 用字：繁體字，香港慣用詞（港鐵、巴士、茶餐廳、MPF、強積金、屋苑、計程車、八達通）
- 貨幣：港幣（HK$、港元），例：「HK$500」「五百蚊港紙」
- 語氣：香港口語，中英夾雜自然（「好core」「好hea」「唔係喎」「係咁先」「即刻」「搞掂」「冇問題」）
- 標點：用「！」「？」「……」，**結尾不加句號**
- 文字風格：精簡直接，港式幽默，去掉廢話
- 文化參照：香港時事、港劇、LIHKG 用語、香港節慶（農曆新年、中秋、聖誕）
- 禁止：台灣用語、大陸網路用語、句尾句號`,

    cn_mo: `**澳門在地化（必須執行）：**
- 用字：繁體字，澳門慣用詞（輕軌、巴士、葡撻、賭場、路氹、官也街）
- 貨幣：澳門幣（MOP$、澳門元），例：「MOP$500」「五百蚊澳門幣」
- 語氣：澳門口語，接近廣東話，偶爾夾葡語詞（「obrigado」「saudade」）
- 標點：用「！」「？」「……」，**結尾不加句號**
- 文字風格：精簡有力，去掉多餘字詞
- 文化參照：澳門時事、博彩文化、葡式文化、澳門節慶
- 禁止：句尾句號`,

    cn_traditional: `**台灣/香港在地化（必須執行）：**
- 用字：繁體字，台灣慣用詞（捷運、機車、便當、健保、夜市、手搖飲）
- 貨幣：台幣（NT$）或港幣（HK$），依人設地區使用正確貨幣
- 語氣：台灣/香港年輕人口語，自然流暢
- 標點：用「！」「？」「⋯⋯」，**結尾不加句號**
- 文字風格：精簡有力，每句話去掉多餘的字，直接說重點
- 禁止：大陸網路用語、句尾句號`,

    cn: `**中文寫作規範：**
- 文字風格：精簡有力，去掉廢話，直接說重點
- 結尾：**不加句號**，用感嘆號、問號或省略號收尾更有力
- 禁止：結尾句號`,

    jp: `**日本ローカライズ（必ず実行）：**
- 文體：SNS向けの自然な日本語口語。「〜だよ」「〜だね」「〜じゃん」「〜かも」「〜してみた」など話し言葉を使う
- 語彙：日本のSNS流行語・若者言葉を自然に取り入れる（「エモい」「ガチ」「ヤバい」「推し」「沼る」「尊い」「草」「ワンチャン」など）
- 文字スタイル：簡潔で力強く、餘分な言葉を省く。文末に句點（。）を付けない
- 文化參照：日本の時事・トレンド・季節行事（花見・夏祭り・コミケ・年末年始）・日本のTV番組・アニメ・J-POP
- 敬語：人設に合わせて使い分け（フレンドリーな人設はタメ口、専門家系は丁寧語）
- 禁止：中國語の直訳表現、不自然な敬語の混在、文末句點`,

    kr: `**한국 현지화（반드시 실행）：**
- 문체：SNS 구어체. 「~야/이야」「~잖아」「~거든」「~지」「~했어」등 자연스러운 말투
- 어휘：한국 SNS 유행어·신조어 자연스럽게 활용（「갓생」「핵인싸」「TMI」「레전드」「ㅋㅋ」「ㅠㅠ」「대박」「헐」「존맛」「꿀잼」등）
- 문체 스타일：간결하고 힘있게, 불필요한 말 제거. 문장 끝에 마침표 사용 금지
- 문화 참조：한국 시사·트렌드·계절 행사（설날·추석·수능·크리스마스）·K-드라마·K-팝·유튜브 트렌드
- 존댓말：인설에 맞게 구분（친근한 인설은 반말, 전문가 계열은 존댓말）
- 금지：중국어 직역 표현, 어색한 존댓말 혼용, 문장 끝 마침표`,

    west: `**Western/English localization (mandatory)：**
- Voice: Natural, conversational American/Western English. Use contractions, casual phrasing, relatable humor
- Vocabulary: Current internet slang and platform-native language (「no cap」「lowkey」「vibe」「slay」「it's giving」「main character energy」「rent free」etc.) — calibrate to persona age/style
- Writing style: Punchy and concise. Cut filler words. No period at the end of posts — end with !, ?, or …
- Cultural references: Western pop culture, current events, holidays (Thanksgiving, Halloween, Super Bowl), Netflix/streaming trends, TikTok/Instagram culture
- Tone: Direct, punchy, emoji-friendly. Avoid overly formal or translated-sounding phrasing
- Forbidden: Literal translations from Chinese, awkward ESL phrasing, trailing periods`,

    sea: `**Southeast Asia English localization (mandatory)：**
- Voice: Friendly, warm SEA-inflected English. Mix of formal and casual, community-oriented tone
- Vocabulary: SEA internet culture (「lah」「lor」「wah」「shiok」「bojio」for SG/MY flavor; adapt to target country)
- Writing style: Concise and punchy. No period at the end of posts
- Cultural references: SEA festivals (CNY, Hari Raya, Songkran, Diwali), local food culture, regional trends
- Tone: Inclusive, relatable, community-first. Emojis and exclamation marks are natural
- Forbidden: Overly American slang that feels foreign to SEA audiences, trailing periods`,
  };

  // Detect sub-region for traditional Chinese and selected persona nationality.
  const localeKey = resolvePromptLocaleKey(setup, characters);
  const localeDirective = localeRules[localeKey] || "";
  const localeGuardrails: Record<string, string> = {
    cn_tw: `## 地區硬約束（優先順序最高）
- 目前帳號地區：台灣
- 參考檔案、過往記憶、熱門話題裡如果出現其他地區的地名、貨幣、稅制、平台或口語，只能視為來源噪音，不能直接沿用
- 只允許出現：台灣用語、台灣地名、台灣生活情境、台灣稅務/制度、新台幣（NT$／新台幣／台幣）
- 嚴禁出現：RM、MYR、令吉、馬幣、RMB、CNY、人民幣、HK$、港幣、MOP$、澳門元
- 若參考樣本裡出現 RM / MYR / 令吉 等境外金額，生成正文時必須改寫成台灣語境與新台幣表達，不能照抄`,
    cn_hk: `## 地區硬約束（優先順序最高）
- 目前帳號地區：香港
- 參考檔案、過往記憶、熱門話題裡如果出現其他地區的地名、貨幣、稅制、平台或口語，只能視為來源噪音，不能直接沿用
- 只允許出現：香港用語、香港地名、香港生活情境、香港製度、港幣（HK$／港幣／港元）
- 嚴禁出現：RM、MYR、令吉、馬幣、RMB、CNY、人民幣、NT$、新台幣、MOP$、澳門元`,
    cn_mo: `## 地區硬約束（優先順序最高）
- 目前帳號地區：澳門
- 參考檔案、過往記憶、熱門話題裡如果出現其他地區的地名、貨幣、稅制、平台或口語，只能視為來源噪音，不能直接沿用
- 只允許出現：澳門用語、澳門地名、澳門生活情境、澳門制度、澳門幣（MOP$／澳門元）
- 嚴禁出現：RM、MYR、令吉、馬幣、RMB、CNY、人民幣、NT$、新台幣、HK$、港幣`,
    cn: `## 地區硬約束（優先順序最高）
- 目前帳號地區：華語區
- 若參考樣本出現繁體區或其他國家/地區的貨幣、制度、地名或口語，只能保留寫作節奏，不能照抄當地元素
- 非明確需要時，不要混入 NT$、HK$、MOP$、RM、MYR 等異地區貨幣符號`,
  };
  const localeGuardrail = localeGuardrails[localeKey] || "";
  const regionalFlavorDirective = buildRegionalFlavorDirective(setup, localeKey, "post");
  const humanVoiceDirective = buildHumanVoiceDirective(isSimpleStyle);
  const personaToneDirective = buildPersonaToneDirective(setup, "post");

  // Combine memory + recent session posts into one context block
  const recentContext = recentPosts && recentPosts.length > 0
    ? recentPosts.map((c, i) => `[本次第${i + 1}篇] ${c.slice(0, 300)}`).join("\n\n")
    : "";

  return `你是一位專業的社交媒體內容創作者。

**輸出語言：${outputLang}** — 所有正文內容必須使用${outputLang}撰寫，不得混用其他語言。
${localeDirective ? `\n${localeDirective}\n` : ""}
${localeGuardrail ? `\n${localeGuardrail}\n` : ""}
${regionalFlavorDirective ? `\n${regionalFlavorDirective}\n` : ""}
${personaToneDirective ? `\n${personaToneDirective}\n` : ""}
${humanVoiceDirective ? `\n${humanVoiceDirective}\n` : ""}

## 帳號人設
- 人設型別：${personaTypes}
- 人設國籍/地區：${setup.personaNationality || "未指定（以目前市場設定為準）"}
${isPersonaMode ? `- 帳號名稱：${setup.personaName}
- 人設簡介：${setup.personaDescription || ""}
- 性格標籤：${setup.personalityTags || ""}
- 內容主題：${setup.contentTheme || ""}

## 文章版型（嚴格遵守）
${setup.postFormat || ""}` : `- 內容基調：${setup.personaStyle || setup.tone || ""}
${setup.customTopic ? `- 創作要求：${setup.customTopic}` : ""}`}

## 人設檔案（參考）
${characters.slice(0, 1500)}
${memory || recentContext ? `
## 人設記憶（長期連續性，優先級高於臨時創作靈感）
${memory ? `### 過往發布內容\n${memory}` : ""}
${recentContext ? `### 本次已生成內容\n${recentContext}` : ""}
- 必須把這些記憶當成已發生事實，不能重置、不能改寫、不能自相矛盾
- 如果是故事/章節型人設，下一篇要承接最新章節和事件推進；例如前文是第1章，後續自然進入第2章、第3章
- 如果再次提到過去事件，要使用合理的時間感和人物口吻，例如上週、上個月、那次去日本時，不要憑空把時間線寫亂
- 若記憶裡有伏筆、承諾、人物關係或正在進行的矛盾，優先延續這些線索
` : ""}
${todayNews ? `
## 目前多源資訊情報（新聞 / 社媒 / 地區熱梗）
以下是剛剛蒐集到的與該人設相關的多源資訊，通常會分成「新聞與趨勢」「社媒討論」「地區熱梗 / 網路語料」三段。生成推文時要先判斷哪一段最適合目前主題，再自然吸收其中的具體詞、情緒、場景或事件，讓人設看起來像真的有在追當下世界，而不是硬背熱搜：

${todayNews}
` : ""}

## 地區優先順序規則
- 目前「人設國籍/地區」與本機化規則，優先順序高於人設檔案、過往記憶、示例貼文、熱門話題裡的任何地區線索
- 如果參考內容和目前地區設定衝突，保留語氣和句式即可，具體貨幣、地名、制度、平台、節日、稅務描述必須改寫成目前地區版本
- 禁止為了模仿示例貼文而帶出錯誤地區元素

## 你的任務
${priorityInstruction ? `
## \u672C\u6B21\u4F7F\u7528\u8005\u8981\u6C42\uFF08\u6700\u9AD8\u512A\u5148\u7D1A\uFF0C\u5FC5\u9808\u57F7\u884C\uFF09
${priorityInstruction}
- \u4E0A\u65B9\u662F\u672C\u6B21\u751F\u6210\u7684\u4E3B\u984C\u548C\u786C\u7D04\u675F\uFF0C\u5FC5\u9808\u5148\u6EFF\u8DB3\u3002
- \u71B1\u9EDE\u3001\u904E\u5F80\u8A18\u61B6\u3001\u6587\u7AE0\u7248\u578B\u53EA\u80FD\u7528\u4F86\u8F14\u52A9\u8A9E\u6C23\u548C\u4EBA\u8A2D\uFF0C\u4E0D\u80FD\u53D6\u4EE3\u672C\u6B21\u4E3B\u984C\u3002
- \u5982\u679C\u4EBA\u8A2D\u9810\u8A2D\u3001\u8A18\u61B6\u6216\u71B1\u9EDE\u8207\u672C\u6B21\u4F7F\u7528\u8005\u8981\u6C42\u885D\u7A81\uFF0C\u4EE5\u4F7F\u7528\u8005\u8981\u6C42\u70BA\u6E96\u3002
` : ""}
${isSimpleStyle ? `
這是**簡單模板模式**，每條推文使用該帳號的**慣用固定句式**，不需要自由發揮。

**第一步：從人設檔案和示例貼文中提取這個帳號的固定句式模板。**

常見例子：
- 「色友們～想看我色色嗎？點心就給群++」→ 模板是「{稱呼}～{誘導語}？{互動指令}」
- 「一天一梗圖直到破處 day{數字}」→ 模板是「一天一梗圖直到破處 day{遞增數字}」
- 「今日限定：{主題}靈符」→ 模板是「今日限定：{主題}靈符」

**第二步：嚴格按提取到的模板生成 ${count} 條，只替換變數部分，保持句式不變。**

規則：
- 每條只替換模板中的變數（如數字、主題詞、稱呼），句式骨架完全一致
- 變數內容每條不同，有遞進感或多樣性
- 字數極短，就是模板那一句，不加任何額外內容
- 完全符合「${personaTypes}」人設的語氣和用字習慣
${existingCount > 0 ? `- 如果模板含遞增數字（如 day{數字}），從第 ${existingCount + 1} 條開始遞增` : ""}
${customInstruction ? `- 本次方向：${customInstruction}` : ""}

**格式：每條之間用「---」分隔，直接輸出，不加編號。**

**【重要】必須輸出恰好 ${count} 條，不多不少，用 --- 分隔。即使內容重複也要湊滿 ${count} 條。**

請直接輸出 ${count} 條：` : ((setup as any).isGirlPersona && useJinjunyaFreeHookStyle) ? `
這是一個**福利/美女傳播型人設**，核心是用圖片吸引互動，文字是勾起好奇心的"鉤子"。

${memeImageItems && memeImageItems.length > 0 ? `
**【先圖後文模式】** 以下是已經蒐集好的 ${memeImageItems.length} 張圖片：

${memeImageItems.slice(0, count).map((item, i) => {
  const desc = item.context ? `圖片描述："${item.context}"` : "（人物寫真/生活照）";
  return `圖片 ${i + 1}：${desc}`;
}).join("\n\n")}

**要求：**
- 前 ${Math.min(count, memeImageItems.length)} 條為上面的圖片各寫一條引子（第1條對應圖片1……）
${count > memeImageItems.length ? `- 後 ${count - memeImageItems.length} 條自由發揮，寫符合人設的引子（不綁定圖片）` : ""}
- 總共輸出 **${count} 條**
- 每條字數控制在 **${wordRange}**
- 文字要與圖片場景呼應，但用暗示而非直說
- 核心技巧：用日常場景、情緒、動作來暗示，讓讀者自己腦補
- 常用句式：「今天有點熱，換了套…你們猜猜」「剛洗完澡，鏡子裡的自己…」「睡前發一張，晚安」「這條裙子穿出去，回頭率…」
- 互動鉤子：結尾留懸念或提問（「你們覺得呢」「猜猜我穿了什麼」「點心的來」）
- 如果使用點贊門檻句式（如「點心滿 X 就發」），**X 必須固定為同一個數字，禁止每條遞增**
- 每條風格輪換（撒嬌型 / 懸念型 / 自嘲型 / 互動型 / 日常型）
- 完全符合「${personaTypes}」人設的語氣
- **禁止**：直白的色情描述、違規詞彙、過於露骨的表達
${todayNews ? `- 可以結合目前熱點：${todayNews.slice(0, 200)}` : ""}
${existingCount > 0 ? `- 這是第 ${existingCount + 1} 到 ${existingCount + count} 條，避免與前 ${existingCount} 條重複` : ""}
${customInstruction ? `- 本次方向：${customInstruction}` : ""}
` : `
請生成 **${count} 條**引子文案，每條字數控制在 **${wordRange}**。

**寫作策略（必須執行）：**
- 核心技巧：**暗示而非直說**。用日常場景、情緒、動作來暗示，讓讀者自己腦補
- 常用句式：「今天有點熱，換了套…你們猜猜」「剛洗完澡，鏡子裡的自己…」「有人說我這樣拍不太好，但我覺得…」「睡前發一張，晚安」「這條裙子穿出去，回頭率…」
- 互動鉤子：結尾留懸念或提問，誘導點贊/評論（「你們覺得呢」「猜猜我穿了什麼」「點心的來」）
- 如果使用點贊門檻句式（如「點心滿 X 就發」），**X 必須固定為同一個數字，禁止每條遞增**
- 語氣：親切、略帶撒嬌、真實感強，像真人在發朋友圈
- 每條風格輪換（撒嬌型 / 懸念型 / 自嘲型 / 互動型 / 日常型）
- 完全符合「${personaTypes}」人設的語氣
- **禁止**：直白的色情描述、違規詞彙、過於露骨的表達
${todayNews ? `- 可以結合目前熱點：${todayNews.slice(0, 200)}` : ""}
${existingCount > 0 ? `- 這是第 ${existingCount + 1} 到 ${existingCount + count} 條，避免與前 ${existingCount} 條重複` : ""}
${customInstruction ? `- 本次方向：${customInstruction}` : ""}
`}

**格式：每條之間用「---」分隔，直接輸出文案，不加編號。**

請直接輸出 ${count} 條引子文案：` : (setup as any).isMemePersona ? `
這是一個**圖片傳播型人設**（梗圖/段子帳號），推文以圖片為主角，文字只是引子。

${memeImageItems && memeImageItems.length > 0 ? `
**【先圖後文模式】** 以下是已經蒐集好的 ${memeImageItems.length} 張梗圖：

${memeImageItems.slice(0, count).map((item, i) => {
  const desc = item.context ? `圖片視覺描述/頁面線索："${item.context}"` : "（無描述）";
  return `圖片 ${i + 1}：${desc}\n圖片來源：${item.source}`;
}).join("\n\n")}

**要求：**
- 前 ${Math.min(count, memeImageItems.length)} 條為上面的圖片各寫一條引子（第1條對應圖片1……）
${count > memeImageItems.length ? `- 後 ${count - memeImageItems.length} 條自由發揮，寫符合人設的梗圖引子（不綁定圖片）` : ""}
- 總共輸出 **${count} 條**
- 每條字數控制在 **${wordRange}**
- 文案必須直接回應圖片裡能看見的內容，至少點到一個具體視覺元素：主體 / 表情 / 動作 / 道具 / 場景
- 先看“圖片視覺描述”，再寫文案；禁止只圍繞人設主題空泛發揮
- 禁止脫離圖片另起話題，禁止把圖片沒出現的劇情、關係、身份硬寫進去
- 如果圖片描述偏弱，也必須圍繞可見主體或動作寫，不要自由發揮成泛話題吐槽
- 每條風格各不相同（感嘆型 / 提問型 / 吐槽型 / 自嘲型 / 互動型 輪換）
- 完全符合「${personaTypes}」人設的語氣
${todayNews ? `- 可以結合目前熱點：${todayNews.slice(0, 200)}` : ""}
${existingCount > 0 ? `- 這是第 ${existingCount + 1} 到 ${existingCount + count} 條，避免與前 ${existingCount} 條重複` : ""}
${customInstruction ? `- 本次方向：${customInstruction}` : ""}
` : `
請生成 **${count} 條**引子文案，每條字數控制在 **${wordRange}**。

**梗圖引子格式要求：**
- 文字是圖片的"鉤子"，引發好奇或共鳴，讓人想看圖
- 可以是一句感嘆、一個問題、一個場景描述、一個吐槽
- 不需要完整敘事，圖片才是主角
- 每條風格各不相同（感嘆型 / 提問型 / 吐槽型 / 自嘲型 / 互動型 輪換）
- 完全符合「${personaTypes}」人設的語氣
${todayNews ? `- 可以結合目前熱點：${todayNews.slice(0, 200)}` : ""}
${existingCount > 0 ? `- 這是第 ${existingCount + 1} 到 ${existingCount + count} 條，避免與前 ${existingCount} 條重複` : ""}
${customInstruction ? `- 本次方向：${customInstruction}` : ""}
`}

**格式：每條之間用「---」分隔，直接輸出文案，不加編號。**

請直接輸出 ${count} 條引子文案：` : `
請生成 **${count} 篇**獨立完整的短文，每篇都是一個完整的內容。

${wordRange ? `**字數要求：每篇嚴格控制在 ${wordRange}，這是每篇獨立文章的字數，不是總字數。**\n` : ""}
**【核心要求：差異化】同一批生成的 ${count} 篇必須做到以下差異化，禁止雷同：**
- 話題維度各不相同（例如：第1篇講具體事件，第2篇講情緒感受，第3篇講實用技巧，第4篇講觀點看法，第5篇講互動提問……以此類推）
- 開頭方式各不相同（不能都以相同句式或相同情緒開頭）
- 結構各不相同（敘事型 / 實用內容型 / 吐槽型 / 提問型 / 故事型 輪換使用）
- 情緒基調各不相同（正能量 / 輕鬆幽默 / 感性共鳴 / 理性分析 輪換）
- 禁止在同一批中出現兩篇核心觀點相同或故事背景相似的內容

其他要求：
- 每篇都是獨立完整的內容，有開頭、發展、結尾
${wordRange ? `- 每篇字數嚴格控制在 ${wordRange}\n` : ""}- 完全符合「${personaTypes}」人設的語氣和性格
- 內容真實貼近生活，像真人在分享日常
- 如果新內容涉及過去經歷，必須與上方記憶保持一致
${todayNews ? `- 必須自然融入上方「目前網路熱門話題」中的內容，使用流行用語，引用熱點事件，讓推文顯得真實、時髦` : ""}
${isPersonaMode ? `- 嚴格按照上方「文章版型」的格式` : ""}
${existingCount > 0 ? `- 這是第 ${existingCount + 1} 到 ${existingCount + count} 篇，避免與前 ${existingCount} 篇重複` : ""}
${customInstruction ? `- 本次創作方向：${customInstruction}` : ""}

**真人感要求（必須執行）：**
- 根據人設性格和內容情緒，在合適位置自然插入 emoji（每篇 2-5 個，不要堆砌）
- 可以使用符合人設的顏文字（如 (´▽\`）、(╥﹏╥)、ヾ(≧▽≦*)o 等）或網路表情（如 😭😂🤣 等），選擇與人設氣質匹配的風格
- 可以適當使用口語化表達、語氣詞（啊、哦、嗯、哈哈、哇）、網路用語，讓文字有溫度
- 段落之間可以有自然的換行和節奏感，不要寫成一整塊文字
- 結尾可以加互動引導（如提問、邀請評論），增加真實感
- **每篇結尾不加句號**，用感嘆號、問號、省略號或 emoji 收尾更有力

**格式要求：每篇之間用「---」分隔，不要加編號，直接輸出正文內容。**

請直接輸出 ${count} 篇完整短文：`}`;
}
