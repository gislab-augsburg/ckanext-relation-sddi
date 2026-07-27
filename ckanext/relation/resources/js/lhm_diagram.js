(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var NODE_WIDTH = 162;
  var NODE_HEIGHT = 56;
  var NODE_HALF_WIDTH = NODE_WIDTH / 2;
  var NODE_HALF_HEIGHT = NODE_HEIGHT / 2;
  var instanceCounter = 0;

  function svgElement(name, attributes, text) {
    var element = document.createElementNS(SVG_NS, name);
    Object.keys(attributes || {}).forEach(function (key) {
      element.setAttribute(key, attributes[key]);
    });
    if (text) {
      element.textContent = text;
    }
    return element;
  }

  function clipped(value, limit) {
    value = String(value || "");
    return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
  }

  function initializeDiagram(root) {
    if (root.dataset.relationLhmInitialized === "true") {
      return;
    }
    root.dataset.relationLhmInitialized = "true";
    instanceCounter += 1;

    var graphNode = root.querySelector("[data-relation-graph]");
    var graph;
    try {
      graph = JSON.parse(graphNode.textContent);
    } catch (error) {
      root.innerHTML =
        '<div class="alert alert-danger">Das Kontextdiagramm konnte nicht geladen werden.</div>';
      return;
    }

    var nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    var edges = Array.isArray(graph.edges) ? graph.edges : [];
    var byId = {};
    nodes.forEach(function (node) {
      byId[node.id] = node;
    });

    if (!nodes.length || !byId[graph.root]) {
      root.innerHTML =
        '<div class="alert alert-info">Für diesen Datensatz ist kein Kontext vorhanden.</div>';
      return;
    }

    var svg = root.querySelector(".relation-lhm-svg");
    var stage = root.querySelector(".relation-lhm-graph-stage");
    var viewport = root.querySelector("[data-viewport]");
    var guideLayer = root.querySelector("[data-guides]");
    var edgeLayer = root.querySelector("[data-edges]");
    var nodeLayer = root.querySelector("[data-nodes]");
    var focusId = graph.root;
    var scale = 1;
    var panX = 0;
    var panY = 0;
    var graphWidth = 1080;
    var graphHeight = 530;
    var dragging = false;
    var dragStart = null;

    function distances(start, reverse) {
      var result = {};
      var queue = [{ id: start, distance: 0 }];
      result[start] = 0;

      while (queue.length) {
        var current = queue.shift();
        edges.forEach(function (edge) {
          var source = edge[0];
          var target = edge[1];
          var next = reverse
            ? target === current.id
              ? source
              : null
            : source === current.id
              ? target
              : null;
          if (next && typeof result[next] === "undefined") {
            result[next] = current.distance + 1;
            queue.push({ id: next, distance: current.distance + 1 });
          }
        });
      }
      delete result[start];
      return result;
    }

    function relativeLevel(nodeId, upstream, downstream) {
      var up = upstream[nodeId];
      var down = downstream[nodeId];
      if (typeof up !== "undefined" && typeof down !== "undefined") {
        return up <= down ? -up : down;
      }
      if (typeof up !== "undefined") {
        return -up;
      }
      if (typeof down !== "undefined") {
        return down;
      }
      return 0;
    }

    function layoutState() {
      var upstream = distances(focusId, true);
      var downstream = distances(focusId, false);
      var visible = nodes.filter(function (node) {
        return (
          node.id === focusId ||
          typeof upstream[node.id] !== "undefined" ||
          typeof downstream[node.id] !== "undefined"
        );
      });
      var groups = {};

      visible.forEach(function (node) {
        var relative = relativeLevel(node.id, upstream, downstream);
        groups[relative] = groups[relative] || [];
        groups[relative].push(node);
      });

      var levels = Object.keys(groups)
        .map(Number)
        .sort(function (a, b) {
          return a - b;
        });
      var maximumGroupSize = Math.max.apply(
        null,
        levels.map(function (level) {
          return groups[level].length;
        })
      );

      graphWidth = Math.max(1080, 180 + Math.max(0, levels.length - 1) * 265);
      graphHeight = Math.max(530, 150 + Math.max(0, maximumGroupSize - 1) * 92);
      svg.setAttribute("viewBox", "0 0 " + graphWidth + " " + graphHeight);

      var positions = {};
      levels.forEach(function (level, levelIndex) {
        var x =
          levels.length === 1
            ? graphWidth / 2
            : 90 + (levelIndex / (levels.length - 1)) * (graphWidth - 180);
        var group = groups[level].sort(function (a, b) {
          return String(a.title).localeCompare(String(b.title), "de");
        });
        var availableHeight = graphHeight - 135;
        var gap =
          group.length > 1
            ? Math.min(94, availableHeight / (group.length - 1))
            : 0;
        var startY = graphHeight / 2 - ((group.length - 1) * gap) / 2 + 12;

        group.forEach(function (node, index) {
          positions[node.id] = {
            x: x,
            y: startY + index * gap,
            relative: level,
          };
        });
      });

      return {
        upstream: upstream,
        downstream: downstream,
        visible: visible,
        positions: positions,
        levels: levels,
      };
    }

    function drawGuides(state) {
      guideLayer.replaceChildren();
      state.levels.forEach(function (relative) {
        var representative = state.visible.find(function (node) {
          return state.positions[node.id].relative === relative;
        });
        var x = state.positions[representative.id].x;
        var label =
          relative === 0
            ? "Fokus"
            : relative < 0
              ? "Vorgänger " + Math.abs(relative)
              : "Nachfolger " + relative;

        guideLayer.appendChild(
          svgElement("line", {
            class: "relation-lhm-depth-line",
            x1: x,
            y1: 48,
            x2: x,
            y2: graphHeight - 20,
          })
        );
        guideLayer.appendChild(
          svgElement(
            "text",
            {
              class: "relation-lhm-depth-label",
              x: x,
              y: 29,
              "text-anchor": "middle",
            },
            label
          )
        );
      });
    }

    function curveGeometry(from, to) {
      var horizontal = Math.abs(to.x - from.x) > NODE_WIDTH + 20;
      if (horizontal) {
        var direction = to.x >= from.x ? 1 : -1;
        var startX = from.x + direction * NODE_HALF_WIDTH;
        var endX = to.x - direction * (NODE_HALF_WIDTH + 7);
        var deltaX = endX - startX;
        return {
          path:
            "M " +
            startX +
            " " +
            from.y +
            " C " +
            (startX + deltaX * 0.46) +
            " " +
            from.y +
            ", " +
            (endX - deltaX * 0.46) +
            " " +
            to.y +
            ", " +
            endX +
            " " +
            to.y,
          tip:
            "M " +
            (endX - direction * 5) +
            " " +
            (to.y - 2.5) +
            " L " +
            endX +
            " " +
            to.y +
            " L " +
            (endX - direction * 5) +
            " " +
            (to.y + 2.5),
        };
      }

      var verticalDirection = to.y >= from.y ? 1 : -1;
      var startY = from.y + verticalDirection * NODE_HALF_HEIGHT;
      var endY = to.y - verticalDirection * (NODE_HALF_HEIGHT + 7);
      var sideX = Math.max(from.x, to.x) + NODE_HALF_WIDTH + 55;
      return {
        path:
          "M " +
          from.x +
          " " +
          startY +
          " C " +
          sideX +
          " " +
          startY +
          ", " +
          sideX +
          " " +
          endY +
          ", " +
          to.x +
          " " +
          endY,
        tip:
          "M " +
          (to.x - 2.5) +
          " " +
          (endY - verticalDirection * 5) +
          " L " +
          to.x +
          " " +
          endY +
          " L " +
          (to.x + 2.5) +
          " " +
          (endY - verticalDirection * 5),
      };
    }

    function edgeClass(source, target, state) {
      var classes = "relation-lhm-edge";
      var upstreamEdge =
        typeof state.upstream[source] !== "undefined" &&
        (typeof state.upstream[target] !== "undefined" || target === focusId);
      var downstreamEdge =
        (source === focusId ||
          typeof state.downstream[source] !== "undefined") &&
        typeof state.downstream[target] !== "undefined";
      if (upstreamEdge) {
        classes += " is-upstream";
      }
      if (downstreamEdge) {
        classes += " is-downstream";
      }
      return classes;
    }

    function drawEdges(state) {
      edgeLayer.replaceChildren();
      edges.forEach(function (edge) {
        var source = edge[0];
        var target = edge[1];
        if (!state.positions[source] || !state.positions[target]) {
          return;
        }
        var geometry = curveGeometry(
          state.positions[source],
          state.positions[target]
        );
        var classes = edgeClass(source, target, state);
        edgeLayer.appendChild(
          svgElement("path", { class: classes, d: geometry.path })
        );
        edgeLayer.appendChild(
          svgElement("path", {
            class: classes.replace(
              "relation-lhm-edge",
              "relation-lhm-edge-tip"
            ),
            d: geometry.tip,
          })
        );
      });
    }

    function visibleFormats(formats) {
      if (!formats || !formats.length) {
        return ["–"];
      }
      if (formats.length > 2) {
        return [clipped(formats[0], 11), "+" + (formats.length - 1)];
      }
      return formats.map(function (format) {
        return clipped(format, 11);
      });
    }

    function drawFormatBadges(group, formats) {
      var displayed = visibleFormats(formats);
      var widths = displayed.map(function (format) {
        return Math.min(66, Math.max(32, format.length * 5.5 + 13));
      });
      var totalWidth =
        widths.reduce(function (sum, width) {
          return sum + width;
        }, 0) +
        Math.max(0, displayed.length - 1) * 4;
      var x = -totalWidth / 2;

      displayed.forEach(function (format, index) {
        var width = widths[index];
        group.appendChild(
          svgElement("rect", {
            class: "relation-lhm-node-badge",
            x: x,
            y: 4,
            width: width,
            height: 16,
            rx: 8,
          })
        );
        group.appendChild(
          svgElement(
            "text",
            {
              class: "relation-lhm-node-badge-text",
              x: x + width / 2,
              y: 15,
            },
            format
          )
        );
        x += width + 4;
      });
    }

    function drawNodes(state) {
      nodeLayer.replaceChildren();
      state.visible.forEach(function (node, index) {
        var point = state.positions[node.id];
        var clipId =
          "relation-lhm-title-" + instanceCounter + "-" + String(index);
        var link = svgElement("a", {
          class:
            "relation-lhm-node" + (node.id === focusId ? " is-focus" : ""),
          transform: "translate(" + point.x + " " + point.y + ")",
          href: node.url,
          tabindex: "0",
          "aria-label":
            node.title +
            ", " +
            (node.formats && node.formats.length
              ? node.formats.join(", ")
              : "kein Ressourcenformat") +
            ". Kontext anzeigen",
          "data-node-id": node.id,
        });
        var titleClip = svgElement("clipPath", { id: clipId });
        titleClip.appendChild(
          svgElement("rect", { x: -74, y: -21, width: 148, height: 18 })
        );

        link.appendChild(svgElement("title", {}, node.title));
        link.appendChild(titleClip);
        link.appendChild(
          svgElement("rect", {
            class: "relation-lhm-node-box",
            x: -NODE_HALF_WIDTH,
            y: -NODE_HALF_HEIGHT,
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            rx: 8,
          })
        );
        link.appendChild(
          svgElement(
            "text",
            {
              class: "relation-lhm-node-title",
              x: -73,
              y: -8,
              "clip-path": "url(#" + clipId + ")",
            },
            clipped(node.title, 24)
          )
        );
        drawFormatBadges(link, node.formats);
        nodeLayer.appendChild(link);
      });

      nodeLayer.querySelectorAll("[data-node-id]").forEach(function (nodeLink) {
        nodeLink.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          focusId = nodeLink.getAttribute("data-node-id");
          render();
        });
      });
    }

    function updateSelected(node) {
      root.querySelector("[data-current-title]").textContent = node.title;
      root.querySelector("[data-current-title]").setAttribute("title", node.title);

      var selectedTitle = root.querySelector("[data-selected-title]");
      selectedTitle.textContent = node.title;
      if (node.title.length > 34) {
        selectedTitle.setAttribute("title", node.title);
      } else {
        selectedTitle.removeAttribute("title");
      }

      var category = node.category || {};
      var categoryTrigger = root.querySelector("[data-selected-category]");
      categoryTrigger.setAttribute("title", category.label || "");
      categoryTrigger.setAttribute("aria-label", category.label || "");
      root.querySelector("[data-selected-category-icon]").src = category.icon || "";
      root.querySelector("[data-selected-source]").textContent = node.source || "–";
      root.querySelector("[data-selected-owner]").textContent = node.owner || "–";

      var formats = root.querySelector("[data-selected-formats]");
      formats.replaceChildren();
      var detailFormats =
        node.formats && node.formats.length ? node.formats : ["–"];
      detailFormats.forEach(function (format) {
        var badge = document.createElement("span");
        badge.className = "relation-lhm-detail-format";
        badge.textContent = format;
        formats.appendChild(badge);
      });
      root.querySelector("[data-selected-link]").href = node.url;
    }

    function applyTransform() {
      viewport.setAttribute(
        "transform",
        "translate(" + panX + " " + panY + ") scale(" + scale + ")"
      );
    }

    function fit() {
      scale = 1;
      panX = 0;
      panY = 0;
      applyTransform();
    }

    function zoomAt(nextScale, centerX, centerY) {
      nextScale = Math.max(0.45, Math.min(3.2, nextScale));
      var worldX = (centerX - panX) / scale;
      var worldY = (centerY - panY) / scale;
      panX = centerX - worldX * nextScale;
      panY = centerY - worldY * nextScale;
      scale = nextScale;
      applyTransform();
    }

    function zoomFromButton(factor) {
      zoomAt(scale * factor, graphWidth / 2, graphHeight / 2);
    }

    function eventPoint(event) {
      var rectangle = svg.getBoundingClientRect();
      return {
        x: ((event.clientX - rectangle.left) / rectangle.width) * graphWidth,
        y: ((event.clientY - rectangle.top) / rectangle.height) * graphHeight,
      };
    }

    function render() {
      var state = layoutState();
      drawGuides(state);
      drawEdges(state);
      drawNodes(state);
      updateSelected(byId[focusId]);
      fit();
    }

    root.querySelector("[data-zoom-in]").addEventListener("click", function () {
      zoomFromButton(1.2);
    });
    root.querySelector("[data-zoom-out]").addEventListener("click", function () {
      zoomFromButton(1 / 1.2);
    });
    root.querySelector("[data-fit]").addEventListener("click", fit);

    stage.addEventListener(
      "wheel",
      function (event) {
        event.preventDefault();
        var point = eventPoint(event);
        zoomAt(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), point.x, point.y);
      },
      { passive: false }
    );

    stage.addEventListener("pointerdown", function (event) {
      if (event.target.closest(".relation-lhm-node")) {
        return;
      }
      dragging = true;
      dragStart = {
        clientX: event.clientX,
        clientY: event.clientY,
        panX: panX,
        panY: panY,
      };
      stage.classList.add("is-dragging");
      stage.setPointerCapture(event.pointerId);
    });

    stage.addEventListener("pointermove", function (event) {
      if (!dragging) {
        return;
      }
      var rectangle = svg.getBoundingClientRect();
      panX =
        dragStart.panX +
        ((event.clientX - dragStart.clientX) / rectangle.width) * graphWidth;
      panY =
        dragStart.panY +
        ((event.clientY - dragStart.clientY) / rectangle.height) * graphHeight;
      applyTransform();
    });

    function stopDragging(event) {
      dragging = false;
      stage.classList.remove("is-dragging");
      if (
        event &&
        typeof event.pointerId !== "undefined" &&
        stage.hasPointerCapture(event.pointerId)
      ) {
        stage.releasePointerCapture(event.pointerId);
      }
    }

    stage.addEventListener("pointerup", stopDragging);
    stage.addEventListener("pointercancel", stopDragging);

    render();
  }

  function initializeAll() {
    document
      .querySelectorAll("[data-relation-lhm-diagram]")
      .forEach(initializeDiagram);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeAll);
  } else {
    initializeAll();
  }
})();
