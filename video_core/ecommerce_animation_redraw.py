from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from .contracts import VideoTaskContext


# Copied from the original platform.  These categories and aliases are part of
# the redraw prompt contract, not a new public configuration surface.
ECOMMERCE_PRODUCT_CATEGORIES = {
    "apparel": "服装鞋包配饰",
    "beauty_personal_care": "美妆个护",
    "food_beverage": "食品饮料",
    "home_living": "家居家具家纺",
    "sanitary_kitchen": "洁具厨卫",
    "electronics": "数码家电",
    "vehicle": "汽车交通工具",
    "real_estate": "房地产空间项目",
    "commercial_space": "商业综合体/商场项目",
    "jewelry_luxury": "珠宝腕表奢侈品",
    "sports_outdoor": "运动户外",
    "mother_baby": "母婴玩具",
    "pet": "宠物用品",
    "tools_industrial": "工具工业品",
    "education_culture": "图书课程文创",
    "generic": "通用商品",
}

ECOMMERCE_CATEGORY_ALIASES = {
    "服装": "apparel",
    "衣服": "apparel",
    "鞋": "apparel",
    "配饰": "apparel",
    "美妆": "beauty_personal_care",
    "护肤": "beauty_personal_care",
    "个护": "beauty_personal_care",
    "食品": "food_beverage",
    "饮料": "food_beverage",
    "保健品": "food_beverage",
    "营养品": "food_beverage",
    "营养补充剂": "food_beverage",
    "膳食补充剂": "food_beverage",
    "鱼油": "food_beverage",
    "深海鱼油": "food_beverage",
    "胶囊": "food_beverage",
    "omega": "food_beverage",
    "swisse": "food_beverage",
    "零食": "food_beverage",
    "脆片": "food_beverage",
    "燕麦": "food_beverage",
    "燕麥": "food_beverage",
    "麦片": "food_beverage",
    "麥片": "food_beverage",
    "谷物": "food_beverage",
    "早餐代餐": "food_beverage",
    "蛋白棒": "food_beverage",
    "饼干": "food_beverage",
    "餅乾": "food_beverage",
    "咖啡": "food_beverage",
    "茶饮": "food_beverage",
    "茶飲": "food_beverage",
    "巧克力": "food_beverage",
    "清洁": "home_living",
    "清潔": "home_living",
    "清洁剂": "home_living",
    "清潔劑": "home_living",
    "清洁喷雾": "home_living",
    "清潔噴霧": "home_living",
    "洗衣液": "home_living",
    "洗衣凝珠": "home_living",
    "凝珠": "home_living",
    "洗洁精": "home_living",
    "洗潔精": "home_living",
    "除菌": "home_living",
    "去污": "home_living",
    "油污": "home_living",
    "家居": "home_living",
    "家具": "home_living",
    "家纺": "home_living",
    "洁具": "sanitary_kitchen",
    "厨卫": "sanitary_kitchen",
    "卫浴": "sanitary_kitchen",
    "马桶": "sanitary_kitchen",
    "花洒": "sanitary_kitchen",
    "热水器": "sanitary_kitchen",
    "燃气热水器": "sanitary_kitchen",
    "浴室柜": "sanitary_kitchen",
    "数码": "electronics",
    "家电": "electronics",
    "电器": "electronics",
    "手机": "electronics",
    "电脑": "electronics",
    "充电器": "electronics",
    "耳机": "electronics",
    "藍牙耳機": "electronics",
    "蓝牙耳机": "electronics",
    "降噪耳机": "electronics",
    "显示器": "electronics",
    "顯示器": "electronics",
    "键盘": "electronics",
    "鍵盤": "electronics",
    "鼠标": "electronics",
    "滑鼠": "electronics",
    "平板": "electronics",
    "投影仪": "electronics",
    "投影機": "electronics",
    "固态硬盘": "electronics",
    "固態硬碟": "electronics",
    "移动固态硬盘": "electronics",
    "移動固態硬碟": "electronics",
    "硬盘": "electronics",
    "硬碟": "electronics",
    "ssd": "electronics",
    "汽车": "vehicle",
    "车": "vehicle",
    "房产": "real_estate",
    "房地产": "real_estate",
    "房屋": "real_estate",
    "公寓": "real_estate",
    "建筑": "real_estate",
    "户型": "real_estate",
    "楼盘": "real_estate",
    "住宅": "real_estate",
    "商场": "commercial_space",
    "购物中心": "commercial_space",
    "商业区": "commercial_space",
    "商业综合体": "commercial_space",
    "商业地产": "commercial_space",
    "商业项目": "commercial_space",
    "商业地标": "commercial_space",
    "商圈": "commercial_space",
    "商业街": "commercial_space",
    "写字楼": "commercial_space",
    "办公楼": "commercial_space",
    "核心商圈": "commercial_space",
    "核心区位": "commercial_space",
    "核心地段": "commercial_space",
    "城市坐标": "commercial_space",
    "资产坐标": "commercial_space",
    "地标建筑": "commercial_space",
    "珠宝": "jewelry_luxury",
    "腕表": "jewelry_luxury",
    "奢侈": "jewelry_luxury",
    "运动": "sports_outdoor",
    "户外": "sports_outdoor",
    "母婴": "mother_baby",
    "玩具": "mother_baby",
    "宠物": "pet",
    "寵物": "pet",
    "猫砂": "pet",
    "貓砂": "pet",
    "猫咪": "pet",
    "貓咪": "pet",
    "狗狗": "pet",
    "狗粮": "pet",
    "狗糧": "pet",
    "猫粮": "pet",
    "貓糧": "pet",
    "宠物湿巾": "pet",
    "寵物濕巾": "pet",
    "宠物饮水机": "pet",
    "寵物飲水機": "pet",
    "工具": "tools_industrial",
    "工业": "tools_industrial",
    "课程": "education_culture",
    "图书": "education_culture",
    "文创": "education_culture",
}

