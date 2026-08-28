from __future__ import annotations

from collections.abc import Mapping
from typing import Any


IMAGE_EDIT_DEFAULT_PROMPT = (
    "根据上传图片生成一张电商宣传海报：以图1商品/空间/服务主体为核心主视觉，图2人物如有则作为品牌代言人或场景体验者自然融入画面；"
    "如果上传了多张商品/空间/服务参考图，先判断每张图的有效信息，自行选择一张或多张最适合的图片作为主体、细节、包装、卖点或场景参考；"
    "不要套用固定模板，要先判断品类、客单价、使用场景和购买理由，再选择不同的海报风格与版式；"
    "汽车、房地产、珠宝腕表等高客单价品类要走高级感、高大上的品牌KV：大留白、低机位或广角透视、电影级光影、克制文字和强主视觉；"
    "生活家具、家居家纺、母婴宠物等生活方式品类要走真实生活化场景：温暖自然光、居家空间、人物真实使用、舒适氛围和可想象的生活改善；"
    "食品饮料、美妆个护要突出感官和质感；数码家电要突出科技、效率和功能光效；普通快消要突出清晰产品、卖点标签和购买转化；"
    "版式可以是品牌大片KV、生活方式海报、详情页首屏、杂志感构图或网格信息流，但必须符合当前品类，不要所有产品都做成同一套三段式模板；"
    "包含清晰主标题、2-4个卖点标签、CTA按钮或咨询引导和短标语，文字位置要顺应画面构图，不能机械堆在顶部或底部；"
    "文案必须基于图片可见信息和合理轻推断，不要编造不可验证卖点；没有真实品牌或Logo时不要绘制任何品牌占位文字，可留空或使用抽象小图形标识；"
    "房地产文案只写稳妥卖点，如采光、通勤、停车便利、户型、物业、配套等；不要写无法从图片确认或过度承诺的词。"
    "必须重新设计整张图的海报构图，主体占主视觉，人物只能辅助代言或展示，不要抢主体；"
    "如果有模特/人物参考图，人物必须按真实透视落在地面或真实接触面上，脚底不悬浮，身体比例与主体和环境尺度一致；"
    "人物比例必须按品类调整：房屋、楼盘、建筑、汽车、家具等大体量主体中，人物只做尺度参照和讲解辅助，建议占画面高度12%-24%；服装、美妆、食品等人物展示型品类可更突出；不能过大、过小、贴边、悬浮、被裁断、站进文字栏或CTA按钮区；"
    "人物站位应在左下/右下/侧前方等画面安全区，并和商品/空间形成介绍关系，视线或手势自然指向主体，不能遮挡主体、标题、卖点标签或CTA。"
    "文字尽量简洁、规整、像真实电商海报，不要乱码、水印或无关品牌。"
)
IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT = (
    "本次没有上传模特、人物、导购、手部或品牌人物参考图，必须按纯产品电商广告图处理。"
    "画面只能围绕输入产品/空间/服务主体、真实使用环境、材质细节、功能结果和卖点层级展开；"
    "严禁新增任何真人、数字人、模特、销售顾问、导购、讲解员、人物半身像、人物全身、脸、手、手臂、人体局部、"
    "人形立牌、人像海报或人物倒影。"
    "如果用户文字里出现“人物比例”“模特”“导购”等泛化描述，也不要生成任何人物，除非实际上传了模特/人物参考图。"
)
THREE_VIEW_DEFAULT_PROMPT = (
    "综合上传的产品角度图还原同一产品的正面、侧面、背面三视图参考板，"
    "保持产品结构、包装颜色和材质，白色或浅灰纯背景，不要文字，不要海报排版。"
)
THREE_VIEW_PROMPT_CONSTRAINTS = (
    "这是同一产品的结构参考三视图，不是电商海报或广告图。"
    "只展示同一产品的正面、侧面、背面三个角度并排在同一张参考板中，产品完整居中，三个角度大小和比例一致，"
    "使用白色或浅灰纯背景、平视视角和均匀柔光。"
    "保留输入产品真实的外观、结构、包装形状、颜色、材质和已有品牌图形位置，但不要新增或重绘可读文字。"
    "禁止标题、卖点、参数、百分比、CTA、按钮、图标、信息图、场景道具、人物、装饰图形、水印和任何海报排版。"
    "不要生成单张宣传主视觉，不要生成商品详情页或促销海报。"
)
IMAGE_EDIT_ENVIRONMENT_INTEGRATION_PROMPT = (
    "不要把图2人物直接裁切贴到图1上；必须重新渲染整张图，让人物成为图1真实场景中拍摄的一部分。"
    "严格匹配图1的相机视角、焦距、地平线、透视比例、镜头畸变、光照方向、阴影方向、色温、对比度、颗粒和清晰度。"
    "人物脚下或身体与环境接触处必须有自然接触阴影和环境遮挡，边缘要有真实景深、反射光和空气透视，不能出现抠图白边、悬浮感、贴纸感或棚拍质感。"
    "如果是房产/空间场景，人物应像现场销售顾问站在真实地面或空间中讲解，身体比例与建筑/家具/车辆尺度一致。"
)

