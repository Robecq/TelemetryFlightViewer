
/*
Copyright (c) 2026 Peter George
Licensed under the MIT License. See LICENSE file in the project root.
*/
// replay.js — 

(function () {
  "use strict";

  // ---- Map setup -----------------------------------------------------------
  const map = L.map("map").setView([0, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  }).addTo(map);

  const backgroundGroup = L.layerGroup().addTo(map);
  const dynamicGroup    = L.layerGroup().addTo(map);
  //----

  // ---- Stats control (top-right) --------------------------------------------
const StatsControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'stats-panel leaflet-control');
    div.innerHTML = `
      <div class="stats-title">Flight stats</div>
      <div id="stats-body">Load a CSV…</div>
    `;
    // Don’t let clicks on the panel drag the map
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
const statsControl = new StatsControl({ position: 'topright' }).addTo(map);

function updateStatsPanel(html) {
  const el = document.getElementById('stats-body');
  if (el) el.innerHTML = html;
}

  // ---- UI elements ---------------------------------------------------------
  const fileInput = document.getElementById("fileInput");
  const playPause = document.getElementById("playPause");
  const speedSel  = document.getElementById("speed");
  const tailRange = document.getElementById("tail");
  const followCb  = document.getElementById("follow");
  const scrub     = document.getElementById("scrub");
  const statusEl  = document.getElementById("status");

  const legendEl  = document.getElementById("legend");
  const altMinEl  = document.getElementById("altMin");
  const altMidEl  = document.getElementById("altMid");
  const altMaxEl  = document.getElementById("altMax");

  // ---- Data & runtime state -----------------------------------------------
  let points = [];
  let altMin = null, altMax = null;
  let tStart = 0, tEnd = 0, duration = 0;
  let running = false, rafId = null, lastTs = null, curTime = 0;
  let marker = null, tailLine = null, hdgTick = null;
  let tailSeconds = 10;

  // ---- Helper functions ----------------------------------------------------
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const pad2  = (n) => String(Math.floor(n)).padStart(2, "0");

  function fmtClock(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return (h ? h + ":" : "") + pad2(m) + ":" + pad2(s);
  }

  function timeToSec(str) {
    if (!str || typeof str !== "string") return null;
    const m = str.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return null;
    const hh = +m[1], mm = +m[2], ss = +m[3], ms = +(m[4] || 0);
    return hh * 3600 + mm * 60 + ss + ms / 1000;
  }

  function colorForT(t) {
    const hue = 120 * (1 - t);
    return `hsl(${hue}, 90%, 45%)`;
  }
  function normalize(v, a, b) {
    if (!isFinite(v) || !isFinite(a) || !isFinite(b) || b <= a) return 0.5;
    return clamp((v - a) / (b - a), 0, 1);
  }

  function offsetLatLon(lat, lon, bearingDeg, distanceMeters) {
    const R = 6371000;
    const br = bearingDeg * Math.PI/180;
    const φ1 = lat * Math.PI/180;
    const λ1 = lon * Math.PI/180;
    const δ  = distanceMeters / R;

    const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(br));
    const λ2 = λ1 + Math.atan2(
      Math.sin(br)*Math.sin(δ)*Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2)
    );

    return [φ2*180/Math.PI, ((λ2*180/Math.PI + 540)%360)-180];
  }

  // ---- Gradient Track (FIXED, restored) ------------------------------------
  function buildGradientTrack(pts, aMin, aMax) {
    backgroundGroup.clearLayers();
    legendEl.style.display = "none";

    if (!pts.length) return;

    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i];
      let alt = null;

      if (isFinite(p0.alt) && isFinite(p1.alt)) alt = (p0.alt + p1.alt) / 2;
      else if (isFinite(p0.alt)) alt = p0.alt;
      else if (isFinite(p1.alt)) alt = p1.alt;

      const color = (alt != null && aMax > aMin)
        ? colorForT(normalize(alt, aMin, aMax))
        : "#d33";

      L.polyline([[p0.lat, p0.lon], [p1.lat, p1.lon]], {
        color, weight: 4, opacity: 0.8
      }).addTo(backgroundGroup);
    }

    if (aMax > aMin) {
      altMinEl.textContent = Math.round(aMin);
      altMaxEl.textContent = Math.round(aMax);
      altMidEl.textContent = Math.round((aMin + aMax) / 2);
      legendEl.style.display = "block";
    }
  }

  // ---- Interpolation -------------------------------------------------------
  function interp(a, b, t) { return a*(1-t) + b*t; }

  function sampleAtTime(t) {
    if (t <= points[0].timeSec) return { ...points[0] };
    if (t >= points[points.length-1].timeSec) return { ...points[points.length-1] };

    let i = 1;
    while (i < points.length && points[i].timeSec < t) i++;

    const p0 = points[i-1], p1 = points[i];
    const span = p1.timeSec - p0.timeSec || 1e-6;
    const u = clamp((t - p0.timeSec) / span, 0, 1);

    const lat = interp(p0.lat, p1.lat, u);
    const lon = interp(p0.lon, p1.lon, u);
    const alt = (isFinite(p0.alt) || isFinite(p1.alt))
      ? interp(p0.alt ?? p1.alt ?? 0, p1.alt ?? p0.alt ?? 0, u)
      : null;
    const gsp = (isFinite(p0.speed) || isFinite(p1.speed))
      ? interp(p0.speed ?? p1.speed ?? 0, p1.speed ?? p0.speed ?? 0, u)
      : null;
    const hdg = (isFinite(p0.hdg) || isFinite(p1.hdg))
      ? interp(p0.hdg ?? p1.hdg ?? 0, p1.hdg ?? p0.hdg ?? 0, u)
      : null;

    const mode = p1.mode ?? p0.mode;
    return {lat, lon, alt, speed:gsp, hdg, timeSec:t, mode};
  }

  // ---- Set animation time --------------------------------------------------
  function setTime(t, scrubbing=false) {
    
    curTime = clamp(t, tStart, tEnd);

    const s = sampleAtTime(curTime);

    // marker
    if (!marker) {
      marker = L.circleMarker([s.lat, s.lon], {
        radius: 6,
        color: "#000",
        weight: 2,
        fillColor: "#ffeb3b",
        fillOpacity: 1
      }).addTo(dynamicGroup);
    }
    marker.setLatLng([s.lat, s.lon]);

    // heading tick
    if (hdgTick) dynamicGroup.removeLayer(hdgTick);
    if (isFinite(s.hdg)) {
      const tip = offsetLatLon(s.lat, s.lon, s.hdg, 2);
      hdgTick = L.polyline([[s.lat, s.lon], tip], {
        color:"#222", weight:2, opacity:0.9
      }).addTo(dynamicGroup);
    }

    // tail
    if (!tailLine) {
      tailLine = L.polyline([], {
        color:"#00e5ff",
        weight:4,
        opacity:0.9
      }).addTo(dynamicGroup);
    }

    const tailPts = [];
    const tailStart = curTime - tailSeconds;
    tailPts.push([s.lat, s.lon]);

    let idx = points.findIndex(p => p.timeSec >= curTime);
    if (idx < 0) idx = points.length - 1;

    let tCursor = curTime;
    let tRemain = tailSeconds;

    for (let k = idx; k > 0 && tRemain > 0; k--) {
      const p1 = points[k], p0 = points[k - 1];
      if (p1.timeSec <= tailStart) break;

      const segA = Math.max(p0.timeSec, tailStart);
      const segB = Math.min(p1.timeSec, tCursor);
      if (segB <= segA) continue;

      const A = sampleAtTime(segA);
      tailPts.unshift([A.lat, A.lon]);

      if (p0.timeSec >= tailStart && p0.timeSec < tCursor)
        tailPts.unshift([p0.lat, p0.lon]);

      tRemain -= (segB - segA);
      tCursor -= (segB - segA);
    }

    tailLine.setLatLngs(tailPts);

    // follow
    if (followCb.checked && !scrubbing) {
      map.panTo([s.lat, s.lon], {animate:false});
    }

    // UI
    const elapsed = curTime - tStart;
    statusEl.textContent =
      `${fmtClock(elapsed)} / ${fmtClock(duration)}  ` +
      (isFinite(s.alt)?`| Alt ${Math.round(s.alt)} m  `:"") +
      (isFinite(s.speed)?`| GSpd ${Math.round(s.speed)} km/h  `:"") +
      (s.mode?`| FM ${s.mode}`:"");

    if (!scrubbing) {
      scrub.value = Math.round(1000 * (elapsed / (duration || 1)));
    }
  }

  // ---- Animation loop ------------------------------------------------------
  function tick(ts) {
    if (!running) return;
    if (lastTs == null) lastTs = ts;
    const dtMs = ts - lastTs;
    lastTs = ts;

    const speed = parseFloat(speedSel.value) || 1;
    setTime(curTime + (dtMs/1000)*speed);

    if (curTime >= tEnd) {
      running = false;
      playPause.textContent = "▶ Play";
    } else {
      rafId = requestAnimationFrame(tick);
    }
  }

  // ---- UI Events -----------------------------------------------------------
  playPause.addEventListener("click", () => {
    if (!points.length) return;
    if (!running) {
      running = true;
      lastTs = null;
      playPause.textContent = "⏸ Pause";
      rafId = requestAnimationFrame(tick);
    } else {
      running = false;
      playPause.textContent = "▶ Play";
      if (rafId) cancelAnimationFrame(rafId);
    }
  });

  tailRange.addEventListener("input", e => {
    tailSeconds = parseInt(e.target.value, 10) || 0;
  });

  scrub.addEventListener("input", e => {
    if (!points.length) return;
    const f = e.target.value / 1000;
    setTime(tStart + f * duration, true);
  });

  // ---- CSV Load & Parse ----------------------------------------------------