_ECOMMERCE_SUPPLEMENT_PATTERN = re.compile(
    r"保健品|营养品|營養品|营养补充剂|營養補充劑|营养补充|營養補充|膳食补充剂|膳食補充劑|鱼油|魚油|"
    r"深海鱼油|深海魚油|叶黄素|葉黃素|益生菌|胶原蛋白|膠原蛋白|褪黑素|辅酶q10|輔酶q10|蔓越莓|"
    r"omega|omega-?3|dha|epa|softgel|capsule|swisse|supplement|supplements|vitamin|维生素|魚膠囊|胶囊|膠囊",
    flags=re.IGNORECASE,
)
_ECOMMERCE_HOUSEHOLD_CLEANING_PATTERN = re.compile(
    r"清洁|清潔|清洁剂|清潔劑|清洁喷雾|清潔噴霧|去污|除菌|除味|油污|"
    r"洗衣液|洗衣凝珠|凝珠|洗洁精|洗潔精|地板清洁|廚房清潔|厨房清洁|台面清洁|"
    r"玻璃清洁|马桶清洁|潔廁|洁厕|detergent|cleaner|sanitizer|laundry|disinfect",
    flags=re.IGNORECASE,
)
_ECOMMERCE_CLEANING_SUPPLY_PATTERN = re.compile(
    r"清洗剂|清洗劑|清洁剂|清潔劑|清洁液|清潔液|清洁喷雾|清潔噴霧|消毒液|除菌液|"
    r"湿巾|濕巾|泡沫|喷雾|噴霧|洗衣液|洗衣凝珠|凝珠|洗洁精|洗潔精|清洁片|清潔片|"
    r"洗地机清洁液|洗地機清潔液|detergent|cleaner|disinfectant|sanitizer",
    flags=re.IGNORECASE,
)
_ECOMMERCE_PET_PATTERN = re.compile(
    r"宠物|寵物|猫砂|貓砂|猫咪|貓咪|狗狗|狗粮|狗糧|猫粮|貓糧|犬用|猫用|貓用|"
    r"宠物湿巾|寵物濕巾|宠物饮水机|寵物飲水機|饮水机|飲水機|除臭垫|除臭墊|逗猫|逗貓",
    flags=re.IGNORECASE,
)
_ECOMMERCE_GENERAL_FOOD_PATTERN = re.compile(
    r"零食|脆片|薯片|燕麦|燕麥|麦片|麥片|谷物|早餐代餐|早餐谷物|蛋白棒|能量棒|"
    r"饼干|餅乾|咖啡|茶饮|茶飲|饮品|飲品|果汁|巧克力|坚果|即食|冲饮|沖飲|口感|开袋|開袋",
    flags=re.IGNORECASE,
)
_ECOMMERCE_APPAREL_PATTERN = re.compile(
    r"西装|西裝|外套|衬衫|襯衫|T恤|卫衣|衛衣|裙|裤|褲|鞋|靴|包包|手袋|托特包|斜挎包|"
    r"面料|版型|显瘦|顯瘦|通勤|上身|剪裁|衣摆|衣擺|穿搭",
    flags=re.IGNORECASE,
)
_ECOMMERCE_BEAUTY_PERSONAL_CARE_PATTERN = re.compile(
    r"护发|護髮|洗发|洗髮|发膜|髮膜|护手|護手|身体乳|身體乳|沐浴露|香水|防晒|防曬|"
    r"牙刷|牙膏|漱口水|口腔护理|口腔護理|口腔清洁|口腔清潔|电动牙刷|電動牙刷|"
    r"精油|面膜|洁面|潔面|卸妆|卸妝|个护|個護|美妆|美妝",
    flags=re.IGNORECASE,
)
_ECOMMERCE_ORAL_CARE_PATTERN = re.compile(
    r"牙刷|牙膏|漱口水|口腔护理|口腔護理|口腔清洁|口腔清潔|电动牙刷|電動牙刷|冲牙器|沖牙器|刷头|刷頭",
    flags=re.IGNORECASE,
)
_ECOMMERCE_MOTHER_BABY_PATTERN = re.compile(
    r"母婴|母嬰|婴儿|嬰兒|宝宝|寶寶|奶瓶|奶嘴|纸尿裤|紙尿褲|尿不湿|尿不濕|喂养|餵養|"
    r"哺乳|辅食|輔食|吸奶器|安抚|安撫|婴童|嬰童|亲子|親子|儿童|兒童|婴儿床|嬰兒床|"
    r"婴儿车|嬰兒車|推车|推車|学步|學步|宝宝餐椅|寶寶餐椅",
    flags=re.IGNORECASE,
)
_ECOMMERCE_MOTHER_BABY_DURABLE_PRODUCT_PATTERN = re.compile(
    r"喂养|餵養|哺乳|辅食|輔食|吸奶器|安抚|安撫|婴儿床|嬰兒床|婴儿车|嬰兒車|"
    r"推车|推車|学步|學步|宝宝餐椅|寶寶餐椅|纸尿裤|紙尿褲|尿不湿|尿不濕|消毒烘干机|消毒烘乾機|"
    r"暖奶器|恒温壶|恆溫壺|调奶器|調奶器|辅食机|輔食機",
    flags=re.IGNORECASE,
)
_ECOMMERCE_EDUCATION_CULTURE_PATTERN = re.compile(
    r"课程|課程|讲义|講義|教材|教辅|教輔|题库|題庫|词典笔|詞典筆|点读笔|點讀筆|"
    r"学习机|學習機|查词|查詞|跟读|跟讀|阅读|閱讀|绘本|繪本|练字|練字|口语训练|口語訓練",
    flags=re.IGNORECASE,
)
_ECOMMERCE_VEHICLE_PATTERN = re.compile(
    r"SUV|轿车|轎車|越野|车身|車身|车辆|車輛|汽车|汽車|车灯|車燈|座舱|座艙|内饰|內飾|"
    r"轮毂|輪轂|方向盘|方向盤|驾驶|駕駛|中控|后排|後排|后备箱|後備箱|车门|車門",
    flags=re.IGNORECASE,
)
_ECOMMERCE_COMMERCIAL_SPACE_PATTERN = re.compile(
    r"商场|购物中心|商業區|商业区|商业综合体|商業綜合體|商业地产|商業地產|商业项目|商業項目|"
    r"商业地标|商業地標|商圈|商业街|商業街|写字楼|寫字樓|办公楼|辦公樓|"
    r"核心商圈|核心区位|核心區位|核心地段|核心地段|城市坐标|城市座標|资产坐标|資產座標|"
    r"地标建筑|地標建築|商业配套|商業配套|客流|人流量|购物便利|購物便利|通达|通達",
    flags=re.IGNORECASE,
)
_ECOMMERCE_NEGATIVE_CATEGORY_CLAUSE_PATTERN = re.compile(
    r"(?:^|[，,。；;\n：:])\s*"
    r"(?:不要误导成|不要写成|不要寫成|不要当成|不要當成|不要做成|不是|并非|不属于|不屬於|不属於|"
    r"不要|別|别|避免|禁止|勿|不能|不应|不應)"
    r"[^，,。；;\n]{0,64}",
    flags=re.IGNORECASE,
)


