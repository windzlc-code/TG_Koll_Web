import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_third_hot_case_uses_the_persisted_report_endpoint() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")

    assert 'id: "tjs0980"' in script
    assert 'number: "03"' in script
    assert 'username: "tjs0980"' in script
    assert 'reportUrl: "http://47.243.99.2:8094/threads-analysis?report=tar_mtwejs0k_bbc154"' in script
    assert 'reportApiUrls: ["/assets/opc/case-studies/tar_mtwejs0k_bbc154.json"]' in script
    assert script.index('id: "gy-zzzzz"') < script.index('id: "tjs0980"')


def test_third_hot_case_snapshot_has_complete_report_data() -> None:
    snapshot_path = ROOT / "static" / "assets" / "opc" / "case-studies" / "tar_mtwejs0k_bbc154.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    result = snapshot["report"]["result"]
    report = result["report"]

    assert result["username"] == "tjs0980"
    assert result["recentViewCount"] == 21936
    assert len(report["posts"]) == 15
    assert len(report["daily"]) == 15
