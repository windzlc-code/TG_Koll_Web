import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_added_hot_cases_use_persisted_report_endpoints() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")

    assert 'id: "tjs0980"' in script
    assert 'number: "03"' in script
    assert 'username: "tjs0980"' in script
    assert 'reportUrl: "http://47.243.99.2:8094/threads-analysis?report=tar_mtwejs0k_bbc154"' in script
    assert 'reportApiUrls: ["/assets/opc/case-studies/tar_mtwejs0k_bbc154.json"]' in script
    assert script.index('id: "gy-zzzzz"') < script.index('id: "tjs0980"')
    assert 'id: "kameoka-yingying"' in script
    assert 'number: "04"' in script
    assert 'username: "kameoka_yingying"' in script
    assert 'reportUrl: "http://47.243.99.2:8094/threads-analysis?report=tar_mtwiw9jh_d4c2c7"' in script
    assert 'reportApiUrls: ["/assets/opc/case-studies/tar_mtwiw9jh_d4c2c7.json"]' in script
    assert script.index('id: "tjs0980"') < script.index('id: "kameoka-yingying"')


def test_third_hot_case_snapshot_has_complete_report_data() -> None:
    snapshot_path = ROOT / "static" / "assets" / "opc" / "case-studies" / "tar_mtwejs0k_bbc154.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    result = snapshot["report"]["result"]
    report = result["report"]

    assert result["username"] == "tjs0980"
    assert result["recentViewCount"] == 21936
    assert len(report["posts"]) == 15
    assert len(report["daily"]) == 15


def test_fourth_hot_case_snapshot_has_complete_report_data() -> None:
    snapshot_path = ROOT / "static" / "assets" / "opc" / "case-studies" / "tar_mtwiw9jh_d4c2c7.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    result = snapshot["report"]["result"]
    report = result["report"]

    assert result["username"] == "kameoka_yingying"
    assert result["recentViewCount"] == 36147
    assert len(report["posts"]) == 15
    assert len(report["daily"]) == 9
    assert sum(len(post.get("mediaItems", [])) for post in report["posts"]) == 21


def test_case_switching_keeps_the_current_scroll_position_and_hero_copy() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")

    switch_start = script.index('root.querySelectorAll("[data-case-id]")')
    switch_end = script.index('window.addEventListener("vecto:language-change", render);')
    switch_handler = script[switch_start:switch_end]
    assert "scrollIntoView" not in switch_handler
    assert 'class="case-studies-hero-copy"' in script
    assert "t.heroIntro" in script
