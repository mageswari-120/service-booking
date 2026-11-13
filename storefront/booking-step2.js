/*
 * SOURCE for extensions/booking-widget/assets/booking-step2.js — built by
 * `npm run build:widget`. Loaded on demand by booking.js (its own 10 KB budget).
 *
 * The booking popup's second step, shown after the customer picks a time:
 * the time range, how many people, the service's questions, an optional
 * signature, add-on products, and "Add to cart" — which holds the seats
 * (POST /apps/booking/hold, with the details) and then adds the booking and
 * any add-ons to the cart in one /cart/add.js call.
 *
 * Every rule here is re-checked by the hold endpoint (validateHoldDetails).
 *
 * Also used by booking-addon.js (the "On the page" add-on card) with:
 *   ctx.compact     — render only people / questions / signature (the card
 *                     shows its own summary; it has no add-ons or back button)
 *   ctx.addBtn      — may be null: the caller runs the returned submit()
 *   ctx.extraItems  — () => cart items added before the booking line (the
 *                     product the service is an add-on to)
 *   ctx.done        — after the cart add; default: go to /cart
 *   ctx.initial     — { seats, answers } to prefill with, from a card this one
 *                     replaced (the signature is never carried over)
 * Returns { submit, empty, seats, values } — `empty` when no fields were
 * rendered; `values()` reports what has been filled in so far.
 */
