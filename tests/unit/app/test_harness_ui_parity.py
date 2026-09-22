"""Every harness guide page must be wired into every surface its siblings are.

Adding a harness means touching a dozen small maps scattered across the web
assets: the route table, the two sidebar alias lists, the header's page titles,
the wizard's install URL and guide slug, the Getting Started chip row, the
integrations page, and the observability colour and label maps. Miss one and
nothing crashes: the page simply renders with a blank title, or the harness
falls out of a filter, or the sidebar banner spills when collapsed. Antigravity
shipped missing eight of them and every existing test stayed green.

So this test does not carry a list of harnesses. It DERIVES the list from the
guide pages actually on disk, then asserts each one appears in each surface.
A new `guide-<slug>.js` file therefore fails this test until it is wired up,
which is the only version of this check that keeps working after the person who
wrote it has moved on.

Surfaces that legitimately differ per harness are not asserted here: the costs
page reads each harness's own session database and only lists the ones whose
format is known, and the task avatar atlas is keyed on Terminals executor ids,
not on every harness with a plugin.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[3] / "src" / "securevector" / "app" / "assets" / "web"

# Guides that are not a single harness: the hub page and the SDK frameworks
# page, which covers four runtimes at once and so has no `proxy-<slug>` twin.
NOT_A_HARNESS = {"connect-agents", "frameworks"}


def _harness_slugs() -> list[str]:
    slugs = sorted(
        p.name[len("guide-"): -len(".js")]
        for p in (WEB / "js" / "pages").glob("guide-*.js")
    )
    found = [s for s in slugs if s not in NOT_A_HARNESS]
    assert found, "no harness guide pages found; the glob or the layout moved"
    return found


def _read(rel: str) -> str:
    return (WEB / rel).read_text(encoding="utf-8")


HARNESSES = _harness_slugs()


@pytest.mark.parametrize("slug", HARNESSES)
def test_guide_page_is_loaded_by_index_html(slug):
    assert f"/js/pages/guide-{slug}.js" in _read("index.html"), (
        f"index.html does not load guide-{slug}.js, so the page object never exists"
    )


@pytest.mark.parametrize("slug", HARNESSES)
def test_guide_and_proxy_routes_exist(slug):
    app_js = _read("js/app.js")
    assert f"'guide-{slug}'" in app_js, f"app.js has no route for guide-{slug}"
    assert f"'proxy-{slug}'" in app_js, f"app.js has no route for proxy-{slug}"


@pytest.mark.parametrize("slug", HARNESSES)
def test_sidebar_claims_both_destinations(slug):
    """Without the alias the rail highlights nothing while the page is open."""
    sidebar = _read("js/components/sidebar.js")
    assert f"'guide-{slug}'" in sidebar, f"sidebar Guide group does not alias guide-{slug}"
    assert f"'proxy-{slug}'" in sidebar, (
        f"sidebar Connect Agents group does not alias proxy-{slug}"
    )


@pytest.mark.parametrize("slug", HARNESSES)
def test_header_titles_both_pages(slug):
    """A missing entry renders the page with an empty title bar, silently."""
    header = _read("js/components/header.js")
    for page in (f"guide-{slug}", f"proxy-{slug}"):
        assert f"'{page}'" in header, f"header.js has no title for {page}"


@pytest.mark.parametrize("slug", HARNESSES)
def test_wizard_can_install_and_link_to_the_guide(slug):
    wizard = _read("js/pages/wizard.js")
    install = re.search(r"INSTALL_URLS:\s*\{(.*?)\}", wizard, re.S)
    guides = re.search(r"GUIDES:\s*\{(.*?)\}", wizard, re.S)
    assert install and guides, "wizard.js INSTALL_URLS / GUIDES moved or were renamed"
    assert f"'{slug}'" in install.group(1), f"wizard has no install URL for {slug}"
    assert f"'{slug}'" in guides.group(1), f"wizard cannot link {slug} to its guide"


@pytest.mark.parametrize("slug", HARNESSES)
def test_getting_started_lists_the_guide(slug):
    assert f"'guide-{slug}'" in _read("js/pages/getting-started.js"), (
        f"the Getting Started coding-agents row omits guide-{slug}"
    )


@pytest.mark.parametrize("slug", HARNESSES)
def test_integrations_page_has_the_panel(slug):
    assert f"'proxy-{slug}'" in _read("js/pages/integrations.js"), (
        f"integrations.js has no proxy-{slug} panel, so Connect Agents dead-ends"
    )


@pytest.mark.parametrize("slug", HARNESSES)
def test_observability_lenses_label_the_runtime(slug):
    """A harness absent from these maps drops to an unnamed grey dot."""
    storylines = _read("js/pages/storylines.js")
    label = re.search(r"STORY_RUNTIME_LABEL\s*=\s*\{(.*?)\};", storylines, re.S)
    assert label, "storylines.js STORY_RUNTIME_LABEL moved or was renamed"
    assert slug in label.group(1), f"storylines has no label for {slug}"
    assert slug in _read("js/pages/agent-map.js"), f"agent-map HARNESS_FIXED omits {slug}"
    assert slug in _read("js/pages/agent-timeline.js"), f"agent-timeline omits {slug}"
    assert slug in _read("js/pages/agent-runs.js"), f"agent-runs omits {slug}"


@pytest.mark.parametrize("slug", HARNESSES)
def test_sidebar_banner_collapses_with_the_rail(slug):
    """A banner the collapsed rail does not shrink spills past the 36px rail.

    Only asserted for harnesses that actually declare a banner: not every
    harness has one, and inventing a CSS rule for an element that does not
    exist would be worse than the gap it guards.
    """
    sidebar = _read("js/components/sidebar.js")
    banner = re.search(rf"id\s*=\s*'([a-z-]+)-plugin-active-banner'", sidebar)
    ids = set(re.findall(r"id\s*=\s*'([a-z-]+-plugin-active-banner)'", sidebar))
    texts = set(re.findall(r"id\s*=\s*'([a-z-]+-plugin-banner-text)'", sidebar))
    del banner
    css = _read("css/styles.css")
    for element_id in sorted(ids | texts):
        assert f"#{element_id}" in css, (
            f"sidebar.js creates #{element_id} but styles.css never collapses it, "
            "so it spills out of the collapsed rail"
        )
