from __future__ import annotations

from copy import deepcopy
import re
from collections.abc import Mapping, Sequence
from typing import Any


# Deterministic prompting helpers extracted from the original standard
# ecommerce-ad runner.  This module intentionally has no filesystem, network,
# task-state, or supplier dependencies.
ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID = "2034917373414539277"
ECOMMERCE_SHORT_VIDEO_FAST_APP_ID = "2034917373414539278"

_MODEL_WORKFLOW_IDS = {
    "seedance2.0": ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID,
    "seedance2.0fast": ECOMMERCE_SHORT_VIDEO_FAST_APP_ID,
}

_PRODUCT_CATEGORIES = {
    "apparel",
    "beauty_personal_care",
    "food_beverage",
    "home_living",
    "sanitary_kitchen",
    "electronics",
    "vehicle",
    "real_estate",
    "commercial_space",
    "jewelry_luxury",
    "sports_outdoor",
    "mother_baby",
    "pet",
    "tools_industrial",
    "education_culture",
    "generic",
}

_CATEGORY_ALIASES = {
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
    "蓝牙耳机": "electronics",
    "藍牙耳機": "electronics",
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

_SUPPLEMENT_PATTERN = re.compile(
    r"保健品|营养品|營養品|营养补充剂|營養補充劑|营养补充|營養補充|膳食补充剂|膳食補充劑|鱼油|魚油|"
    r"深海鱼油|深海魚油|叶黄素|葉黃素|益生菌|胶原蛋白|膠原蛋白|褪黑素|辅酶q10|輔酶q10|蔓越莓|"
    r"omega|omega-?3|dha|epa|softgel|capsule|swisse|supplement|supplements|vitamin|维生素|魚膠囊|胶囊|膠囊",
    re.IGNORECASE,
)
_HOUSEHOLD_CLEANING_PATTERN = re.compile(
    r"清洁|清潔|清洁剂|清潔劑|清洁喷雾|清潔噴霧|去污|除菌|除味|油污|洗衣液|洗衣凝珠|凝珠|"
    r"洗洁精|洗潔精|地板清洁|廚房清潔|厨房清洁|台面清洁|玻璃清洁|马桶清洁|潔廁|洁厕|"
    r"detergent|cleaner|sanitizer|laundry|disinfect",
    re.IGNORECASE,
)
_CLEANING_SUPPLY_PATTERN = re.compile(
    r"清洗剂|清洗劑|清洁剂|清潔劑|清洁液|清潔液|清洁喷雾|清潔噴霧|消毒液|除菌液|湿巾|濕巾|"
    r"泡沫|喷雾|噴霧|洗衣液|洗衣凝珠|凝珠|洗洁精|洗潔精|清洁片|清潔片|detergent|cleaner|disinfectant|sanitizer",
    re.IGNORECASE,
)
_PET_PATTERN = re.compile(
    r"宠物|寵物|猫砂|貓砂|猫咪|貓咪|狗狗|狗粮|狗糧|猫粮|貓糧|犬用|猫用|貓用|"
    r"宠物湿巾|寵物濕巾|宠物饮水机|寵物飲水機|饮水机|飲水機|除臭垫|除臭墊|逗猫|逗貓",
    re.IGNORECASE,
)
_GENERAL_FOOD_PATTERN = re.compile(
    r"零食|脆片|薯片|燕麦|燕麥|麦片|麥片|谷物|早餐代餐|早餐谷物|蛋白棒|能量棒|饼干|餅乾|咖啡|"
    r"茶饮|茶飲|饮品|飲品|果汁|巧克力|坚果|即食|冲饮|沖飲|口感|开袋|開袋",
    re.IGNORECASE,
)
_APPAREL_PATTERN = re.compile(
    r"西装|西裝|外套|衬衫|襯衫|T恤|卫衣|衛衣|裙|裤|褲|鞋|靴|包包|手袋|托特包|斜挎包|"
    r"面料|版型|显瘦|顯瘦|通勤|上身|剪裁|衣摆|衣擺|穿搭",
    re.IGNORECASE,
)
_BEAUTY_PATTERN = re.compile(
    r"护发|護髮|洗发|洗髮|发膜|髮膜|护手|護手|身体乳|身體乳|沐浴露|香水|防晒|防曬|牙刷|牙膏|"
    r"漱口水|口腔护理|口腔護理|口腔清洁|口腔清潔|电动牙刷|電動牙刷|精油|面膜|洁面|潔面|卸妆|卸妝|个护|個護|美妆|美妝",
    re.IGNORECASE,
)
_ORAL_CARE_PATTERN = re.compile(
    r"牙刷|牙膏|漱口水|口腔护理|口腔護理|口腔清洁|口腔清潔|电动牙刷|電動牙刷|冲牙器|沖牙器|刷头|刷頭",
    re.IGNORECASE,
)
_MOTHER_BABY_PATTERN = re.compile(
    r"母婴|母嬰|婴儿|嬰兒|宝宝|寶寶|奶瓶|奶嘴|纸尿裤|紙尿褲|尿不湿|尿不濕|喂养|餵養|哺乳|"
    r"辅食|輔食|吸奶器|安抚|安撫|婴童|嬰童|亲子|親子|儿童|兒童|婴儿床|嬰兒床|婴儿车|嬰兒車|推车|推車|学步|學步|宝宝餐椅|寶寶餐椅",
    re.IGNORECASE,
)
_MOTHER_BABY_DURABLE_PATTERN = re.compile(
    r"喂养|餵養|哺乳|辅食|輔食|吸奶器|安抚|安撫|婴儿床|嬰兒床|婴儿车|嬰兒車|推车|推車|学步|學步|"
    r"宝宝餐椅|寶寶餐椅|纸尿裤|紙尿褲|尿不湿|尿不濕|消毒烘干机|消毒烘乾機|暖奶器|恒温壶|恆溫壺|调奶器|調奶器|辅食机|輔食機",
    re.IGNORECASE,
)
_EDUCATION_PATTERN = re.compile(
    r"课程|課程|讲义|講義|教材|教辅|教輔|题库|題庫|词典笔|詞典筆|点读笔|點讀筆|学习机|學習機|"
    r"查词|查詞|跟读|跟讀|阅读|閱讀|绘本|繪本|练字|練字|口语训练|口語訓練",
    re.IGNORECASE,
)
_VEHICLE_PATTERN = re.compile(
    r"SUV|轿车|轎車|越野|车身|車身|车辆|車輛|汽车|汽車|车灯|車燈|座舱|座艙|内饰|內飾|"
    r"轮毂|輪轂|方向盘|方向盤|驾驶|駕駛|中控|后排|後排|后备箱|後備箱|车门|車門",
    re.IGNORECASE,
)
_COMMERCIAL_SPACE_PATTERN = re.compile(
    r"商场|购物中心|商業區|商业区|商业综合体|商業綜合體|商业地产|商業地產|商业项目|商業項目|商业地标|商業地標|"
    r"商圈|商业街|商業街|写字楼|寫字樓|办公楼|辦公樓|核心商圈|核心区位|核心區位|核心地段|城市坐标|城市座標|"
    r"资产坐标|資產座標|地标建筑|地標建築|商业配套|商業配套|客流|人流量|购物便利|購物便利|通达|通達",
    re.IGNORECASE,
)
_NEGATIVE_CATEGORY_CLAUSE_PATTERN = re.compile(
    r"(?:^|[，,。；;\n：:])\s*(?:不要误导成|不要写成|不要寫成|不要当成|不要當成|不要做成|不是|并非|"
    r"不属于|不屬於|不属於|不要|別|别|避免|禁止|勿|不能|不应|不應)[^，,。；;\n]{0,64}",
    re.IGNORECASE,
)

_TIME_UNIT_PATTERN = r"(?:秒钟|秒|seconds?|secs?|s)"
_TIME_RANGE_PATTERN = rf"(\d+)\s*[-到至]\s*(\d+)\s*{_TIME_UNIT_PATTERN}\s*[:：]"

_LANGUAGE_LABELS = {
    "Japanese": "日语",
    "Malay": "马来语",
    "Spanish": "西班牙语",
    "Thai": "泰语",
    "Indonesian": "印尼语",
    "Chinese": "中文",
    "English": "英文",
}


def normalize_ecommerce_model(value: Any) -> str:
    text = str(value or "").strip().lower().replace(" ", "")
    text = text.replace("seedance-2.0", "seedance2.0")
    if text in {"seedance2.0fast", "seedance20fast", "2.0fast", "fast"}:
        return "seedance2.0fast"
    if text in {"seedance2.0", "seedance20", "2.0", "standard", "normal"}:
        return "seedance2.0"
    return ""


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def workflow_id_for_ecommerce_model(value: Any) -> str:
    return _MODEL_WORKFLOW_IDS.get(normalize_ecommerce_model(value), "")


def normalize_ecommerce_workflow_id(value: Any) -> str:
    workflow_id = str(value or "").strip()
    if workflow_id in {ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID, ECOMMERCE_SHORT_VIDEO_FAST_APP_ID}:
        return workflow_id
    return ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID


def normalize_ecommerce_workflow_chain(value: Any) -> list[str]:
    if isinstance(value, str):
        raw_items: Sequence[Any] = (
            value.replace("->", ",")
            .replace(">", ",")
            .replace("，", ",")
            .replace("\r", ",")
            .replace("\n", ",")
            .split(",")
        )
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_items = value
    else:
        return []

    result: list[str] = []
    for item in raw_items:
        if isinstance(item, Mapping):
            item = item.get("value") or item.get("model") or item.get("workflow_id") or item.get("id")
        text = str(item or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def normalize_ecommerce_model_workflow(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    # The runner payload can contain callbacks and synchronization objects that
    # are not deepcopy-safe.  A shallow copy is sufficient because only
    # top-level routing fields are replaced.
    normalized_payload = dict(payload or {})
    requested_model = (
        normalized_payload.get("ecommerce_model")
        or normalized_payload.get("ecommerce_short_video_model")
        or normalized_payload.get("seedance_model")
    )
    selected_workflow_id = workflow_id_for_ecommerce_model(requested_model)
    if selected_workflow_id:
        normalized_payload["app_id"] = selected_workflow_id
        normalized_payload["ecommerce_short_video_app_id"] = selected_workflow_id
        normalized_payload["ecommerce_short_video_workflow_ids"] = [selected_workflow_id]
        normalized_payload["workflow_chain_ids"] = [selected_workflow_id]

    workflow_ids = normalize_ecommerce_workflow_chain(
        normalized_payload.get("ecommerce_short_video_workflow_ids")
    )
    if not workflow_ids:
        workflow_ids = normalize_ecommerce_workflow_chain(
            [
                normalized_payload.get("app_id"),
                normalized_payload.get("ecommerce_short_video_app_id"),
                ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID,
            ]
        )
    raw_workflow_id = workflow_ids[-1] if workflow_ids else (
        normalized_payload.get("app_id") or ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID
    )
    workflow_id = normalize_ecommerce_workflow_id(raw_workflow_id)
    model = normalize_ecommerce_model(requested_model)
    if not model:
        model = (
            "seedance2.0fast"
            if workflow_id == ECOMMERCE_SHORT_VIDEO_FAST_APP_ID
            else "seedance2.0"
        )

    ratio = str(normalized_payload.get("ratio") or "9:16").strip() or "9:16"
    if ratio not in {"16:9", "4:3", "1:1", "3:4", "9:16", "21:9"}:
        ratio = "9:16"
    resolution = str(normalized_payload.get("resolution") or "720p").strip() or "720p"
    if resolution not in {"480p", "720p", "1080p", "2k", "4k"}:
        resolution = "720p"

    return {
        "payload": normalized_payload,
        "workflow_ids": workflow_ids,
        "workflow_id": workflow_id,
        "model": model,
        "model_slug": "sparkvideo-2.0-fast" if model == "seedance2.0fast" else "sparkvideo-2.0",
        "ratio": ratio,
        "resolution": resolution,
        "real_person_mode": _to_bool(normalized_payload.get("real_person_mode"), True),
    }


def _positive_context(pattern: re.Pattern[str], source: str) -> bool:
    cleaned = _NEGATIVE_CATEGORY_CLAUSE_PATTERN.sub("\n", source)
    return bool(pattern.search(re.sub(r"\n{2,}", "\n", cleaned).strip()))


def normalize_ecommerce_product_category(value: Any, *, prompt: str = "") -> str:
    text = str(value or "").strip()
    lowered = text.lower().replace("-", "_").replace(" ", "_")
    source = f"{text}\n{prompt or ''}"
    weak_explicit = {"generic", "electronics"}
    explicit: list[str] = []
    if lowered in _PRODUCT_CATEGORIES:
        explicit.append(lowered)
    if lowered in _PRODUCT_CATEGORIES and lowered not in weak_explicit:
        if lowered != "real_estate" or not _positive_context(_COMMERCIAL_SPACE_PATTERN, source):
            return lowered
    for line in text.splitlines():
        token = line.strip().lower().replace("-", "_").replace(" ", "_")
        if token in _PRODUCT_CATEGORIES:
            explicit.append(token)
        if token in _PRODUCT_CATEGORIES and token not in weak_explicit:
            if token != "real_estate" or not _positive_context(_COMMERCIAL_SPACE_PATTERN, source):
                return token

    tokens = [item for item in explicit if item] or ([lowered] if lowered else [""])
    supplement = _positive_context(_SUPPLEMENT_PATTERN, source)
    pet = _positive_context(_PET_PATTERN, source)
    food = _positive_context(_GENERAL_FOOD_PATTERN, source)
    apparel = _positive_context(_APPAREL_PATTERN, source)
    beauty = _positive_context(_BEAUTY_PATTERN, source)
    oral = _positive_context(_ORAL_CARE_PATTERN, source)
    mother_baby = _positive_context(_MOTHER_BABY_PATTERN, source)
    mother_baby_durable = _positive_context(_MOTHER_BABY_DURABLE_PATTERN, source)
    education = _positive_context(_EDUCATION_PATTERN, source)
    cleaning = _positive_context(_HOUSEHOLD_CLEANING_PATTERN, source)
    cleaning_supply = _positive_context(_CLEANING_SUPPLY_PATTERN, source)
    vehicle = _positive_context(_VEHICLE_PATTERN, source)

    if supplement and any(item in {"", "generic", "food_beverage"} for item in tokens):
        return "food_beverage"
    if pet and any(item in {"", "generic", "pet", "home_living"} for item in tokens):
        return "pet"
    if vehicle and any(item in {"", "generic", "vehicle", "apparel", "electronics"} for item in tokens):
        return "vehicle"
    if cleaning and cleaning_supply and mother_baby and any(
        item in {"", "generic", "home_living", "mother_baby"} for item in tokens
    ):
        return "home_living"
    if apparel and any(item in {"", "generic", "apparel"} for item in tokens):
        return "apparel"
    if oral and beauty and any(
        item in {"", "generic", "beauty_personal_care", "home_living", "electronics", "mother_baby"}
        for item in tokens
    ):
        return "beauty_personal_care"
    if education and any(item in {"", "generic", "education_culture", "electronics"} for item in tokens):
        return "education_culture"
    if mother_baby and any(
        item in {"", "generic", "mother_baby", "home_living", "electronics"} for item in tokens
    ):
        return "mother_baby"
    if beauty and any(
        item in {"", "generic", "beauty_personal_care", "home_living", "electronics"} for item in tokens
    ):
        return "beauty_personal_care"
    if food and any(item in {"", "generic", "food_beverage"} for item in tokens):
        return "food_beverage"
    if cleaning and any(item in {"", "generic", "home_living"} for item in tokens):
        return "home_living"

    hot_water = bool(
        re.search(
            r"燃气热水器|燃氣熱水器|热水器|熱水器|恒温热水|恆溫熱水|18L|18升|大水量|不忽冷|不抢水|不搶水",
            source,
            re.IGNORECASE,
        )
    )
    if hot_water and any(item in {"", "generic", "electronics"} for item in tokens):
        return "sanitary_kitchen"
    commercial_space = _positive_context(_COMMERCIAL_SPACE_PATTERN, source)
    if commercial_space and (not explicit or any(item in {"generic", "real_estate", "commercial_space"} for item in explicit)):
        return "commercial_space"
    for item in explicit:
        if item in _PRODUCT_CATEGORIES and item != "generic":
            return item

    fallbacks = (
        (supplement, "food_beverage"),
        (pet, "pet"),
        (vehicle, "vehicle"),
        (cleaning and cleaning_supply and mother_baby, "home_living"),
        (apparel, "apparel"),
        (oral and beauty, "beauty_personal_care"),
        (education, "education_culture"),
        (mother_baby, "mother_baby"),
        (beauty, "beauty_personal_care"),
        (food, "food_beverage"),
        (cleaning, "home_living"),
    )
    for matched, category in fallbacks:
        if matched:
            return category
    for alias, category in _CATEGORY_ALIASES.items():
        if alias.lower() in text.lower():
            return category
    for alias, category in _CATEGORY_ALIASES.items():
        if alias.lower() in source.lower():
            return category
    return "sanitary_kitchen" if hot_water else "generic"


_ONTOLOGY_PROFILES: dict[str, dict[str, Any]] = {
    "commercial_space": {
        "product_type": "商业综合体/商场项目",
        "core_essence": "用核心区位、交通可达和集中配套提升购物餐饮休闲便利",
        "primary_subject": "商业建筑外观、入口与公共商业空间",
        "scene_objects": ["建筑外立面", "入口与导视", "中庭/公共空间", "扶梯或动线", "购物餐饮休闲场景"],
        "selling_points": ["核心地段", "到达方便", "配套集中", "一站式消费", "城市地标辨识度"],
        "human_role": "访客/消费者/商业讲解人",
        "human_product_relationship": "到达、逛店、使用公共配套并自然展示商业动线",
        "recommended_scene_order": ["城市与建筑远景", "入口导视", "中庭或主通道", "购物餐饮休闲配套", "商业地标收束"],
        "interaction_logic": ["从城市道路到达", "沿入口导视进入", "经过中庭或扶梯", "展示逛吃休闲便利", "回到建筑整体收束"],
        "avoid_focus": ["住宅客厅/卧室/阳台", "入住幻想", "垃圾桶与污染", "脏乱环境", "编造租售价格或客流数据"],
    },
    "real_estate": {
        "product_type": "房产空间",
        "core_essence": "用空间、采光、动线和配套解决居住体验问题",
        "primary_subject": "房屋/项目空间",
        "scene_objects": ["外立面", "入口", "客厅", "厨房", "卧室", "卫浴"],
        "selling_points": ["外观", "采光", "空间尺度", "动线", "收纳", "配套"],
        "human_role": "置业顾问",
        "human_product_relationship": "带看空间并指向空间卖点",
        "recommended_scene_order": ["项目主体/外立面", "入口或客厅", "厨房", "卧室", "卫浴/阳台"],
        "interaction_logic": ["走向建筑", "带看室内", "指向采光和空间", "看向镜头讲解"],
        "avoid_focus": ["墙面设备", "可视对讲", "控制面板", "无关装饰"],
    },
    "vehicle": {
        "product_type": "车辆",
        "core_essence": "用外观气场、座舱体验和配置提升出行价值",
        "primary_subject": "整车",
        "scene_objects": ["车身", "车灯", "轮毂", "车门", "座舱", "中控"],
        "selling_points": ["外观", "空间", "内饰", "配置", "驾驶体验"],
        "human_role": "车辆讲解人",
        "human_product_relationship": "绕车讲解并进入车内体验",
        "recommended_scene_order": ["整车外观", "前脸车灯", "车门与座舱", "中控内饰", "乘坐体验"],
        "interaction_logic": ["走向车辆", "指向车身线条", "打开车门", "坐入座舱"],
        "avoid_focus": ["路边杂物", "背景建筑", "无关行人"],
    },
    "sanitary_kitchen": {
        "product_type": "厨卫家电/洁具",
        "core_essence": "用稳定、舒适和易打理改善厨房或浴室体验",
        "primary_subject": "厨卫产品",
        "scene_objects": ["厨房", "浴室", "台面", "水流", "安装位置", "外观面板"],
        "selling_points": ["外观", "恒温", "大水量", "易清洁", "稳定体验"],
        "human_role": "产品讲解人",
        "human_product_relationship": "在真实厨卫环境中指向和展示产品",
        "recommended_scene_order": ["安装整体", "产品外观", "水流/使用结果", "空间体验"],
        "interaction_logic": ["站在产品旁讲解", "指向机身或水流", "切换到使用场景", "看向镜头说明卖点"],
        "avoid_focus": ["屏幕交互", "错误点击", "无关墙面设备"],
    },
    "apparel": {
        "product_type": "服装鞋包配饰",
        "core_essence": "用版型、材质和搭配提升穿着形象",
        "primary_subject": "穿戴商品",
        "scene_objects": ["全身穿搭", "面料", "袖口", "五金", "通勤场景"],
        "selling_points": ["版型", "面料", "搭配", "细节", "舒适度"],
        "human_role": "穿搭展示者",
        "human_product_relationship": "穿戴商品并自然展示细节",
        "recommended_scene_order": ["完整上身", "走动转身", "面料细节", "搭配场景"],
        "interaction_logic": ["整理衣领", "转身展示", "抬手展示细节"],
        "avoid_focus": ["背景橱窗", "无关道具"],
    },
    "beauty_personal_care": {
        "product_type": "美妆个护",
        "core_essence": "用质地、肤感和护理结果改善日常状态",
        "primary_subject": "个护产品",
        "scene_objects": ["瓶身", "质地", "梳妆台", "使用场景"],
        "selling_points": ["肤感", "吸收", "护理效率", "状态改善"],
        "human_role": "日常使用者",
        "human_product_relationship": "拿起、涂抹或喷洒并展示肤感变化",
        "recommended_scene_order": ["产品外观", "质地特写", "使用动作", "状态收束"],
        "interaction_logic": ["拿起产品", "展示质地", "自然使用", "收在状态变化"],
        "avoid_focus": ["家清去污话术", "零食食欲词"],
    },
    "food_beverage": {
        "product_type": "食品饮料",
        "core_essence": "用香气、口感和分享场景触发消费欲望",
        "primary_subject": "包装食品或饮品",
        "scene_objects": ["包装", "成品/内容物", "餐桌", "分享场景"],
        "selling_points": ["香气", "口感", "新鲜感", "分享欲"],
        "human_role": "品尝或分享者",
        "human_product_relationship": "开封、倒出、拿取、品尝或分享商品",
        "recommended_scene_order": ["包装主体", "开封瞬间", "食物质感", "分享收束"],
        "interaction_logic": ["拿起包装", "开封", "倒出/夹取", "品尝分享"],
        "avoid_focus": ["房产/厨卫词", "数码效率词"],
    },
    "home_living": {
        "product_type": "家居/家清用品",
        "core_essence": "用收纳整理、清洁结果或顺手体验改善居家日常",
        "primary_subject": "家居或家清商品",
        "scene_objects": ["主体商品", "真实家居空间", "使用前后状态", "手部操作"],
        "selling_points": ["顺手", "整洁", "省心", "空间改善"],
        "human_role": "居家使用者",
        "human_product_relationship": "展开、摆放、清洁或收纳并展示结果",
        "recommended_scene_order": ["主体展示", "摆放/展开", "使用动作", "空间结果"],
        "interaction_logic": ["拿起商品", "展开或摆放", "完成使用", "展示收束"],
        "avoid_focus": ["母婴安抚口播", "零食食欲词"],
    },
    "electronics": {
        "product_type": "数码家电",
        "core_essence": "用连接、效率和稳定使用结果提升工作或生活体验",
        "primary_subject": "数码设备或家电",
        "scene_objects": ["整机外观", "接口/屏幕", "桌面或生活场景", "使用状态"],
        "selling_points": ["效率", "连接", "轻便", "稳定", "清晰"],
        "human_role": "设备使用者",
        "human_product_relationship": "拿起、连接、开启并展示实际使用状态",
        "recommended_scene_order": ["整机外观", "接口细节", "连接使用", "结果收束"],
        "interaction_logic": ["摆放设备", "连接", "展示使用结果", "收在桌面场景"],
        "avoid_focus": ["零食食欲词", "房产空间词"],
    },
    "education_culture": {
        "product_type": "图书课程文创",
        "core_essence": "用内容清晰度和学习/审美价值提升认知或表达",
        "primary_subject": "书籍、课程或文创产品",
        "scene_objects": ["封面/主体", "翻阅或课程内容", "学习/使用场景"],
        "selling_points": ["内容清晰", "学习效率", "知识吸收", "审美价值"],
        "human_role": "阅读者/学习者",
        "human_product_relationship": "翻阅、记录、点读或展示内容价值",
        "recommended_scene_order": ["主体展示", "内容细节", "使用场景", "学习收束"],
        "interaction_logic": ["拿起内容主体", "翻阅或点读", "记录或复习", "收在学习状态"],
        "avoid_focus": ["数码快充词", "零食食欲词"],
    },
    "mother_baby": {
        "product_type": "母婴用品",
        "core_essence": "用安全舒适和照护便利改善亲子日常",
        "primary_subject": "母婴商品",
        "scene_objects": ["产品主体", "亲子或照护场景", "配件细节"],
        "selling_points": ["安全", "舒适", "照护省心", "日常便利"],
        "human_role": "家长/照护者",
        "human_product_relationship": "陪伴、整理、使用或收纳商品",
        "recommended_scene_order": ["主体展示", "细节", "照护互动", "安心收束"],
        "interaction_logic": ["拿起或整理产品", "进行照护动作", "展示舒适结果"],
        "avoid_focus": ["家清去污词", "零食食欲词"],
    },
    "pet": {
        "product_type": "宠物用品",
        "core_essence": "用宠物舒适和主人打理省心提升陪伴体验",
        "primary_subject": "宠物用品",
        "scene_objects": ["宠物", "商品", "家中或户外日常场景"],
        "selling_points": ["舒适", "清洁方便", "省心", "陪伴体验"],
        "human_role": "宠物主人",
        "human_product_relationship": "陪伴宠物并自然展示商品使用结果",
        "recommended_scene_order": ["宠物与商品同框", "使用动作", "细节展示", "陪伴收束"],
        "interaction_logic": ["放置商品", "引导宠物使用", "展示结果"],
        "avoid_focus": ["母婴安抚口播", "零食食欲词"],
    },
    "tools_industrial": {
        "product_type": "工具工业品",
        "core_essence": "用稳定、耐用和效率提升实际作业结果",
        "primary_subject": "工具设备",
        "scene_objects": ["工具主体", "关键部件", "安装/维修场景"],
        "selling_points": ["稳定", "效率", "扭矩/力度", "耐用"],
        "human_role": "操作人员",
        "human_product_relationship": "握持、安装、紧固或维修演示",
        "recommended_scene_order": ["主体展示", "部件特写", "操作过程", "结果收束"],
        "interaction_logic": ["拿起工具", "对准操作位", "完成动作", "展示结果"],
        "avoid_focus": ["零食食欲词", "房产空间词"],
    },
    "generic": {
        "product_type": "商品",
        "core_essence": "解决用户的具体使用需求并展示购买理由",
        "primary_subject": "主商品",
        "scene_objects": ["商品主图", "使用场景", "细节", "人物"],
        "selling_points": ["外观", "功能", "材质", "使用体验"],
        "human_role": "产品讲解人",
        "human_product_relationship": "与商品互动并说出核心卖点",
        "recommended_scene_order": ["主体完整展示", "人物互动", "细节特写", "使用结果"],
        "interaction_logic": ["拿起或指向商品", "展示细节", "看向镜头说明卖点"],
        "avoid_focus": ["无关背景", "装饰物", "偶然出现的小物件"],
    },
}


def _short_text_list(values: Any, *, max_items: int = 5, max_len: int = 24) -> list[str]:
    if isinstance(values, str):
        raw_items = re.split(r"[、,，;；\n]+", values)
    elif isinstance(values, (list, tuple, set)):
        raw_items = list(values)
    else:
        raw_items = []
    result: list[str] = []
    for item in raw_items:
        text = re.sub(r"\s+", "", str(item or "")).strip(" ，,。；;")
        text = text[:max_len].rstrip("，。、；;")
        if text and text not in result:
            result.append(text)
        if len(result) >= max_items:
            break
    return result


def _default_ontology(category: Any, *, prompt: str, image_count: int, has_model: bool) -> dict[str, Any]:
    normalized = normalize_ecommerce_product_category(category, prompt=prompt)
    profile = deepcopy(_ONTOLOGY_PROFILES.get(normalized, _ONTOLOGY_PROFILES["generic"]))
    source = f"{category}\n{prompt}"
    if normalized == "food_beverage" and _positive_context(_SUPPLEMENT_PATTERN, source):
        profile = {
            "product_type": "保健品/营养补充剂",
            "core_essence": "用成分清晰、每日补充和坚持方便帮助用户做轻量健康管理",
            "primary_subject": "瓶身包装与软胶囊/胶囊",
            "scene_objects": ["瓶身标签", "软胶囊", "清水杯", "早餐台面", "每日补充场景"],
            "selling_points": ["成分清晰", "每日补充", "吞服顺手", "坚持方便", "生活管理感"],
            "human_role": "生活方式分享者",
            "human_product_relationship": "自然拿起、查看、倒出并配合清水准备吞服",
            "recommended_scene_order": ["完整包装", "瓶身标签", "倒出软胶囊", "配合清水准备吞服", "每日补充收束"],
            "interaction_logic": ["拿起瓶身", "展示标签", "倒出胶囊", "配合清水准备吞服", "收在坚持补充场景"],
            "avoid_focus": ["零食开袋", "香脆入口", "解馋分享", "夸张味觉刺激"],
        }
    elif normalized == "home_living" and _positive_context(_HOUSEHOLD_CLEANING_PATTERN, source):
        profile = {
            "product_type": "家清/清洁用品",
            "core_essence": "用去污效率、易清洁和日常打理省心改善家务体验",
            "primary_subject": "清洁用品与被清洁表面",
            "scene_objects": ["瓶身", "喷头/倒液口", "台面污渍", "抹布", "清洁前后对比"],
            "selling_points": ["去污效率", "一擦即净", "不费劲", "打理省心", "空间更清爽"],
            "human_role": "家务使用者",
            "human_product_relationship": "喷洒、擦拭并展示清洁结果",
            "recommended_scene_order": ["污渍场景", "产品外观", "喷洒动作", "擦拭结果", "台面收束"],
            "interaction_logic": ["拿起产品", "对准污渍喷洒", "擦拭", "展示前后变化"],
            "avoid_focus": ["宝宝安抚口播", "零食口感词", "数码效率词"],
        }
    elif normalized == "beauty_personal_care" and _positive_context(_ORAL_CARE_PATTERN, source):
        profile = {
            "product_type": "口腔护理/个护产品",
            "core_essence": "用轻柔刷感和清洁效率降低日常护理负担",
            "primary_subject": "口腔护理产品",
            "scene_objects": ["机身/刷头", "洗手台", "杯子/牙膏", "晨晚护理场景"],
            "selling_points": ["刷感轻柔", "清洁省力", "日常护理方便", "晨晚可用"],
            "human_role": "日常护理使用者",
            "human_product_relationship": "拿起、启动并自然展示护理动作",
            "recommended_scene_order": ["产品外观", "刷头细节", "使用动作", "护理收束"],
            "interaction_logic": ["拿起产品", "靠近口部或洗手台展示", "完成护理动作"],
            "avoid_focus": ["去污清洁台词", "母婴安抚口播", "数码办公词"],
        }
    elif normalized == "education_culture" and _positive_context(_EDUCATION_PATTERN, source):
        profile = {
            "product_type": "学习设备/教育内容",
            "core_essence": "用查词、跟读、复习和知识组织提升学习效率",
            "primary_subject": "学习设备或课程内容",
            "scene_objects": ["课桌", "教材", "词句内容", "学习设备", "复习场景"],
            "selling_points": ["查词高效", "跟读纠音", "复习清晰", "知识吸收更顺"],
            "human_role": "学习者",
            "human_product_relationship": "点读、查词、跟读或翻阅复习",
            "recommended_scene_order": ["设备/内容主体", "查词或翻阅", "跟读/记录", "复习收束"],
            "interaction_logic": ["拿起设备", "划过词句", "跟读复习", "收在知识吸收场景"],
            "avoid_focus": ["数码快充口播", "零食食欲词", "厨卫/房产词"],
        }
    elif normalized == "mother_baby" and _positive_context(_MOTHER_BABY_DURABLE_PATTERN, source):
        profile = {
            "product_type": "母婴耐用品/喂养器具",
            "core_essence": "用安全舒适和照护省心帮助家长完成日常喂养与护理",
            "primary_subject": "母婴器具",
            "scene_objects": ["产品主体", "奶瓶/睡袋/配件", "婴儿房或台面", "照护场景"],
            "selling_points": ["照护省心", "喂养准备方便", "安全舒适", "夜间使用便利"],
            "human_role": "家长/照护者",
            "human_product_relationship": "整理、准备、收纳或配合照护动作使用器具",
            "recommended_scene_order": ["产品主体", "关键配件", "照护动作", "省心收束"],
            "interaction_logic": ["拿起或整理产品", "准备喂养/照护", "收在家长安心场景"],
            "avoid_focus": ["家清去污台词", "零食食欲词", "数码效率词"],
        }
    if image_count > 1:
        profile["scene_objects"] = [*profile.get("scene_objects", []), "多张参考图代表的角度/场景"]
    if has_model:
        profile["scene_objects"] = [*profile.get("scene_objects", []), "人物参考图"]
    return profile


def _normalize_ontology(
    value: Any,
    *,
    category: Any,
    prompt: str,
    image_count: int,
    has_model: bool,
) -> dict[str, Any]:
    fallback = _default_ontology(category, prompt=prompt, image_count=image_count, has_model=has_model)
    source = value if isinstance(value, Mapping) else {}
    result: dict[str, Any] = {}
    for key in ("product_type", "core_essence", "primary_subject", "human_role", "human_product_relationship"):
        text = re.sub(r"\s+", "", str(source.get(key) or fallback.get(key) or "")).strip(" ，,。；;")
        result[key] = text[:42] if text else str(fallback.get(key) or "")
    for key in ("scene_objects", "selling_points", "recommended_scene_order", "interaction_logic", "avoid_focus"):
        items = _short_text_list(source.get(key), max_items=6 if key == "scene_objects" else 5)
        result[key] = items or _short_text_list(fallback.get(key), max_items=6 if key == "scene_objects" else 5)
    return result


def _default_creative_brief(category: Any, *, prompt: str, image_count: int, has_model: bool) -> dict[str, Any]:
    ontology = _default_ontology(category, prompt=prompt, image_count=image_count, has_model=has_model)
    normalized = normalize_ecommerce_product_category(category, prompt=prompt)
    world_defaults = {
        "real_estate": {
            "typical_environments": ["外立面", "入口", "客厅", "厨房", "卧室", "卫浴"],
            "reasonable_actions": ["走向建筑", "带看空间", "指向采光和动线", "看向镜头介绍"],
            "unreasonable_actions": ["重点讲墙面设备", "操作可视对讲", "编造地铁学区"],
            "scene_progression": ["项目主体", "入口", "起居空间", "功能空间", "居住体验"],
        },
        "commercial_space": {
            "typical_environments": ["城市街区", "建筑入口", "中庭/主通道", "购物餐饮休闲配套"],
            "reasonable_actions": ["从城市道路到达", "沿导视进入", "经过扶梯或中庭", "展示购物餐饮便利"],
            "unreasonable_actions": ["写成住宅看房", "安排入住或家庭生活幻想", "拍垃圾桶和污染环境", "编造客流或商业数据"],
            "scene_progression": ["城市地标", "入口导视", "公共空间", "配套动线", "商业价值收束"],
        },
        "sanitary_kitchen": {
            "typical_environments": ["现代厨房", "浴室", "家庭多点用水场景"],
            "reasonable_actions": ["指向机身", "展示水流", "带看安装位置", "说明恒温体验"],
            "unreasonable_actions": ["点击屏幕切换页面", "长时间只拍讲解人", "编造参数"],
            "scene_progression": ["安装外观", "产品细节", "浴室出水", "稳定体验"],
        },
        "vehicle": {
            "typical_environments": ["户外道路", "停车场", "车内座舱"],
            "reasonable_actions": ["绕车介绍", "打开车门", "坐入车内", "指向配置"],
            "unreasonable_actions": ["先讲无关配件", "编造动力参数", "忽略整车外观"],
            "scene_progression": ["整车外观", "车灯轮毂", "开门入座", "内饰配置"],
        },
        "apparel": {
            "typical_environments": ["街拍", "试衣间", "通勤场景", "商场橱窗"],
            "reasonable_actions": ["整理衣领", "转身展示", "走动展示版型", "展示面料"],
            "unreasonable_actions": ["只拍背景", "忽略上身效果"],
            "scene_progression": ["完整上身", "走动转身", "面料细节", "搭配场景"],
        },
        "beauty_personal_care": {
            "typical_environments": ["梳妆台", "浴室", "护肤/护理日常场景"],
            "reasonable_actions": ["拿起产品", "展示质地", "自然使用", "展示状态变化"],
            "unreasonable_actions": ["写成家清打理", "编造功效承诺"],
            "scene_progression": ["产品外观", "质地特写", "使用动作", "状态收束"],
        },
        "food_beverage": {
            "typical_environments": ["餐桌", "厨房", "分享或品尝场景"],
            "reasonable_actions": ["开封", "倒出", "夹取", "品尝", "分享"],
            "unreasonable_actions": ["套用房产/厨卫话术", "忽略真实食用场景"],
            "scene_progression": ["包装主体", "开封", "食物质感", "分享收束"],
        },
        "home_living": {
            "typical_environments": ["客厅", "厨房", "收纳/清洁家务场景"],
            "reasonable_actions": ["摆放", "展开", "喷洒", "擦拭", "收纳"],
            "unreasonable_actions": ["写成母婴安抚用品", "忽略前后结果"],
            "scene_progression": ["主体展示", "使用动作", "前后变化", "空间收束"],
        },
        "electronics": {
            "typical_environments": ["桌面", "办公区", "家庭使用场景"],
            "reasonable_actions": ["连接", "开启", "展示使用状态", "切换真实使用场景"],
            "unreasonable_actions": ["只拍屏幕反光", "忽略真实使用结果"],
            "scene_progression": ["整机外观", "接口/细节", "使用状态", "结果收束"],
        },
        "education_culture": {
            "typical_environments": ["课桌", "书桌", "阅读或复习场景"],
            "reasonable_actions": ["翻阅", "点读", "查词", "记录", "跟读"],
            "unreasonable_actions": ["写成普通数码快充工具", "忽略知识内容"],
            "scene_progression": ["主体展示", "内容细节", "学习动作", "复习收束"],
        },
        "mother_baby": {
            "typical_environments": ["婴儿房", "餐桌台面", "亲子照护场景"],
            "reasonable_actions": ["整理", "收纳", "准备喂养", "陪伴使用"],
            "unreasonable_actions": ["写成家清去污用品", "忽略安全舒适语境"],
            "scene_progression": ["主体展示", "关键细节", "照护动作", "安心收束"],
        },
        "pet": {
            "typical_environments": ["客厅", "猫砂盆/喂食区", "陪伴互动场景"],
            "reasonable_actions": ["放置用品", "引导宠物使用", "展示陪伴或打理结果"],
            "unreasonable_actions": ["写成母婴照护", "忽略宠物实际使用"],
            "scene_progression": ["宠物与商品同框", "使用过程", "细节展示", "陪伴收束"],
        },
        "tools_industrial": {
            "typical_environments": ["安装位", "工位", "维修场景"],
            "reasonable_actions": ["握持工具", "对准部件", "完成操作", "展示结果"],
            "unreasonable_actions": ["写成数码桌面工具", "只拍背景"],
            "scene_progression": ["主体展示", "关键部件", "操作过程", "结果收束"],
        },
        "generic": {
            "typical_environments": ["真实使用场景", "商业展示空间", "生活化环境"],
            "reasonable_actions": ["拿起商品", "指向细节", "展示使用结果", "看向镜头说明"],
            "unreasonable_actions": ["让背景抢焦点", "编造不可见参数"],
            "scene_progression": ["主体展示", "人物互动", "细节特写", "使用价值"],
        },
    }
    if normalized == "food_beverage" and _positive_context(_SUPPLEMENT_PATTERN, f"{category}\n{prompt}"):
        world = {
            "typical_environments": ["早餐台面", "书桌/餐桌", "日常补充场景"],
            "reasonable_actions": ["拿起瓶身", "展示成分标签", "倒出软胶囊", "配合清水准备吞服", "收在每日补充节奏"],
            "unreasonable_actions": ["咬一口", "香脆入口", "解馋分享", "夸张味觉刺激"],
            "scene_progression": ["包装主体", "标签识别", "倒出胶囊", "准备吞服", "坚持补充收束"],
        }
    else:
        world = world_defaults.get(normalized, world_defaults["generic"])
    scene_order = _short_text_list(ontology.get("recommended_scene_order"), max_items=6)
    selling_points = _short_text_list(ontology.get("selling_points"), max_items=4)
    return {
        "ontology": ontology,
        "epistemology": {
            "visible_facts": ["以上传图片中可见主体、场景、材质和人物为准"],
            "reasonable_inferences": ["可按品类推导真实使用环境和商业展示场景"],
            "unknowns": ["品牌", "价格", "精确参数", "认证信息"],
            "forbidden_claims": ["不要编造品牌、价格、具体参数、认证、距离和政策"],
        },
        "world_model": world,
        "axiology": {
            "user_benefits": selling_points or ["使用价值", "购买理由"],
            "emotional_value": "真实可信、清晰种草",
            "conversion_points": selling_points or ["核心卖点", "使用体验"],
        },
        "narratology": {
            "opening": scene_order[0] if scene_order else "用主体主图建立识别",
            "progression": scene_order or ["主体展示", "细节说明", "使用结果"],
            "ending": "看向镜头用短句收束购买理由",
            "segment_logic": "长视频按卖点均衡推进，跨段不重复同一卖点过久",
        },
        "methodology": {
            "creation_steps": ["识别主体", "提取可见事实", "推导真实场景", "安排卖点顺序", "压缩台词", "检查跑偏"]
        },
        "cinematic_language": {
            "shot_strategy": ["中景建立环境", "近景展示产品", "特写呈现细节"],
            "camera_motion": ["缓慢前推", "横移", "跟拍", "特写切换"],
            "sound_rules": ["无背景音", "分镜旁白短句清晰"],
        },
        "quality_control": {
            "checks": ["不编造不可见信息", "产品不被人物抢焦点", "时间轴完整", "台词匹配时长", "不输出分析标题"]
        },
    }


def _normalize_brief_section(value: Any, fallback: Mapping[str, Any]) -> dict[str, Any]:
    source = value if isinstance(value, Mapping) else {}
    result: dict[str, Any] = {}
    for key, fallback_value in fallback.items():
        if isinstance(fallback_value, list):
            result[key] = _short_text_list(source.get(key), max_items=6) or _short_text_list(fallback_value, max_items=6)
        else:
            text = re.sub(r"\s+", "", str(source.get(key) or fallback_value or "")).strip(" ，,。；;")
            result[key] = text[:60] if text else fallback_value
    return result


def normalize_ecommerce_creative_brief(
    value: Any,
    *,
    category: Any,
    prompt: str = "",
    image_count: int = 0,
    has_model: bool = False,
) -> dict[str, Any]:
    normalized_image_count = max(_to_int(image_count, 0), 0)
    fallback = _default_creative_brief(
        category,
        prompt=prompt,
        image_count=normalized_image_count,
        has_model=bool(has_model),
    )
    source = value if isinstance(value, Mapping) else {}
    ontology_source = source.get("ontology") if isinstance(source.get("ontology"), Mapping) else source
    result = {
        "ontology": _normalize_ontology(
            ontology_source,
            category=category,
            prompt=prompt,
            image_count=normalized_image_count,
            has_model=bool(has_model),
        )
    }
    for key in (
        "epistemology",
        "world_model",
        "axiology",
        "narratology",
        "methodology",
        "cinematic_language",
        "quality_control",
    ):
        result[key] = _normalize_brief_section(source.get(key), fallback[key])
    return result


def format_ecommerce_creative_brief_execution_guidance(brief: Any) -> str:
    if not isinstance(brief, Mapping):
        return ""
    ontology = brief.get("ontology") if isinstance(brief.get("ontology"), Mapping) else {}
    world_model = brief.get("world_model") if isinstance(brief.get("world_model"), Mapping) else {}
    axiology = brief.get("axiology") if isinstance(brief.get("axiology"), Mapping) else {}
    quality = brief.get("quality_control") if isinstance(brief.get("quality_control"), Mapping) else {}
    subject = str(ontology.get("primary_subject") or ontology.get("product_type") or "主商品").strip()
    points = _short_text_list(ontology.get("selling_points") or axiology.get("user_benefits"), max_items=4)
    scene_order = _short_text_list(
        ontology.get("recommended_scene_order") or world_model.get("scene_progression"), max_items=5
    )
    actions = _short_text_list(world_model.get("reasonable_actions") or ontology.get("interaction_logic"), max_items=4)
    checks = _short_text_list(quality.get("checks"), max_items=3)
    parts = [f"围绕{subject}展开"]
    if points:
        parts.append("突出" + "、".join(points))
    if scene_order:
        parts.append("按" + "、".join(scene_order) + "推进")
    if actions:
        parts.append("人物动作包含" + "、".join(actions))
    for check in checks:
        normalized = ""
        if "不编造" in check or "不可见" in check:
            normalized = "不得编造不可见信息"
        elif "抢焦点" in check:
            normalized = "产品不能被人物抢焦点"
        if normalized and normalized not in parts:
            parts.append(normalized)
    return "；".join(parts) + "。"


def strip_ecommerce_analysis_from_execution_prompt(prompt: Any) -> str:
    text = str(prompt or "").strip()
    if not text:
        return ""
    forbidden = (
        "本体分析",
        "认识论",
        "方法论",
        "价值论",
        "叙事学",
        "电影语言",
        "世界模型",
        "质量审校",
        "creative_brief",
        "ontology",
        "epistemology",
        "methodology",
        "内部创作推理",
        "内部推理",
        "创作推理",
        "创作思路",
        "推理过程",
        "分析过程",
        "审校",
    )
    lines: list[str] = []
    for line in re.split(r"[\r\n]+", text):
        stripped = re.sub(r"^\s{0,3}#{1,6}\s*", "", line.strip()).strip()
        if stripped and not any(token in stripped for token in forbidden):
            lines.append(stripped)
    cleaned = "\n".join(lines).strip()
    return re.sub(
        rf"^(?:分析|推理|创作分析|内部推理)[:：].*?(?={_TIME_RANGE_PATTERN}|$)",
        "",
        cleaned,
        flags=re.DOTALL | re.IGNORECASE,
    ).strip()


def _normalize_time_units(text: Any) -> str:
    content = str(text or "")
    content = re.sub(
        rf"[（(]\s*(\d+)\s*[-到至]\s*(\d+)\s*{_TIME_UNIT_PATTERN}\s*[）)]\s*[:：]",
        r"\g<1>-\g<2>秒：",
        content,
        flags=re.IGNORECASE,
    )
    content = re.sub(
        rf"[（(]\s*(\d+)\s*[-到至]\s*(\d+)\s*{_TIME_UNIT_PATTERN}\s*[）)](?!\s*[:：])",
        r"\n\g<1>-\g<2>秒：",
        content,
        flags=re.IGNORECASE,
    )
    return re.sub(
        rf"(\d+)\s*[-到至]\s*(\d+)\s*{_TIME_UNIT_PATTERN}\s*[:：]",
        r"\g<1>-\g<2>秒：",
        content,
        flags=re.IGNORECASE,
    )


def clean_ecommerce_video_prompt_text(prompt: Any, *, product_category: Any = "") -> str:
    text = strip_ecommerce_analysis_from_execution_prompt(prompt)
    if not text:
        return ""
    text = _normalize_time_units(text)
    text = re.sub(r"(\d+\s*[-到至]\s*\d+\s*秒)\s*:", r"\1：", text)
    text = re.sub(r"(?<![\d-])\b\d+\.\d+\s*秒\s*[:：]?", "", text)
    text = re.sub(r"\s+\d+\.(?=\s|$)", "", text)
    text = re.sub(r"(?<!^)(?<![\n\d])(?=\d+\s*[-到至]\s*\d+\s*秒\s*[:：])", "\n", text)
    text = re.sub(r"看向镜头\s*(?:自然)?总结\s*说?[:：]?", "旁白：", text)
    text = re.sub(r"人物(?:继续)?(?:自然)?总结\s*说?[:：]?", "旁白：", text)
    text = re.sub(r"(?:自然)?总结\s*说[:：]?", "旁白：", text)
    text = re.sub(r"总结[:：]", "旁白：", text)
    text = re.sub(r"(?:旁白|画外音)\s*说[:：]?", "旁白：", text)
    text = re.sub(r"人物继续站在", "人物站在", text)
    text = re.sub(r"画面(?:稳定|顺势)?承接前段尾帧[，,]?", "", text)
    text = re.sub(r"无背景音乐[，,、\s]*", "", text)
    text = re.sub(r"（\s*只保留人物口播和必要环境声[，,、\s]*无背景音\s*）", "（无背景音）", text)
    text = re.sub(r"\(\s*只保留人物口播和必要环境声[，,、\s]*无背景音\s*\)", "（无背景音）", text)
    text = re.sub(r"（\s*无背景音\s*）|\(\s*无背景音\s*\)", "", text)
    text = re.sub(
        r"声音(?:要求|约束)[:：]\s*只保留人物口播和必要环境声[，,、\s]*无背景音[。.]?",
        "无背景音。",
        text,
    )
    text = re.sub(r"(无背景音[。.]?)(?:\s*无背景音[。.]?)+", r"\1", text)
    replacements = (
        (r"标准电商开场[，,、；;]?", ""),
        (r"产品主体和核心卖点先(?:入镜|出现在画面中)[，,、；;]?", ""),
        (r"核心卖点先(?:入镜|出现在画面中)[，,、；;]?", ""),
        (r"产品主体先(?:入镜|出现在画面中)[，,、；;]?", ""),
        (r"产品英雄镜头", "@Image 1产品完整清晰入镜并在真实使用场景中带出可见卖点和实际结果"),
        (r"产品主画面", "@Image 1产品完整清晰入镜并在真实使用场景中带出可见卖点和实际结果"),
        (r"空间英雄镜头", "空间完整展开"),
        (r"空间主画面", "空间完整展开"),
        (r"主体英雄镜头", "主体完整出现在画面中"),
        (r"主体主画面", "主体完整出现在画面中"),
        (r"英雄镜头", "完整画面"),
        (r"主视觉", "完整画面"),
        (r"功能过程", "使用过程"),
    )
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)

    def clean_dialogue_line(match: re.Match[str]) -> str:
        prefix = str(match.group(1) or "")
        body = str(match.group(2) or "").strip()
        cleaned = _filter_dialogue_for_category(body, product_category).strip(" “”。；;，,")
        return f"{prefix}{cleaned}" if cleaned else ""

    text = re.sub(
        r"((?:旁白|画外音|纪录片旁白|人物对白)[:：]\s*[“\"']?)([^”\"'\n]+)",
        clean_dialogue_line,
        text,
    )
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[，,]{2,}", "，", text)
    return text.strip(" \t\r\n，,")


def _forbidden_dialogue_terms(product_category: Any) -> list[str]:
    context = str(product_category or "").strip()
    category = normalize_ecommerce_product_category(product_category, prompt=context)
    if category == "food_beverage" and _positive_context(_SUPPLEMENT_PATTERN, context):
        return [
            "一开就香",
            "一口满足",
            "解馋",
            "咬一口",
            "口感",
            "食欲",
            "香脆",
            "嫩",
            "甜",
            "好吃",
            "开袋",
            "入口",
            "越嚼越香",
            "停不下来",
            "自己吃合适",
            "分享也合适",
            "好吃好分享",
            "更有味",
        ]
    by_category = {
        "real_estate": ["18升", "恒温", "水温", "水量", "花洒", "淋浴", "座舱", "显瘦", "好推开", "一开就香"],
        "commercial_space": [
            "好想住在这里",
            "想入住",
            "入住",
            "住进这里",
            "回家",
            "客厅",
            "卧室",
            "阳台",
            "厨房",
            "卫浴",
            "这房子",
            "住起来",
            "垃圾桶",
            "垃圾",
            "污染",
            "脏乱",
        ],
        "sanitary_kitchen": ["好采光", "好动线", "停车近", "回家快", "座舱", "显瘦", "好推开", "一开就香"],
        "vehicle": ["18升", "恒温", "水温", "不忽冷", "不抢水", "全家热水", "一台稳住", "好采光", "停车近", "显瘦", "好推开", "一开就香"],
        "apparel": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "好推开", "一开就香"],
        "beauty_personal_care": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "一开就香", "一擦就净", "打理省心", "去污更快"],
        "food_beverage": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "好推开"],
        "home_living": ["18升", "恒温", "水温", "不忽冷", "不抢水", "全家热水", "一台稳住", "好采光", "停车近", "回家快", "座舱", "显瘦", "好推开", "一开就香", "宝宝舒服", "家长少操心", "照顾更省心"],
        "electronics": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "好推开", "一开就香"],
        "jewelry_luxury": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "好推开", "一开就香"],
        "sports_outdoor": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "好推开", "一开就香"],
        "mother_baby": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "一开就香", "一擦就净", "打理省心", "去污更快"],
        "pet": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "好推开"],
        "tools_industrial": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "一开就香", "好推开"],
        "education_culture": ["18升", "恒温", "水温", "好采光", "停车近", "回家快", "座舱", "显瘦", "一开就香", "好推开", "打开就快", "用着顺手", "效率更高"],
    }
    return list(by_category.get(category) or [])


