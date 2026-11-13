/*
 * SOURCE for extensions/booking-widget/assets/booking-addon.js — built by
 * `npm run build:widget`. Loaded by booking.liquid only for the "On the page"
 * display, so it has its own 10 KB budget.
 *
 * The add-on card: a service (e.g. a consultation) offered on another
 * product's page. The customer ticks "Add <service>", picks a date and a time,
 * and the theme's own add-to-cart then adds the product AND the booking in one
 * /cart/add.js call (via booking-step2.js, which holds the slot first and
 * renders any people / questions / signature fields under the summary).
 *
 *   unticked        → the theme's button works exactly as before
 *   ticked, no time → the theme's button points the customer at the card
 *   ticked + time   → "Add to cart · <product + service total>"
 *
 * "Self" mode ([data-self]): the page's product is itself the service. Only
 * the booking is added, and the theme's button opens the card (it can't buy
 * the service without a time). Both modes start unticked.
 *
 * The server re-checks everything; this file is UX, not the security boundary.
 */
(function () {
  "use strict";

  var HOUR_PREF = "sb-hour-cycle";
  var step2Loading = null;
  // Service variant id -> { on, date, start }. Themes re-render the product
  // section on all sorts of interactions, which replaces this card with fresh
  // markup: unticked, collapsed, nothing chosen. Keeping the choice out here,
  // module-side, lets the replacement pick up where the old card left off, so
  // a re-render is invisible instead of looking like the add-on switched
  // itself off when a date or a time was clicked.
  var saved = {};

  function init(root) {
    if (root.__sb) return;
    root.__sb = true;

    var $ = function (sel) {
      return root.querySelector(sel);
    };
    var self = root.hasAttribute("data-self");
    var check = $("[data-sb-check]");
    var body = $("[data-sb-body]");
    var pickers = $("[data-sb-pickers]");
    var calEl = $("[data-sb-calendar]");
    var timesEl = $("[data-sb-times]");
    var noteEl = $("[data-sb-note]");
    var summary = $("[data-sb-summary]");
    var detailsEl = $("[data-sb-details]");
    var statusEl = $("[data-sb-status]");
    var locale = document.documentElement.lang || undefined;
    var weekStart = Number(root.dataset.weekStart) || 0;
    var form = findProductForm(root);
    var section = (form && form.closest(".shopify-section")) || root.closest(".shopify-section");
    var prices = pairs(root.dataset.prices, ",");
    var variantTitles = pairs(root.dataset.variantTitles, "|");
    var step2 = null; // booking-step2's { submit, empty, seats, values } once a time is picked
    var pendingInitial = null; // step 2 values rescued from the card this one replaced

    var state = {
      variantId: root.dataset.variantId, // the SERVICE variant
      timezone: null,
      month: null,
      firstMonth: null,
      lastMonth: null,
      days: [],
      byDay: {},
      date: null,
      pick: null,
      capacity: 1,
      mode: "people",
      minSeats: 1,
      maxSeats: null,
      duration: 0,
      questions: [],
      signature: false,
      h24: readHourPref(),
      seq: 0,
    };

    function t(key, vars) {
      var text = root.dataset["i18n" + key] || "";
      Object.keys(vars || {}).forEach(function (k) {
        text = text.replace("__" + k.toUpperCase() + "__", vars[k]);
      });
      return text;
    }

    function setStatus(text, isError) {
      statusEl.textContent = text || "";
      statusEl.classList.toggle("sb-error", !!isError);
    }

    function api(path, params, options) {
      var url = root.dataset.proxy + path + (params ? "?" + new URLSearchParams(params) : "");
      return fetch(url, Object.assign({ credentials: "same-origin" }, options)).then(function (res) {
        return res.json().then(
          function (data) {
            return { status: res.status, data: data };
          },
          function () {
            return { status: res.status, data: {} };
          },
        );
      });
    }

    function el(tag, attrs, children) {
      var node = document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        var v = attrs[k];
        if (k === "text") node.textContent = v;
        else if (k === "onclick") node.addEventListener("click", v);
        else if (v !== false && v != null) node.setAttribute(k, v);
      });
      (children || []).forEach(function (c) {
        if (c) node.appendChild(c);
      });
      return node;
    }

    function fmt(iso, opts) {
      return new Intl.DateTimeFormat(locale, Object.assign({ timeZone: state.timezone }, opts)).format(
        new Date(iso),
      );
    }

    function formatTime(iso) {
      return fmt(iso, { hour: "2-digit", minute: "2-digit", hourCycle: state.h24 ? "h23" : "h12" });
    }

    function zoneName(style) {
      return new Intl.DateTimeFormat(locale, { timeZone: state.timezone, timeZoneName: style })
        .formatToParts(new Date())
        .find(function (p) {
          return p.type === "timeZoneName";
        }).value;
    }

    /**
     * Still on the page and not backed out by the app. A theme that re-renders
     * the section replaces this card; the old one's listeners must go quiet.
     */
    function live() {
      return root.isConnected && !root.hidden;
    }

    function on() {
      return live() && check.checked;
    }

    // Many themes treat any `change` or click inside the product area as a
    // variant change and re-render the section, which would reset this card.
    // Note this only stops bubbling listeners; a theme listening on document
    // in the capture phase still sees these, which is why state is restored
    // as well rather than relying on this alone.
    ["change", "input", "click"].forEach(function (type) {
      root.addEventListener(type, function (e) {
        e.stopPropagation();
        // Capture as it is typed. The poll only runs every 750 ms, and a
        // re-render landing between two ticks would lose the last keystrokes.
        remember();
      });
    });

    // ---------------------------------------------------------------------
    // Card
    // ---------------------------------------------------------------------

    function showPickers() {
      state.pick = null;
      step2 = null;
      pickers.hidden = false;
      summary.hidden = true;
      detailsEl.hidden = true;
      detailsEl.textContent = "";
      renderTimes();
    }

    /**
     * `wasOn` is this card's state; the checkbox only ever mirrors it.
     *
     * Themes do all sorts of things to the product area — wrap blocks in a
     * <label>, delegate clicks, re-fire events — and any of them can turn a
     * click on a date or a time into a checkbox toggle, which closed the card
     * mid-booking. Rather than chase each mechanism, nothing outside setOn()
     * is allowed to change the state: the header cancels its own click so even
     * the checkbox never toggles natively, and any flip that gets through from
     * elsewhere is put straight back.
     */
    var wasOn = false;
    function setOn(next) {
      check.checked = next;
      if (next === wasOn) return;
      wasOn = next;
      body.hidden = !next;
      if (!next) showPickers();
      else if (!state.month) loadMonth(null);
      sync();
    }

    // The header owns the toggle, and is a <div> rather than a <label> so a
    // theme re-wiring labels can't claim it.
    $("[data-sb-head]").addEventListener("click", function (e) {
      e.preventDefault();
      setOn(!wasOn);
    });

    // Anything that still manages to flip the box — a wrapping <label>, a
    // theme handler calling .click() — is reverted before it means anything.
    check.addEventListener("change", function () {
      if (check.checked !== wasOn) check.checked = wasOn;
    });
    // Clicks in the calendar, times and fields stay in the card: no theme
    // handler sees them, and no <label> around the block can turn them into
    // a checkbox toggle. Form controls keep their default action.
    body.addEventListener("click", function (e) {
      e.stopPropagation();
      // Only a real form control, or a label for one INSIDE the card, needs its
      // default action. Matching an ancestor <label> instead — as
      // closest("input,textarea,select,label") did — exempted every click in
      // the card whenever a theme wrapped the block in a label, so the default
      // was never prevented and the label toggled the checkbox: picking a date
      // or a time switched the add-on back off.
      remember();
      var label = e.target.closest("label");
      var keep =
        /^(?:INPUT|TEXTAREA|SELECT|OPTION)$/.test(e.target.tagName) ||
        !!(label && label.control && body.contains(label.control));
      if (!keep) e.preventDefault();
    });

    $("[data-sb-change]").addEventListener("click", function () {
      showPickers();
      sync();
    });

    function remember() {
      // Nothing to save until this card has taken over from the one it
      // replaced: sync() runs before restore() does, and saving first would
      // overwrite the previous card's choice with this one's blank state.
      if (!restored) return;
      saved[state.variantId] = {
        on: check.checked,
        date: state.date,
        start: state.pick ? state.pick.start : null,
        // What has been typed into step 2 so far, so a re-render mid-form
        // doesn't make the customer fill it in again. The signature is not
        // carried over: it is an attestation, and re-signing is correct.
        fields: step2 && step2.values ? step2.values() : null,
      };
    }

    /**
     * Put back what the previous card had, once this one knows the month's
     * slots. Runs once: later month navigation must not pull the choice back.
     */
    var restored = false;
    function restore() {
      if (restored) return;
      restored = true;
      var k = saved[state.variantId];
      if (!k || !k.on) return;
      setOn(true);
      if (k.date && state.days.indexOf(k.date) >= 0) {
        state.date = k.date;
        renderCalendar();
        renderTimes();
      }
      pendingInitial = k.fields || null;
      if (k.start) {
        // Only if that time is still free — someone else may have taken it.
        var slot = (state.byDay[state.date] || []).filter(function (s) {
          return s.start === k.start && s.remaining > 0;
        })[0];
        if (slot) pickSlot(slot);
      }
      sync();
    }

    function pickSlot(slot) {
      state.pick = slot;
      renderTimes();
      setStatus(t("Loading"));
      loadStep2().then(
        function () {
          if (state.pick !== slot || !on()) return;
          setStatus("");
          pickers.hidden = true;
          summary.hidden = false;
          $("[data-sb-when]").textContent =
            fmt(slot.start, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) +
            " · " + formatTime(slot.start) + " (" + zoneName("short") + ")";
          $("[data-sb-sub]").textContent = t("Minutes", { count: state.duration });
          detailsEl.hidden = false; // visible first: the signature pad sizes itself
          step2 = window.__sbStep2({
            root: root,
            state: state,
            el: el,
            t: t,
            api: api,
            fmt: fmt,
            formatTime: formatTime,
            setStatus: setStatus,
            detailsEl: detailsEl,
            addBtn: null,
            compact: true,
            initial: pendingInitial,
            extraItems: self ? null : productLine,
            taken: function () {
              showPickers();
              sync();
              loadMonth(state.month).then(function () {
                setStatus(t("Taken"), true);
              });
            },
          });
          pendingInitial = null;
          detailsEl.hidden = step2.empty;
          sync();
        },
        function () {
          setStatus(t("Error"), true);
        },
      );
    }

    function loadStep2() {
      if (!step2Loading) {
        step2Loading = new Promise(function (resolve, reject) {
          var s = document.createElement("script");
          s.src = root.dataset.step2Src;
          s.async = true;
          s.onload = resolve;
          s.onerror = function () {
            step2Loading = null; // allow a retry
            reject();
          };
          document.head.appendChild(s);
        });
      }
      return step2Loading;
    }

    // ---------------------------------------------------------------------
    // Calendar + times
    // ---------------------------------------------------------------------

    function monthDate(month) {
      var p = month.split("-");
      return new Date(Date.UTC(+p[0], +p[1] - 1, 1));
    }

    function shiftMonth(month, delta) {
      var d = monthDate(month);
      d.setUTCMonth(d.getUTCMonth() + delta);
      return d.toISOString().slice(0, 7);
    }

    function utcFmt(opts) {
      return new Intl.DateTimeFormat(locale, Object.assign({ timeZone: "UTC" }, opts));
    }

    function dayBtn(cls, d, iso, children) {
      var closed = state.days.indexOf(iso) < 0;
      return el("button", {
        type: "button",
        // Booked out (it has slots, none free) is struck through; closed isn't.
        class: cls + (closed && state.byDay[iso] ? " is-full" : ""),
        "aria-label": utcFmt({ dateStyle: "full" }).format(d),
        "aria-pressed": String(state.date === iso),
        disabled: closed ? "" : false,
        onclick: function () {
          state.date = iso;
          loadStep2().catch(function () {}); // ready before a time is picked
          renderCalendar();
          renderTimes();
        },
      }, children);
    }

    /**
     * Both layouts are drawn; a container query on the card shows the month
     * grid when there's room and a row of day chips when there isn't.
     */
    function renderCalendar() {
      var first = monthDate(state.month);
      var nav = function (label, text, delta, off) {
        return el("button", {
          type: "button",
          class: "sb-addon__nav",
          "aria-label": label,
          text: text,
          disabled: off ? "" : false,
          onclick: function () {
            loadMonth(shiftMonth(state.month, delta));
          },
        });
      };
      var title = utcFmt({ month: "long", year: "numeric" }).format(first);
      var grid = el("div", { class: "sb-addon__grid", role: "group", "aria-label": title });
      var strip = el("div", { class: "sb-addon__strip", role: "group", "aria-label": title });
      var dow = utcFmt({ weekday: "short" });
      for (var i = 0; i < 7; i++) {
        // 2023-01-01 was a Sunday.
        grid.appendChild(el("span", {
          class: "sb-addon__dow",
          "aria-hidden": "true",
          text: dow.format(new Date(Date.UTC(2023, 0, 1 + ((i + weekStart) % 7)))),
        }));
      }
      for (var pad = (first.getUTCDay() - weekStart + 7) % 7; pad > 0; pad--) grid.appendChild(el("span"));
      // The strip starts at the first open day: earlier ones are in the past.
      var from = state.days[0] || "";
      for (var d = new Date(first); d.getUTCMonth() === first.getUTCMonth(); d.setUTCDate(d.getUTCDate() + 1)) {
        var iso = d.toISOString().slice(0, 10);
        grid.appendChild(dayBtn("sb-addon__day", d, iso, [el("span", { text: String(d.getUTCDate()) })]));
        if (iso >= from) {
          strip.appendChild(dayBtn("sb-addon__chip", d, iso, [
            el("small", { text: dow.format(d) }),
            el("strong", { text: String(d.getUTCDate()) }),
          ]));
        }
      }
      calEl.textContent = "";
      calEl.appendChild(el("div", { class: "sb-addon__bar" }, [
        el("span", { class: "sb-eyebrow", text: t("ChooseDate") }),
        el("span", { class: "sb-addon__month" }, [
          nav(t("PreviousMonth"), "‹", -1, state.month <= state.firstMonth),
          el("strong", { text: title }),
          nav(t("NextMonth"), "›", 1, state.month >= state.lastMonth),
        ]),
      ]));
      calEl.appendChild(grid);
      if (state.days.length) calEl.appendChild(strip);
      else calEl.appendChild(el("p", { class: "sb-muted", text: t("NoDates") }));
    }

    function renderTimes() {
      timesEl.textContent = "";
      if (!state.date) return;
      timesEl.appendChild(el("div", { class: "sb-addon__bar" }, [
        el("span", { class: "sb-eyebrow", text: t("AvailableTimes") }),
        el("strong", {
          text: utcFmt({ weekday: "short", day: "numeric", month: "short", year: "numeric" })
            .format(new Date(state.date + "T00:00:00Z")),
        }),
      ]));
      var slots = state.byDay[state.date] || [];
      if (!slots.length) {
        timesEl.appendChild(el("p", { class: "sb-muted", text: t("NoTimes") }));
        return;
      }
      var list = el("div", { class: "sb-addon__times-list" });
      slots.forEach(function (slot) {
        list.appendChild(el("button", {
          type: "button",
          class: "sb-addon__time",
          "aria-pressed": String(!!state.pick && state.pick.start === slot.start),
          disabled: slot.remaining > 0 ? false : "",
          text: formatTime(slot.start),
          onclick: function () {
            pickSlot(slot);
          },
        }));
      });
      timesEl.appendChild(list);
    }

    function loadMonth(month) {
      var seq = ++state.seq;
      var params = { variant: state.variantId };
      if (month) params.month = month;
      return api("/availability", params)
        .then(function (res) {
          if (seq !== state.seq) return;
          // The service was paused or removed since the page was rendered.
          if (res.data.bookable === false && (res.status === 404 || res.status === 200)) {
            root.hidden = true;
            sync();
            return;
          }
          if (res.status !== 200 || !res.data.bookable) throw res.status;
          var d = res.data;
          state.timezone = d.timezone;
          state.month = d.month;
          state.firstMonth = d.firstMonth;
          state.lastMonth = d.lastMonth;
          state.days = d.days;
          state.byDay = d.slots || {};
          state.capacity = d.capacity || 1;
          state.mode = d.mode || "people";
          state.minSeats = d.minSeats || 1;
          state.maxSeats = d.maxSeats || null;
          state.duration = d.duration || 0;
          state.questions = d.questions || [];
          state.signature = !!d.signature;
          if (state.date && state.date.slice(0, 7) !== d.month) state.date = null;
          if (!state.date && d.days.length) state.date = d.days[0];
          noteEl.textContent = t("TimesNote", { zone: zoneName("long"), minutes: state.duration });
          setStatus("");
          renderCalendar();
          renderTimes();
          sync();
          restore();
        })
        .catch(function () {
          if (seq === state.seq && on()) setStatus(t("Error"), true);
        });
    }

    // ---------------------------------------------------------------------
    // The theme's add-to-cart
    // ---------------------------------------------------------------------

    function themeBtn() {
      return form && (form.querySelector('[name="add"], [type="submit"]') ||
        document.querySelector('[form="' + form.id + '"][name="add"], [form="' + form.id + '"][type="submit"]'));
    }

    function formValue(name) {
      var input = form && (form.querySelector('[name="' + name + '"]') ||
        document.querySelector('[name="' + name + '"][form="' + form.id + '"]'));
      return input ? input.value : "";
    }

    /** The product line, as the theme's form would add it. */
    function productLine() {
      var data = new FormData(form);
      var item = { id: Number(data.get("id")), quantity: Number(data.get("quantity")) || 1 };
      var props = {};
      data.forEach(function (v, k) {
        var m = /^properties\[(.+)\]$/.exec(k);
        if (m && typeof v === "string" && v !== "") props[m[1]] = v;
      });
      if (Object.keys(props).length) item.properties = props;
      if (data.get("selling_plan")) item.selling_plan = Number(data.get("selling_plan"));
      return [item];
    }

    function money(cents) {
      return (root.dataset.moneyFormat || "{{amount}}").replace(/\{\{\s*(\w+)\s*\}\}/, function (_, k) {
        var euro = /comma_separator/.test(k);
        var n = (cents / 100).toFixed(/no_decimals/.test(k) ? 0 : 2).split(".");
        return n[0].replace(/\B(?=(\d{3})+(?!\d))/g, euro ? "." : ",") + (n[1] ? (euro ? "," : ".") + n[1] : "");
      });
    }

    function seats() {
      return step2 ? step2.seats() : Math.max(1, state.minSeats);
    }

    function total() {
      var service = Number(root.dataset.servicePrice) * seats();
      if (self) return service;
      var id = formValue("id");
      return (Number(prices[id]) || 0) * (Number(formValue("quantity")) || 1) + service;
    }

    /** First non-blank text node: the label, whatever the theme wraps it in. */
    function labelNode(btn) {
      var walk = document.createTreeWalker(btn, 4); // 4: NodeFilter.SHOW_TEXT
      var node;
      while ((node = walk.nextNode()) && !/\S/.test(node.nodeValue));
      return node;
    }

    /** Relabel the theme's button with the total (or restore it), and the hint under it. */
    function sync() {
      if (!root.isConnected) return; // replaced by a re-render: the new card owns the button
      remember();
      var active = on();
      // Hides "Buy it now", which would skip the booking (booking.css).
      if (section) section.classList.toggle("sb-has-booking", active || (self && live()));
      var btn = themeBtn();
      if (!btn) return;
      var node = labelNode(btn);
      if (node) {
        // The theme rewrites its label on variant change ("Sold out"): keep its latest.
        if (node.nodeValue !== btn.__sbSet) btn.__sbLabel = node.nodeValue;
        var want = active && !btn.disabled ? t("AddWithTotal", { total: money(total()) }) : btn.__sbLabel;
        if (node.nodeValue !== want) node.nodeValue = want;
        btn.__sbSet = want;
      }
      if (self) return;
      // Kept on the button, so a re-initialised card reuses it.
      var hint = btn.__sbHint;
      if (!hint) {
        // Under the button's row (often quantity + button side by side).
        var anchor = btn;
        if (form.contains(btn)) while (anchor.parentElement !== form) anchor = anchor.parentElement;
        hint = btn.__sbHint = el("p", { class: "sb-addon__hint" });
        anchor.insertAdjacentElement("afterend", hint);
      }
      var variant = variantTitles[formValue("id")];
      hint.hidden = !active || !step2;
      hint.textContent = t("AddsItems", {
        product: root.dataset.productTitle + (variant ? " (" + variant + ")" : ""),
        service: root.dataset.serviceTitle,
      });
    }

    /** Drop this instance's page-level listeners and timer once it is gone. */
    var pollId = 0;
    function detach() {
      document.removeEventListener("submit", guard, true);
      document.removeEventListener("click", guard, true);
      if (pollId) pollId = clearInterval(pollId);
    }

    function guard(event) {
      // A re-render leaves this card detached with a fresh one in charge:
      // without this, every re-render would leave another set behind.
      if (!root.isConnected) return detach();
      // Unticked, an add-on leaves the theme's flow alone. In self mode the
      // product IS the service: it can't be bought without a time.
      if (!form || !live() || !(self || check.checked)) return;
      var target = event.target;
      var hit = event.type === "submit"
        ? target === form
        : target.closest &&
          target.closest('[type="submit"], [name="add"]') &&
          (form.contains(target) || target.closest('[form="' + form.id + '"]'));
      if (!hit) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!step2) {
        setOn(true);
        setStatus(t("PickTime"), true);
        root.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      step2.submit(); // ignores repeat clicks while busy
    }
    document.addEventListener("submit", guard, true);
    document.addEventListener("click", guard, true);

    // Variant / quantity / party size changes move the total. Themes update
    // the form in different ways, so poll as well.
    if (form) {
      form.addEventListener("change", sync);
      form.addEventListener("input", sync);
    }
    pollId = setInterval(function () {
      if (!root.isConnected) return detach();
      // A theme that assigns check.checked directly fires no event; put it back.
      if (check.checked !== wasOn) check.checked = wasOn;
      sync();
    }, 750);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        loadMonth(null);
        sync();
      });
    });
  }

  /** "a:b,c:d" → { a: "b", c: "d" } */
  function pairs(text, sep) {
    var out = {};
    (text || "").split(sep).forEach(function (p) {
      var i = p.indexOf(":");
      if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
    });
    return out;
  }

  function readHourPref() {
    try {
      var saved = localStorage.getItem(HOUR_PREF);
      if (saved) return saved === "24";
    } catch (e) {}
    var cycle = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { hour: "numeric" })
      .resolvedOptions().hourCycle;
    return cycle === "h23" || cycle === "h24";
  }

  /** The add-to-cart form belonging to the same product section as the block. */
  function findProductForm(root) {
    var scope = root.closest(".shopify-section") || document;
    return scope.querySelector('form[action*="/cart/add"]') || document.querySelector('form[action*="/cart/add"]');
  }

  function boot() {
    document.querySelectorAll("[data-sb-addon]").forEach(init);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  document.addEventListener("shopify:section:load", boot);
  // booking.js re-runs this when a theme re-renders the product section.
  window.__sbAddon = boot;
})();