TARGET_LANGUAGE_SPECS = {
    "Japanese": {"label": "日语", "audio": "Japanese"},
    "Malay": {"label": "马来语", "audio": "Malay"},
    "Spanish": {"label": "西班牙语", "audio": "Spanish"},
    "Thai": {"label": "泰语", "audio": "Thai"},
    "Indonesian": {"label": "印尼语", "audio": "Indonesian"},
    "Chinese": {"label": "中文", "audio": "Chinese"},
    "English": {"label": "英文", "audio": "English"},
}

SUBJECT_REPLACE_DEFAULT_USER_PROMPT = (
    "请根据原始图片和目标商品/人物图精准判断替换区域；只替换原图中对应的人物或商品主体，"
    "原图中的建筑、背景、光影、构图、招牌、Logo、包装文字、门头文字、海报文字和其他可读文字必须完整保留。"
)
SUBJECT_REPLACE_LEGACY_PROMPTS = {
    "主体替换局部编辑，不生成广告海报、标题、卖点文字、图标或Logo。",
    "识别替换图是商品还是模特；若是商品，替换原图中所有同类商品；若是模特，替换原图中的人物。保持原图背景、光影、构图和无关内容不变，不新增文字。",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def append_once(text: Any, clause: Any) -> str:
    base = _text(text)
    addition = _text(clause)
    if not addition or addition in base:
        return base
    return f"{base} {addition}".strip()


def normalize_target_language(value: Any, *, default: str = "Chinese") -> str:
    text = _text(value)
    aliases = {
        "日本": "Japanese",
        "日语": "Japanese",
        "日本語": "Japanese",
        "japanese": "Japanese",
        "马来西亚": "Malay",
        "馬來西亞": "Malay",
        "马来语": "Malay",
        "馬來語": "Malay",
        "malay": "Malay",
        "bahasa malaysia": "Malay",
        "bahasa melayu": "Malay",
        "西班牙语": "Spanish",
        "español": "Spanish",
        "spanish": "Spanish",
        "泰语": "Thai",
        "thai": "Thai",
        "印尼语": "Indonesian",
        "印度尼西亚语": "Indonesian",
        "indonesian": "Indonesian",
        "中文": "Chinese",
        "汉语": "Chinese",
        "chinese": "Chinese",
        "英文": "English",
        "英语": "English",
        "english": "English",
    }
    if text in TARGET_LANGUAGE_SPECS:
        return text
    return aliases.get(text.lower(), aliases.get(text, default))


def target_language_label(value: Any) -> str:
    language = normalize_target_language(value)
    return _text(TARGET_LANGUAGE_SPECS.get(language, TARGET_LANGUAGE_SPECS["Chinese"]).get("label")) or "中文"


def ensure_environment_integration_prompt(prompt_text: Any) -> str:
    text = _text(prompt_text)
    if not text:
        return IMAGE_EDIT_ENVIRONMENT_INTEGRATION_PROMPT
    markers = ("重新渲染", "接触阴影", "透视", "光照方向", "贴图", "贴纸感", "悬浮感", "环境遮挡")
    if sum(1 for marker in markers if marker in text) >= 3:
        return text
    return f"{text} {IMAGE_EDIT_ENVIRONMENT_INTEGRATION_PROMPT}".strip()


def ensure_product_details_prompt(prompt_text: Any, payload: Mapping[str, Any] | None) -> str:
    source = payload or {}
    text = _text(prompt_text)
    details = _text(source.get("product_details") or source.get("product_description") or source.get("product_intro"))
    if not details:
        return text
    if details in text and ("产品相关简介" in text or "用户简介" in text or "用户填写" in text):
        return text
    clause = (
        f"用户填写的产品相关简介：{details}。"
        "最终广告图需要吸收这些信息，但不要生硬逐字照搬。"
        "优先用画面表达或自然转译来体现：例如通过使用场景、动作动势、功能结果、材质质感、光效、图标或少量短卖点表达；"
        "如果使用文字，只写短而自然的广告卖点，不要把用户原句拆成一排标签，不要编造简介之外的价格、参数或承诺。"
    )
    return append_once(text, clause)


def apply_product_only_prompt_constraints(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    updated = dict(payload or {})
    if _text(updated.get("mode")) != "product_only":
        return updated
    updated.pop("model_image_local_path", None)
    updated.pop("model_image_local_paths", None)
    updated["ecommerce_model_reference_skipped"] = True
    updated["prompt"] = append_once(
        updated.get("prompt") or updated.get("prompt_text") or updated.get("message"),
        IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT,
    )
    updated["prompt_text"] = updated["prompt"]
    updated["tg_user_instruction"] = append_once(
        updated.get("tg_user_instruction") or updated.get("prompt") or updated.get("prompt_text"),
        IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT,
    )
    return updated


def build_product_or_model_prompt(payload: Mapping[str, Any] | None, *, mode: Any = None) -> str:
    source = dict(payload or {})
    normalized_mode = _text(mode if mode is not None else source.get("mode")) or "product_only"
    source["mode"] = normalized_mode
    if normalized_mode == "product_only":
        source = apply_product_only_prompt_constraints(source)
    prompt = _text(source.get("prompt") or source.get("prompt_text") or source.get("message"))
    if not prompt:
        raise RuntimeError("图片生成需要填写提示词")
    prompt = ensure_product_details_prompt(prompt, source)
    return ensure_environment_integration_prompt(prompt)


def digital_human_character_region_prompt(region: Any, label: Any = "") -> str:
    region_key = _text(region).lower()
    label_text = _text(label)
    mapping = {
        "china": "中国人", "western": "欧美人", "europe_america": "欧美人",
        "indonesia": "印尼人", "thailand": "泰国人", "japan": "日本人", "malaysia": "马来西亚人",
    }
    identity = mapping.get(region_key) or (f"{label_text}人" if label_text else "真实人物")
    return (
        f"{identity}，自然上镜，脸型精致，五官协调，现代写实审美，"
        "避免刻板化、脸谱化或夸张地域特征"
    )


_DIGITAL_HUMAN_HAIRSTYLE_LABELS = {
    "short_clean": "利落短发", "shoulder_length": "中长发", "long_straight": "长直发",
    "bob": "波波头", "soft_wave": "微卷发", "ponytail": "马尾", "bun": "盘发",
    "air_bangs_long": "刘海长发", "side_part": "偏分短发", "crew_cut": "寸头",
    "textured_short": "纹理短发", "slick_back": "背头", "medium_layered": "中短层次发",
}

_DIGITAL_HUMAN_TEMPERAMENT_LABELS = {
    "gentle": "亲和自然", "business": "商务干练", "elegant": "优雅知性",
    "lively": "活力外向", "sweet": "清新甜美", "cool": "高级冷感",
    "calm": "沉稳大气", "sunny": "阳光亲和", "elite": "精英专业",
    "street": "潮流自信", "adult_glamour": "妩媚性感",
}

_DIGITAL_HUMAN_CLOTHING_LABELS = {
    "formal_suit": "正式西装套装", "smart_casual_set": "通勤休闲套装",
    "soft_knit_set": "针织舒适套装", "casual_jacket_set": "休闲夹克套装", "sporty": "运动套装",
    "tailored_suit_female": "女士西装套装", "business_dress_female": "轻商务裙装套装",
    "elegant_commute_female": "优雅通勤套装", "soft_knit_set_female": "温柔针织套装",
    "sporty_female": "运动休闲套装", "blazer_dress_female": "轻商务连衣裙套装",
    "shirt_skirt_female": "学院感半裙套装", "knit_jeans_female": "针织休闲套装",
    "sweet_female": "清新甜美裙装套装", "silk_blouse_trousers_female": "高级通勤套装",
    "elegant_female": "优雅知性裙装套装", "knit_cardigan_female": "温柔针织裙装套装",
    "daily_female": "简洁日常套装", "intimate_glamour_female": "福利诱惑套装",
    "dark_suit_male": "男士西装套装", "smart_commute_male": "商务通勤套装",
    "polo_casual_male": "商务休闲套装", "casual_jacket_male": "成熟休闲套装",
    "sporty_male": "运动休闲套装", "shirt_chinos_male": "清爽通勤套装",
    "polo_chinos_male": "轻商务休闲套装", "street_male": "潮流街头套装",
    "knit_male": "简约针织套装", "shirt_trousers_male": "稳重通勤套装",
    "knit_cardigan_male": "温和针织套装",
}


def _selected_clothing_style_prompt(clothing_key: str, clothing: str) -> str:
    if clothing_key == "intimate_glamour_female":
        return "性感福利风格，明显露肤、清凉妩媚、高级写真感，服装款式由模型自主设计"
    return f"{clothing.removesuffix('套装')}风格，服装由模型自主设计"


def build_digital_human_character_selection_prompt(payload: Mapping[str, Any] | None) -> str:
    """Expand broad UI choices into model-facing visual directions."""
    source = payload or {}
    parts: list[str] = []
    region = _text(source.get("digital_human_character_region"))
    region_label = _text(source.get("digital_human_character_region_label"))
    if region or region_label:
        parts.append(digital_human_character_region_prompt(region, region_label).rstrip("。"))

    gender = _text(source.get("character_gender")).lower()
    age = _text(source.get("character_age")).lower()
    gender_label = {"female": "女性", "male": "男性"}.get(gender, "人物")
    age_label = {
        "18_22": "18至22岁的成年",
        "23_27": "23至27岁的成年",
        "28_32": "28至32岁的成年",
        "33_38": "33至38岁的成年",
        "39_45": "39至45岁的成熟",
        "46_55": "46至55岁的成熟",
        "56_plus": "56岁以上的成熟",
    }.get(age, "")
    if gender or age_label:
        parts.append(f"{age_label or '成年'}{gender_label}，自然身材比例")

    hairstyle = _DIGITAL_HUMAN_HAIRSTYLE_LABELS.get(_text(source.get("character_hairstyle")).lower())
    if hairstyle:
        parts.append(hairstyle)
    temperament_key = _text(source.get("character_temperament")).lower()
    temperament = _DIGITAL_HUMAN_TEMPERAMENT_LABELS.get(temperament_key)
    if temperament:
        parts.append(f"{temperament}气质")
    clothing_key = _text(source.get("character_clothing")).lower()
    clothing = _DIGITAL_HUMAN_CLOTHING_LABELS.get(clothing_key)
    if clothing:
        parts.append(_selected_clothing_style_prompt(clothing_key, clothing))
    return "，".join(parts)


def build_digital_human_character_prompt(payload: Mapping[str, Any] | None) -> str:
    source = payload or {}
    user_prompt = _text(source.get("prompt") or source.get("prompt_text") or source.get("message"))
    reference_values = [
        _text(source.get("product_image_local_path")),
        _text(source.get("character_reference_image_local_path")),
        *[_text(item) for item in (source.get("product_image_local_paths") or []) if _text(item)],
        *[_text(item) for item in (source.get("character_reference_image_local_paths") or []) if _text(item)],
    ]
    has_reference = bool({item for item in reference_values if item})
    selection_text = build_digital_human_character_selection_prompt(source)
    if has_reference:
        reference_clause = (
            "输入图是用户上传的人设参考图。"
            "性别、年龄段、脸型、五官比例、肤色、身材比例、核心气质和整体风格必须从参考图自动判断，"
            "不得被表单预设、地区特征或补充文字覆盖。"
            "输入包含多张三视图参考图时，必须综合所有参考图保持同一人物身份、发型、服装结构、正侧背一致性和体型比例。"
            "用户明确调整发型、服装时，只允许在保持参考人物身份、性别、年龄段、脸型、五官和核心气质不变的前提下应用这些调整。"
        )
        allowed_directions = f"{selection_text}。" if selection_text else ""
        supplement = f"{user_prompt}。" if user_prompt else ""
        character_clause = (
            f"{allowed_directions}{supplement}不得用这些文字改变参考人物身份、性别、年龄段或核心气质。"
            if allowed_directions or supplement
            else "未指定发型、服装调整时，发型、服装、妆容和气质均跟随参考图。"
        )
    else:
        reference_clause = ""
        selected_directions = f"{selection_text}。" if selection_text else ""
        supplement = f"{user_prompt}。" if user_prompt else ""
        character_clause = selected_directions + supplement or (
            "AI 自动生成一个适合商业口播、直播带货、品牌短视频使用的数字人人设，包含清晰年龄段、职业感、气质、发型、服装和妆容。"
        )
    return (
        "生成一张数字人人设三视图设定图。"
        f"{reference_clause}"
        f"{character_clause}"
        "画面必须是同一个角色的三视图，正面、左侧面、背面并排展示，角色身份、脸型、发型、身材比例、服装完全一致。"
        "全身站姿，纯白背景，棚拍级柔和光线，真实高级数字人质感，可用于后续建模和视频生成参考。"
        "不要出现文字、标签、箭头、尺寸线、Logo、水印、品牌名、多余装饰；不要生成多人；不要改变服装。"
    )


def build_three_view_prompt(prompt_text: Any) -> str:
    text = _text(prompt_text) or THREE_VIEW_DEFAULT_PROMPT
    if text == IMAGE_EDIT_DEFAULT_PROMPT:
        text = THREE_VIEW_DEFAULT_PROMPT
    return append_once(text, THREE_VIEW_PROMPT_CONSTRAINTS)


def subject_replace_user_prompt(payload: Mapping[str, Any] | None) -> str:
    source = payload or {}
    prompt = _text(source.get("prompt") or source.get("prompt_text") or source.get("message"))
    if prompt in SUBJECT_REPLACE_LEGACY_PROMPTS:
        return SUBJECT_REPLACE_DEFAULT_USER_PROMPT
    return prompt


def build_subject_replace_prompt(payload: Mapping[str, Any] | None) -> str:
    source = payload or {}
    product_ref = _text(source.get("subject_replace_product_image_local_path"))
    model_ref = _text(source.get("subject_replace_model_image_local_path"))
    user_prompt = subject_replace_user_prompt(source)
    preserve_text_clause = (
        "必须先精准观察 @Image 1 的真实内容，识别画面中的建筑、空间、商品、人物、招牌、门牌、包装、海报、屏幕、字幕、Logo 和所有可读文字。"
        "除被替换主体自身表面被新主体覆盖的文字或标识外，@Image 1 中所有未被替换主体遮挡的文字、招牌、门牌、Logo、包装文字、海报文字、水印和图标都必须原位置、原语种、原内容、原字体风格保留；"
        "不得删除、翻译、改写、重排、模糊化或用伪文字替换原图文字。"
        "如果替换商品/人物会遮挡原图文字，只允许按真实遮挡关系覆盖被主体占据的区域，不能把周围背景文字一起抹掉。"
        "如果新商品自身带有包装文字或 Logo，只保留在新商品自身表面，不要扩散到背景区域。"
    )
    user_clause = f"用户补充要求：{user_prompt}。" if user_prompt else ""
    if product_ref and model_ref:
        return (
            "执行纯局部图片主体替换任务，不是电商海报生成任务。输入包含三张图：@Image 1 是需要被替换的原图，@Image 2 是商品替换参考图，@Image 3 是模特替换参考图。"
            "如果用户要求替换商品、产品、包装、设备、服装、汽车、家具、食品、美妆或其他物体，只能使用 @Image 2，必须识别 @Image 1 中所有同类商品/同品类物体实例并全部替换；"
            "如果用户要求替换人物、模特、真人、数字人或人像，只能使用 @Image 3，只替换 @Image 1 中对应的人物/模特主体；"
            "绝不同时替换商品和人物，也不要把商品参考图用于替换人物，不要把模特参考图用于替换商品。"
            "同一画面里出现多个同类产品时不要只替换一个，不要遗漏远处、手中、桌面上或背景中的同类产品。"
            "必须保留 @Image 1 的构图、背景、光线、透视、画幅、风格、阴影和其他未被替换元素。"
            "替换后的主体要使用对应参考图的外观、身份、材质、颜色、款式和比例，并自然融入原图环境。"
            "严禁生成广告海报版式，严禁新增标题、卖点文案、参数文字、标签、底部横幅或边框。"
            f"{preserve_text_clause}"
            f"{user_clause}"
            "不要替换错误主体，不要新增无关人物或商品。"
        )
    if product_ref:
        return (
            "执行纯局部图片主体替换任务，不是电商海报生成任务。输入包含两张图：@Image 1 是需要被替换的原图，@Image 2 是用来替换的新商品参考图。"
            "必须识别 @Image 1 中所有同类商品/同品类物体实例，并全部替换为 @Image 2 的主体外观；"
            "同一画面里出现多个同类产品时不要只替换一个，不要遗漏远处、手中、桌面上或背景中的同类产品。"
            "必须保留 @Image 1 的构图、背景、光线、透视、画幅、风格、阴影和其他未被替换元素。"
            "替换后的商品要使用 @Image 2 的外观、材质、颜色、款式和比例，并自然融入原图环境。"
            "严禁生成广告海报版式，严禁新增标题、卖点文案、参数文字、标签、底部横幅或边框。"
            f"{preserve_text_clause}"
            f"{user_clause}"
            "不要替换人物，不要新增无关人物或商品。"
        )
    if model_ref:
        return (
            "执行纯局部图片主体替换任务，不是电商海报生成任务。输入包含两张图：@Image 1 是需要被替换的原图，@Image 2 是用来替换的新模特参考图。"
            "只替换 @Image 1 中对应的人物/模特主体，不要替换商品、包装、道具、家具、背景或其他物体。"
            "必须保留 @Image 1 的构图、背景、光线、透视、画幅、风格、阴影和其他未被替换元素。"
            "替换后的模特要使用 @Image 2 的身份、脸型、发型、肤色、服装风格和身材比例，并自然融入原图环境。"
            "严禁生成广告海报版式，严禁新增标题、卖点文案、参数文字、标签、底部横幅或边框。"
            f"{preserve_text_clause}"
            f"{user_clause}"
            "不要替换错误主体，不要同时替换商品和人物，不要新增无关人物或商品。"
        )
    return (
        "执行纯局部图片主体替换任务，不是电商海报生成任务。输入包含两张图：@Image 1 是需要被替换的原图，@Image 2 是用来替换的新主体参考图。"
        "先判断 @Image 2 的主体类型：如果是人物、模特、真人、数字人或人像，只替换 @Image 1 中对应的人物/模特主体；"
        "如果是商品、产品、包装、设备、服装、汽车、家具、食品、美妆或其他物体，必须识别 @Image 1 中所有同类商品/同品类物体实例，并全部替换为 @Image 2 的主体外观；"
        "同一画面里出现多个同类产品时不要只替换一个，不要遗漏远处、手中、桌面上或背景中的同类产品。"
        "必须保留 @Image 1 的构图、背景、光线、透视、画幅、风格、阴影和其他未被替换元素。"
        "替换后的主体要使用 @Image 2 的外观、身份、材质、颜色、款式和比例，并自然融入原图环境。"
        "严禁生成广告海报版式，严禁新增标题、卖点文案、参数文字、标签、底部横幅或边框。"
        f"{preserve_text_clause}"
        f"{user_clause}"
        "不要替换错误主体，不要同时替换人物和商品，不要新增无关人物或商品。"
    )


def build_poster_translate_prompt(payload: Mapping[str, Any] | None) -> str:
    source = payload or {}
    language = normalize_target_language(source.get("target_language") or source.get("language"))
    label = target_language_label(language)
    return (
        "执行电商海报文字语种切换任务。输入 @Image 1 是原始电商海报图。"
        f"必须把海报画面中所有可见的广告文字、标题、卖点、标签、按钮、角标、参数说明、底部标语和正文都改写为自然准确的{label}。"
        f"不要保留原语言文字；如果原图中存在中文、英文或其他语言文案，都要替换成{label}。"
        "必须保持原海报的商品、人物、背景、构图、画幅、排版层级、文字区域位置、字体大小关系、颜色风格和商业质感。"
        "只做文字语言转换和必要的本地化改写，不要重新设计海报，不要改变产品外观，不要替换人物，不要新增无关商品、图标、Logo、水印、边框或额外卖点。"
        "翻译后的文案要短、清晰、像真实目标市场电商海报，避免乱码、伪文字、拼写错误、混合语言和过长段落。"
        "品牌名和产品包装固有标识如必须保留才能维持真实商品识别，可以保持原样；海报叠加宣传文案必须切换为目标语言。"
    )


def build_scene_image_prompt(payload: Mapping[str, Any] | None) -> str:
    source = payload or {}
    prompt = _text(source.get("prompt") or source.get("prompt_text") or source.get("message"))
    if not prompt:
        raise RuntimeError("图片生成需要填写提示词")
    prompt = (
        f"{prompt}\n"
        "生成一张真实自然、可作为数字人口播背景的场景图。"
        "画面不要出现人物、商品硬广、可读文字、字幕、水印、Logo 或UI界面。"
        "必须像真实手机或相机现场拍摄的照片，而不是3D渲染、CG样板间、建筑/室内效果图或AI概念图。"
        "重点放在真实镜头质感：真实光源方向、明暗层次、局部高光、接触阴影、合理动态范围、轻微镜头畸变、空间透视和背景景深层次。"
        "光线可以是自然光、室内灯光、窗光与灯光混合或夜间室内光，但必须符合真实现场摄影的受光逻辑，不能是CG渲染式均匀假光。"
        "如果用户没有明确要求暗调、夜景或低照度氛围，默认生成整体偏明亮通透的普通现场照：主体区域、桌面/墙面/地面和背景层次都要有足够可见度，但不要过曝、发白、丢失高光细节或变成棚拍大平光。"
        "保留材质微纹理和边缘细节，不要把墙面、桌面、织物、木纹、玻璃、金属或植物表面磨平成塑料质感。"
        "所有材质都要有真实照片里的非均匀细节：墙面细微颗粒、木纹纹路、纸张纤维、布料织纹、植物叶脉、玻璃反光和金属边缘高光都不能被AI平滑掉。"
        "场景保持正常整洁、现代、不过度空泛；可以有少量自然摆放的日常物件作为尺度参考，但不要故意做旧、脏污、磨损、杂乱或复古化。"
        "不要酒店样板间、棚拍布景、塑料质感、完美无瑕的CG光滑表面、虚假全局光、过强景深虚化、过度降噪、AI磨皮式平滑、过度锐化或渲染器高光。"
        "保持空间透视平稳、光线自然、画面可信，适合后续融合数字人口播人物。"
    )
    return ensure_environment_integration_prompt(prompt)


def build_image_mode_prompt(payload: Mapping[str, Any] | None, mode: Any = None) -> str:
    source = dict(payload or {})
    normalized_mode = _text(mode if mode is not None else source.get("mode")) or "product_only"
    source["mode"] = normalized_mode
    if normalized_mode in {"product_only", "model_product"}:
        return build_product_or_model_prompt(source, mode=normalized_mode)
    if normalized_mode == "digital_human_character":
        return build_digital_human_character_prompt(source)
    if normalized_mode == "three_view":
        return build_three_view_prompt(source.get("prompt") or source.get("prompt_text") or source.get("message"))
    if normalized_mode == "subject_replace":
        return build_subject_replace_prompt(source)
    if normalized_mode == "poster_translate":
        return build_poster_translate_prompt(source)
    if normalized_mode == "scene_image":
        return build_scene_image_prompt(source)
    raise ValueError(f"unsupported image_generate prompt mode: {normalized_mode}")


# Mainline-friendly alias: both names describe the same pure prompt dispatcher.
build_image_generate_prompt = build_image_mode_prompt


__all__ = [
    "IMAGE_EDIT_DEFAULT_PROMPT",
    "IMAGE_EDIT_ENVIRONMENT_INTEGRATION_PROMPT",
    "IMAGE_GENERATE_PRODUCT_ONLY_NO_PERSON_PROMPT",
    "SUBJECT_REPLACE_DEFAULT_USER_PROMPT",
    "SUBJECT_REPLACE_LEGACY_PROMPTS",
    "TARGET_LANGUAGE_SPECS",
    "THREE_VIEW_DEFAULT_PROMPT",
    "THREE_VIEW_PROMPT_CONSTRAINTS",
    "append_once",
    "apply_product_only_prompt_constraints",
    "build_digital_human_character_prompt",
    "build_digital_human_character_selection_prompt",
    "build_image_generate_prompt",
    "build_image_mode_prompt",
    "build_poster_translate_prompt",
    "build_product_or_model_prompt",
    "build_scene_image_prompt",
    "build_subject_replace_prompt",
    "build_three_view_prompt",
    "digital_human_character_region_prompt",
    "ensure_environment_integration_prompt",
    "ensure_product_details_prompt",
    "normalize_target_language",
    "subject_replace_user_prompt",
    "target_language_label",
]
