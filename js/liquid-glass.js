/*!
 * Liquid Glass — real refraction for the web.
 *
 * Every glass element gets its own SVG filter, built for its exact size and corner radius:
 *   1. A displacement map is drawn on a canvas from the element's rounded-rect shape (signed
 *      distance field). Inside a "bezel" next to the edge, each pixel points along the surface
 *      normal, strongest at the rim: like the curved edge of a thick lens.
 *   2. feDisplacementMap bends the backdrop through that map, three times with slightly
 *      different strengths for R, G and B (chromatic aberration), then recombines them.
 *   3. The filter is applied with `backdrop-filter: url(#id)`, so what's BEHIND the element
 *      is what gets refracted.
 *
 * Chromium renders SVG filters inside backdrop-filter. Safari and Firefox don't yet, so they
 * get the `lg-fallback` class: frosted blur + the same highlights (nothing breaks).
 *
 * Usage:  LiquidGlass.attach(element, {refraction, bezel, blur, aberration, saturation})
 *         LiquidGlass.auto('.lg, .seg')   // attach to everything matching, now and later
 */
(function(global){
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var ua = navigator.userAgent;
  var SUPPORTED = !!global.chrome && /Chrome\//.test(ua) && !/iPhone|iPad|iPod/.test(ua) &&
                  !global.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  var DEFAULTS = { refraction: 38, bezel: 16, blur: 1.2, aberration: 0.10, saturation: 1.45 };
  var defs = null, uid = 0, items = new Map();
  var mapCache = new Map();

  function ensureDefs(){
    if(defs) return defs;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
  }

  /* Displacement map for a rounded rectangle. R = x offset, G = y offset, 128 = none. */
  function buildMap(w, h, r, bezel){
    var key = w + 'x' + h + 'r' + r + 'b' + bezel;
    if(mapCache.has(key)) return mapCache.get(key);
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
    var hw = w / 2, hh = h / 2;
    r = Math.min(r, hw, hh);
    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        var px = x + 0.5 - hw, py = y + 0.5 - hh;
        var qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
        var ox = Math.max(qx, 0), oy = Math.max(qy, 0);
        var outLen = Math.sqrt(ox * ox + oy * oy);
        var depth = r - outLen - Math.min(Math.max(qx, qy), 0);   /* distance from the edge, inward */
        var dx = 0, dy = 0;
        if(depth > 0 && depth < bezel){
          var nx, ny;
          if(qx > 0 && qy > 0){ nx = ox / outLen; ny = oy / outLen; }
          else if(qx > qy){ nx = 1; ny = 0; } else { nx = 0; ny = 1; }
          nx *= px < 0 ? -1 : 1; ny *= py < 0 ? -1 : 1;
          /* convex lens profile: steep at the rim, flat towards the centre */
          var t = 1 - depth / bezel;
          var m = 1 - Math.sqrt(1 - t * t);
          dx = -nx * m; dy = -ny * m;   /* sample inward → the rim magnifies and bends the backdrop */
        }
        var i = (y * w + x) * 4;
        d[i] = 128 + dx * 127; d[i + 1] = 128 + dy * 127; d[i + 2] = 128; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    var url = c.toDataURL();
    mapCache.set(key, url);
    if(mapCache.size > 120) mapCache.delete(mapCache.keys().next().value);
    return url;
  }

  function node(tag, attrs, parent){
    var n = document.createElementNS(NS, tag);
    for(var k in attrs) n.setAttribute(k, attrs[k]);
    if(parent) parent.appendChild(n);
    return n;
  }

  function channel(parent, input, out, row){
    var m = ['0 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0', '0 0 0 1 0'];
    m[row] = row === 0 ? '1 0 0 0 0' : row === 1 ? '0 1 0 0 0' : '0 0 1 0 0';
    node('feColorMatrix', { in: input, type: 'matrix', values: m.join(' '), result: out }, parent);
  }

  function render(el){
    var it = items.get(el); if(!it) return;
    var w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if(!w || !h){ return; }
    if(w === it.w && h === it.h && it.built) return;
    it.w = w; it.h = h;
    var cs = getComputedStyle(el);
    var r = parseFloat(cs.borderTopLeftRadius) || 0;
    var o = it.opts;
    var bezel = Math.max(4, Math.min(o.bezel, w / 2 - 1, h / 2 - 1));
    var map = buildMap(w, h, Math.min(r, h / 2, w / 2), bezel);

    var f = it.filter;
    while(f.firstChild) f.removeChild(f.firstChild);
    f.setAttribute('width', w); f.setAttribute('height', h);
    node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: o.blur, result: 'blur' }, f);
    node('feImage', { href: map, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'map' }, f);
    var s = o.refraction, a = o.aberration;
    node('feDisplacementMap', { in: 'blur', in2: 'map', scale: s * (1 + a), xChannelSelector: 'R', yChannelSelector: 'G', result: 'dr' }, f);
    node('feDisplacementMap', { in: 'blur', in2: 'map', scale: s, xChannelSelector: 'R', yChannelSelector: 'G', result: 'dg' }, f);
    node('feDisplacementMap', { in: 'blur', in2: 'map', scale: s * (1 - a), xChannelSelector: 'R', yChannelSelector: 'G', result: 'db' }, f);
    channel(f, 'dr', 'r', 0); channel(f, 'dg', 'g', 1); channel(f, 'db', 'b', 2);
    node('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }, f);
    node('feBlend', { in: 'rg', in2: 'b', mode: 'screen', result: 'rgb' }, f);
    node('feColorMatrix', { in: 'rgb', type: 'saturate', values: o.saturation }, f);

    var v = 'url(#' + it.id + ')';
    el.style.backdropFilter = v; el.style.webkitBackdropFilter = v;
    it.built = true;
  }

  var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function(entries){
    entries.forEach(function(e){ render(e.target); });
  }) : null;

  function attach(el, opts){
    if(!el || items.has(el)) return;
    el.classList.add('lg-on');
    if(!SUPPORTED){ el.classList.add('lg-fallback'); items.set(el, { fallback: true }); return; }
    var id = 'lg-' + (++uid);
    var filter = node('filter', {
      id: id, x: 0, y: 0, width: 1, height: 1,
      filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB'
    }, ensureDefs());
    var o = {}; for(var k in DEFAULTS) o[k] = DEFAULTS[k];
    var ds = el.dataset;
    if(ds.lgRefraction) o.refraction = +ds.lgRefraction;
    if(ds.lgBezel) o.bezel = +ds.lgBezel;
    if(ds.lgBlur) o.blur = +ds.lgBlur;
    for(var k2 in (opts || {})) o[k2] = opts[k2];
    items.set(el, { id: id, filter: filter, opts: o, w: 0, h: 0 });
    render(el);
    if(ro) ro.observe(el);
  }

  function update(el, opts){
    var it = items.get(el); if(!it || it.fallback) return;
    for(var k in opts) it.opts[k] = opts[k];
    it.built = false; it.w = 0; render(el);
  }

  function auto(selector, opts){
    document.querySelectorAll(selector).forEach(function(el){ attach(el, opts); });
    if(typeof MutationObserver === 'undefined') return;
    new MutationObserver(function(muts){
      muts.forEach(function(m){
        m.addedNodes.forEach(function(n){
          if(n.nodeType !== 1) return;
          if(n.matches && n.matches(selector)) attach(n, opts);
          if(n.querySelectorAll) n.querySelectorAll(selector).forEach(function(x){ attach(x, opts); });
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* Specular highlight that follows the pointer (sets --mx / --my on the hovered glass). */
  document.addEventListener('pointermove', function(e){
    var b = e.target && e.target.closest && e.target.closest('.lg-on'); if(!b) return;
    var rc = b.getBoundingClientRect();
    b.style.setProperty('--mx', (e.clientX - rc.left) + 'px');
    b.style.setProperty('--my', (e.clientY - rc.top) + 'px');
  }, { passive: true });

  global.LiquidGlass = { attach: attach, update: update, auto: auto, supported: SUPPORTED, defaults: DEFAULTS };
})(window);
