(function () {
  "use strict";

  function initializeContextPage(root) {
    if (root.dataset.relationLhmInitialized === "true") {
      return;
    }
    root.dataset.relationLhmInitialized = "true";

    root.querySelectorAll("[data-toggle-relation-list]").forEach(function (button) {
      button.addEventListener("click", function () {
        var name = button.getAttribute("data-toggle-relation-list");
        var list = root.querySelector('[data-relation-list="' + name + '"]');
        if (!list) {
          return;
        }

        var expanded = !list.classList.contains("is-expanded");
        var hiddenCount = button.getAttribute("data-hidden-count");
        list.classList.toggle("is-expanded", expanded);
        button.setAttribute("aria-expanded", expanded ? "true" : "false");
        button.innerHTML = expanded
          ? '<i class="fa fa-chevron-up" aria-hidden="true"></i> Weniger anzeigen'
          : '<i class="fa fa-ellipsis-h" aria-hidden="true"></i> Weitere ' +
            hiddenCount +
            " anzeigen";
      });
    });
  }

  function initializeAll() {
    document.querySelectorAll(".relation-lhm-context").forEach(initializeContextPage);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeAll);
  } else {
    initializeAll();
  }
})();
