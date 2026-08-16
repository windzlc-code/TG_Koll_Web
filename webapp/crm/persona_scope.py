"""Industry-neutral persona relevance classification.

All signals are derived from the supplied persona/query keyword material.  The
module intentionally has no built-in vocabulary for any particular industry.
"""

from __future__ import annotations

from collections import Counter
import copy
import re
import unicodedata
from typing import Any, Iterable, Mapping, Sequence

from .collection_policy import collect_source_keywords


AUDIENCE_TIERS = ("precision", "expanded", "excluded")
_TIER_RANK = {"excluded": 0, "expanded": 1, "precision": 2}
_TEXT_FIELDS = (
    "text",
    "evidence_text",
    "evidenceText",
    "raw_text",
    "rawText",
    "caption",
    "bio",
    "display_name",
    "displayName",
)
_GROUP_KEYS = ("keyword_groups", "keywordGroups")
_CLAUSE_SPLIT = re.compile(r"[\n\r,，;；。.!！？?、|/]+")


def _clean(value: Any, maximum: int = 3000) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).replace("\x00", "").strip()[:maximum]


def _identity(value: Any) -> str:
    return re.sub(r"\s+", "", _clean(value, 120).casefold())


def _dedupe(values: Iterable[Any], maximum: int = 120) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = _clean(raw, 120)
        identity = _identity(value)
        if len(identity) < 2 or identity in seen:
            continue
        seen.add(identity)
        result.append(value)
        if len(result) >= maximum:
            break
    return result


def normalize_audience_scope(value: Any) -> str:
    return "expanded" if str(value or "").strip().casefold() == "expanded" else "vertical"


