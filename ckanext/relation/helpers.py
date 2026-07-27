from collections import deque
import logging

import ckan.plugins.toolkit as tk
from werkzeug.routing import BuildError


log = logging.getLogger(__name__)

DIAGRAM_STYLE_CONFIG = "ckanext.relation_sddi_diagram_style"
DEFAULT_DIAGRAM_STYLE = "tum"
DIAGRAM_STYLES = {"tum", "lhm"}
LHM_PREVIEW_LIMIT = 5

MAIN_CATEGORIES = {
    "dataset": ("Datensatz und Dokumente", "/base/images/group_icons/dataset.jpg"),
    "online-service": ("Online-Dienst", "/base/images/group_icons/online_service.jpg"),
    "software": ("Software", "/base/images/group_icons/software.jpg"),
    "online-application": ("Online-Anwendung", "/base/images/group_icons/method.jpg"),
    "portal": ("Portal", "/base/images/group_icons/online_application.jpg"),
    "device": ("Gerät / Ding", "/base/images/group_icons/device.jpg"),
}


def get_diagram_style():
    """Return the configured presentation style with a safe fallback."""
    value = tk.config.get(DIAGRAM_STYLE_CONFIG, DEFAULT_DIAGRAM_STYLE)
    style = str(value or DEFAULT_DIAGRAM_STYLE).strip().lower()
    if style not in DIAGRAM_STYLES:
        log.warning(
            "Unsupported value %r for %s; falling back to %r",
            value,
            DIAGRAM_STYLE_CONFIG,
            DEFAULT_DIAGRAM_STYLE,
        )
        return DEFAULT_DIAGRAM_STYLE
    return style


def _action_context(context):
    action_context = dict(context or {})
    if "user" not in action_context:
        try:
            action_context["user"] = getattr(tk.g, "user", None)
        except RuntimeError:
            action_context["user"] = None
    action_context["use_cache"] = False
    return action_context


def _package_show(package_id, context):
    return tk.get_action("package_show")(
        _action_context(context),
        {"id": package_id},
    )


def _safe_package_show(package_id, context):
    try:
        return _package_show(package_id, context)
    except (tk.ObjectNotFound, tk.NotAuthorized):
        return None


def _relationships(package_id, relation_type, context):
    try:
        return tk.get_action("package_relationships_list")(
            _action_context(context),
            {"id": package_id, "rel": relation_type},
        )
    except (tk.ObjectNotFound, tk.NotAuthorized):
        return []


def _relationship_target(relationship, current_package):
    """Return the other package reference from a relationship response."""
    current_refs = {
        str(current_package.get("id") or ""),
        str(current_package.get("name") or ""),
    }
    for key in ("object", "subject"):
        value = relationship.get(key)
        if value is not None and str(value) not in current_refs:
            return value
    return relationship.get("object") or relationship.get("subject")


def _extra_value(package, key):
    if package.get(key) not in (None, ""):
        return package[key]
    for extra in package.get("extras") or []:
        if extra.get("key") == key:
            return extra.get("value") or ""
    return ""


def _resource_formats(package):
    formats = []
    seen = set()
    for resource in package.get("resources") or []:
        value = (
            resource.get("format")
            or resource.get("resource_type")
            or resource.get("mimetype")
            or ""
        )
        value = str(value).strip()
        normalized = value.casefold()
        if value and normalized not in seen:
            seen.add(normalized)
            formats.append(value)
    return formats


def _main_category(package):
    groups = package.get("groups") or []

    for group in groups:
        name = group.get("name")
        if name in MAIN_CATEGORIES:
            fallback_label, fallback_icon = MAIN_CATEGORIES[name]
            return {
                "name": name,
                "label": group.get("title") or fallback_label,
                "icon": (
                    group.get("image_display_url")
                    or group.get("image_url")
                    or fallback_icon
                ),
            }

    for group in groups:
        image = group.get("image_display_url") or group.get("image_url") or ""
        if "group_icons" in image:
            return {
                "name": group.get("name") or "dataset",
                "label": group.get("title") or "Datensatz und Dokumente",
                "icon": image,
            }

    label, icon = MAIN_CATEGORIES["dataset"]
    return {"name": "dataset", "label": label, "icon": icon}


