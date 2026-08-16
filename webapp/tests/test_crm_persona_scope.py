import unittest

from webapp.crm.persona_scope import (
    apply_persona_audience_scope,
    classify_persona_candidate,
    plan_persona_keywords,
)


PERSONA = {
    "keywordGroups": [
        {"name": "场景", "keywords": ["露营装备", "轻量帐篷", "帐篷"]},
        {"name": "需求", "keywords": ["周末露营", "亲子露营"]},
    ]
}


class CRMPersonaScopeTests(unittest.TestCase):
    def test_generic_persona_layers_have_no_industry_rules(self):
        precision = classify_persona_candidate(
            {"text": "周末露营想换轻量帐篷", "keyword": "轻量帐篷"}, persona=PERSONA
        )
        expanded = classify_persona_candidate(
            {"text": "正在比较轻量帐篷的重量"}, persona=PERSONA
        )
        excluded = classify_persona_candidate(
            {"text": "今天分享帐篷照片"}, persona=PERSONA
        )
        self.assertEqual(precision["tier"], "precision")
        self.assertEqual(expanded["tier"], "expanded")
        self.assertEqual(excluded["tier"], "excluded")
        self.assertEqual(excluded["reason"], "generic_signal_only")

    def test_scope_annotations_are_pure_and_scope_controls_eligibility(self):
        rows = [
            {"platform": "threads", "row": {"username": "a", "text": "亲子露营寻找轻量帐篷"}},
            {"platform": "threads", "row": {"username": "b", "text": "比较轻量帐篷"}},
            {"platform": "threads", "row": {"username": "c", "text": "不相关内容"}},
        ]
        vertical = apply_persona_audience_scope(rows, persona=PERSONA, audience_scope="vertical")
        expanded = apply_persona_audience_scope(rows, persona=PERSONA, audience_scope="expanded")
        self.assertEqual(vertical["counts"], {"precision": 1, "expanded": 1, "excluded": 1})
        self.assertEqual(len(vertical["eligible"]), 1)
        self.assertEqual(len(expanded["eligible"]), 2)
        self.assertNotIn("audience_tier", rows[0]["row"])

    def test_vertical_keyword_plan_uses_persona_material_without_fallback(self):
        planned = plan_persona_keywords(
            ["帐篷", "轻量帐篷", "周末露营", "随便聊聊"], "vertical", persona=PERSONA
        )
        self.assertEqual(planned, ["轻量帐篷", "周末露营"])
        self.assertEqual(plan_persona_keywords(["随便聊聊"], "vertical", persona={}), [])
        self.assertEqual(
            plan_persona_keywords(["随便聊聊", "轻量帐篷"], "expanded", persona={}),
            ["随便聊聊", "轻量帐篷"],
        )


if __name__ == "__main__":
    unittest.main()