def _ecommerce_context_source(*values: Any) -> str:
    return "\n".join(str(item or "") for item in values if str(item or "").strip())


def _strip_negative_ecommerce_category_clauses(source: Any) -> str:
    text = str(source or "")
    if not text:
        return ""
    cleaned = _ECOMMERCE_NEGATIVE_CATEGORY_CLAUSE_PATTERN.sub("\n", text)
    return re.sub(r"\n{2,}", "\n", cleaned).strip()


def _has_positive_ecommerce_context(pattern: re.Pattern[str], *values: Any) -> bool:
    source = _ecommerce_context_source(*values)
    if not source:
        return False
    return bool(pattern.search(_strip_negative_ecommerce_category_clauses(source)))


def _has_ecommerce_supplement_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_SUPPLEMENT_PATTERN, *values)


def _has_ecommerce_household_cleaning_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_HOUSEHOLD_CLEANING_PATTERN, *values)


def _has_ecommerce_vehicle_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_VEHICLE_PATTERN, *values)


def _has_ecommerce_commercial_space_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_COMMERCIAL_SPACE_PATTERN, *values)


def _has_ecommerce_cleaning_supply_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_CLEANING_SUPPLY_PATTERN, *values)


def _has_ecommerce_pet_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_PET_PATTERN, *values)


