from webapp import social_automation_api


def test_live_browser_html_uses_vecto_branding():
    source = b"<html><head><title>KasmVNC</title></head><body></body></html>"

    branded = social_automation_api._brand_live_browser_html(source).decode("utf-8")

    assert "Vecto \u5b9e\u65f6\u6d4f\u89c8\u5668" in branded
    assert 'id="vecto-live-browser-brand"' in branded
    assert "/assets/opc/vecto-logo-ui-icon.png" in branded
    assert "vecto-browser-brand-reveal" in branded
    assert "vecto-browser-dot-hop" in branded
    assert "radial-gradient(circle at 4px 4px" in branded
    assert "prefers-reduced-motion: reduce" in branded
    assert "mask: url(\"/assets/opc/vecto-logo-ui-icon.png" in branded
    assert 'content: "VECTO OS"' in branded
    assert "background: #ffffff;" in branded
    assert "color: #ffffff !important;" in branded
    assert "--vecto-brand-logo-y:" in branded
    assert "top: var(--vecto-brand-status-y);" in branded
    assert "transform: translate(-50%, 0);" in branded
    assert "#noVNC_transition_text button," in branded
    assert "#noVNC_transition .noVNC_logo" in branded
    assert "display: none !important;" in branded
    assert "margin-top: 158px" not in branded
    assert "margin-top: 126px" not in branded


def test_live_browser_branding_is_idempotent():
    source = b"<html><head><title>KasmVNC</title></head><body></body></html>"

    once = social_automation_api._brand_live_browser_html(source)
    twice = social_automation_api._brand_live_browser_html(once)

    assert twice == once
