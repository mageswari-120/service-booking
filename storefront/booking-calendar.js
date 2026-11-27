/*
 * SOURCE for extensions/booking-widget/assets/booking-calendar.js — built by
 * `npm run build:widget`. App block script: must stay under 10 KB.
 *
 * Service Booking — "Booking calendar" block ([data-sb-cal]).
 *
 * "Book now" opens a full-size month view of every bookable service (or only
 * the current product's): one coloured chip per service per day, from
 * GET /apps/booking/calendar. A chip opens a card with that day's times;
 * "Continue to Book" hands the chosen time to booking-step2.js (people,
 * questions, signature → hold → cart), exactly like the product popup.
 *
 * The server re-checks everything; this file is UX, not the security boundary.
 */
(function () {
  "use strict";

  var COLORS = ["#4f5bd5", "#e0a526", "#2f9e77", "#d1495b", "#7b52c7", "#1f8fbf"];
  var step2Loading = null;
  var locale = document.documentElement.lang || undefined;
  var UTC = { timeZone: "UTC" };

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

  function monthDate(month) {
    var p = month.split("-");
    return new Date(Date.UTC(+p[0], +p[1] - 1, 1));
  }

  function shiftMonth(month, delta) {
    var d = monthDate(month);
    d.setUTCMonth(d.getUTCMonth() + delta);
    return d.toISOString().slice(0, 7);
  }

  function hour24() {
    try {
      var saved = localStorage.getItem("sb-hour-cycle");
      if (saved) return saved === "24";
    } catch (e) {}
    var c = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    return c === "h23" || c === "h24";
  }

  function init(root) {
    if (root.__sb) return;
    root.__sb = true;

    var $ = function (sel) {
      return root.querySelector(sel);
    };
    var dialog = $("[data-sb-dialog]");
    var monthEl = $("[data-sb-month]");
    var statusEl = $("[data-sb-status]");
    var popEl = $("[data-sb-pop]");
    var weekStart = Number(root.dataset.weekStart) || 0;
    var maxChips = Number(root.dataset.maxChips) || 3;
    var today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    var data = null; // the month on screen (a /calendar answer)
    var cache = {}; // "YYYY-MM" -> /calendar answer
    var inflight = {}; // "YYYY-MM" ("" = current month) -> pending request
    var current = null; // the current month, once the server has said which
    var seq = 0;
    var pop = null; // the open card: { day, entry, service, pick, state }

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
          function (d) {
            return { status: res.status, data: d };
          },
          function () {
            return { status: res.status, data: {} };
          },
        );
      });
    }

    // -----------------------------------------------------------------------
    // Month view
    // -----------------------------------------------------------------------

    /**
     * One month from /calendar (null: the current one), shared by everyone
     * asking for it at the same time: the page-load prefetch, the neighbour
     * prefetch and a click all wait on the same request. Resolves to null
     * when nothing can be booked.
     */
    function fetchMonth(month) {
      var key = month || "";
      if (inflight[key]) return inflight[key];
      var params = {};
      if (month) params.month = month;
      if (root.dataset.product) params.product = root.dataset.product;
      // Days in the visitor's timezone, like the times on them.
      if (viewerTz) params.tz = viewerTz;
      var done = function () {
        delete inflight[key];
      };
      inflight[key] = api("/calendar", params).then(function (res) {
        done();
        if (res.status === 404) return null;
        if (res.status !== 200) throw res.status;
        current = current || (!month && res.data.month);
        cache[res.data.month] = res.data;
        return res.data;
      }, function (e) {
        done();
        throw e;
      });
      return inflight[key];
    }

    /**
     * Show a month: at once from the cache when we have it (then refreshed
     * quietly — slots change), else a skeleton until it arrives. Afterwards
     * the months either side are prefetched so ‹ › is instant too.
     */
    function show(month) {
      var key = month || current;
      var hit = key && cache[key];
      var mine = ++seq;
      setStatus("");
      if (hit) {
        data = hit;
        render();
      } else {
        renderSkeleton(key);
      }
      return fetchMonth(key).then(
        function (d) {
          if (mine !== seq) return;
          if (!d) {
            monthEl.textContent = "";
            return setStatus(t("NoServices"));
          }
          if (!hit || JSON.stringify(d) !== JSON.stringify(hit)) {
            data = d;
            render();
          }
          [1, -1].forEach(function (delta) {
            var m = shiftMonth(d.month, delta);
            if (!cache[m] && m >= d.firstMonth && m <= d.lastMonth) fetchMonth(m).catch(function () {});
          });
        },
        function (status) {
          if (mine !== seq || hit) return;
          console.warn("[service-booking] calendar failed", status);
          monthEl.textContent = "";
          setStatus(t("Error"), true);
        },
      );
    }

    /** The month's shape, greyed, while its services load. */
    function renderSkeleton(month) {
      var grid = el("div", { class: "sb-bcal__grid", "aria-hidden": "true" });
      for (var i = 0; i < 7; i++) grid.appendChild(el("span", { class: "sb-bcal__dow", text: " " }));
      for (var j = 0; j < 35; j++) grid.appendChild(el("span", { class: "sb-bcal__cell sb-bcal__cell--skeleton" }));
      monthEl.textContent = "";
      monthEl.appendChild(el("div", { class: "sb-bcal__head", "aria-hidden": "true" }, [
        el("span", { class: "sb-bcal__nav" }),
        month
          ? el("strong", {
              text: new Intl.DateTimeFormat(locale, Object.assign({ month: "long", year: "numeric" }, UTC)).format(monthDate(month)),
            })
          : el("span", { class: "sb-bcal__title--skeleton" }),
        el("span", { class: "sb-bcal__nav" }),
      ]));
      monthEl.appendChild(grid);
    }

    function render() {
      var first = monthDate(data.month);
      var title = new Intl.DateTimeFormat(locale, Object.assign({ month: "long", year: "numeric" }, UTC)).format(first);
      var nav = function (label, text, delta, off) {
        return el("button", {
          type: "button",
          class: "sb-bcal__nav",
          "aria-label": label,
          text: text,
          disabled: off ? "" : false,
          onclick: function () {
            show(shiftMonth(data.month, delta));
          },
        });
      };
      var dow = new Intl.DateTimeFormat(locale, Object.assign({ weekday: "short" }, UTC));
      var grid = el("div", { class: "sb-bcal__grid", role: "group", "aria-label": title });
      for (var i = 0; i < 7; i++) {
        grid.appendChild(el("span", {
          class: "sb-bcal__dow",
          "aria-hidden": "true",
          text: dow.format(new Date(Date.UTC(2023, 0, 1 + ((i + weekStart) % 7)))),
        }));
      }
      var d = new Date(first);
      d.setUTCDate(1 - ((first.getUTCDay() - weekStart + 7) % 7));
      var any = false;
      // Whole weeks: from the week of the 1st to the week of the last day.
      do {
        for (var w = 0; w < 7; w++) {
          var cell = dayCell(d.toISOString().slice(0, 10), d.getUTCMonth() === first.getUTCMonth(), dow.format(d));
          if (cell.__has) any = true;
          grid.appendChild(cell);
          d.setUTCDate(d.getUTCDate() + 1);
        }
      } while (d.getUTCMonth() === first.getUTCMonth());

      monthEl.textContent = "";
      monthEl.appendChild(el("div", { class: "sb-bcal__head" }, [
        nav(t("PreviousMonth"), "‹", -1, data.month <= data.firstMonth),
        el("strong", { "aria-live": "polite", text: title }),
        nav(t("NextMonth"), "›", 1, data.month >= data.lastMonth),
      ]));
      monthEl.appendChild(grid);
      if (!any) setStatus(t("NoDates"));
    }

    function dayCell(iso, inMonth, weekday) {
      var entries = (inMonth && data.days[iso]) || [];
      var cell = el("div", {
        class: "sb-bcal__cell" + (inMonth ? "" : " is-out") + (entries.length ? "" : " is-empty"),
      }, [
        el("span", { class: "sb-bcal__wd", text: weekday }),
        el("span", { class: "sb-bcal__num" + (iso === today ? " is-today" : ""), text: iso.slice(8) }),
      ]);
      cell.__has = entries.length > 0;
      entries.forEach(function (entry, n) {
        var service = data.services[entry.s];
        var full = !entry.slots.some(function (s) {
          return s.remaining > 0;
        });
        cell.appendChild(el("button", {
          type: "button",
          class: "sb-bcal__chip" + (full ? " is-full" : "") + (n >= maxChips ? " is-extra" : ""),
          style: "--sb-c:" + COLORS[entry.s % COLORS.length],
          title: service.title + (full ? " — " + t("SoldOut") : ""),
          text: service.title,
          onclick: function () {
            openPop(iso, entry);
          },
        }));
      });
      if (entries.length > maxChips) {
        cell.appendChild(el("button", {
          type: "button",
          class: "sb-bcal__more",
          text: t("More", { count: entries.length - maxChips }),
          onclick: function (e) {
            cell.classList.add("is-open");
            e.currentTarget.remove();
          },
        }));
      }
      return cell;
    }

    // -----------------------------------------------------------------------
    // Time card
    // -----------------------------------------------------------------------

    function openPop(day, entry) {
      var service = data.services[entry.s];
      pop = {
        day: day,
        entry: entry,
        // What booking-step2.js reads.
        state: {
          variantId: service.variant,
          timezone: service.timezone,
          capacity: service.capacity || 1,
          mode: service.mode || "people",
          minSeats: service.minSeats || 1,
          maxSeats: service.maxSeats || null,
          duration: service.duration || 0,
          questions: service.questions || [],
          signature: !!service.signature,
          pick: null,
          h24: hour24(),
        },
      };
      popEl.style.setProperty("--sb-c", COLORS[entry.s % COLORS.length]);
      renderPop(service);
      popEl.hidden = false;
      loadStep2().catch(function () {}); // prefetch
    }

    function closePop() {
      pop = null;
      popEl.hidden = true;
      popEl.textContent = "";
    }

    /** The visitor's own timezone: every time is shown where they are. */
    var viewerTz = (function () {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
      } catch (e) {
        return null;
      }
    })();

    function fmt(iso, opts) {
      return new Intl.DateTimeFormat(locale, Object.assign({ timeZone: viewerTz || pop.state.timezone }, opts)).format(new Date(iso));
    }

    function formatTime(iso) {
      return fmt(iso, { hour: "numeric", minute: "2-digit", hourCycle: pop.state.h24 ? "h23" : "h12" });
    }

    function renderPop(service) {
      var state = pop.state;
      var date = new Intl.DateTimeFormat(locale, Object.assign({
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      }, UTC)).format(new Date(pop.day + "T00:00:00Z"));
      var times = el("div", { class: "sb-bcal__times", role: "group" });
      pop.entry.slots.forEach(function (slot) {
        times.appendChild(el("button", {
          type: "button",
          class: "sb-bcal__time",
          "aria-pressed": String(!!state.pick && state.pick.start === slot.start),
          disabled: slot.remaining > 0 ? false : "",
          text: formatTime(slot.start),
          onclick: function () {
            state.pick = slot;
            renderPop(service);
          },
        }));
      });
      var go = el("button", { type: "button", class: "sb-add sb-bcal__go", text: t("Continue") });
      go.disabled = !state.pick;
      go.onclick = function () {
        showDetails(service, go, details, pick);
      };
      var details = el("div", { class: "sb-details sb-bcal__details", hidden: "" });
      var pick = el("div", { class: "sb-bcal__pick" }, [
        el("p", { class: "sb-eyebrow", text: t("SelectTime") }),
        times,
      ]);
      popEl.textContent = "";
      popEl.appendChild(el("div", { class: "sb-bcal__card", role: "dialog", "aria-modal": "true", "aria-label": service.title }, [
        el("span", { class: "sb-bcal__bar", "aria-hidden": "true" }),
        el("h3", { class: "sb-bcal__title", text: service.title }),
        el("p", { class: "sb-muted sb-bcal__date", text: date + " (" + (viewerTz || service.timezone) + ")" }),
        service.duration ? el("p", { class: "sb-bcal__meta", text: t("Minutes", { count: service.duration }) }) : null,
        pick,
        details,
        el("p", { class: "sb-modal__status", role: "status", "aria-live": "polite", "data-sb-pop-status": "" }),
        el("div", { class: "sb-bcal__actions" }, [
          go,
          el("button", { type: "button", class: "sb-bcal__close", text: t("Close"), onclick: closePop }),
        ]),
      ]));
    }

    function popStatus(text, isError) {
      var s = popEl.querySelector("[data-sb-pop-status]");
      if (!s) return;
      s.textContent = text || "";
      s.classList.toggle("sb-error", !!isError);
    }

    /** booking-step2.js: people, questions, signature → hold → cart. */
    function showDetails(service, go, details, pick) {
      var mine = pop;
      if (!mine.state.pick) return;
      go.disabled = true;
      popStatus(t("Loading"));
      loadStep2().then(
        function () {
          if (pop !== mine) return;
          popStatus("");
          var step = window.__sbStep2({
            root: root,
            state: mine.state,
            el: el,
            t: t,
            api: api,
            fmt: fmt,
            formatTime: formatTime,
            setStatus: popStatus,
            detailsEl: details,
            addBtn: go,
            upsells: null,
            back: function () {
              renderPop(service);
            },
            taken: function () {
              closePop();
              delete cache[data.month];
              show(data.month).then(function () {
                setStatus(t("Taken"), true);
              });
            },
          });
          // Nothing to ask (no questions, fixed party size): book straight away.
          if (step.empty) return step.submit();
          pick.hidden = true;
          details.hidden = false;
          go.textContent = t("AddToCart");
        },
        function () {
          go.disabled = false;
          popStatus(t("Error"), true);
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
            step2Loading = null;
            reject();
          };
          document.head.appendChild(s);
        });
      }
      return step2Loading;
    }

    // -----------------------------------------------------------------------
    // Dialog
    // -----------------------------------------------------------------------

    function open() {
      if (!dialog.open) dialog.showModal();
      closePop();
      show(data && data.month);
    }

    // Fetch this month while the customer reads the page: by the time they
    // click "Book now" it is usually already here.
    (window.requestIdleCallback || function (fn) {
      return setTimeout(fn, 1500);
    })(function () {
      fetchMonth(null).catch(function () {});
    });

    $("[data-sb-open]").addEventListener("click", open);
    $("[data-sb-close]").addEventListener("click", function () {
      dialog.close();
    });
    dialog.addEventListener("click", function (e) {
      if (e.target === dialog) dialog.close();
      else if (e.target === popEl) closePop();
    });
    // Esc closes the time card first, then the calendar.
    dialog.addEventListener("cancel", function (e) {
      if (!popEl.hidden) {
        e.preventDefault();
        closePop();
      }
    });
  }

  function boot() {
    document.querySelectorAll("[data-sb-cal]").forEach(init);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  document.addEventListener("shopify:section:load", boot);
})();