def _filter_dialogue_for_category(dialogue: Any, product_category: Any) -> str:
    text = str(dialogue or "").strip()
    forbidden = _forbidden_dialogue_terms(product_category)
    if not text or not forbidden:
        return text
    kept: list[str] = []
    sentences = [
        item.strip(" ，,。；;")
        for item in re.split(r"(?<=[。！？!?；;])", text)
        if item.strip(" ，,。；;")
    ] or [text]
    for sentence in sentences:
        clean = sentence.strip(" “”。；;，,")
        if clean and not any(term in clean for term in forbidden):
            kept.append(clean)
    return "。".join(kept).strip("。")


def _unique_texts(values: Any) -> list[str]:
    result: list[str] = []
    for value in values or []:
        text = str(value or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def build_ecommerce_reference_constraints(
    *,
    product_paths: Sequence[Any],
    model_path: Any = "",
    model_reference_skipped: bool = False,
    max_images: int = 9,
) -> dict[str, Any]:
    products = _unique_texts(product_paths)
    model_value = str(model_path or "").strip()
    skipped = bool(model_reference_skipped) or not model_value
    limit = min(max(_to_int(max_images, 9), 1), 9)
    reference_paths = list(products)
    if not skipped and model_value and model_value not in reference_paths:
        reference_paths = reference_paths[: max(limit - 1, 0)]
        reference_paths.append(model_value)
    else:
        reference_paths = reference_paths[:limit]

    product_index_by_path = {path: index for index, path in enumerate(products, start=1)}
    note_parts: list[str] = []
    product_refs: list[str] = []
    model_ref = ""
    for index, path in enumerate(reference_paths, start=1):
        if not skipped and model_value and path == model_value:
            note_parts.append(f"@Image {index}=模特/人物参考图")
            model_ref = f"@Image {index}"
        else:
            product_index = product_index_by_path.get(path, index)
            note_parts.append(f"@Image {index}=产品图{product_index}")
            product_refs.append(f"@Image {index}")

    reference_note = ""
    if note_parts:
        reference_note = (
            "素材说明：参考图编号与上传素材对应，"
            + "，".join(note_parts)
            + "。叙事顺序应由画面主体和商业卖点决定，不必按编号顺序；先判断哪张是主图/主体/封面/最具代表性的画面，不要机械按上传顺序。"
        )
        submitted_product_count = len(product_refs)
        if len(products) > submitted_product_count:
            reference_note += " 超过接口上限的产品图未提交给视频模型。"
    else:
        submitted_product_count = 0

    return {
        "reference_paths": reference_paths,
        "reference_note_parts": note_parts,
        "reference_note": reference_note,
        "product_refs": product_refs,
        "model_ref": model_ref,
        "model_reference_skipped": skipped,
        "submitted_product_count": submitted_product_count,
    }


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "y"}:
        return True
    if text in {"0", "false", "no", "off", "n"}:
        return False
    return default