def _has_ecommerce_general_food_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_GENERAL_FOOD_PATTERN, *values)


def _has_ecommerce_apparel_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_APPAREL_PATTERN, *values)


def _has_ecommerce_beauty_personal_care_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_BEAUTY_PERSONAL_CARE_PATTERN, *values)


def _has_ecommerce_oral_care_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_ORAL_CARE_PATTERN, *values)


def _has_ecommerce_mother_baby_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_MOTHER_BABY_PATTERN, *values)


def _has_ecommerce_mother_baby_durable_product_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_MOTHER_BABY_DURABLE_PRODUCT_PATTERN, *values)


def _has_ecommerce_education_culture_context(*values: Any) -> bool:
    return _has_positive_ecommerce_context(_ECOMMERCE_EDUCATION_CULTURE_PATTERN, *values)


def _normalize_ecommerce_product_category(value: Any, *, prompt: str = "") -> str:
    text = str(value or "").strip()
    lowered = text.lower().replace("-", "_").replace(" ", "_")
    source = f"{text}\n{prompt or ''}"
    weak_explicit_categories = {"generic", "electronics"}
    explicit_tokens: list[str] = []
    if lowered in ECOMMERCE_PRODUCT_CATEGORIES:
        explicit_tokens.append(lowered)
    if lowered in ECOMMERCE_PRODUCT_CATEGORIES and lowered not in weak_explicit_categories:
        if lowered != "real_estate" or not _has_ecommerce_commercial_space_context(source):
            return lowered
    for line in text.splitlines():
        token = str(line or "").strip().lower().replace("-", "_").replace(" ", "_")
        if token in ECOMMERCE_PRODUCT_CATEGORIES:
            explicit_tokens.append(token)
        if token in ECOMMERCE_PRODUCT_CATEGORIES and token not in weak_explicit_categories:
            if token != "real_estate" or not _has_ecommerce_commercial_space_context(source):
                return token
    explicit_or_fallback_tokens = [token for token in explicit_tokens if token] or ([lowered] if lowered else [""])
    supplement_context = _has_ecommerce_supplement_context(source)
    pet_context = _has_ecommerce_pet_context(source)
    general_food_context = _has_ecommerce_general_food_context(source)
    apparel_context = _has_ecommerce_apparel_context(source)
    beauty_personal_care_context = _has_ecommerce_beauty_personal_care_context(source)
    oral_care_context = _has_ecommerce_oral_care_context(source)
    mother_baby_context = _has_ecommerce_mother_baby_context(source)
    mother_baby_durable_product_context = _has_ecommerce_mother_baby_durable_product_context(source)
    education_culture_context = _has_ecommerce_education_culture_context(source)
    household_cleaning_context = _has_ecommerce_household_cleaning_context(source)
    cleaning_supply_context = _has_ecommerce_cleaning_supply_context(source)
    vehicle_context = _has_ecommerce_vehicle_context(source)
    if supplement_context and any(token in {"", "generic", "food_beverage"} for token in explicit_or_fallback_tokens):
        return "food_beverage"
    if pet_context and any(token in {"", "generic", "pet", "home_living"} for token in explicit_or_fallback_tokens):
        return "pet"
    if vehicle_context and any(token in {"", "generic", "vehicle", "apparel", "electronics"} for token in explicit_or_fallback_tokens):
        return "vehicle"
    if (
        household_cleaning_context
        and cleaning_supply_context
        and mother_baby_context
        and any(token in {"", "generic", "home_living", "mother_baby"} for token in explicit_or_fallback_tokens)
    ):
        return "home_living"
    if apparel_context and any(token in {"", "generic", "apparel"} for token in explicit_or_fallback_tokens):
        return "apparel"
    if oral_care_context and beauty_personal_care_context and any(
        token in {"", "generic", "beauty_personal_care", "home_living", "electronics", "mother_baby"}
        for token in explicit_or_fallback_tokens
    ):
        return "beauty_personal_care"
    if education_culture_context and any(token in {"", "generic", "education_culture", "electronics"} for token in explicit_or_fallback_tokens):
        return "education_culture"
    if mother_baby_context and any(token in {"", "generic", "mother_baby", "home_living", "electronics"} for token in explicit_or_fallback_tokens):
        return "mother_baby"
    if beauty_personal_care_context and any(token in {"", "generic", "beauty_personal_care", "home_living", "electronics"} for token in explicit_or_fallback_tokens):
        return "beauty_personal_care"
    if general_food_context and any(token in {"", "generic", "food_beverage"} for token in explicit_or_fallback_tokens):
        return "food_beverage"
    if household_cleaning_context and any(token in {"", "generic", "home_living"} for token in explicit_or_fallback_tokens):
        return "home_living"
    hot_water_context = bool(re.search(r"燃气热水器|燃氣熱水器|热水器|熱水器|恒温热水|恆溫熱水|18L|18升|大水量|不忽冷|不抢水|不搶水", source, flags=re.IGNORECASE))
    if hot_water_context and any(token in {"", "generic", "electronics"} for token in explicit_or_fallback_tokens):
        return "sanitary_kitchen"
    commercial_space_context = _has_ecommerce_commercial_space_context(source)
    if commercial_space_context and (
        not explicit_tokens
        or any(token in {"generic", "real_estate", "commercial_space"} for token in explicit_tokens)
    ):
        return "commercial_space"
    for token in explicit_tokens:
        if token in ECOMMERCE_PRODUCT_CATEGORIES and token != "generic":
            return token
    if supplement_context:
        return "food_beverage"
    if pet_context:
        return "pet"
    if vehicle_context:
        return "vehicle"
    if household_cleaning_context and cleaning_supply_context and mother_baby_context:
        return "home_living"
    if apparel_context:
        return "apparel"
    if oral_care_context and beauty_personal_care_context:
        return "beauty_personal_care"
    if education_culture_context:
        return "education_culture"
    if mother_baby_context:
        return "mother_baby"
    if beauty_personal_care_context:
        return "beauty_personal_care"
    if general_food_context:
        return "food_beverage"
    if household_cleaning_context:
        return "home_living"
    for alias, category in ECOMMERCE_CATEGORY_ALIASES.items():
        if alias in text:
            return category
    for alias, category in ECOMMERCE_CATEGORY_ALIASES.items():
        if alias in source:
            return category
    if hot_water_context:
        return "sanitary_kitchen"
    return "generic"