function resampleTrack(points, targetHz) {
  const dt = 1 / targetHz;
  const out = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];

    const segStart = p0.timeSec;
    const segEnd   = p1.timeSec;
    const segDt    = segEnd - segStart;

    // number of new frames inside this segment
    const steps = Math.max(1, Math.round(segDt / dt));

    for (let s = 0; s < steps; s++) {
      const t = segStart + (s * segDt / steps);
      out.push(sampleAtTime(t));
    }
  }

  // push the final point
  out.push(points[points.length - 1]);

  return out;
}


// Great-circle distance (meters)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*
            Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Compute total distance, max/avg speed, max/avg altitude
function computeStats(srcPoints) {
  if (!srcPoints || srcPoints.length < 2) return null;

  // Duration from timeSec (already real-time cumulative)
  const durationSec = Math.max(0, srcPoints[srcPoints.length - 1].timeSec - srcPoints[0].timeSec);

  let totalDistM = 0;
  let maxSegSpeedKmh = 0;

  for (let i = 1; i < srcPoints.length; i++) {
    const a = srcPoints[i-1], b = srcPoints[i];
    if (Number.isFinite(a.lat) && Number.isFinite(a.lon) &&
        Number.isFinite(b.lat) && Number.isFinite(b.lon)) {
      const d = haversine(a.lat, a.lon, b.lat, b.lon);
      totalDistM += d;
      const dt = Math.max(0.001, b.timeSec - a.timeSec); // s
      const segSpeedKmh = (d / dt) * 3.6;
      if (segSpeedKmh > maxSegSpeedKmh) maxSegSpeedKmh = segSpeedKmh;
    }
  }

  // Max/avg altitude
  let altSum = 0, altCount = 0, maxAlt = -Infinity;
  for (const p of srcPoints) {
    if (Number.isFinite(p.alt)) {
      altSum += p.alt; altCount++;
      if (p.alt > maxAlt) maxAlt = p.alt;
    }
  }
  const avgAlt = altCount ? (altSum / altCount) : null;

  // Average speed from total distance / total time
  const avgSpeedKmh = durationSec > 0 ? (totalDistM / durationSec) * 3.6 : 0;

  // If the log has GSpd(kmh), include it when choosing max speed
  let maxLoggedSpeedKmh = 0;
  for (const p of srcPoints) {
    if (Number.isFinite(p.speed) && p.speed > maxLoggedSpeedKmh) {
      maxLoggedSpeedKmh = p.speed;
    }
  }
  
  const maxSpeedKmh = maxLoggedSpeedKmh;

  return {
    totalDistKm: totalDistM / 1000,
    avgSpeedKmh,
    maxSpeedKmh,
    avgAlt,
    maxAlt: Number.isFinite(maxAlt) ? maxAlt : null,
  };
}

  fileInput.addEventListener("change", evt => {
    const file = evt.target.files[0];
    if (!file) return;

    backgroundGroup.clearLayers();
    dynamicGroup.clearLayers();
    legendEl.style.display = "none";

    marker = hdgTick = tailLine = null;
    points = [];
    altMin = altMax = null;
    tStart = tEnd = duration = 0;
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;

    lastTs = null;
    curTime = 0;

    playPause.disabled =
      speedSel.disabled =
      tailRange.disabled =
      followCb.disabled =
      scrub.disabled = true;

    statusEl.textContent = `Parsing ${file.name} …`;

    Papa.parse(file, {
      header: true,
      dynamicTyping: false,
      skipEmptyLines: "greedy",
      transformHeader: h => h.trim(),

      complete: function(res) {
        const rows = res.data || [];
        if (!rows.length) {
          statusEl.textContent = "No rows found.";
          return;
        }

        const out = [];
        const altVals = [];

        for (const row of rows) {
          // GPS parsing
          let gps = row["GPS"];
          if (typeof gps !== "string") continue;
          gps = gps.trim();
          if (!gps) continue;

          const parts = gps.split(/\s+/);
          if (parts.length !== 2) continue;

          const lat = parseFloat(parts[0]);
          const lon = parseFloat(parts[1]);
          if (!isFinite(lat) || !isFinite(lon)) continue;

          // Timestamp
          const tSec = timeToSec(row["Time"]);

          // Altitude
          let alt = row["Alt(m)"];
          alt = (alt != null && String(alt).trim() !== "")
            ? parseFloat(String(alt).replace(",", "."))
            : null;
          if (isFinite(alt)) altVals.push(alt);

          // Speed
          let gspd = row["GSpd(kmh)"];
          gspd = (gspd != null && String(gspd).trim() !== "")
            ? parseFloat(String(gspd).replace(",", "."))
            : null;

          // Heading
          let hdg = row["Hdg(°)"];
          if (hdg == null) hdg = row["Hdg(Â°)"];
          if (hdg == null) hdg = row["Hdg"];
          hdg = (hdg != null && String(hdg).trim() !== "")
            ? parseFloat(String(hdg).replace(",", "."))
            : null;

          // Mode
          const mode = row["FM"] || null;

          out.push({
            lat, lon,
            alt: isFinite(alt)?alt:null,
            speed: isFinite(gspd)?gspd:null,
            hdg: isFinite(hdg)?hdg:null,
            timeRaw: tSec,
            mode
          });
        }

        if (!out.length) {
          statusEl.textContent = "No valid GPS points found.";
          return;
        }

        // ---- REAL SPEED SMOOTH TIMING PATCH ----
        function smoothSpatial(points, window = 5) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    let lat = 0, lon = 0, alt = 0, count = 0;
    for (let j = -window; j <= window; j++) {
      const k = i + j;
      if (k >= 0 && k < points.length) {
        lat += points[k].lat;
        lon += points[k].lon;
        if (points[k].alt != null) alt += points[k].alt;
        count++;
      }
    }
    out.push({
      ...points[i],
      lat: lat / count,
      lon: lon / count,
      alt: points[i].alt != null ? alt / count : null
    });
  }
  return out;
}

        let realTimes = [];
        for (let i = 0; i < out.length; i++) {
          let t = out[i].timeRaw;
          if (!isFinite(t)) {
            // if missing, assume ~2 seconds after previous
            t = (i > 0 ? realTimes[i - 1] + 2 : 0);
          }
          realTimes.push(t);
        }

        let realDt = [];
        for (let i = 1; i < realTimes.length; i++) {
          realDt[i] = Math.max(0.05, realTimes[i] - realTimes[i - 1]);
        }
        realDt[0] = realDt[1] || 0.1;

        let smoothTime = 0;
        for (let i = 0; i < out.length; i++) {
          out[i].timeSec = smoothTime;
          smoothTime += realDt[i];
        }
    
        
//--------------------------------------------------------------
// Build timeSec from realDt
//--------------------------------------------------------------


        points = out;                 // original points with real timing
points = smoothSpatial(points, 3);  // spatial smoothing to reduce GPS noise (3-frame window)
points = resampleTrack(points, 30);   // now smoothed to 30Hz
        altMin = altVals.length ? Math.min(...altVals) : 0;
        altMax = altVals.length ? Math.max(...altVals) : 0;
        tStart = points[0].timeSec; 
        tEnd   = points[points.length-1].timeSec;
        duration = tEnd - tStart;

// Use the original parsed points (“out”) for physics-accurate stats
const stats = computeStats(out);

if (stats) {
  const fmt = (v, d=1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d));
  const html = `
    <table>
      <tr><th>Total distance</th><td>${fmt(stats.totalDistKm, 2)} km</td></tr>
      <tr><th>Max speed</th><td>${fmt(stats.maxSpeedKmh, 1)} km/h</td></tr>
      <tr><th>Average speed</th><td>${fmt(stats.avgSpeedKmh, 1)} km/h</td></tr>
      <tr><th>Max altitude</th><td>${fmt(stats.maxAlt, 0)} m</td></tr>
      <tr><th>Average altitude</th><td>${fmt(stats.avgAlt, 0)} m</td></tr>
    </table>
  `;
  updateStatsPanel(html);
}



        // Gradient track
        buildGradientTrack(points, altMin, altMax);

        // Fit bounds
        const bounds = L.latLngBounds(points.map(p => [p.lat, p.lon]));
        map.fitBounds(bounds, { padding: [20,20] });

        // Prepare
        setTime(tStart);

        // Enable UI
        playPause.disabled =
          speedSel.disabled =
          tailRange.disabled =
          followCb.disabled =
          scrub.disabled = false;

        statusEl.textContent =
          `Ready — ${points.length} points, duration ${fmtClock(duration)}. Hit Play.`;
      }
    });
  });

})();