def _sequence(value: Any) -> list[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    return []


def _persona_groups(persona: Mapping[str, Any] | None, query_keywords: Any = None) -> list[dict[str, Any]]:
    persona = persona if isinstance(persona, Mapping) else {}
    result: list[dict[str, Any]] = []
    for key in _GROUP_KEYS:
        for index, group in enumerate(_sequence(persona.get(key))):
            if not isinstance(group, Mapping):
                continue
            keywords = collect_source_keywords(group.get("keywords"), None, None)
            if keywords:
                result.append({"name": _clean(group.get("name"), 80) or f"group:{index + 1}", "keywords": keywords})

    direct = collect_source_keywords(None, None, persona)
    grouped_identities = {_identity(keyword) for group in result for keyword in group["keywords"]}
    ungrouped = [keyword for keyword in direct if _identity(keyword) not in grouped_identities]
    if ungrouped:
        result.append({"name": "persona", "keywords": ungrouped})

    query = _dedupe(_sequence(query_keywords) if not isinstance(query_keywords, str) else _CLAUSE_SPLIT.split(query_keywords))
    if query:
        result.append({"name": "query", "keywords": query})
    return result


def _generic_identities(groups: Sequence[Mapping[str, Any]]) -> set[str]:
    occurrences: Counter[str] = Counter()
    phrases: dict[str, str] = {}
    for group in groups:
        group_seen: set[str] = set()
        for keyword in group.get("keywords", ()):  # type: ignore[union-attr]
            identity = _identity(keyword)
            if not identity:
                continue
            phrases[identity] = _clean(keyword, 120)
            group_seen.add(identity)
        occurrences.update(group_seen)

    generic = {identity for identity, count in occurrences.items() if count > 1}
    identities = tuple(phrases)
    for identity in identities:
        if len(identity) <= 1:
            generic.add(identity)
            continue
        if any(identity != other and identity in other and len(other) >= len(identity) + 2 for other in identities):
            generic.add(identity)
    return generic


def _candidate_parts(row: Mapping[str, Any]) -> tuple[str, str]:
    body = "\n".join(_clean(row.get(field)) for field in _TEXT_FIELDS if _clean(row.get(field)))
    declared_values: list[Any] = [row.get("keyword")]
    declared_values.extend(_sequence(row.get("keywords")))
    declared_values.extend(_sequence(row.get("tags")))
    declared = "\n".join(_clean(value, 120) for value in declared_values if _clean(value, 120))
    return body.casefold(), declared.casefold()


def classify_persona_candidate(
    row: Mapping[str, Any] | None,
    *,
    persona: Mapping[str, Any] | None = None,
    query_keywords: Any = None,
) -> dict[str, Any]:
    """Classify one candidate using only supplied persona/query evidence."""

    row = row if isinstance(row, Mapping) else {}
    groups = _persona_groups(persona, query_keywords)
    generic = _generic_identities(groups)
    body, declared = _candidate_parts(row)
    searchable = f"{body}\n{declared}"
    matched_groups: list[str] = []
    matched_keywords: list[str] = []
    specific: list[str] = []

    for group in groups:
        group_matches: list[str] = []
        for keyword in group["keywords"]:
            if _clean(keyword).casefold() in searchable:
                group_matches.append(keyword)
                matched_keywords.append(keyword)
                if _identity(keyword) not in generic:
                    specific.append(keyword)
        if group_matches:
            matched_groups.append(str(group["name"]))

    matched_groups = _dedupe(matched_groups)
    matched_keywords = _dedupe(matched_keywords)
    specific = _dedupe(specific)
    corroborated = any(
        _clean(keyword).casefold() in body and _clean(keyword).casefold() in declared
        for keyword in specific
    )

    if len(matched_groups) >= 2 or len(specific) >= 2 or (specific and corroborated):
        tier = "precision"
        reason = "multiple_persona_signals" if not corroborated else "corroborated_persona_signal"
    elif specific:
        tier = "expanded"
        reason = "single_persona_signal"
    elif matched_keywords:
        tier = "excluded"
        reason = "generic_signal_only"
    elif searchable.strip():
        tier = "excluded"
        reason = "no_persona_signal"
    else:
        tier = "excluded"
        reason = "missing_candidate_text"

    return {
        "tier": tier,
        "reason": reason,
        "matched_groups": matched_groups,
        "matched_keywords": matched_keywords,
        "specific_keywords": specific,
    }


def _candidate_identity(item: Mapping[str, Any], row: Mapping[str, Any]) -> str:
    platform = _identity(item.get("platform") or row.get("platform"))
    username = _identity(row.get("username") or row.get("handle"))
    return f"{platform}:{username}" if platform and username else ""


def apply_persona_audience_scope(
    rows: Iterable[Mapping[str, Any]] | None,
    *,
    audience_scope: Any = "vertical",
    persona: Mapping[str, Any] | None = None,
    query_keywords: Any = None,
) -> dict[str, Any]:
    """Annotate rows and select eligible precision/expanded candidates."""

    scope = normalize_audience_scope(audience_scope)
    classified: list[tuple[Mapping[str, Any], Mapping[str, Any], dict[str, Any], str]] = []
    by_identity: dict[str, dict[str, Any]] = {}
    for item in list(rows or ()):
        nested = item.get("row")
        row = nested if isinstance(nested, Mapping) else item
        assessment = classify_persona_candidate(row, persona=persona, query_keywords=query_keywords)
        identity = _candidate_identity(item, row)
        classified.append((item, row, assessment, identity))
        current = by_identity.get(identity) if identity else None
        if identity and (current is None or _TIER_RANK[assessment["tier"]] > _TIER_RANK[current["tier"]]):
            by_identity[identity] = assessment

    counts = {tier: 0 for tier in AUDIENCE_TIERS}
    if by_identity:
        for assessment in by_identity.values():
            counts[assessment["tier"]] += 1
        for _, _, assessment, identity in classified:
            if not identity:
                counts[assessment["tier"]] += 1
    else:
        for _, _, assessment, _ in classified:
            counts[assessment["tier"]] += 1

    annotated: list[dict[str, Any]] = []
    for item, row, assessment, identity in classified:
        resolved = by_identity.get(identity, assessment)
        annotated_row = copy.deepcopy(dict(row))
        annotated_row.update(
            {
                "audience_tier": resolved["tier"],
                "audience_reason": resolved["reason"],
                "audience_matched_groups": list(resolved["matched_groups"]),
                "audience_matched_keywords": list(resolved["matched_keywords"]),
            }
        )
        if isinstance(item.get("row"), Mapping):
            annotated_item = copy.deepcopy(dict(item))
            annotated_item["row"] = annotated_row
        else:
            annotated_item = annotated_row
        annotated.append(annotated_item)

    def tier_of(item: Mapping[str, Any]) -> str:
        row = item.get("row") if isinstance(item.get("row"), Mapping) else item
        return str(row.get("audience_tier") or "excluded")

    eligible = [
        item
        for item in annotated
        if tier_of(item) == "precision" or (scope == "expanded" and tier_of(item) == "expanded")
    ]
    return {"audience_scope": scope, "counts": counts, "annotated": annotated, "eligible": eligible}


def plan_persona_keywords(
    keywords: Any,
    audience_scope: Any = "vertical",
    *,
    persona: Mapping[str, Any] | None = None,
    query_keywords: Any = None,
    maximum: int = 120,
) -> list[str]:
    """Filter supplied keywords without synthesizing fallback vocabulary."""

    supplied = collect_source_keywords(keywords, None, None, maximum=maximum)
    if normalize_audience_scope(audience_scope) == "expanded":
        return supplied
    groups = _persona_groups(persona, query_keywords)
    generic = _generic_identities(groups)
    persona_identities = {
        _identity(keyword)
        for group in groups
        for keyword in group["keywords"]
        if _identity(keyword) not in generic
    }
    return [
        keyword
        for keyword in supplied
        if _identity(keyword) not in generic
        and any(
            _identity(keyword) == target
            or (_identity(keyword) in target and len(target) >= len(_identity(keyword)) + 2)
            or (target in _identity(keyword) and len(_identity(keyword)) >= len(target) + 2)
            for target in persona_identities
        )
    ]