def _target_language_label(value: Any) -> str:
    text = str(value or "").strip()
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
    language = text if text in _LANGUAGE_LABELS else aliases.get(text.lower(), aliases.get(text, "Chinese"))
    return _LANGUAGE_LABELS.get(language, "中文")


def build_ecommerce_submission_constraints(
    payload: Mapping[str, Any] | None,
    *,
    reference_constraints: Mapping[str, Any] | None = None,
    has_audio: bool = False,
) -> dict[str, Any]:
    source = dict(payload or {})
    references = dict(reference_constraints or {})
    model_ref = str(references.get("model_ref") or "").strip()
    skipped = _to_bool(references.get("model_reference_skipped"), not bool(model_ref))

    product_brief_text = str(
        source.get("product_details") or source.get("product_description") or source.get("product_intro") or ""
    ).strip()
    copy_text = str(
        source.get("copy_text") or source.get("script") or source.get("speech_text") or product_brief_text
    ).strip()
    if model_ref:
        model_performance_constraint = (
            "人物规则：已上传人物参考图时，至少一个分镜必须让人物按参考人物图自然出镜；"
            "人物只做辅助展示、带看、体验或尺度参照，不要变成直播口播。"
        )
        model_identity_constraint = f"人物形象参考 {model_ref}，保持身份一致，允许自然改变姿态、手势、表情和站位。"
    else:
        model_performance_constraint = ""
        model_identity_constraint = ""
    low_person_weight_constraint = (
        "用户未提供人物参考图：优先拍产品、空间、功能过程和使用结果；"
        "如需人物，只用手部、背影、侧身、远景或虚焦氛围，不要正面人脸。"
        if skipped
        else ""
    )

    if product_brief_text:
        copy_text_constraint = (
            f"用户补充的产品相关简介：{product_brief_text}。必须结合商品名称和上传图像提炼视频卖点、使用场景和少量短旁白，不必逐字照搬。"
        )
    elif copy_text:
        copy_text_constraint = f"历史任务文案：{copy_text}。可转成视觉卖点或少量短旁白，不必整段照搬。"
    else:
        copy_text_constraint = ""

    product_name = str(
        source.get("product_name") or source.get("product_project_name") or source.get("project_name") or ""
    ).strip()
    product_context_constraint = (
        f"商品名称：{product_name}。视频主体、旁白和卖点必须围绕该名称对应的商品/项目。"
        if product_name
        else ""
    )
    subject_integrity_constraint = (
        "主体规则：主体保持在产品、场景或使用结果；围绕真实商品、项目或空间展开；"
        "可以大胆联想场景和视觉隐喻，但不要编造品牌型号、参数或不存在的功能。"
    )
    sound_constraint = "无字幕，无背景音乐。"
    style = str(source.get("ecommerce_ad_style") or source.get("ad_style") or "").strip()
    story_dialogue_constraint = (
        "剧情模式声音：人物对白或剧情旁白写入各自对应分镜，按剧情推进分布在开场、发展和结果段，"
        "不能全部放在最后一段；最后一段只保留必要收束句。"
        if style == "story"
        else ""
    )
    if has_audio:
        audio_output_constraint = (
            f"如有旁白，使用上传的音色参考音频。{story_dialogue_constraint or '旁白统一放在整段时间轴之后。'}"
        )
    elif product_brief_text:
        audio_output_constraint = (
            "台词可以有，也可以没有；如有旁白，根据产品相关简介、商品名称和上传图像压缩成短句卖点；"
            f"{story_dialogue_constraint or '统一放在整段时间轴之后。'}"
        )
    elif copy_text:
        audio_output_constraint = (
            f"台词可以有，也可以没有；如有旁白，压缩历史文案为短句卖点；{story_dialogue_constraint or '统一放在整段时间轴之后。'}"
        )
    else:
        audio_output_constraint = (
            f"台词可以有，也可以没有；{story_dialogue_constraint or '如有旁白，统一放在整段时间轴之后。'}"
        )
    language_label = _target_language_label(source.get("target_language") or source.get("language"))
    target_language_constraint = (
        f"目标地区语言：{language_label}。所有人物台词、统一旁白、口播文稿和字幕文本都必须使用{language_label}；画面描述仍可使用中文。"
    )
    no_text_overlay_constraint = "禁止生成字幕、水印、海报文字或无关品牌标识。"
    segment_constraints = [
        target_language_constraint,
        model_performance_constraint,
        model_identity_constraint,
        low_person_weight_constraint,
        product_context_constraint,
        copy_text_constraint,
        subject_integrity_constraint,
        audio_output_constraint,
        no_text_overlay_constraint,
    ]
    return {
        "product_brief_text": product_brief_text,
        "copy_text": copy_text,
        "model_performance_constraint": model_performance_constraint,
        "model_identity_constraint": model_identity_constraint,
        "low_person_weight_constraint": low_person_weight_constraint,
        "copy_text_constraint": copy_text_constraint,
        "product_context_constraint": product_context_constraint,
        "subject_integrity_constraint": subject_integrity_constraint,
        "story_dialogue_constraint": story_dialogue_constraint,
        "audio_output_constraint": audio_output_constraint,
        "target_language_constraint": target_language_constraint,
        "no_text_overlay_constraint": no_text_overlay_constraint,
        "sound_constraint": sound_constraint,
        "segment_constraints": segment_constraints,
    }


