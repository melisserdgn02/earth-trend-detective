/* Orthographic map for browsers without a WebGL context. */
function canvasGlobe(element, options) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Interactive world map. Use the country search for keyboard navigation.");
  canvas.setAttribute("role", "img");
  element.replaceChildren(canvas);
  const ctx = canvas.getContext("2d");
  const projection = d3.geoOrthographic().clipAngle(90).precision(1);
  const path = d3.geoPath(projection, ctx);
  const grid = d3.geoGraticule10();
  const settings = { autoRotate: true, autoRotateSpeed: .35 };
  let features = [], points = [], hovered = null, drag = null, target = null;
  let width = 1, height = 1, lat = 30, lng = 10, altitude = 1.37, last = 0;
  let radius = 1;

  function shape(feature, fill, stroke) {
    ctx.beginPath();
    path(feature);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }

  function draw() {
    const x = width / 2, y = height / 2;
    radius = Math.max(1, Math.min(width, height) * .45 * Math.min(1.5, 1.37 / altitude));
    projection.translate([x, y]).scale(radius).rotate([-lng, -lat]);
    ctx.clearRect(0, 0, width, height);
    const ocean = ctx.createRadialGradient(x - radius * .3, y - radius * .35, 2, x, y, radius * 1.03 + 2);
    ocean.addColorStop(0, "#1d4e79");
    ocean.addColorStop(.75, "#0b244a");
    ocean.addColorStop(1, "#06172f");
    ctx.save();
    ctx.shadowColor = "#5cb5ffa5";
    ctx.shadowBlur = 28;
    shape({type: "Sphere"}, ocean, "#82cfff");
    ctx.restore();
    ctx.lineWidth = .5;
    shape(grid, null, "#a4d7ff25");
    for (const feature of features) {
      const selected = options.selected(feature);
      ctx.lineWidth = selected ? 1 : .48;
      shape(feature, feature === hovered && !selected ? "#6e9fc4" : options.color(feature), selected ? "#edf7ff" : "#527ea2");
    }
    for (const p of points) {
      if (d3.geoDistance([lng, lat], [p.lng, p.lat]) > Math.PI / 2) continue;
      const [px, py] = projection([p.lng, p.lat]);
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = "#ffdc9e";
      ctx.fill();
    }
  }

  function locate(event) {
    if (Math.hypot(event.offsetX - width / 2, event.offsetY - height / 2) > radius) return null;
    const position = projection.invert([event.offsetX, event.offsetY]);
    return features.find(f => !f.properties.isBox && d3.geoContains(f, position)) || null;
  }

  canvas.addEventListener("pointerdown", event => {
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, distance: 0 };
    settings.autoRotate = false;
    target = null;
  });
  canvas.addEventListener("pointermove", event => {
    if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag = { x: event.clientX, y: event.clientY, distance: drag.distance + Math.hypot(dx, dy) };
      lng -= dx * .28;
      lat = Math.max(-89, Math.min(89, lat + dy * .28));
    } else {
      hovered = locate(event);
      options.hover(hovered);
    }
    draw();
  });
  canvas.addEventListener("pointerup", event => {
    const feature = drag?.distance < 5 ? locate(event) : null;
    drag = null;
    if (feature) options.select(feature);
  });
  canvas.addEventListener("pointercancel", () => { drag = null; });
  canvas.addEventListener("pointerleave", () => { hovered = null; options.hover(null); draw(); });
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    altitude = Math.max(.82, Math.min(3, altitude + event.deltaY * .002));
    draw();
  }, { passive: false });

  function frame(now) {
    requestAnimationFrame(frame);
    if (now - last < 45) return;
    last = now;
    if (target) {
      const delta = ((target.lng - lng + 540) % 360) - 180;
      lng += delta * .15;
      lat += (target.lat - lat) * .15;
      altitude += (target.altitude - altitude) * .15;
      if (Math.abs(delta) + Math.abs(target.lat - lat) + Math.abs(target.altitude - altitude) < .15) {
        ({ lat, lng, altitude } = target);
        target = null;
      }
      draw();
    } else if (settings.autoRotate) {
      lng = (lng + .18) % 360;
      draw();
    }
  }
  requestAnimationFrame(frame);

  function resize() {
    const ratio = Math.min(2, devicePixelRatio || 1);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  return {
    controls: () => settings,
    polygonsData(data) { features = data; draw(); return this; },
    pointsData(data) { points = data; draw(); return this; },
    pointOfView(view, duration) {
      if (duration) target = view;
      else { ({ lat, lng, altitude } = view); draw(); }
      return this;
    },
    ringsData() { return this; },
    htmlElementsData() { return this; },
    arcsData() { return this; },
    polygonCapColor() { draw(); return this; },
    width(value) { width = Math.max(value, 1); return this; },
    height(value) { height = Math.max(value, 1); resize(); return this; },
  };
}
