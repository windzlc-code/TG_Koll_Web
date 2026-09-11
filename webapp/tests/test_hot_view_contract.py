from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_new_server_preserves_hot_view_aliases_at_normalization_boundary():
    from webapp.server import _normalize_persona_hot_candidate

    normalized = _normalize_persona_hot_candidate(
        {
            "id": "post-1",
            "sourceUrl": "https://www.threads.net/@demo/post/1",
            "content": "hello",
            "viewCount": "18000",
            "metrics": {"likes": 2},
            "engagement": {},
        }
    )

    assert normalized is not None
    assert normalized["view_count"] == 18000
    assert normalized["engagement"]["viewCount"] == 18000


def test_reader_parser_and_spider_markdown_carry_real_view_counts():
    importer = (ROOT / "tool_r18" / "src" / "lib" / "sentiment-hot-importer.ts").read_text(encoding="utf-8")

    parser_start = importer.index("export function parseThreadsReaderSearchMarkdownCandidates")
    parser_end = importer.index("export function", parser_start + 1)
    parser = importer[parser_start:parser_end]

    assert "parseThreadsPostViewCountFromText(block)" in parser
    markdown_start = importer.index("export function buildSpiderSearchMarkdownFromHotCandidates")
    markdown_end = importer.index("export function", markdown_start + 1)
    markdown = importer[markdown_start:markdown_end]
    assert "浏览" in markdown


def test_reader_view_enrichment_is_not_blocked_by_browser_rescue_and_heat_uses_views():
    importer = (ROOT / "tool_r18" / "src" / "lib" / "sentiment-hot-importer.ts").read_text(encoding="utf-8")
    console = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")

    assert "const browserMetricsPromise = options.includeReader === false" in importer
    assert '["热度", personaHotViewMetric(candidate)]' in console
    assert '["热度", personaHotViewMetric(meta)]' in console