def _truncate_text(value: Any, max_len: int = 1200) -> str:
    text = str(value or "")
    if len(text) <= int(max_len):
        return text
    return f"{text[:int(max_len)]}...(已截断，共{len(text)}字符)"


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on", "y"}:
        return True
    if text in {"0", "false", "no", "off", "n"}:
        return False
    return bool(default)


def _ecommerce_animation_redraw_prompt(*, source_prompt: str, product_category: str, index: int, role: str) -> str:
    category_text = _normalize_ecommerce_product_category(product_category)
    category_clause = {
        "real_estate": "房产/空间动画广告参考图，保留建筑、户型、空间结构、采光和真实比例。",
        "vehicle": "汽车动画广告参考图，保留整车比例、车灯、轮毂、内饰和车身线条。",
        "apparel": "服装动画广告参考图，保留版型、面料、颜色和穿搭轮廓。",
        "beauty_personal_care": "美妆动画广告参考图，保留包装造型、材质、颜色和使用质感。",
        "food_beverage": "食品/保健品动画广告参考图，保留食物质感、包装、服用前/展示场景和真实生活感。",
        "electronics": "数码产品动画广告参考图，保留产品外观、屏幕比例、接口和材质。",
        "home_living": "家居动画广告参考图，保留空间尺度、材质、家具关系和生活场景。",
        "sanitary_kitchen": "厨卫家电动画广告参考图，保留产品结构、安装环境、水流/使用结果和核心卖点。",
    }.get(category_text, "动画广告参考图，保留主体、结构、材质、颜色和真实使用场景。")
    redraw_elements = (
        "墙面、地面、家具、产品和水流都必须重新绘制成动画插画质感，不能只是给原照片叠加光效线条。"
        if category_text == "sanitary_kitchen"
        else "墙面、地面、家具、产品、人物、道具和真实使用场景都必须重新绘制成动画插画质感，不能只是给原照片叠加光效线条；场景和动作只围绕当前产品品类的真实展示、使用前准备或生活化呈现。"
    )
    role_text = str(role or "参考图").strip()
    prompt_hint = _truncate_text(source_prompt, max_len=360)
    role_style = (
        "人物需转成统一的 2D 商业动画角色：保持五官身份、发型、服装轮廓和姿态，使用干净线稿、赛璐璐上色和广告插画质感。"
        if "人物" in role_text or "模特" in role_text
        else "产品和场景需转成统一的 2D 商业动画广告关键帧：使用干净线稿、清晰色块、赛璐璐上色和插画式空间层次。"
    )
    return (
        f"将这张{role_text}转绘为统一的动画广告参考图。"
        f"{category_clause}"
        f"{role_style}"
        "目标是明确的 2D 动画广告画面，不要保留照片质感，不要做成半写实 CG、真实摄影修图、3D 渲染图、游戏 CG 截图或低幼卡通贴纸。"
        f"{redraw_elements}"
        "产品主体必须完整、清晰、位于画面核心位置；如果原图产品过小，可以适度放大重构，但绝对不能消失、变成背景或被其他物体遮挡。"
        "这是一张纯动画画面参考图，不是信息图、参数图、海报图或说明图。"
        "绝对不要生成任何文字、数字、箭头、标签、参数标注、说明图标、字幕、水印或无关品牌。"
        "必须保持原图主体身份、产品关键结构、人物五官身份和空间透视关系；原图上的品牌位置可保留为简化图形标识，但不要生成可读文字。"
        "画面干净，色彩统一，有明确轮廓线和动画广告美术风格，可直接作为动画广告视频生成的参考图。"
        f"参考视频提示词方向：{prompt_hint}"
        f"当前为第 {index} 张转绘素材。"
    )