def _dataset_url(package):
    package_name = package.get("name") or package.get("id")
    package_type = package.get("type") or "dataset"
    routes = ["{}.read".format(package_type)]
    if package_type != "dataset":
        routes.append("dataset.read")

    for route in routes:
        try:
            return tk.url_for(route, id=package_name)
        except (BuildError, RuntimeError):
            continue
    return "/dataset/{}".format(package_name)


def package_context_data(package):
    """Return the metadata needed by the LHM lists and graph."""
    organization = package.get("organization") or {}
    name = package.get("name") or package.get("id")
    return {
        "id": name,
        "title": package.get("title") or name,
        "source": organization.get("title") or organization.get("name") or "",
        "owner": _extra_value(package, "datenverantwortlicher"),
        "formats": _resource_formats(package),
        "category": _main_category(package),
        "url": _dataset_url(package),
    }


def _related_packages(package, relation_type, context):
    related = {}
    for relationship in _relationships(package["name"], relation_type, context):
        package_ref = _relationship_target(relationship, package)
        if not package_ref:
            continue
        related_package = _safe_package_show(package_ref, context)
        if not related_package or related_package.get("state") == "deleted":
            continue
        related[related_package["name"]] = related_package
    return sorted(
        related.values(),
        key=lambda item: (item.get("title") or item.get("name") or "").casefold(),
    )


def get_lhm_context(package_id, context=None):
    """Return the current dataset and its direct depends_on neighbours."""
    package = _package_show(package_id, context)
    predecessors = _related_packages(package, "depends_on", context)
    successors = _related_packages(package, "dependency_of", context)
    return {
        "package": package,
        "predecessors": [package_context_data(item) for item in predecessors],
        "successors": [package_context_data(item) for item in successors],
        "preview_limit": LHM_PREVIEW_LIMIT,
    }


def build_lhm_context_graph(package_id, context=None):
    """Build the complete accessible depends_on component around a dataset.

    CKAN stores ``A depends_on B`` as A being the relationship subject and B
    the object.  For lineage rendering the edge direction is inverted, from
    the dependency B to the derived dataset A.
    """
    root_package = _package_show(package_id, context)
    root_name = root_package["name"]
    packages = {root_name: root_package}
    edges = set()
    processed = set()
    queued = {root_name}
    queue = deque([root_name])

    while queue:
        current_name = queue.popleft()
        current_package = packages[current_name]
        processed.add(current_name)

        directions = (
            ("depends_on", "predecessor"),
            ("dependency_of", "successor"),
        )
        for relation_type, direction in directions:
            relationships = _relationships(current_name, relation_type, context)
            for relationship in relationships:
                package_ref = _relationship_target(relationship, current_package)
                if not package_ref:
                    continue
                related_package = _safe_package_show(package_ref, context)
                if not related_package or related_package.get("state") == "deleted":
                    continue

                related_name = related_package["name"]
                packages[related_name] = related_package
                if direction == "predecessor":
                    edges.add((related_name, current_name))
                else:
                    edges.add((current_name, related_name))

                if related_name not in processed and related_name not in queued:
                    queue.append(related_name)
                    queued.add(related_name)

    nodes = [
        package_context_data(package)
        for package in sorted(
            packages.values(),
            key=lambda item: (item.get("title") or item.get("name") or "").casefold(),
        )
    ]
    return {
        "root": root_name,
        "nodes": nodes,
        "edges": [list(edge) for edge in sorted(edges)],
    }


def outgoing_relationship(id):
    """Return true if the dataset has any relationship, false otherwise."""
    type = ["depends_on", "child_of" ,"links_to"]
    for i in type:
        try:
            relationship = tk.get_action("package_relationships_list")(data_dict={"id": id, "rel": i})                
            rel = bool(relationship)
            break
        except:
            rel = 0
    return rel