(function () {
  "use strict";

  /** Called by booking.js with its helpers; renders into ctx.detailsEl. */
  window.__sbStep2 = function (ctx) {
    var state = ctx.state;
    var el = ctx.el;
    var t = ctx.t;
    var slot = state.pick;
    // Party size: the service's min/max per booking. In people mode the slot's
    // free places cap it too; in bookings mode a booking takes one place.
    var min = Math.max(1, state.minSeats || 1);
    var limit = state.maxSeats || (state.mode === "bookings" ? min : Infinity);
    var max = state.mode === "bookings" ? limit : Math.min(limit, slot.remaining || 1);
    max = Math.max(min, max);
    var initial = ctx.initial || {};
    var filled = initial.answers || {};
    var seats = Math.min(max, Math.max(min, Number(initial.seats) || min));
    var fields = {}; // question id / "signature" -> { input, error }
    var pad = null;
    var busy = false;
    var lastHold = null; // a retry (e.g. the cart add failed) replaces this hold

    /** `control` is shown under the label; `input` (default: control) gets focus on error. */
    function field(id, label, help, control, input) {
      var error = el("p", { class: "sb-field__error", role: "alert" });
      fields[id] = { input: input || control, error: error };
      return el("div", { class: "sb-field" }, [
        label,
        help ? el("p", { class: "sb-muted", text: help }) : null,
        control,
        error,
      ]);
    }

    function labelFor(text, required, htmlFor) {
      var node = el("label", { class: "sb-field__label", for: htmlFor, text: text });
      if (required) node.appendChild(el("span", { class: "sb-req", "aria-hidden": "true", text: " *" }));
      return node;
    }

    function stepper(get, set, min, maxN, label) {
      var out = el("output", { "aria-live": "polite", text: String(get()) });
      function bump(d) {
        var n = Math.min(maxN, Math.max(min, get() + d));
        set(n);
        out.textContent = String(n);
        dec.disabled = n <= min;
        inc.disabled = n >= maxN;
      }
      var dec = el("button", { type: "button", "aria-label": "−", text: "−", onclick: function () { bump(-1); } });
      var inc = el("button", { type: "button", "aria-label": "+", text: "+", onclick: function () { bump(1); } });
      dec.disabled = get() <= min;
      inc.disabled = get() >= maxN;
      return el("div", { class: "sb-stepper", role: "group", "aria-label": label }, [dec, out, inc]);
    }

    // --- Summary -----------------------------------------------------------
    var end = new Date(new Date(slot.start).getTime() + state.duration * 60000).toISOString();
    var btn = ctx.addBtn;
    var parts = ctx.compact ? [] : [
      el("button", { type: "button", class: "sb-back", text: "‹ " + t("Back"), onclick: ctx.back }),
      el("p", { class: "sb-eyebrow", text: t("SelectedTime") }),
      el("div", { class: "sb-pick" }, [
        el("span", {
          text: t("FromTo", {
            date: ctx.fmt(slot.start, { dateStyle: "long" }),
            start: ctx.formatTime(slot.start),
            end: ctx.formatTime(end),
          }),
        }),
      ]),
    ];

    // --- People --------------------------------------------------------------
    if (max > 1) {
      var help = min === max
        ? t("PeopleHelpExact", { count: min })
        : min > 1
          ? t("PeopleHelpRange", { min: min, max: max })
          : t("PeopleHelp", { max: max });
      parts.push(field("seats", labelFor(t("People")), help,
        stepper(function () { return seats; }, function (n) { seats = n; }, min, max, t("People"))));
    }

    // --- Questions -----------------------------------------------------------
    state.questions.forEach(function (q) {
      var id = "sb-q-" + q.id;
      if (q.type === "checkbox") {
        var box = el("input", { type: "checkbox", id: id });
        box.checked = !!filled[q.id];
        var row = el("label", { class: "sb-check", for: id }, [box, el("span", { text: q.label })]);
        if (q.required) row.appendChild(el("span", { class: "sb-req", "aria-hidden": "true", text: " *" }));
        parts.push(field(q.id, row, q.help, null, box));
      } else {
        var text = el("input", { type: "text", id: id, maxlength: "500", autocomplete: "off" });
        if (filled[q.id]) text.value = filled[q.id];
        parts.push(field(q.id, labelFor(q.label, q.required, id), q.help, text));
      }
    });

    // --- Signature -----------------------------------------------------------
    if (state.signature) {
      var canvas = el("canvas", { class: "sb-sign__pad", "aria-label": t("Signature") });
      pad = signaturePad(canvas);
      parts.push(field("signature", labelFor(t("Signature"), true), t("SignatureHelp"),
        el("div", { class: "sb-sign" }, [
          canvas,
          el("button", { type: "button", class: "sb-sign__clear", text: t("ClearSignature"), onclick: function () { pad.clear(); } }),
        ]), canvas));
    }

    // --- Add-ons (rendered by the block in Liquid) ---------------------------
    var addons = [];
    var rows = ctx.upsells && !ctx.compact ? ctx.upsells.content.querySelectorAll("[data-id]") : [];
    if (rows.length) {
      var list = el("div", { class: "sb-upsells" });
      Array.prototype.forEach.call(rows, function (tpl) {
        var row = tpl.cloneNode(true);
        var item = { id: Number(row.dataset.id), qty: 1, on: false };
        var toggle = el("button", {
          type: "button",
          class: "sb-upsell__add",
          "aria-pressed": "false",
          text: t("Add"),
          onclick: function () {
            item.on = !item.on;
            toggle.setAttribute("aria-pressed", String(item.on));
            toggle.textContent = item.on ? t("Added") : t("Add");
          },
        });
        row.appendChild(el("div", { class: "sb-upsell__buy" }, [
          stepper(function () { return item.qty; }, function (n) { item.qty = n; }, 1, 10, row.dataset.title || ""),
          toggle,
        ]));
        addons.push(item);
        list.appendChild(row);
      });
      parts.push(el("p", { class: "sb-field__label", text: t("AddThese") }), list);
    }

    ctx.detailsEl.textContent = "";
    parts.forEach(function (p) {
      ctx.detailsEl.appendChild(p);
    });
    if (pad) pad.size();
    if (btn) {
      btn.disabled = false;
      btn.onclick = submit;
    }

    // --- Submit --------------------------------------------------------------
    function showError(id, text) {
      var f = fields[id];
      if (!f) return;
      f.error.textContent = text;
      if (f.input && f.input.focus) f.input.focus();
    }

    function collect() {
      var answers = {};
      var firstBad = null;
      Object.keys(fields).forEach(function (id) {
        fields[id].error.textContent = "";
      });
      state.questions.forEach(function (q) {
        var input = fields[q.id].input;
        var value = q.type === "checkbox" ? input.checked : input.value.trim();
        answers[q.id] = value;
        if (q.required && !value && !firstBad) firstBad = q.id;
      });
      if (!firstBad && pad && pad.empty()) firstBad = "signature";
      if (firstBad) {
        showError(firstBad, t("Required"));
        return null;
      }
      return answers;
    }

    function submit() {
      if (busy) return;
      var answers = collect();
      if (!answers) return;
      busy = true;
      if (btn) {
        btn.disabled = true;
        var label = btn.textContent;
        btn.textContent = t("Adding") || label;
      }
      ctx.setStatus("");
      return ctx.api("/hold", null, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variant: state.variantId,
          start: slot.start,
          seats: seats,
          answers: answers,
          signature: pad ? pad.png() : undefined,
          release: lastHold || undefined,
        }),
      })
        .then(function (res) {
          if (res.status === 409) return ctx.taken();
          if (res.status === 400 && res.data.error) {
            ctx.setStatus(res.data.error, true);
            showError(res.data.field, res.data.error);
            return;
          }
          if (res.status !== 200) throw 0;
          lastHold = res.data.token;
          return addToCart(res.data, answers);
        })
        .catch(function (message) {
          ctx.setStatus(typeof message === "string" ? message : t("Error"), true);
        })
        .then(function () {
          busy = false;
          if (btn) {
            btn.disabled = false;
            btn.textContent = label;
          }
        });
    }

    function addToCart(hold, answers) {
      var props = {
        Appointment: ctx.fmt(slot.start, {
          weekday: "short", day: "numeric", month: "short", year: "numeric",
          hour: "numeric", minute: "2-digit", timeZoneName: "short",
          hourCycle: state.h24 ? "h23" : "h12",
        }),
      };
      if (seats > 1) props[t("People")] = String(seats);
      state.questions.forEach(function (q) {
        var v = answers[q.id];
        if (v === true) props[q.label] = t("Yes");
        else if (v) props[q.label] = v;
      });
      props._booking_start = hold.start;
      props._booking_hold = hold.token;
      props._booking_seats = String(seats);

      var items = (ctx.extraItems ? ctx.extraItems() : []).concat([
        { id: Number(state.variantId), quantity: seats, properties: props },
      ]);
      addons.forEach(function (a) {
        if (a.on) items.push({ id: a.id, quantity: a.qty });
      });
      var base = (window.Shopify && Shopify.routes && Shopify.routes.root) || "/";
      return fetch(base + "cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ items: items }),
      }).then(function (res) {
        if (res.ok) {
          if (ctx.done) return ctx.done();
          window.location.href = base + "cart";
          return new Promise(function () {}); // keep the button disabled while leaving
        }
        // e.g. an add-on just sold out: Shopify explains in `description`.
        return res.json().then(
          function (d) {
            throw d.description || d.message || t("Error");
          },
          function () {
            throw t("Error");
          },
        );
      });
    }

    /** What the customer has entered so far; no validation, no side effects. */
    function values() {
      var answers = {};
      state.questions.forEach(function (q) {
        var input = fields[q.id] && fields[q.id].input;
        if (input) answers[q.id] = q.type === "checkbox" ? input.checked : input.value;
      });
      return { seats: seats, answers: answers };
    }

    return {
      submit: submit,
      empty: !parts.length,
      seats: function () { return seats; },
      values: values,
    };
  };

  /** A minimal pointer-events signature pad. */
  function signaturePad(canvas) {
    var g = canvas.getContext("2d");
    var drawn = false;
    var last = null;

    function point(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener("pointerdown", function (e) {
      canvas.setPointerCapture(e.pointerId);
      last = point(e);
      g.beginPath();
      g.arc(last.x, last.y, 0.8, 0, Math.PI * 2);
      g.fill();
      drawn = true;
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!last) return;
      var p = point(e);
      g.beginPath();
      g.moveTo(last.x, last.y);
      g.lineTo(p.x, p.y);
      g.stroke();
      last = p;
    });
    function up() {
      last = null;
    }
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    return {
      /** Match the backing store to the on-screen size (call once visible). */
      size: function () {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = canvas.clientHeight * dpr;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.lineWidth = 2;
        g.lineCap = g.lineJoin = "round";
        g.strokeStyle = g.fillStyle = "#111";
        drawn = false;
      },
      clear: function () {
        g.clearRect(0, 0, canvas.width, canvas.height);
        drawn = false;
      },
      empty: function () {
        return !drawn;
      },
      /** Exported at 1× (CSS pixels): a smaller upload on high-DPI screens. */
      png: function () {
        if (!drawn) return undefined;
        var w = canvas.clientWidth;
        var h = canvas.clientHeight;
        if (!w || !h || canvas.width === w) return canvas.toDataURL("image/png");
        var out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        out.getContext("2d").drawImage(canvas, 0, 0, w, h);
        return out.toDataURL("image/png");
      },
    };
  }
})();