def _split_dialogue_tail(prompt: Any) -> tuple[str, str]:
    text = str(prompt or "").strip()
    matches = list(re.finditer(r"(?:台词|旁白|画外音)[:：]", text))
    if not matches:
        return text, ""
    marker = matches[-1]
    body = text[: marker.start()].strip()
    dialogue = text[marker.end() :].strip()
    dialogue = re.split(r"\n(?:声音要求|声音约束)[:：]", dialogue, maxsplit=1)[0].strip()
    return body, dialogue


def compose_ecommerce_segment_prompt(
    *,
    prompt: Any,
    constraints: Sequence[Any] | None = None,
    sound_constraint: Any = "",
    product_category: Any = "",
    preserve_dialogue: bool = False,
) -> str:
    del product_category  # Kept for source-runner call compatibility.
    body, dialogue = _split_dialogue_tail(prompt)
    clean_constraints: list[str] = []
    for item in constraints or []:
        text = str(item or "").strip()
        if text and text not in clean_constraints and text not in body:
            clean_constraints.append(text)
    parts: list[str] = []
    if clean_constraints:
        parts.append("\n".join(clean_constraints))
    if body:
        if dialogue:
            # The standard runner always submits with preserve_dialogue=True.
            label = "旁白：" if preserve_dialogue else "旁白："
            body = f"{body.rstrip()}\n{label}{dialogue}"
        parts.append(body)
    sound = str(sound_constraint or "").strip()
    if sound and sound not in "\n".join(parts):
        parts.append(sound)
    return "\n".join(part for part in parts if part.strip()).strip()


__all__ = [
    "ECOMMERCE_SHORT_VIDEO_DEFAULT_APP_ID",
    "ECOMMERCE_SHORT_VIDEO_FAST_APP_ID",
    "build_ecommerce_reference_constraints",
    "build_ecommerce_submission_constraints",
    "clean_ecommerce_video_prompt_text",
    "compose_ecommerce_segment_prompt",
    "format_ecommerce_creative_brief_execution_guidance",
    "normalize_ecommerce_creative_brief",
    "normalize_ecommerce_model",
    "normalize_ecommerce_model_workflow",
    "normalize_ecommerce_product_category",
    "normalize_ecommerce_workflow_chain",
    "normalize_ecommerce_workflow_id",
    "strip_ecommerce_analysis_from_execution_prompt",
    "workflow_id_for_ecommerce_model",
]
