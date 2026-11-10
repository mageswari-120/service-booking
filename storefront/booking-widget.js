/*
 * SOURCE for extensions/booking-widget/assets/booking.js — edit this file, not
 * the asset. `npm run build:widget` (also run by `npm run dev` and `deploy`)
 * minifies it there: app block scripts must stay under 10 KB.
 *
 * Service Booking — "Select a time" button + popup.
 *
 * Flow: ask the app proxy whether the selected variant is a bookable service →
 * if so, hide the theme's buy buttons and show our button → popup with a month
 * calendar and the chosen day's times → clicking a time reserves it (a short
 * hold) → "Book now" adds the line with the booking as line item properties
 * and goes straight to checkout.
 *
 * The order webhook re-checks everything server-side; this file is UX, not the
 * security boundary.
 */
(function () {
  "use strict";

  var HOUR_PREF = "sb-hour-cycle";

  function init(root) {
    if (root.__sb) return;
    root.__sb = true;

    var $ = function (sel) {
      return root.querySelector(sel);
    };
    var proxy = root.dataset.proxy;
    var weekStart = Number(root.dataset.weekStart) || 0;
    var dialog = $("[data-sb-dialog]");
    var calEl = $("[data-sb-calendar]");
    var timesEl = $("[data-sb-times]");
    var statusEl = $("[data-sb-status]");
    var bookBtn = $("[data-sb-book]");
    var summaryEl = $("[data-sb-summary]");
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
      date: null,
      slots: null,
      capacity: 1,
      hold: null, // { token, start, expiresAt }
      busy: false,
      seq: 0,
      h24: readHourPref(),
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

    // ---------------------------------------------------------------------
    // Theme integration
    // ---------------------------------------------------------------------

    /** Show our button and hide the theme's buy controls, or undo both. */
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
    }

    // Fallback for themes whose buy buttons the CSS doesn't catch: a click on
    // the theme's add-to-cart opens our popup instead.
    function guard(event) {
      if (!form || !state.bookable) return;
      var target = event.target;
      var hit = event.type === "submit"
        ? target === form
        : target.closest &&
          target.closest('[type="submit"], [name="add"]') &&
          (form.contains(target) || target.closest('[form="' + form.id + '"]'));
      if (!hit) return;
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
      if (!dialog.open) dialog.showModal();
      if (!state.month) loadMonth(null, true);
    }

    function close() {
      dialog.close();
    }

    $("[data-sb-open]").addEventListener("click", open);
    $("[data-sb-close]").addEventListener("click", close);
    // A click on the backdrop lands on the <dialog> itself.
    dialog.addEventListener("click", function (e) {
      if (e.target === dialog) close();
    });
    bookBtn.addEventListener("click", book);

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
            renderSummary();
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
          "aria-pressed": String(!!state.hold && state.hold.start === slot.start),
          onclick: function (e) {
            hold(slot.start, e.currentTarget);
          },
        }, [
          el("span", { text: formatTime(slot.start) }),
          state.capacity > 1
            ? el("small", { text: t("Available", { count: slot.remaining, total: state.capacity }) })
            : null,
        ]));
      });
      timesEl.appendChild(list);
    }

    function renderSummary() {
      var h = state.hold;
      var text = h ? fmt(h.start, { weekday: "short", month: "short", day: "numeric" }) + " · " + formatTime(h.start) : "";
      summaryEl.textContent = text;
      bookBtn.disabled = !h;
      if (h) setStatus(text + " — " + t("Held", { time: formatTime(h.expiresAt) }));
    }

    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    /** `pickDay`: when the popup is open, auto-select the first open day. */
    function loadMonth(month, pickDay) {
      var seq = ++state.seq;
      var params = { variant: state.variantId };
      if (month) params.month = month;
      return api("/availability", params)
        .then(function (res) {
          if (seq !== state.seq) return;
          if (res.status === 404 || !res.data.bookable) {
            applyBookable(false);
            return;
          }
          if (res.status !== 200) throw 0;
          var d = res.data;
          state.timezone = d.timezone;
          state.month = d.month;
          state.firstMonth = d.firstMonth;
          state.lastMonth = d.lastMonth;
          state.days = d.days;
          applyBookable(true);
          $("[data-sb-zone]").textContent = t("Timezone", { zone: d.timezone });
          if (state.date && state.date.slice(0, 7) !== d.month) state.date = null;
          if (pickDay && !state.date && d.days.length) state.date = d.days[0];
          renderCalendar();
          if (state.date) return loadSlots();
          renderTimes();
        })
        .catch(function () {
          if (seq === state.seq) setStatus(t("Error"), true);
        });
    }

    function selectDate(date) {
      state.date = date;
      renderCalendar();
      loadSlots();
    }

    function loadSlots() {
      var date = state.date;
      state.slots = null;
      renderTimes();
      return api("/slots", { variant: state.variantId, date: date })
        .then(function (res) {
          if (state.date !== date) return;
          if (res.status !== 200) throw 0;
          state.slots = res.data.slots;
          state.capacity = res.data.capacity || 1;
          renderTimes();
          if (!state.hold) setStatus(t("PickTime"));
        })
        .catch(function () {
          setStatus(t("Error"), true);
        });
    }

    function hold(start, button) {
      if (state.busy) return;
      state.busy = true;
      button.disabled = true;
      api("/hold", null, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: state.variantId, start: start, release: state.hold && state.hold.token }),
      })
        .then(function (res) {
          if (res.status === 409) {
            state.hold = null;
            renderSummary();
            // Reload so the taken time disappears, then explain why.
            return loadMonth(state.month).then(function () {
              setStatus(t("Taken"), true);
            });
          }
          if (res.status !== 200) throw 0;
          state.hold = res.data;
          renderTimes();
          renderSummary();
        })
        .catch(function () {
          setStatus(t("Error"), true);
        })
        .then(function () {
          state.busy = false;
          button.disabled = false;
        });
    }

    function book() {
      var h = state.hold;
      if (!h || state.busy) return;
      state.busy = true;
      bookBtn.disabled = true;
      var root_ = (window.Shopify && Shopify.routes && Shopify.routes.root) || "/";
      fetch(root_ + "cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          items: [{
            id: Number(state.variantId),
            quantity: 1,
            properties: {
              Appointment: fmt(h.start, {
                weekday: "short", day: "numeric", month: "short", year: "numeric",
                hour: "numeric", minute: "2-digit", timeZoneName: "short",
                hourCycle: state.h24 ? "h23" : "h12",
              }),
              _booking_start: h.start,
              _booking_hold: h.token,
            },
          }],
        }),
      })
        .then(function (res) {
          if (!res.ok) throw 0;
          window.location.href = root_ + "checkout";
        })
        .catch(function () {
          state.busy = false;
          bookBtn.disabled = false;
          setStatus(t("Error"), true);
        });
    }

    // ---------------------------------------------------------------------
    // Variant changes — themes update the form's `id` input in different ways
    // (change events, custom events, silent assignment), so poll it as well.
    // ---------------------------------------------------------------------

    function checkVariant() {
      var input = form && (form.querySelector('[name="id"]') ||
        document.querySelector('[name="id"][form="' + form.id + '"]'));
      var id = input && input.value ? String(input.value) : state.variantId;
      if (id === state.variantId) return;
      state.variantId = id;
      state.date = state.month = state.slots = state.hold = null;
      if (dialog.open) close();
      renderSummary();
      setStatus("");
      loadMonth(null, false);
    }

    if (form) {
      form.addEventListener("change", checkVariant);
      setInterval(checkVariant, 750);
    }

    loadMonth(null, false);
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
})();
