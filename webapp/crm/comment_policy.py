from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Any


PUBLIC_COMMENT_SIMILARITY_LIMIT = 0.76

_LEADING_MENTION_PATTERN = re.compile(r"^\s*@[a-z0-9._-]+\s*", re.IGNORECASE)
_URL_PATTERN = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_CONTACT_PATTERN = re.compile(
    r"(?:https?://|www\.|line\s*(?:id|@|[:：])|line\.me|whatsapp|telegram|"
    r"(?:\d[\s().+-]*){8,})",
    re.IGNORECASE,
)
_TEMPLATE_QUESTION_PATTERN = re.compile(
    r"^(?:@[a-z0-9._-]+\s*)?你提到.{0,18}[，,].{8,}你(?:目前|主要|現在|现在).{0,18}(?:還是|还是|或是).{1,30}[？?]?$",
    re.IGNORECASE,
)


def normalize_public_comment_similarity_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower()
    text = _LEADING_MENTION_PATTERN.sub("", text)
    text = _URL_PATTERN.sub("", text)
    return "".join(
        character
        for character in text
        if not character.isspace() and unicodedata.category(character)[0] not in {"P", "S"}
    ).strip()


def character_shingles(value: Any, width: int = 3) -> frozenset[str]:
    normalized = normalize_public_comment_similarity_text(value)
    characters = list(normalized)
    size = max(1, int(width))
    if not characters:
        return frozenset()
    if len(characters) <= size:
        return frozenset({"".join(characters)})
    return frozenset("".join(characters[index:index + size]) for index in range(len(characters) - size + 1))


def public_comment_similarity(left: Any, right: Any) -> float:
    left_normalized = normalize_public_comment_similarity_text(left)
    right_normalized = normalize_public_comment_similarity_text(right)
    if not left_normalized or not right_normalized:
        return 0.0
    if left_normalized == right_normalized:
        return 1.0
    left_set = character_shingles(left_normalized)
    right_set = character_shingles(right_normalized)
    union = left_set | right_set
    return len(left_set & right_set) / len(union) if union else 0.0


def assess_public_comment_content(
    *,
    comment: Any = "",
    recent_comments: Iterable[Any] = (),
    similarity_limit: float = PUBLIC_COMMENT_SIMILARITY_LIMIT,
) -> dict[str, Any]:
    """Apply first-touch contact, context, template, and duplicate guards."""

    raw = str(comment or "").strip()
    normalized = normalize_public_comment_similarity_text(raw)
    if _CONTACT_PATTERN.search(raw):
        return {
            "allowed": False,
            "code": "first_contact_information",
            "reason": "首次公开互动不可加入电话、LINE 或链接",
        }
    if len(normalized) < 18:
        return {
            "allowed": False,
            "code": "comment_too_generic",
            "reason": "留言内容太短或缺少可识别的原文脉络",
        }
    if _TEMPLATE_QUESTION_PATTERN.fullmatch(re.sub(r"\s+", " ", raw).strip()):
        return {
            "allowed": False,
            "code": "repetitive_question_template",
            "reason": "留言使用高风险制式句型“你提到…你目前／主要…还是…”",
        }

    highest_similarity = 0.0
    for previous in recent_comments or ():
        similarity = public_comment_similarity(raw, previous)
        highest_similarity = max(highest_similarity, similarity)
        if similarity >= float(similarity_limit):
            exact = similarity == 1
            return {
                "allowed": False,
                "code": "duplicate_comment" if exact else "near_duplicate_comment",
                "reason": (
                    "相同发送账号已使用过完全相同的留言"
                    if exact
                    else f"留言与近期内容过度相似（{round(similarity * 100)}%）"
                ),
                "similarity": similarity,
            }
    return {
        "allowed": True,
        "code": "ready",
        "reason": "",
        "similarity": highest_similarity,
    }


__all__ = [
    "PUBLIC_COMMENT_SIMILARITY_LIMIT",
    "assess_public_comment_content",
    "character_shingles",
    "normalize_public_comment_similarity_text",
    "public_comment_similarity",
]