GenerateImage = Callable[..., tuple[dict[str, Any], dict[str, Any], list[Any]]]


def redraw_animation_references(
    payload: dict[str, Any],
    task_id: str,
    workdir: Path,
    context: VideoTaskContext,
    generate_image: GenerateImage,
) -> dict[str, Any]:
    """Redraw ecommerce animation references using an injected image generator.

    The field mapping and error messages mirror the original hidden server step.
    Provider access stays outside this module so tests and local orchestration do
    not need Telegram, HTTP clients, credentials, or paid API calls.
    """

    source = dict(payload or {})
    style = str(source.get("ecommerce_ad_style") or "").strip().lower()
    if style != "animation":
        raise RuntimeError("只有动画广告风格需要执行素材转绘")
    context.check_cancelled()

    prompt = str(source.get("prompt") or source.get("prompt_text") or "").strip()
    product_category = _normalize_ecommerce_product_category(
        source.get("product_category") or source.get("category"),
        prompt=prompt,
    )
    product_values = [
        str(item or "").strip()
        for item in (source.get("ecommerce_effective_product_image_local_paths") or source.get("product_image_local_paths") or [])
        if str(item or "").strip()
    ]
    if not product_values:
        product_value = str(source.get("product_image_local_path") or source.get("image_local_path") or "").strip()
        if product_value:
            product_values = [product_value]
    model_value = str(source.get("model_image_local_path") or "").strip()
    model_skipped = _to_bool(
        source.get("ecommerce_model_reference_skipped") or source.get("model_reference_skipped"),
        False,
    ) or not model_value

    redraw_items: list[tuple[str, str, str]] = []
    for index, value in enumerate(product_values, start=1):
        path = Path(value).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"待转绘产品图不存在: {path}")
        redraw_items.append(("product", str(path), f"产品/场景有效图{index}"))
    if not model_skipped and model_value:
        model_path = Path(model_value).expanduser().resolve()
        if not model_path.exists() or not model_path.is_file():
            raise FileNotFoundError(f"待转绘人物图不存在: {model_path}")
        redraw_items.append(("model", str(model_path), "人物/模特参考图"))
    if not redraw_items:
        raise RuntimeError("动画转绘缺少可处理图片")

    output_dir = Path(workdir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    redrawn_products: list[str] = []
    redrawn_model = ""
    redrawn_all: list[str] = []
    attempts_by_item: list[dict[str, Any]] = []
    for index, (kind, source_path_text, role) in enumerate(redraw_items, start=1):
        context.check_cancelled()
        source_path = Path(source_path_text).resolve()
        output_path = output_dir / f"animation_redraw_{index:02d}{source_path.suffix.lower() or '.png'}"
        result, selected, attempts = generate_image(
            source=source,
            prompt=_ecommerce_animation_redraw_prompt(
                source_prompt=prompt,
                product_category=product_category,
                index=index,
                role=role,
            ),
            output_image_path=str(output_path),
            input_image_path=str(source_path),
            logger=source.get("_event_logger"),
            allow_builtin=True,
            request_label=f"动画广告素材转绘 {index}/{len(redraw_items)}",
        )
        context.check_cancelled()
        image_path = (
            Path(str((result or {}).get("image_path") or output_path)).resolve()
            if isinstance(result, dict)
            else output_path.resolve()
        )
        if not image_path.exists() or not image_path.is_file():
            raise RuntimeError(f"动画素材转绘成功但未找到输出图: {image_path}")
        redrawn_all.append(str(image_path))
        if kind == "model":
            redrawn_model = str(image_path)
        else:
            redrawn_products.append(str(image_path))
        attempts_by_item.append(
            {
                "index": index,
                "kind": kind,
                "source_path": str(source_path),
                "output_path": str(image_path),
                "model": str((selected or {}).get("model") or ""),
                "attempts": attempts,
            }
        )

    updated = dict(source)
    if redrawn_products:
        updated["product_image_local_path"] = redrawn_products[0]
        updated["product_image_local_paths"] = redrawn_products
        updated["ecommerce_effective_product_image_local_paths"] = redrawn_products
    if redrawn_model:
        updated["model_image_local_path"] = redrawn_model
        updated["ecommerce_model_reference_skipped"] = False
    updated["ecommerce_animation_redraw_done"] = True
    updated["ecommerce_animation_redraw_skipped"] = False
    updated["ecommerce_animation_original_reference_paths"] = [item[1] for item in redraw_items]
    updated["ecommerce_animation_redrawn_reference_paths"] = redrawn_all
    updated["ecommerce_animation_redraw_result"] = {
        "task_id": task_id,
        "product_category": product_category,
        "items": attempts_by_item,
    }
    context.check_cancelled()
    return {"ok": True, "params": updated, "image_paths": redrawn_all}


__all__ = ["redraw_animation_references"]
