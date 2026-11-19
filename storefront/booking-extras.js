/*
 * Bundled into extensions/booking-widget/assets/booking-step2.js (imported
 * by storefront/booking-step2.js; `npm run build:widget`), which booking.js
 * loads on demand — at once when the service has services to add.
 *
 *   window.__sbServices(ctx) — the popup's first step: a card per active
 *     service of the shop (image, title, duration · price from /services),
 *     the one being booked checked; calendar and times hidden meanwhile.
 *     Tapping a card goes on to the calendar, with a summary row and
 *     "Change" above it; another service's card calls change(), which loads
 *     that service instead. Every open starts on the cards. Run by booking.js
 *     after every month load. ctx: { root, state, el, t, api, setStatus,
 *     change(variantId) }.
 *
 *   window.__sbRemoteUpsells(ctx, add) — add-on rows for a service from
 *     another product (no Liquid template for it), from /upsells.
 *
 *   window.__sbStaff(ctx) — "Choose staff" for step 2 (booking-step2.js).
 *     Returns null when the service has no staff step; otherwise
 *     { node, value(), check(message) }: value() is a staff id, "any", or
 *     null (nothing picked yet). Only staff free at the picked time are shown.
 *
 * The hold endpoint re-checks everything.
 */
(function () {
  "use strict";

  /** The /services card data (prices, images), fetched once per page. */
  var cardData = null;

  /** "₹850" in the shop's currency; "Free" for 0; "" when unknown. */
  function money(t, cents, currency) {
    if (cents == null) return "";
    if (!cents) return t("Free") || "Free";
    try {
      return new Intl.NumberFormat(document.documentElement.lang || undefined, {
        style: "currency",
        currency: currency,
      }).format(cents / 100);
    } catch (e) {
      return (cents / 100).toFixed(2);
    }
  }

  window.__sbServices = function (ctx) {
    var state = ctx.state;
    var root = ctx.root;
    var box = root.querySelector("[data-sb-services]");
    if (!box) return;
    var services = state.services || [];
    box.hidden = services.length < 2;

    // The heading names the product; on another product's service, name
    // that service instead (back to the product title on its own variant).
    var heading = root.querySelector("[data-sb-title]");
    if (heading) {
      if (heading.__sbTitle == null) heading.__sbTitle = heading.textContent;
      var current = services.filter(function (s) { return s.variantId === state.variantId; })[0];
      heading.textContent = state.variantId === state.formId || !current ? heading.__sbTitle : current.title;
    }

    if (!box.__sbInit) {
      box.__sbInit = true;
      // Every open starts on the cards.
      box.__sbStep = "pick";
      var dialog = root.querySelector("[data-sb-dialog]");
      if (dialog) {
        dialog.addEventListener("close", function () {
          box.__sbStep = "pick";
          draw(ctx, box);
        });
      }
      if (!cardData) {
        cardData = ctx.api("/services").then(
          function (res) { return res.status === 200 ? res.data : null; },
          function () { return null; },
        );
      }
      cardData.then(function (data) {
        box.__sbData = data;
        draw(ctx, box);
      });
    }
    draw(ctx, box);
  };

  /**
   * Step "pick": the service cards, calendar and times hidden. Step
   * "chosen": a one-line summary with "Change", above the calendar.
   */
  function draw(ctx, box) {
    var state = ctx.state;
    var el = ctx.el;
    var t = ctx.t;
    var data = box.__sbData;
    var info = {};
    (data && data.services || []).forEach(function (s) {
      info[s.variantId] = s;
    });
    // Only services the storefront can sell: a product that isn't on the
    // Online Store fails at the cart ("Cannot find variant"). The one being
    // booked always stays (it's this page's product, or was offered before).
    // A late /services answer only drops unsellable cards: it never leaves
    // the card step by itself (only a tap does). If the filter would leave
    // a single card, show them all — the cart reports a truly unsellable one.
    var all = state.services || [];
    var services = all.filter(function (s) {
      return s.variantId === state.variantId || (info[s.variantId] || {}).available !== false;
    });
    if (services.length < 2) services = all;
    var step1 = ctx.root.querySelector("[data-sb-step1]");
    var picking = !box.hidden && box.__sbStep === "pick";
    if (step1) step1.classList.toggle("sb-step-service", picking);
    if (box.hidden) return;
    // The subtitle already says it: no footer text on the card step.
    if (picking) ctx.setStatus("");
    // Redrawn only when something shown changes: a redraw on every month
    // load would move focus away from the card the customer just picked.
    var people = state.staffMode && state.staffMode !== "NONE" ? state.staff || [] : [];
    var key = [
      box.__sbStep, state.variantId, !!data, state.only,
      services.map(function (s) { return s.variantId; }),
      people.map(function (p) { return p.id; }),
    ].join("|");
    if (box.__sbKey === key) return;
    box.__sbKey = key;
    box.textContent = "";

    function thumb(s) {
      var image = (info[s.variantId] || {}).image;
      if (image) return el("img", { class: "sb-card__thumb", src: image, alt: "", loading: "lazy" });
      var words = s.title.split(/[\s\-—–()[\]/,.]+/).filter(Boolean);
      var initials = ((words[0] || "")[0] || "") + ((words[1] || "")[0] || "");
      var hue = 0;
      for (var i = 0; i < s.variantId.length; i++) hue = (hue * 31 + s.variantId.charCodeAt(i)) % 360;
      return el("span", {
        class: "sb-card__thumb sb-card__initials",
        "aria-hidden": "true",
        style: "background:hsl(" + hue + " 55% 90%)",
        text: initials.toUpperCase(),
      });
    }

    function body(s) {
      var price = money(t, (info[s.variantId] || {}).price, data && data.currency);
      return el("span", { class: "sb-card__body" }, [
        el("span", { class: "sb-card__title", text: s.title }),
        el("span", { class: "sb-card__meta" }, [
          el("strong", { text: t("Minutes", { count: s.duration }) || s.duration + " min" }),
          price ? el("span", { text: " · " + price }) : null,
        ]),
      ]);
    }

    if (!picking) {
      var chosen = services.filter(function (s) { return s.variantId === state.variantId; })[0];
      if (!chosen) return;
      box.appendChild(el("div", { class: "sb-chosen" }, [
        thumb(chosen),
        body(chosen),
        el("button", {
          type: "button",
          class: "sb-chosen__change",
          text: t("Change") || "Change",
          onclick: function () {
            box.__sbStep = "pick";
            draw(ctx, box);
          },
        }),
      ]));
      // Staff first: pick who, then the calendar shows only their times.
      if (people.length > 1) {
        var row = el("div", { class: "sb-staff sb-staff--first", role: "radiogroup", "aria-label": t("ChooseStaff") || "Choose staff" });
        [{ id: "", name: t("AnyStaff") || "Any available" }].concat(people).forEach(function (p) {
          row.appendChild(el("button", {
            type: "button",
            role: "radio",
            "aria-checked": String((state.only || "") === p.id),
            text: p.name,
            onclick: function () {
              if ((state.only || "") === p.id) return;
              state.only = p.id || null;
              // Reload this service's month for that person.
              ctx.change(state.variantId);
            },
          }));
        });
        box.appendChild(el("p", { class: "sb-field__label", text: t("ChooseStaff") || "Choose staff" }));
        box.appendChild(row);
      }
      return;
    }

    var grid = el("div", { class: "sb-cards", role: "radiogroup", "aria-label": t("ChooseService") || "Service" });
    services.forEach(function (s) {
      grid.appendChild(el("button", {
        type: "button",
        class: "sb-card",
        role: "radio",
        "aria-checked": String(s.variantId === state.variantId),
        onclick: function () {
          box.__sbStep = "chosen";
          // Another service: booking.js reloads its month (and calls
          // __sbServices again); the summary shows meanwhile.
          if (s.variantId !== state.variantId) {
            state.only = null; // staff differ per service
            ctx.change(s.variantId);
          }
          draw(ctx, box);
        },
      }, [thumb(s), body(s)]));
    });
    box.appendChild(el("p", { class: "sb-field__label", text: t("ChooseService") || "Service" }));
    var help = t("ChooseServiceHelp");
    if (help) box.appendChild(el("p", { class: "sb-muted", text: help }));
    box.appendChild(grid);
  }

  /**
   * Add-on rows for a service the theme block didn't render in Liquid (one
   * sold on another product): fetched from /upsells, built with the same
   * markup as the Liquid rows, then handed to `add(rows)`.
   */
  window.__sbRemoteUpsells = function (ctx, add) {
    var el = ctx.el;
    var variant = ctx.state.variantId;
    ctx.api("/upsells", { variant: variant }).then(function (res) {
      var items = (res.status === 200 && res.data.items) || [];
      if (!items.length || ctx.state.variantId !== variant) return;
      add(items.map(function (u) {
        return el("div", { class: "sb-upsell", "data-id": u.id, "data-price": u.price, "data-title": u.title }, [
          u.image ? el("img", { class: "sb-upsell__img", src: u.image, alt: "", loading: "lazy" }) : null,
          el("div", { class: "sb-upsell__info" }, [
            el("span", { class: "sb-upsell__title", text: u.title }),
            u.variantTitle ? el("small", { text: u.variantTitle }) : null,
          ]),
          el("span", { class: "sb-upsell__price", text: money(ctx.t, u.price, res.data.currency) }),
        ]);
      }));
    }, function () {});
  };

  window.__sbStaff = function (ctx) {
    var state = ctx.state;
    var el = ctx.el;
    var t = ctx.t;
    if (!state.staffMode || state.staffMode === "NONE" || !state.staff || !state.staff.length) return null;

    // Everyone is listed; those busy or off at the picked time are greyed.
    var free = state.pick && state.pick.staff;
    var isFree = function (id) {
      return !free || free.indexOf(id) >= 0;
    };
    // Chosen before the calendar ("staff first"): the times were that
    // person's, so they're the one shown here (change it above the calendar).
    var chosen = state.only && state.staff.filter(function (p) { return p.id === state.only; });
    var people = chosen && chosen.length ? chosen : state.staff;
    var open = people.filter(function (p) {
      return isFree(p.id);
    });
    var optional = state.staffMode === "OPTIONAL";
    // The "staff first" choice carries over. Otherwise: nothing to choose
    // between, preselect; required with several, the customer must pick.
    var pick = state.only && isFree(state.only)
      ? state.only
      : optional ? "any" : open.length === 1 ? open[0].id : null;
    var error = el("p", { class: "sb-field__error", role: "alert" });
    var group = el("div", { class: "sb-staff", role: "radiogroup", "aria-label": t("ChooseStaff") || "Choose staff" });
    var buttons = [];

    function option(id, label, busy) {
      var b = el("button", {
        type: "button",
        role: "radio",
        "aria-checked": String(pick === id),
        disabled: busy ? "" : false,
        title: busy ? t("Unavailable") || "Unavailable" : null,
        text: label,
        onclick: function () {
          pick = id;
          error.textContent = "";
          buttons.forEach(function (x) {
            x.setAttribute("aria-checked", String(x.__sbId === pick));
          });
        },
      });
      if (busy) b.appendChild(el("small", { text: t("Unavailable") || "Unavailable" }));
      b.__sbId = id;
      buttons.push(b);
      group.appendChild(b);
    }

    if (optional && people === state.staff) option("any", t("AnyStaff") || "Any available");
    people.forEach(function (p) {
      option(p.id, p.name, !isFree(p.id));
    });

    return {
      node: el("div", { class: "sb-field" }, [
        el("p", { class: "sb-field__label", text: t("ChooseStaff") || "Choose staff" }),
        group,
        error,
      ]),
      value: function () {
        return pick;
      },
      /** False (and shows `message`) when nobody is picked yet. */
      check: function (message) {
        error.textContent = pick ? "" : message;
        var first = buttons.filter(function (x) { return !x.disabled; })[0];
        if (!pick && first) first.focus();
        return !!pick;
      },
    };
  };
})();
