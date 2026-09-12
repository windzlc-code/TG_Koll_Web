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
    assert 'id: "mirahuang-12"' in script
    assert 'number: "05"' in script
    assert 'username: "mirahuang.12"' in script
    assert 'reportUrl: "http://47.243.99.2:8094/threads-analysis?report=tar_mtwloux8_ae32f0"' in script
    assert 'reportApiUrls: ["/assets/opc/case-studies/tar_mtwloux8_ae32f0.json"]' in script
    assert script.index('id: "kameoka-yingying"') < script.index('id: "mirahuang-12"')
    assert 'id: "saasaimomo"' in script
    assert 'number: "06"' in script
    assert 'username: "saasaimomo"' in script
    assert 'reportUrl: "http://47.243.99.2:8094/threads-analysis?report=tar_mtwtcgfx_7a15a3"' in script
    assert 'reportApiUrls: ["/assets/opc/case-studies/tar_mtwtcgfx_7a15a3.json"]' in script
    assert script.index('id: "mirahuang-12"') < script.index('id: "saasaimomo"')


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


def test_fifth_hot_case_snapshot_has_complete_report_data() -> None:
    snapshot_path = ROOT / "static" / "assets" / "opc" / "case-studies" / "tar_mtwloux8_ae32f0.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    result = snapshot["report"]["result"]
    report = result["report"]

    assert result["username"] == "mirahuang.12"
    assert result["recentViewCount"] == 1473
    assert len(report["posts"]) == 15
    assert len(report["daily"]) == 10
    assert sum(len(post.get("mediaItems", [])) for post in report["posts"]) == 15


def test_sixth_hot_case_snapshot_has_complete_report_data() -> None:
    snapshot_path = ROOT / "static" / "assets" / "opc" / "case-studies" / "tar_mtwtcgfx_7a15a3.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    result = snapshot["report"]["result"]
    report = result["report"]

    assert result["username"] == "saasaimomo"
    assert result["recentViewCount"] == 7889
    assert len(report["posts"]) == 15
    assert len(report["daily"]) == 5
    assert sum(len(post.get("mediaItems", [])) for post in report["posts"]) == 4


def test_case_catalog_keeps_hero_copy_without_the_legacy_switcher() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "static" / "assets" / "opc" / "case-studies.css").read_text(encoding="utf-8")

    assert 'class="case-study-switcher-band"' not in script
    assert 'class="case-profile-field"' in script
    assert 'data-case-layout="${index + 1}" data-case-open data-case-id=' in script
    assert 'class="case-profile-open"' not in script
    assert 'class="case-studies-hero-copy"' in script
    assert "t.heroIntro" in script
    assert "padding: calc(var(--site-header-height" in stylesheet


def test_case_catalog_uses_desktop_orbit_motion_without_breaking_mobile_layout() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "static" / "assets" / "opc" / "case-studies.css").read_text(encoding="utf-8")

    assert 'class="case-profile-orbit-center"' in script
    assert 'class="case-profile-surface"' in script
    assert "caseLibraryIcon" in script
    assert "@media (min-width: 1240px)" in stylesheet
    assert "case-profile-orbit-float" in stylesheet
    assert ".case-profile-card:hover .case-profile-surface" in stylesheet
    assert "@media (max-width: 720px)" in stylesheet
    assert 'data-case-layout="6"' in stylesheet
    assert "@media (prefers-reduced-motion: reduce)" in stylesheet
    assert ".case-studies-canvas { background-attachment: fixed; }" in stylesheet


def test_case_account_card_uses_persisted_avatars_and_opens_the_common_report_modal() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "static" / "assets" / "opc" / "case-studies.css").read_text(encoding="utf-8")

    assert 'avatarUrl: "/assets/opc/case-studies/avatars/mina_ya2002.jpg"' in script
    assert 'avatarUrl: "/assets/opc/case-studies/avatars/saasaimomo.jpg"' in script
    assert "profileAvatarUrlFrom" in script
    assert 'class="case-profile-card case-profile-card--catalog"' in script
    assert "data-case-open" in script
    assert 'class="case-report-modal"' in script
    assert "data-case-modal-close" in script
    assert "setCaseDetailOpen" in script
    assert "case-profile-field" in stylesheet
    assert 'data-case-layout="1"' in stylesheet
    assert "case-profile-avatar img { position: absolute" in stylesheet
    assert ".case-profile-card::before { content: none; }" in stylesheet
    assert ".case-profile-copy > strong { overflow-wrap: anywhere;" in stylesheet
    assert ".case-profile-card" in stylesheet
    assert ".case-report-dialog" in stylesheet
    assert 'class="platform-brand-icon"' in script
    assert ".case-profile-platform .platform-brand-icon" in stylesheet
    assert 'class="case-profile-source"' in script
    assert 'class="case-action-icon"' in script
    assert 'data-case-modal-close' in script
    assert 'root.addEventListener("keydown"' in script


def test_case_avatar_assets_are_persisted_locally() -> None:
    avatar_directory = ROOT / "static" / "assets" / "opc" / "case-studies" / "avatars"
    expected = ["mina_ya2002.jpg", "gy.zzzzz.jpg", "tjs0980.jpg", "kameoka_yingying.jpg", "mirahuang.12.jpg", "saasaimomo.jpg"]

    for avatar in expected:
        asset = avatar_directory / avatar
        assert asset.is_file()
        assert asset.stat().st_size > 5_000


def test_case_context_hides_internal_metric_scope_from_public_layout() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "static" / "assets" / "opc" / "case-studies.css").read_text(encoding="utf-8")

    context_start = script.index('<section class="case-panel case-report-context"')
    context_end = script.index('<section class="case-panel case-style-panel case-engagement-panel"')
    context_markup = script[context_start:context_end]
    assert "t.metricScope" not in context_markup
    assert "repeat(3, minmax(0, 1fr))" in stylesheet


def test_case_modal_ends_after_report_data_without_legacy_signal_cards() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "static" / "assets" / "opc" / "case-studies.css").read_text(encoding="utf-8")

    assert 'class="case-top-post"' not in script
    assert 'class="case-guidance"' not in script
    assert 'class="case-source-note"' not in script
    assert ".case-top-post" not in stylesheet
    assert ".case-guidance" not in stylesheet


def test_case_catalog_uses_smooth_actions_and_grid_backdrop() -> None:
    stylesheet = (ROOT / "static" / "assets" / "opc" / "case-studies.css").read_text(encoding="utf-8")

    assert "case-profile-actions" in stylesheet
    assert "transition: border-color 520ms ease" in stylesheet
    assert "scale: 1.025" in stylesheet
    assert ".case-profile-open" not in stylesheet
    assert "border-radius: 0;" in stylesheet
    assert "repeating-linear-gradient(90deg, rgba(44, 112, 136, .07)" in stylesheet


def test_case_detail_keeps_identity_horizontal_and_fills_daily_traffic_calendar() -> None:
    script = (ROOT / "static" / "assets" / "opc" / "case-studies.js").read_text(encoding="utf-8")
    stylesheet = (ROOT / "static" / "assets" / "opc" / "case-studies.css").read_text(encoding="utf-8")

    assert "trafficDaysForMonth" in script
    assert "length: totalDays" in script
    assert 'class="case-traffic-day-list"' in script
    assert 'class="case-report-identity-row"' in script
    assert ".case-report-identity-row" in stylesheet
    assert ".case-traffic-day-list" in stylesheet
