from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
NAVIGATION = (ROOT / "static" / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
STYLES = (ROOT / "static" / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")


def test_home_header_exposes_product_menu_with_real_workspace_targets():
    assert 'data-site-product-menu' in INDEX
    assert 'data-site-product-trigger' in INDEX
    assert 'data-site-copy="productWorkspaces"' in INDEX
    assert any(label in INDEX for label in ("相关产品", "相關產品"))
    assert 'class="site-nav-link-icon"' in INDEX
    assert 'data-video-entry href="/video.html"' in INDEX
    assert 'data-crm-entry href="/crm.html"' in INDEX
    assert 'role="menuitem"' in INDEX


def test_shared_navigation_generates_and_binds_home_product_menu():
    assert "function productMenuMarkup" in NAVIGATION
    assert "function pageKeepsProductMenu" in NAVIGATION
    assert 'return !["admin", "adminProfile"].includes(String(page || ""));' in NAVIGATION
    assert "function ensureDesktopNavigation" in NAVIGATION
    assert "function setProductMenuOpen" in NAVIGATION
    assert "function bindProductMenus" in NAVIGATION
    assert "function navigationIconPaths" in NAVIGATION
    assert "navigationIcon(key)" in NAVIGATION
    assert "bindProductMenus(header);" in NAVIGATION
    assert "syncVideoEntryTargets();" in NAVIGATION
    assert "syncCrmEntryTargets();" in NAVIGATION


def test_product_menu_has_keyboard_and_mobile_styles():
    for selector in (
        ".site-product-trigger",
        ".site-product-popover",
        ".site-product-option",
        ".site-product-menu-mobile",
        ".site-mobile-menu-links .site-product-menu-mobile .site-product-popover",
        ".site-nav-link-icon",
    ):
        assert selector in STYLES
    assert ".site-product-option {" in STYLES
    assert ".site-nav .site-product-option" in STYLES
    assert "justify-content: start;" in STYLES
    assert "aria-expanded" in NAVIGATION
    assert 'event.key === "ArrowDown"' in NAVIGATION
    assert 'event.key === "Escape"' in NAVIGATION


def test_product_navigation_is_shared_by_public_pages_and_workbenches():
    for name in ("index.html", "about-vecto.html", "case-studies.html", "console.html", "video.html", "crm.html", "product-login.html"):
        markup = (ROOT / "static" / name).read_text(encoding="utf-8")
        assert 'site-navigation.js?v=__SITE_NAVIGATION_JS_VERSION__' in markup
        assert 'site-navigation.css?v=__SITE_NAVIGATION_CSS_VERSION__' in markup
    assert 'navLink({ key: "console", href: "/console.html", current })' in NAVIGATION
    assert 'return !["admin", "adminProfile"].includes(String(page || ""));' in NAVIGATION
    assert 'items = isolatedWorkspacePage(page)' in NAVIGATION
