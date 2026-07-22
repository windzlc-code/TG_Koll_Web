from webapp import social_automation_api


def test_live_browser_html_uses_vecto_branding():
    source = b"<html><head><title>KasmVNC</title></head><body></body></html>"

    branded = social_automation_api._brand_live_browser_html(source).decode("utf-8")

    assert "Vecto \u5b9e\u65f6\u6d4f\u89c8\u5668" in branded
    assert 'id="vecto-live-browser-brand"' in branded
    assert "/assets/opc/vecto-logo-ui-icon.png" in branded
    assert "vecto-browser-brand-reveal" in branded
    assert "vecto-browser-signal" in branded
    assert "prefers-reduced-motion: reduce" in branded
    assert "mask: url(\"/assets/opc/vecto-logo-ui-icon.png" in branded


def test_live_browser_branding_is_idempotent():
    source = b"<html><head><title>KasmVNC</title></head><body></body></html>"

    once = social_automation_api._brand_live_browser_html(source)
    twice = social_automation_api._brand_live_browser_html(once)

    assert twice == once
