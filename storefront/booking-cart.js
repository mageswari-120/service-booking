/*
 * SOURCE for extensions/booking-widget/assets/booking-cart.js — built by
 * `npm run build:widget`. App embed script: must stay under 10 KB.
 *
 * "Booking cart details" app embed. In the theme's cart drawer and cart page,
 * a booking line's details (Appointment date / time / Duration / …) are shown
 * as a card, with "Qty 1 · one slot held for 15 min" under it and a "Your slot
 * is reserved while you check out." note under the line items.
 *
 * Works without knowing the theme's markup. Booking lines come from /cart.js
 * (items with `_booking_start`); each is found in the page by either
 *   1. the theme's own property rows: the smallest element whose text holds
 *      every visible property value of the line — hidden, the card replaces
 *      them; or, for themes that don't print properties,
 *   2. the line's product link (a[href*="variant=<id>"]) inside a cart: the
 *      card goes under the title and variant text.
 * A MutationObserver re-applies it whenever the theme re-renders its cart.
 */
(function () {
  "use strict";

  var cfg = document.querySelector("[data-sb-cart]");
  if (!cfg) return;
  var base = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  var showHold = cfg.dataset.showHold !== "false";
  var showReserved = cfg.dataset.showReserved !== "false";
  var CART = '[id*="cart" i],[class*="cart" i],cart-drawer,cart-items,form[action*="/cart"]';
  var LINE = 'li,tr,[class*="cart-item" i],[class*="line-item" i],[class*="cart__item" i],[class*="cartitem" i]';
  var OURS = "[data-sb-card],[data-sb-addon],[data-sb-booking],[data-sb-cal],script,template";
  var bookings = []; // [{ key, variant, qty, props: [[name, value]], expires }]
  var lastFetch = 0;
  var fetching = null;
  var lastLog = "";

  function t(key, vars) {
    var text = cfg.dataset["i18n" + key] || "";
    Object.keys(vars || {}).forEach(function (k) {
      text = text.replace("__" + k.toUpperCase() + "__", vars[k]);
    });
    return text;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    node.setAttribute("data-sb-card", "");
    return node;
  }

  /** The booking lines of a cart (/cart.js, or the page's inline copy). */
  function setCart(cart) {
    bookings = ((cart && cart.items) || [])
      .filter(function (item) {
        return item.properties && item.properties._booking_start;
      })
      .map(function (item) {
        var props = Object.keys(item.properties)
          .filter(function (k) {
            var v = item.properties[k];
            return k.charAt(0) !== "_" && v != null && String(v).trim() !== "";
          })
          .map(function (k) {
            return [k, String(item.properties[k])];
          });
        return {
          key: item.key,
          variant: String(item.variant_id),
          qty: item.quantity,
          props: props,
          expires: item.properties._booking_expires,
          forVariant: item.properties._booking_for,
          handle: item.handle,
          variantTitle: item.variant_title,
          title: item.product_title || item.title,
        };
      });
  }

  function load() {
    if (fetching) return fetching;
    lastFetch = Date.now();
    fetching = fetch(base + "cart.js", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) {
        return res.json();
      })
      .then(setCart)
      .catch(function () {})
      .then(function () {
        fetching = null;
        apply();
      });
    return fetching;
  }

  // ---------------------------------------------------------------------
  // Finding a booking line in the theme's markup
  // ---------------------------------------------------------------------

  function hasAll(node, b) {
    var text = node.textContent;
    return b.props.every(function (p) {
      return text.indexOf(p[1]) >= 0;
    });
  }

  /** 1. The theme's printed property rows for one booking line. */
  function findBlocks(b) {
    if (!b.props.length) return [];
    var first = b.props[0][1];
    var found = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeValue.indexOf(first) < 0) return NodeFilter.FILTER_SKIP;
        var p = n.parentElement;
        return !p || p.closest(OURS + ",style,noscript") ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var node = n.parentElement;
      for (var up = 0; node && node !== document.body && up < 7; up++) {
        if (hasAll(node, b)) {
          if (found.indexOf(node) < 0) found.push(node);
          break;
        }
        node = node.parentElement;
      }
    }
    // A block nested in another match is the same line: keep the innermost.
    return found.filter(function (a) {
      return !found.some(function (o) {
        return o !== a && a.contains(o);
      });
    });
  }

  var QTY = 'input[type="number"],input[name^="updates"],input[name="quantity"],[name*="quantity" i]';
  var STOP = 'form,dialog,cart-drawer,cart-items,main,body,[name="checkout"],[href*="/checkout"]';

  function productPath(a) {
    return (a.pathname || "").replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/products\/)/i, "");
  }

  /**
   * The cart line holding `node`: the closest LINE element, else the largest
   * ancestor that still holds a single product (one product path, at most one
   * quantity box) — themes name their rows anything. Null outside a cart.
   */
  function lineFor(node) {
    if (node.closest(OURS) || !node.closest(CART)) return null;
    var line = node.closest(LINE);
    if (line && single(line)) return line;
    line = node;
    for (var up = 0; up < 10; up++) {
      var p = line.parentElement;
      if (!p || p.matches(STOP) || !single(p)) break;
      line = p;
    }
    return line === node ? null : line;
  }

  function single(elm) {
    if (elm.querySelector('[name="checkout"],[href*="/checkout"]')) return false;
    var paths = {};
    elm.querySelectorAll('a[href*="/products/"]').forEach(function (a) {
      paths[productPath(a)] = 1;
    });
    return Object.keys(paths).length <= 1 && elm.querySelectorAll(QTY).length <= 1;
  }

  /** The line's product title: a product link with text, else a heading. */
  function titleIn(line, name) {
    var links = line.querySelectorAll('a[href*="/products/"]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].textContent.trim() && !links[i].closest(OURS)) return links[i];
    }
    var heads = line.querySelectorAll('h2,h3,h4,h5,[class*="title" i],[class*="name" i]');
    for (var j = 0; j < heads.length; j++) {
      if (heads[j].textContent.trim() && !heads[j].closest(OURS)) return heads[j];
    }
    var all = line.querySelectorAll("*");
    for (var k = 0; k < all.length; k++) {
      if (name && all[k].textContent.trim() === name) return all[k];
    }
    return null;
  }

  /** [{ line, title }] for the elements' lines, de-duplicated, page order. */
  function entries(nodes, name) {
    var out = [];
    nodes.forEach(function (node) {
      var line = lineFor(node);
      if (!line || out.some(function (e) { return e.line === line || e.line.contains(line) || line.contains(e.line); })) return;
      var title = titleIn(line, name);
      if (title) out.push({ line: line, title: title });
    });
    return out;
  }

  function all(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }

  /** Cart lines linking to a variant (?variant=<id>), page order. */
  function findLines(variant, name) {
    var re = new RegExp("variant=" + variant + "(\\D|$)");
    return entries(all('a[href*="variant=' + variant + '"]').filter(function (a) {
      return re.test(a.getAttribute("href"));
    }), name);
  }

  /**
   * 2. A booking's lines when the theme prints no properties, first method
   * that finds any: its line key (remove links, quantity inputs and data
   * attributes carry it), its variant link, its product link + variant text.
   */
  /** Exact: the booking's own line key (remove links, inputs, data attributes). */
  function findByKey(b) {
    var k = b.key;
    var ek = encodeURIComponent(k);
    return entries(all(
      '[href*="' + k + '"],[href*="' + ek + '"],[data-key="' + k + '"],[data-line-key="' + k + '"],' +
      '[data-item-key="' + k + '"],[data-cart-item-key="' + k + '"],[id*="' + k + '"]',
    ), b.title);
  }

  /** A guess: lines of the same variant (link), else product link + variant text. */
  function findGuess(b) {
    var byVariant = findLines(b.variant, b.title);
    if (byVariant.length || !b.handle) return byVariant;
    return entries(all('a[href*="/products/' + b.handle + '"]').filter(function (a) {
      var line = lineFor(a);
      return line && (!b.variantTitle || line.textContent.indexOf(b.variantTitle) >= 0);
    }), b.title);
  }

  /** Where the card goes in a line found by link: under title + variant text. */
  function anchorAfter(entry) {
    var node = entry.title;
    while (node.parentElement !== entry.line && node.parentElement.children.length === 1) {
      node = node.parentElement;
    }
    for (var i = 0; i < 3; i++) {
      var next = node.nextElementSibling;
      if (!next || next.matches("[data-sb-card]") || next.querySelector("input,button,select,a")) break;
      if (next.textContent.trim().length > 80) break;
      node = next;
    }
    return node;
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function heldText(b) {
    var min = Math.ceil((new Date(b.expires).getTime() - Date.now()) / 60000);
    return min > 0 ? t("Held", { qty: b.qty, min: min }) : t("Expired", { qty: b.qty });
  }

  /** Card (+ held line) right after `after`, both tagged with the line key. */
  function place(b, after) {
    var card = el("div", "sb-cart-card");
    card.setAttribute("data-sb-key", b.key);
    b.props.forEach(function (p) {
      var row = el("div", "sb-cart-row");
      row.appendChild(el("span", "", p[0] + ":"));
      row.appendChild(el("strong", "", p[1]));
      card.appendChild(row);
    });
    after.parentNode.insertBefore(card, after.nextSibling);
    if (showHold && b.expires) {
      var held = el("p", "sb-cart-held", heldText(b));
      held.__sb = b;
      held.setAttribute("data-sb-key", b.key);
      card.parentNode.insertBefore(held, card.nextSibling);
    }
  }

  /** Claim `entry`'s line for `b` and show its card, unless already shown. */
  function claim(b, entry) {
    var owner = entry.line.getAttribute("data-sb-line");
    if (owner === b.key) return;
    if (owner) return; // another booking's line
    entry.line.setAttribute("data-sb-line", b.key);
    place(b, anchorAfter(entry));
  }

  /** The outermost cart container (drawer, cart page) holding `node`. */
  function cartRoot(node) {
    var root = node.closest(CART);
    for (;;) {
      var up = root && root.parentElement && root.parentElement.closest(CART);
      if (!up || up === document.body || up === document.documentElement) return root;
      root = up;
    }
  }

  /**
   * Drop what belongs to bookings no longer in the cart: their cards and held
   * lines, their claims on lines, their product notes. The theme may keep a
   * line element and only move or reuse it, so stale cards don't always go
   * away with a re-render.
   */
  function cleanup() {
    var keys = {};
    bookings.forEach(function (b) {
      keys[b.key] = 1;
    });
    all("[data-sb-key]").forEach(function (n) {
      if (!keys[n.getAttribute("data-sb-key")]) n.remove();
    });
    all("[data-sb-line]").forEach(function (line) {
      var k = line.getAttribute("data-sb-line");
      if (!keys[k] || !line.querySelector('[data-sb-key="' + k + '"]')) line.removeAttribute("data-sb-line");
    });
    all("[data-sb-for]").forEach(function (line) {
      var left = line.getAttribute("data-sb-for").split(" ").filter(function (k) {
        return keys[k];
      });
      if (left.length) line.setAttribute("data-sb-for", left.join(" "));
      else line.removeAttribute("data-sb-for");
    });
  }

  /** One reserved note per cart (drawer, page), after its last booking line. */
  function reservedNotes() {
    var roots = new Map(); // cart root -> its last card
    all(".sb-cart-card").forEach(function (card) {
      roots.set(cartRoot(card) || document.body, card);
    });
    var have = new Set();
    all(".sb-cart-reserved").forEach(function (note) {
      var root = cartRoot(note) || document.body;
      if (!roots.has(root) || have.has(root)) note.remove();
      else have.add(root);
    });
    if (!showReserved) return;
    roots.forEach(function (card, root) {
      if (have.has(root)) return;
      addReserved(card.closest(LINE) || card.closest("[data-sb-line]") || card.parentElement);
    });
  }

  /** The note, after the line in its list. */
  function addReserved(line) {
    var list = line && line.parentElement;
    if (!list) return;
    var tag = line.tagName === "TR" ? "tr" : line.tagName === "LI" ? "li" : "div";
    var note = el(tag, "sb-cart-reserved");
    if (tag === "tr") {
      var td = el("td", "", t("Reserved"));
      td.colSpan = 99;
      note.appendChild(td);
    } else {
      note.textContent = t("Reserved");
    }
    list.appendChild(note);
  }

  function apply() {
    var missing = [];
    cleanup();

    // 1. Exact: printed properties, or the line's own key.
    var guess = {}; // variant -> bookings left to place by guessing
    bookings.forEach(function (b) {
      var blocks = findBlocks(b);
      if (blocks.length) {
        blocks.forEach(function (block) {
          if (block.hasAttribute("data-sb-done")) return;
          block.setAttribute("data-sb-done", "");
          block.classList.add("sb-cart-hidden");
          place(b, block);
        });
        return;
      }
      var exact = findByKey(b);
      if (exact.length) return exact.forEach(function (entry) {
        claim(b, entry);
      });
      (guess[b.variant] = guess[b.variant] || []).push(b);
    });

    // 2. Guesses, for themes whose lines carry no key: the bookings of a
    // variant take its free lines in order, in each list (drawer, cart page).
    // Fewer free lines than bookings means our cart is out of date (a line
    // was just removed): wait for /cart.js rather than show the wrong card.
    Object.keys(guess).forEach(function (variant) {
      var list = guess[variant];
      var keys = list.map(function (b) {
        return b.key;
      });
      var lines = findGuess(list[0]).filter(function (entry) {
        var owner = entry.line.getAttribute("data-sb-line");
        return !owner || keys.indexOf(owner) >= 0;
      });
      if (!lines.length) list.forEach(function (b) {
        missing.push(b.title);
      });
      var byList = new Map();
      lines.forEach(function (entry) {
        var root = cartRoot(entry.line) || document.body;
        if (!byList.has(root)) byList.set(root, []);
        byList.get(root).push(entry);
      });
      byList.forEach(function (free) {
        if (free.length < list.length) return;
        list.forEach(function (b, i) {
          claim(b, free[i]);
        });
      });
    });

    // Add-on bookings: a note under the product the service was booked with,
    // on its first line in each list (drawer, cart page). Two services booked
    // with the same product both note that line.
    bookings.forEach(function (b) {
      if (!b.forVariant) return;
      var done = new Set();
      findLines(b.forVariant, "").forEach(function (entry) {
        var root = cartRoot(entry.line) || document.body;
        if (done.has(root)) return;
        done.add(root);
        var mark = entry.line.getAttribute("data-sb-for") || "";
        if (entry.line.querySelector('.sb-cart-for[data-sb-key="' + b.key + '"]')) return;
        entry.line.setAttribute("data-sb-for", (mark + " " + b.key).trim());
        var when = b.props.slice(0, 2).map(function (p) {
          return p[1];
        }).join(" · ");
        var note = el("p", "sb-cart-for", t("For", { when: when, service: b.title }));
        note.setAttribute("data-sb-key", b.key);
        var after = anchorAfter(entry);
        after.parentNode.insertBefore(note, after.nextSibling);
      });
    });

    reservedNotes();

    var cards = document.querySelectorAll(".sb-cart-card").length;
    var notes = document.querySelectorAll(".sb-cart-for").length;
    var log = bookings.length + "/" + cards + "/" + notes + "/" + missing.join();
    if (log !== lastLog) {
      lastLog = log;
      console.info("[service-booking] cart details:", bookings.length, "booking line(s),",
        cards, "shown,", notes, "product note(s)");
      missing.forEach(function (name) {
        console.info('[service-booking] cart details: no cart line found for "' + name +
          '" (tried line key, ?variant= link, product link)');
      });
    }
  }

  // ---------------------------------------------------------------------
  // Keeping up with the theme
  // ---------------------------------------------------------------------

  /** `refetch`: the new markup may hold a line we haven't fetched yet. */
  function schedule(refetch) {
    // Right away, inside the observer callback: it runs before the browser
    // paints, so the theme's fresh markup is never shown without its card.
    // Waiting for /cart.js first is what made the card vanish for a second.
    apply();
    // Then check for lines we don't know yet (a booking just added).
    if (refetch && Date.now() - lastFetch > 1000) load();
  }

  // Only cart markup matters (the theme re-rendering its drawer or cart page)
  // or markup that mentions a booking. Everything else on the page (sliders,
  // marquees, …) is ignored, so this costs nothing on a busy page.
  var label = cfg.dataset.i18nLabel || "Appointment date";
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var a = added[j];
        if (a.nodeType !== 1 || a.hasAttribute("data-sb-card")) continue;
        if (a.closest(OURS)) continue;
        if (a.closest(CART) || a.querySelector(CART)) return schedule(true);
        if (a.textContent.indexOf(label) >= 0) return schedule(true);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  ["service-booking:cart-added", "cart:updated", "cart:refresh", "cart:change"].forEach(function (name) {
    document.addEventListener(name, function () {
      setTimeout(load, 300);
    });
  });

  setInterval(function () {
    document.querySelectorAll(".sb-cart-held").forEach(function (p) {
      if (p.__sb) p.textContent = heldText(p.__sb);
    });
  }, 30000);

  console.info("[service-booking] cart details embed on");
  // The cart as the page was rendered: cards on first paint, no round trip.
  var inline = document.querySelector("[data-sb-cart-data]");
  if (inline) {
    try {
      setCart(JSON.parse(inline.textContent));
      apply();
    } catch (e) {}
  }
  // Still confirm with /cart.js (a page restored from the back/forward cache
  // shows an old cart).
  load();
})();
