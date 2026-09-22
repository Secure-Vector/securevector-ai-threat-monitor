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


def _banner_ids() -> list[str]:
    """Every sidebar banner element, read from the code that creates them."""
    sidebar = _read("js/components/sidebar.js")
    ids = set(re.findall(r"id\s*=\s*'([a-z-]+-plugin-active-banner)'", sidebar))
    texts = set(re.findall(r"id\s*=\s*'([a-z-]+-plugin-banner-text)'", sidebar))
    found = sorted(ids | texts)
    assert found, "no sidebar plugin banners found; sidebar.js changed shape"
    return found


@pytest.mark.parametrize("element_id", _banner_ids())
def test_sidebar_banner_collapses_with_the_rail(element_id):
    """A banner the collapsed rail does not shrink spills past the 36px rail.

    Parametrized over the banner elements rather than over harnesses, because
    not every harness declares one and a harness is not the thing that can be
    wrong here: a specific element id is. Asserting per element is also what
    makes a failure name the element that spills, instead of failing once per
    harness with the same global message.
    """
    assert f"#{element_id}" in _read("css/styles.css"), (
        f"sidebar.js creates #{element_id} but styles.css never collapses it, "
        "so it spills out of the collapsed rail"
    )


# Every map that turns a runtime_kind into something a person reads. All of
# them fall back to the raw slug, so a missing entry never throws: the UI just
# says "opencode" where it should say "OpenCode". They are listed here as
# (file, regex naming the map body) because they live in three languages and
# two repositories' worth of conventions, and there is no honest way to find
# them by shape. Adding a harness means adding it to all of them, which is
# exactly the thing nobody remembers, so the list is the memory.
LABEL_REGISTRIES = [
    ("js/pages/tool-permissions.js", r"_JIT_RUNTIME_LABEL:\s*\{(.*?)\},\n",
     "the just-in-time permission prompt"),
    ("js/pages/storylines.js", r"STORY_RUNTIME_LABEL\s*=\s*\{(.*?)\};", "Storylines"),
    ("js/pages/redactions.js", r"_runtimeLabel\(slug\)\s*\{.*?const map = \{(.*?)\};", re.S and "the Redactions table"),
]

# Not under WEB: the backend's own copy, rendered into Tool Inventory.
BACKEND_LABELS = (
    Path(__file__).resolve().parents[3]
    / "src" / "securevector" / "app" / "server" / "routes" / "tool_permissions.py"
)


def _map_keys(body: str) -> set[str]:
    """The keys of an object literal, ignoring anything in a comment.

    Parsed rather than substring-matched: a slug mentioned in a comment inside
    the map, or appearing as a fragment of another key, would satisfy `in` and
    the prompt would still render a raw id.
    """
    without_comments = re.sub(r"//[^\n]*", "", body)
    return set(re.findall(r"""['"]?([A-Za-z][A-Za-z0-9_-]*)['"]?\s*:""", without_comments))


@pytest.mark.parametrize("slug", HARNESSES)
@pytest.mark.parametrize("rel,pattern,what", LABEL_REGISTRIES, ids=lambda v: v if isinstance(v, str) and "/" not in v else "")
def test_every_label_registry_names_the_runtime(slug, rel, pattern, what):
    """A harness absent from one of these renders as a raw slug.

    The permission prompt is the one that matters most, because it is the
    dialog where a person is asked to grant access and the subject of the
    sentence is the harness. OpenCode and Antigravity were missing from it,
    and from two others, while every test passed.
    """
    found = re.search(pattern, _read(rel), re.S)
    assert found, f"{rel}: the label map matching {pattern!r} moved or was renamed"
    keys = _map_keys(found.group(1))
    assert slug in keys, (
        f"{what} has no display name for {slug}, so it shows a raw runtime id. "
        f"Known: {sorted(keys)}"
    )


@pytest.mark.parametrize("slug", HARNESSES)
def test_the_backend_label_map_names_the_runtime(slug):
    """Tool Inventory renders its rows from the server's own copy."""
    src = BACKEND_LABELS.read_text(encoding="utf-8")
    found = re.search(r"_RUNTIME_LABELS = \{(.*?)\n\}", src, re.S)
    assert found, "tool_permissions.py _RUNTIME_LABELS moved or was renamed"
    keys = set(re.findall(r'"([^"]+)":', re.sub(r"#[^\n]*", "", found.group(1))))
    assert slug in keys, (
        f"the backend label map has no display name for {slug}, so Tool "
        f"Inventory shows a raw runtime id. Known: {sorted(keys)}"
    )


def test_setup_prose_names_the_same_harnesses_as_the_chip_row():
    """The one-line Setup guides blurb and the chip row below it must agree.

    Two lists of the same thing, forty lines apart, one prose and one data.
    The chip row is inside a card that is collapsed by default, so an omission
    in the prose is what a reader actually sees and the chip row is what looks
    correct when someone greps. Antigravity landed in the chips and not in the
    prose, and nothing noticed.

    The expected names are read out of the chip row rather than listed here,
    so this cannot drift into a second hand-maintained copy of the same list.
    """
    src = _read("js/pages/getting-started.js")

    row = re.search(r"group\('Coding agents',\s*\[(.*?)\]\);", src, re.S)
    assert row, "the Coding agents chip row moved or was renamed"
    chips = re.findall(r"\['([^']+)',\s*'guide-[a-z-]+'\]", row.group(1))
    assert len(chips) >= 5, f"only parsed {chips} out of the chip row"

    blurb = re.search(r"coding-agent plugins \(([^)]*)\)", src)
    assert blurb, "the Setup guides blurb no longer lists the coding agents"
    named = blurb.group(1)

    # "GitHub Copilot CLI" in the chip is "Copilot CLI" in the blurb, and
    # "OpenClaw / ClawdBot" is "OpenClaw": compare on the distinctive word.
    missing = [c for c in chips if c.split(" / ")[0].split()[-1] not in named]
    assert not missing, (
        f"the Setup guides blurb omits {missing}, so the collapsed card is the "
        "only place a reader would learn those harnesses are supported"
    )
