/*
 * SOURCE for extensions/booking-widget/assets/booking.js — edit this file, not
 * the asset. `npm run build:widget` (also run by `npm run dev` and `deploy`)
 * minifies it there: app block scripts must stay under 10 KB, which is why the
 * popup's second step lives in booking-step2.js and is loaded on demand.
 *
 * Service Booking — "Select a time" on the theme's button + popup.
 *
 * This is the block's "In a popup" display. "On the page" renders a different
 * root ([data-sb-addon], an add-on card) driven by booking-addon.js instead.
 *
 * Flow: the theme's add-to-cart is relabelled "Select a time" for bookable
 * services (known at render from a variant metafield, confirmed through the
 * app proxy) → popup step 1: month calendar + the chosen day's times (a whole
 * month comes in one /availability call) → picking a time opens step 2
 * (booking-step2.js): people, questions, signature, add-ons → its "Add to
 * cart" holds the seats and adds everything to the cart.
 *
 * The server re-checks everything; this file is UX, not the security boundary.
 */
(function () {
  "use strict";

  var HOUR_PREF = "sb-hour-cycle";
  var step2Loading = null; // one <script> per page, shared by every block

  function init(root) {
    if (root.__sb) return;
    root.__sb = true;

    var $ = function (sel) {
      return root.querySelector(sel);
    };
    var proxy = root.dataset.proxy;
    var weekStart = Number(root.dataset.weekStart) || 0;
    var dialog = $("[data-sb-dialog]");
    var step1El = $("[data-sb-step1]");
    var detailsEl = $("[data-sb-details]");
    var addBtn = $("[data-sb-add]");
    var calEl = $("[data-sb-calendar]");
    var timesEl = $("[data-sb-times]");
    var statusEl = $("[data-sb-status]");
    var triggerBtn = $("[data-sb-open]");
    // Variants the app flagged as services (Liquid metafield), known at render.
    var flagged = (root.dataset.bookableVariants || "").split(",");
    var locale = document.documentElement.lang || undefined;
    var form = findProductForm(root);
    var section = (form && form.closest(".shopify-section")) || root.closest(".shopify-section");

    var state = {
      variantId: root.dataset.variantId,
      bookable: false,
      timezone: null,
      month: null,
      firstMonth: null,
      lastMonth: null,
      days: [],
      byDay: {}, // "YYYY-MM-DD" -> [{ start, remaining }] for the loaded month
      date: null,
      slots: null,
      capacity: 1, // the service's default slot limit; slots carry their own
      mode: "people", // what slot limits count: "people" or "bookings"
      minSeats: 1,
      maxSeats: null, // null: only the slot's free places limit party size
      duration: 0,
      questions: [],
      signature: false,
      pick: null, // the slot chosen in step 1
      seq: 0,
      loading: null, // the /availability request in flight, if any
      wantDay: false, // popup opened before data came: pick a day on arrival
      h24: readHourPref(),
    };

    function t(key, vars) {
      var text = root.dataset["i18n" + key] || "";
      Object.keys(vars || {}).forEach(function (k) {
        text = text.replace("__" + k.toUpperCase() + "__", vars[k]);
      });
      return text;
    }

    /** Is the popup in front of the customer? */
    function shown() {
      return !!(dialog && dialog.open);
    }

    function setStatus(text, isError) {
      statusEl.textContent = text || "";
      statusEl.classList.toggle("sb-error", !!isError);
    }

    function api(path, params, options) {
      var url = proxy + path + (params ? "?" + new URLSearchParams(params) : "");
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
      return fmt(iso, { hour: "numeric", minute: "2-digit", hourCycle: state.h24 ? "h23" : "h12" });
    }

    /** "3 / 10 available" (people) or "2 spots left" (bookings); none for 1-per-slot. */
    function slotLabel(slot) {
      var total = slot.capacity || state.capacity;
      if (total <= 1) return null;
      var text = state.mode === "bookings"
        ? t("SpotsLeft", { count: slot.remaining })
        : t("Available", { count: slot.remaining, total: total });
      return el("small", { text: text });
    }

    // ---------------------------------------------------------------------
    // Theme integration
    // ---------------------------------------------------------------------

    /** Relabel the theme's button and hide its other buy controls, or undo both. */
    function applyBookable(on) {
      state.bookable = on;
      root.hidden = !on;
      if (section) section.classList.toggle("sb-has-booking", on);
      if (form) {
        var qty = form.querySelector('[name="quantity"]') ||
          document.querySelector('[name="quantity"][form="' + form.id + '"]');
        var wrap = qty && (qty.closest(".product-form__quantity, quantity-input, .quantity") || qty.parentElement);
        if (wrap) wrap.classList.toggle("sb-hide", on);
      }
      syncLabel();
    }

    /** The theme's add-to-cart. Re-queried: themes re-render it on variant change. */
    function themeBtn() {
      return form && (form.querySelector('[name="add"], [type="submit"]') ||
        document.querySelector('[form="' + form.id + '"][name="add"], [form="' + form.id + '"][type="submit"]'));
    }

    /**
     * Relabel straight away when the variant is flagged as a service; either
     * way, ask the app in the background. The flag only makes the relabel
     * instant — services saved before it existed (or whose flag write failed)
     * are still found by the proxy, and a stale flag is backed out.
     */
    function start() {
      applyBookable(flagged.indexOf(String(state.variantId)) >= 0);
      loadMonth(null, false);
    }

    /**
     * The theme's add-to-cart reads "Select a time" for a bookable service and
     * its own label otherwise. Themes without a findable button get our own
     * trigger instead (`sb-own-btn`).
     */
    function syncLabel() {
      var btn = themeBtn();
      if (section) section.classList.toggle("sb-own-btn", !btn);
      triggerBtn.hidden = !!btn;
      if (!btn) return;
      var walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      var node = walker.nextNode();
      if (!node) return;
      var ours = root.dataset.label;
      // Remember the theme's own text (it may change with the variant, e.g. "Sold out").
      if (node.nodeValue.trim() !== ours) btn.__sbLabel = node.nodeValue;
      var want = state.bookable ? ours : btn.__sbLabel;
      if (want && node.nodeValue !== want && node.nodeValue.trim() !== want) node.nodeValue = want;
    }

    /** Drop this instance's page-level listeners and timer once it is gone. */
    var pollId = 0;
    function detach() {
      document.removeEventListener("submit", guard, true);
      document.removeEventListener("click", guard, true);
      if (pollId) pollId = clearInterval(pollId);
    }

    // For a bookable service the theme's add-to-cart opens our popup instead:
    // the booking (with its details) is added to the cart from there.
    function guard(event) {
      // A theme that re-renders the section leaves this root detached and a
      // fresh one in charge: these listeners and the poll below would
      // otherwise pile up, one set per re-render, for the whole visit.
      if (!root.isConnected) return detach();
      if (!form || !state.bookable) return;
      var target = event.target;
      var hit = event.type === "submit"
        ? target === form
        : target.closest &&
          target.closest('[type="submit"], [name="add"]') &&
          (form.contains(target) || target.closest('[form="' + form.id + '"]'));
      if (!hit) return;
      // A bookable variant must never go through the theme's form: that would
      // add the service to the cart with no appointment on it.
      event.preventDefault();
      event.stopImmediatePropagation();
      open();
    }
    document.addEventListener("submit", guard, true);
    document.addEventListener("click", guard, true);

    // ---------------------------------------------------------------------
    // Popup
    // ---------------------------------------------------------------------

    function open() {
      if (dialog && !dialog.open) dialog.showModal();
      showStep1();
      loadStep2(); // prefetch: picking a time should feel instant
      if (!state.month) {
        setStatus(t("Loading"));
        renderSkeleton();
        state.wantDay = true;
        // The page-load prefetch is usually still in flight: wait for it
        // rather than starting over (a new request would discard its answer).
        // Only when it failed or never ran, load now.
        if (!state.loading) loadMonth(null, true);
      } else {
        // Show the prefetched dates and times at once, then refresh them
        // quietly so the popup doesn't offer times taken since page load.
        if (!state.date && state.days.length) selectDate(state.days[0]);
        loadMonth(state.month, false);
      }
    }

    function close() {
      if (dialog) dialog.close();
    }

    triggerBtn.addEventListener("click", open);
    if (dialog) {
      $("[data-sb-close]").addEventListener("click", close);
      // A click on the backdrop lands on the <dialog> itself.
      dialog.addEventListener("click", function (e) {
        if (e.target === dialog) close();
      });
    }

    function showStep1() {
      step1El.hidden = false;
      detailsEl.hidden = true;
      addBtn.hidden = true;
      if (state.slots) setStatus(t("PickTime"));
    }

    /** Step 2: people, questions, signature, add-ons (booking-step2.js). */
    function showDetails(slot) {
      state.pick = slot;
      renderTimes();
      setStatus(t("Loading"));
      loadStep2().then(
        function () {
          if (state.pick !== slot || !shown()) return;
          setStatus("");
          step1El.hidden = true;
          detailsEl.hidden = false;
          addBtn.hidden = false;
          window.__sbStep2({
            root: root,
            state: state,
            el: el,
            t: t,
            api: api,
            fmt: fmt,
            formatTime: formatTime,
            setStatus: setStatus,
            detailsEl: detailsEl,
            addBtn: addBtn,
            upsells: $('template[data-sb-upsells][data-for="' + state.variantId + '"]'),
            back: showStep1,
            // The time filled while the customer was filling in step 2.
            taken: function () {
              state.pick = null;
              showStep1();
              loadMonth(state.month).then(function () {
                setStatus(t("Taken"), true);
              });
            },
          });
          detailsEl.scrollTop = 0;
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

    function monthDate(month) {
      var p = month.split("-");
      return new Date(Date.UTC(+p[0], +p[1] - 1, 1));
    }

    function shiftMonth(month, delta) {
      var d = monthDate(month);
      d.setUTCMonth(d.getUTCMonth() + delta);
      return d.toISOString().slice(0, 7);
    }

    function renderCalendar() {
      var first = monthDate(state.month);
      var utc = { timeZone: "UTC" };
      var navBtn = function (label, text, delta, off) {
        return el("button", {
          type: "button",
          class: "sb-cal__nav",
          "aria-label": label,
          text: text,
          disabled: off ? "" : false,
          onclick: function () {
            loadMonth(shiftMonth(state.month, delta), true);
          },
        });
      };
      var title = new Intl.DateTimeFormat(locale, Object.assign({ month: "long", year: "numeric" }, utc)).format(first);
      var grid = el("div", { class: "sb-cal__grid", role: "group", "aria-label": title });
      var dow = new Intl.DateTimeFormat(locale, Object.assign({ weekday: "short" }, utc));
      for (var i = 0; i < 7; i++) {
        // 2023-01-01 was a Sunday.
        grid.appendChild(el("span", {
          class: "sb-cal__dow",
          "aria-hidden": "true",
          text: dow.format(new Date(Date.UTC(2023, 0, 1 + ((i + weekStart) % 7)))),
        }));
      }
      for (var pad = (first.getUTCDay() - weekStart + 7) % 7; pad > 0; pad--) {
        grid.appendChild(el("span"));
      }
      var full = new Intl.DateTimeFormat(locale, Object.assign({ dateStyle: "full" }, utc));
      for (var d = new Date(first); d.getUTCMonth() === first.getUTCMonth(); d.setUTCDate(d.getUTCDate() + 1)) {
        var iso = d.toISOString().slice(0, 10);
        grid.appendChild(el("button", {
          type: "button",
          class: "sb-cal__day",
          text: String(d.getUTCDate()),
          "aria-label": full.format(d),
          "aria-pressed": String(state.date === iso),
          disabled: state.days.indexOf(iso) < 0 ? "" : false,
          onclick: selectDate.bind(null, iso),
        }));
      }
      calEl.textContent = "";
      calEl.appendChild(el("div", { class: "sb-cal__head" }, [
        navBtn(t("PreviousMonth"), "‹", -1, state.month <= state.firstMonth),
        el("strong", { "aria-live": "polite", text: title }),
        navBtn(t("NextMonth"), "›", 1, state.month >= state.lastMonth),
      ]));
      calEl.appendChild(grid);
      if (!state.days.length) calEl.appendChild(el("p", { class: "sb-muted", text: t("NoDates") }));
    }

    /** A greyed month grid so the popup has its size before the dates arrive. */
    function renderSkeleton() {
      if (calEl.firstChild) return;
      var utc = { timeZone: "UTC" };
      var dow = new Intl.DateTimeFormat(locale, Object.assign({ weekday: "short" }, utc));
      var grid = el("div", { class: "sb-cal__grid", "aria-hidden": "true" });
      for (var i = 0; i < 7; i++) {
        grid.appendChild(el("span", {
          class: "sb-cal__dow",
          text: dow.format(new Date(Date.UTC(2023, 0, 1 + ((i + weekStart) % 7)))),
        }));
      }
      for (var j = 0; j < 35; j++) {
        grid.appendChild(el("span", { class: "sb-cal__day sb-cal__day--skeleton" }));
      }
      calEl.appendChild(el("div", { class: "sb-cal__head", "aria-hidden": "true" }, [
        el("span", { class: "sb-cal__nav" }),
        el("span", { class: "sb-cal__title--skeleton" }),
        el("span", { class: "sb-cal__nav" }),
      ]));
      calEl.appendChild(grid);
    }

    function renderTimes() {
      timesEl.textContent = "";
      if (!state.date) return;
      var toggle = function (h24, label) {
        return el("button", {
          type: "button",
          "aria-pressed": String(state.h24 === h24),
          text: label,
          onclick: function () {
            state.h24 = h24;
            writeHourPref(h24);
            renderTimes();
          },
        });
      };
      timesEl.appendChild(el("div", { class: "sb-times__head" }, [
        el("strong", {
          text: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
            new Date(state.date + "T00:00:00Z"),
          ),
        }),
        el("div", { class: "sb-toggle", role: "group" }, [toggle(false, t("Hour12")), toggle(true, t("Hour24"))]),
      ]));
      if (!state.slots) {
        timesEl.appendChild(el("p", { class: "sb-muted", text: t("Loading") }));
        return;
      }
      if (!state.slots.length) {
        timesEl.appendChild(el("p", { class: "sb-muted", text: t("NoTimes") }));
        return;
      }
      var list = el("div", { class: "sb-times__list", role: "group" });
      state.slots.forEach(function (slot) {
        list.appendChild(el("button", {
          type: "button",
          class: "sb-time",
          "aria-pressed": String(!!state.pick && state.pick.start === slot.start),
          // Booked out: shown struck through (/availability sends them), never picked.
          disabled: slot.remaining > 0 ? false : "",
          onclick: function () {
            showDetails(slot);
          },
        }, [
          el("span", { text: formatTime(slot.start) }),
          slotLabel(slot),
        ]));
      });
      timesEl.appendChild(list);
    }

    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    /** `pickDay`: when the popup is open, auto-select the first open day. */
    function loadMonth(month, pickDay) {
      var seq = ++state.seq;
      var params = { variant: state.variantId };
      if (month) params.month = month;
      var done = function () {
        if (seq === state.seq) state.loading = null;
      };
      state.loading = api("/availability", params)
        .then(function (res) {
          if (seq !== state.seq) return;
          // Only the app's explicit "not a service" answer backs out. A tunnel
          // that's down, a 5xx or Shopify's HTML error page is a temporary
          // failure: keep the metafield-driven relabel and retry on open.
          if (res.data.bookable === false && (res.status === 404 || res.status === 200)) {
            applyBookable(false);
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
          applyBookable(true);
          $("[data-sb-zone]").textContent = t("Timezone", { zone: d.timezone });
          if (state.date && state.date.slice(0, 7) !== d.month) state.date = null;
          if ((pickDay || state.wantDay) && !state.date && d.days.length) state.date = d.days[0];
          state.wantDay = false;
          renderCalendar();
          if (state.date) return loadSlots();
          renderTimes();
          if (step1El.hidden === false) setStatus("");
        })
        .catch(function (status) {
          if (seq !== state.seq) return;
          console.warn("[service-booking] availability failed", status);
          if (shown()) setStatus(t("Error"), true);
        })
        .then(done, done);
      return state.loading;
    }

    function selectDate(date) {
      state.date = date;
      renderCalendar();
      loadSlots();
    }

    /** The chosen day's times come with the month (`/availability`): no request. */
    function loadSlots() {
      state.slots = state.byDay[state.date] || [];
      renderTimes();
      if (!step1El.hidden) setStatus(t("PickTime"));
    }

    // ---------------------------------------------------------------------
    // Variant changes — themes update the form's `id` input in different ways
    // (change events, custom events, silent assignment), so poll it as well.
    // ---------------------------------------------------------------------

    function checkVariant() {
      var input = form && (form.querySelector('[name="id"]') ||
        document.querySelector('[name="id"][form="' + form.id + '"]'));
      var id = input && input.value ? String(input.value) : state.variantId;
      if (id === state.variantId) return syncLabel();
      state.variantId = id;
      state.date = state.month = state.slots = state.pick = state.loading = null;
      state.wantDay = false;
      state.seq++;
      calEl.textContent = "";
      timesEl.textContent = "";
      if (dialog && dialog.open) close();
      setStatus("");
      start();
    }

    if (form) {
      form.addEventListener("change", checkVariant);
      pollId = setInterval(function () {
        if (!root.isConnected) return detach();
        checkVariant();
      }, 750);
    }

    // Let the page paint with the theme's original button first.
    requestAnimationFrame(function () {
      requestAnimationFrame(start);
    });
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

  function writeHourPref(h24) {
    try {
      localStorage.setItem(HOUR_PREF, h24 ? "24" : "12");
    } catch (e) {}
  }

  /** The add-to-cart form belonging to the same product section as the block. */
  function findProductForm(root) {
    var scope = root.closest(".shopify-section") || document;
    return scope.querySelector('form[action*="/cart/add"]') || document.querySelector('form[action*="/cart/add"]');
  }

  function boot() {
    document.querySelectorAll("[data-sb-booking]").forEach(init);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  // Theme editor: re-init when the merchant adds or moves the block.
  document.addEventListener("shopify:section:load", boot);

  // Many themes re-render the product section on variant change (Section
  // Rendering API) by swapping its HTML: scripts in it don't run again, so
  // set up any new booking roots — ours and booking-addon.js's — once per frame.
  var SB_ROOTS = "[data-sb-booking],[data-sb-addon]";
  function addsABookingRoot(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType === 1 && (n.matches(SB_ROOTS) || n.querySelector(SB_ROOTS))) return true;
    }
    return false;
  }
  var queued = false;
  new MutationObserver(function (records) {
    if (queued) return;
    // Only when a booking root was actually inserted. Testing the added nodes
    // is cheap; re-scanning the whole document every frame is not, and on a
    // page with its own moving parts (carousels, drawers, lazy sections) this
    // observer would otherwise run flat out for the whole visit.
    for (var i = 0; i < records.length; i++) {
      if (!addsABookingRoot(records[i].addedNodes)) continue;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        boot();
        if (window.__sbAddon) window.__sbAddon();
      });
      return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
