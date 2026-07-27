from ckanext.relation import helpers


def _package(name, title=None, formats=None):
    return {
        "id": name + "-uuid",
        "name": name,
        "title": title or name.upper(),
        "type": "dataset",
        "state": "active",
        "organization": {"name": "geodatenpool", "title": "Geodatenpool"},
        "datenverantwortlicher": "KR-GSM-GEO-GDM-GIS",
        "groups": [
            {
                "name": "dataset",
                "title": "Datensatz und Dokumente",
                "image_display_url": "/base/images/group_icons/dataset.jpg",
            }
        ],
        "resources": [
            {"format": value}
            for value in (formats or ["WFS"])
        ],
    }


def _install_actions(monkeypatch, packages, relationships):
    def get_action(name):
        if name == "package_show":
            def package_show(context, data_dict):
                return packages[data_dict["id"]]

            return package_show

        if name == "package_relationships_list":
            def relationship_list(context, data_dict):
                return relationships.get(
                    (data_dict["id"], data_dict["rel"]),
                    [],
                )

            return relationship_list

        raise AssertionError("Unexpected action {}".format(name))

    monkeypatch.setattr(helpers.tk, "get_action", get_action)
    monkeypatch.setattr(
        helpers.tk,
        "url_for",
        lambda route, id: "/dataset/{}".format(id),
    )


def test_lhm_context_contains_only_direct_neighbours(monkeypatch):
    packages = {
        name: _package(name)
        for name in ("p", "b", "a", "e", "f")
    }
    relationships = {
        ("a", "depends_on"): [{"subject": "a", "object": "b"}],
        ("a", "dependency_of"): [{"subject": "a", "object": "e"}],
    }
    _install_actions(monkeypatch, packages, relationships)

    result = helpers.get_lhm_context("a", {"user": "tester"})

    assert [item["id"] for item in result["predecessors"]] == ["b"]
    assert [item["id"] for item in result["successors"]] == ["e"]
    assert result["preview_limit"] == 5


def test_graph_collects_all_transitive_predecessors_and_successors(monkeypatch):
    packages = {
        name: _package(name, formats=["WFS", "WFS", "GeoJSON"])
        for name in ("p", "b", "a", "e", "f")
    }
    relationships = {
        ("a", "depends_on"): [{"subject": "a", "object": "b"}],
        ("a", "dependency_of"): [{"subject": "a", "object": "e"}],
        ("b", "depends_on"): [{"subject": "b", "object": "p"}],
        ("b", "dependency_of"): [{"subject": "b", "object": "a"}],
        ("p", "dependency_of"): [{"subject": "p", "object": "b"}],
        ("e", "depends_on"): [{"subject": "e", "object": "a"}],
        ("e", "dependency_of"): [{"subject": "e", "object": "f"}],
        ("f", "depends_on"): [{"subject": "f", "object": "e"}],
    }
    _install_actions(monkeypatch, packages, relationships)

    graph = helpers.build_lhm_context_graph("a", {"user": "tester"})

    assert graph["root"] == "a"
    assert {node["id"] for node in graph["nodes"]} == {"p", "b", "a", "e", "f"}
    assert {tuple(edge) for edge in graph["edges"]} == {
        ("p", "b"),
        ("b", "a"),
        ("a", "e"),
        ("e", "f"),
    }
    assert all(node["formats"] == ["WFS", "GeoJSON"] for node in graph["nodes"])


def test_graph_stops_at_cycles(monkeypatch):
    packages = {name: _package(name) for name in ("a", "b")}
    relationships = {
        ("a", "depends_on"): [{"subject": "a", "object": "b"}],
        ("a", "dependency_of"): [{"subject": "a", "object": "b"}],
        ("b", "depends_on"): [{"subject": "b", "object": "a"}],
        ("b", "dependency_of"): [{"subject": "b", "object": "a"}],
    }
    _install_actions(monkeypatch, packages, relationships)

    graph = helpers.build_lhm_context_graph("a", {"user": "tester"})

    assert {node["id"] for node in graph["nodes"]} == {"a", "b"}
    assert {tuple(edge) for edge in graph["edges"]} == {
        ("a", "b"),
        ("b", "a"),
    }


def test_diagram_style_is_normalized_and_defaults_to_tum(monkeypatch):
    monkeypatch.setattr(
        helpers.tk,
        "config",
        {helpers.DIAGRAM_STYLE_CONFIG: " LHM "},
    )
    assert helpers.get_diagram_style() == "lhm"

    monkeypatch.setattr(
        helpers.tk,
        "config",
        {helpers.DIAGRAM_STYLE_CONFIG: "unknown"},
    )
    assert helpers.get_diagram_style() == "tum"
