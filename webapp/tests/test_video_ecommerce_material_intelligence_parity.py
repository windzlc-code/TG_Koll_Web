from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from video_core import ecommerce_material_intelligence as material


class EcommerceMaterialIntelligenceParityTests(unittest.TestCase):
    def test_material_analysis_uses_original_contract_and_normalizes_indexes(self):
        calls: list[dict] = []

        def request_json(**values):
            calls.append(values)
            return {
                "parsed": {
                    "product_category": "real_estate",
                    "product_identity": {"brand": "Vecto", "keywords": ["apartment"]},
                    "usable_image_indexes": [3, 1, 99, 3],
                    "ignored_image_indexes": [2, 3],
                    "image_assessments": [{"index": 1, "role": "main", "visible_info": ["front"]}],
                    "visible_selling_points": ["natural light"],
                }
            }

        result = material.analyze_ecommerce_materials(
            source={},
            parameters={"product_name": "Apartment", "duration": 15},
            image_paths=["one.png", "two.png", "three.png"],
            request_json=request_json,
        )
        self.assertEqual(result["usable_image_indexes"], [3, 1])
        self.assertEqual(result["ignored_image_indexes"], [2])
        self.assertEqual(result["product_category"], "real_estate")
        self.assertIn("usable_image_indexes", calls[0]["system_prompt"])

    def test_effective_reference_selection_preserves_priority_model_and_caps(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = [str((Path(tmpdir) / f"p{index}.png").resolve()) for index in range(1, 6)]
            model_path = str((Path(tmpdir) / "model.png").resolve())
            selected = material.select_ecommerce_effective_references(
                product_paths=paths,
                model_path=model_path,
                material_analysis={
                    "product_category": "generic",
                    "usable_image_indexes": [4, 2, 1, 3, 5],
                    "ignored_image_indexes": [5],
                },
                priority_product_paths=[paths[2]],
            )
        self.assertEqual(selected["selected_original_indexes"], [3, 4, 2])
        self.assertEqual(selected["reference_paths"][-1], model_path)
        self.assertEqual(selected["model_image_index"], 4)
        self.assertIn("模特/人物参考图", selected["reference_order"][-1])

    def test_creative_brief_instruction_keeps_analysis_internal(self):
        instruction = material.ecommerce_creative_brief_schema_instruction()
        self.assertIn("creative_brief", instruction)
        self.assertIn("execution_prompt", instruction)
        self.assertIn("不得把它的标题或分析过程写进", instruction)

    def test_original_product_research_query_and_html_parser_are_available(self):
        query = material.ecommerce_material_search_query(
            {"product_identity": {"brand": "Vecto", "model": "X1", "product_type": "camera"}},
            product_name="Camera",
        )
        self.assertIn("Vecto X1 camera", query)

        class Response:
            text = (
                '<a class="result__a" href="https://example.test/item"><b>Vecto X1</b></a>'
                '<a class="result__snippet">Visible product facts</a>'
            )

            @staticmethod
            def raise_for_status():
                return None

        research = material.search_ecommerce_product_web_info(query, http_get=lambda *args, **kwargs: Response())
        context = material.build_ecommerce_product_web_research_context(research)
        self.assertEqual(context["results"][0]["title"], "Vecto X1")
        self.assertIn("Visible product facts", context["summary_lines"][0])


if __name__ == "__main__":
    unittest.main()