def has_relationship(id):
    """Return true if the dataset has any relationship, false otherwise."""
    relationship = tk.get_action("package_relationships_list")(
        data_dict={"id": id}
    )
    if relationship:
        rel = bool(relationship)
    else:
        rel = 0
    return rel


def rel_id_list(rel_list):
    """Return a list of already added datasets with relationships"""

    rel_ids = []
    for i in range(0, len(rel_list)):
        rel_id = rel_list[i]["id"]
        rel_ids.append(rel_id)
    return rel_ids


def package_all(q):
    """Return a list of all datasets searched for with value 'q'."""

    query = q.get('q')
    datasets = tk.get_action("package_search")(
        {}, data_dict={"q": query, "include_private": True}
    )

    result = datasets["results"]
    results = []
    for res in result:
        results.append(res)
    return results


def get_child_package(id):
    """ Returns a list of packages that are the subjects of child_of relationships."""

    relationships = []
    try:
        relationships = tk.get_action("package_relationships_list")(
            data_dict={"id": id, "rel": "parent_of"}
        )
    except Exception as e:
        return {}

    children = []
    if relationships:
        for rel in relationships:
            try:
                access = tk.check_access(
                    "package_show",
                    context={"user": tk.c.user},
                    data_dict={"id": rel["object"]},
                )
                child = tk.get_action("package_show")(
                    data_dict={"id": rel["object"]}
                )
                children.append(child)
            except:
                pass
    return children


def get_parent_package(id):
    """ Returns a list of packages that are the subjects of parent_of relationships."""

    relationships = []
    try:
        relationships = tk.get_action("package_relationships_list")(
            data_dict={"id": id, "rel": "child_of"}
        )
    except Exception as e:
        return {}

    parents = []
    if relationships:
        for rel in relationships:
            parent = tk.get_action("package_show")(data_dict={"id": rel["object"]})
            parents.append(parent)
    return parents


def get_dependency_package(id):
    """ Returns a list of packages that are the subjects of dependency_of relationships."""

    relationships = []
    try:
        relationships = tk.get_action("package_relationships_list")(
            data_dict={"id": id, "rel": "depends_on"}
        )
    except Exception as e:
        return {}

    dependencies = []
    if relationships:
        for rel in relationships:
            dependency = tk.get_action("package_show")(
                data_dict={"id": rel["object"]}
            )
            dependencies.append(dependency)
    return dependencies


def get_depend_package(id):
    """ Returns a list of packages that are the subjects of depends_on relationships."""

    relationships = []
    try:
        relationships = tk.get_action("package_relationships_list")(
            data_dict={"id": id, "rel": "dependency_of"}
        )
    except Exception as e:
        return {}

    depend = []
    if relationships:
        for rel in relationships:
            try:
                access = tk.check_access(
                    "package_show",
                    context={"user": tk.c.user},
                    data_dict={"id": rel["object"]},
                )
                dep = tk.get_action("package_show")(
                    data_dict={"id": rel["object"]}
                )
                depend.append(dep)
            except:
                pass
    return depend


def get_linked_package(id):
    """ Returns a list of packages that are the subjects of linked_from relationships."""

    relationships = []
    try:
        relationships = tk.get_action("package_relationships_list")(
            data_dict={"id": id, "rel": "links_to"}
        )
    except Exception as e:
        return {}

    linked = []
    if relationships:
        for rel in relationships:
            lnk = tk.get_action("package_show")(
                data_dict={"id": rel["object"]}
            )
            linked.append(lnk)

    return linked


def get_links_package(id):
    """ Returns a list of packages that are the subjects of links_to relationships."""

    relationships = []
    try:
        relationships = tk.get_action("package_relationships_list")(
            data_dict={"id": id, "rel": "linked_from"}
        )
    except Exception as e:
        return {}

    links = []
    if relationships:
        for rel in relationships:
            try:
                tk.check_access(
                    "package_show",
                    context={"user": tk.c.user},
                    data_dict={"id": rel["object"]},
                )
                link = tk.get_action("package_show")(
                    data_dict={"id": rel["object"]}
                )
                links.append(link)
            except:
                pass
    return links
