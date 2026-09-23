// Shared searchable sport selector.
//
// Loaded by the staff dashboard (achievement form) and the public achievements
// page (sport filter). Renders a tappable trigger + a popup with a live search
// box and results grouped by category. Last category is the "Other" block.
// If "Other" is picked, a custom name field appears and is saved with the
// achievement. Works on desktop and mobile (390px) with an on-screen popup.
(function () {
  "use strict";

  const $ = (s, root) => (root || document).querySelector(s);

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // Builds one sport picker instance. opts:
  //   host         : the element to mount into
  //   allowOther   : bool - show the "Other / custom sport" row (default false)
  //   onSelect     : fn(name) called when a sport (or custom value) is picked
  //   initial      : string - preselected value
  //   groups       : [{name, category}] flattened catalog from /api/sports
  //   includeAll   : bool - prepend an "All Sports" option (public filter)
  function SportPicker(opts) {
    const o = opts || {};
    const host = o.host;
    const allowOther = o.allowOther !== false;
    const includeAll = !!o.includeAll;
    let groups = o.groups || [];
    let value = o.initial || "";
    let term = "";

    // --- build DOM ---------------------------------------------------------
    const wrap = el("div", "sport-picker");
    wrap.tabIndex = 0;
    // trigger
    const trig = el("button", "sport-picker-trigger", '<span class="sport-picker-value"></span><span class="sport-picker-caret">&#9662;</span>');
    trig.type = "button";
    trig.setAttribute("aria-haspopup", "listbox");
    // popup
    const popup = el("div", "sport-picker-popup hidden");
    const search = el("input", "sport-picker-search");
    search.type = "search";
    search.placeholder = "Search sport...";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Search sport");
    const listEl = el("div", "sport-picker-list");
    popup.appendChild(search);
    popup.appendChild(listEl);

    wrap.appendChild(trig);
    wrap.appendChild(popup);
    host.appendChild(wrap);

    const valueEl = $(".sport-picker-value", wrap);

    // --- state helpers -----------------------------------------------------
    function refreshValue() {
      valueEl.textContent = value || (includeAll ? "All Sports" : "Select sport");
      valueEl.classList.toggle("empty", !value);
    }

    function pick(name) {
      value = name;
      refreshValue();
      closePopup();
      if (o.onSelect) o.onSelect(name);
    }

    // --- rendering ---------------------------------------------------------
    function renderList() {
      const t = term.trim().toLowerCase();
      const cats = [];
      const byCat = {};
      let any = false;
      (groups || []).forEach((s) => {
        const n = s.name || "";
        if (t && !n.toLowerCase().includes(t)) return;
        if (!byCat[s.category]) { byCat[s.category] = []; cats.push(s.category); }
        byCat[s.category].push(n);
        any = true;
      });

      if (includeAll) {
        const allBtn = el("button", "sport-picker-item" + (value === "" ? " active" : ""), "All Sports");
        allBtn.type = "button";
        allBtn.addEventListener("click", () => pick(""));
        listEl.appendChild(allBtn);
      }

      if (!any) {
        listEl.appendChild(el("p", "sport-picker-empty", t ? "No sports match your search." : "No sports available."));
      } else {
        cats.forEach((cat) => {
          listEl.appendChild(el("div", "sport-picker-cat", cat.toUpperCase()));
          byCat[cat].forEach((n) => {
            const btn = el("button", "sport-picker-item" + (n === value ? " active" : ""), n);
            btn.type = "button";
            btn.addEventListener("click", () => pick(n));
            listEl.appendChild(btn);
          });
        });
      }

      // "Other / custom sport" row always appended to the category list.
      if (allowOther) {
        listEl.appendChild(el("div", "sport-picker-cat", "OTHER"));
        const otherRow = el("div", "sport-picker-other");
        const customInput = el("input", "sport-picker-custom");
        customInput.type = "text";
        customInput.placeholder = "Type sport name and press Enter";
        customInput.maxLength = 80;
        customInput.autocomplete = "off";

        const saveCustom = () => {
          const n = customInput.value.trim();
          if (!n) return;
          if (!groups.some((s) => s.name && s.name.toLowerCase() === n.toLowerCase())) {
            groups = groups.concat([{ name: n, category: "Other" }]);
          }
          pick(n);
        };
        customInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); saveCustom(); }
        });
        // Blur saves too unless the user is interacting elsewhere.
        customInput.addEventListener("blur", () => setTimeout(saveCustom, 120));

        otherRow.appendChild(customInput);
        listEl.appendChild(otherRow);
      }
    }

    // --- open / close ------------------------------------------------------
    function openPopup() {
      listEl.innerHTML = "";
      term = "";
      search.value = "";
      renderList();
      popup.classList.remove("hidden");
      wrap.classList.add("open");
      setTimeout(() => search.focus({ preventScroll: true }), 20);
    }

    function closePopup() {
      popup.classList.add("hidden");
      wrap.classList.remove("open");
    }

    trig.addEventListener("click", (e) => {
      e.stopPropagation();
      popup.classList.contains("hidden") ? openPopup() : closePopup();
    });
    search.addEventListener("input", () => {
      term = search.value;
      listEl.innerHTML = "";
      renderList();
    });
    // Close when clicking outside the whole control.
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) closePopup();
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePopup();
    });

    refreshValue();

    // --- public API ----------------------------------------------------------
    return {
      setGroups(g) { groups = g; if (value) { const still = groups.some((s) => s.name === value); if (!still && !allowOther) value = ""; refreshValue(); } },
      setValue(v) { value = v || ""; refreshValue(); },
      getValue() { return value; },
      open: openPopup,
      close: closePopup,
      element: wrap,
    };
  }

  window.SportPicker = SportPicker;
})();