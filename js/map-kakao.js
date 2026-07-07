/** Kakao Maps SDK adapter */

const DEFAULT_SDK_TIMEOUT_MS = 8000;
const HOVER_HIDE_MS = 480;
const POPUP_LAT_OFFSET = 0.00014;

export function loadKakaoSdk(jsKey, timeoutMs = DEFAULT_SDK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!jsKey) {
      reject(new Error("kakaoJsKey missing"));
      return;
    }
    if (window.kakao?.maps?.LatLng) {
      resolve(window.kakao.maps);
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`Kakao Maps SDK load timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(jsKey)}&libraries=services&autoload=false`;
    script.async = true;
    script.onload = () => {
      if (!window.kakao?.maps?.load) {
        finish(reject, new Error("Kakao Maps SDK loaded but kakao.maps missing"));
        return;
      }
      window.kakao.maps.load(() => {
        if (window.kakao?.maps?.LatLng) {
          finish(resolve, window.kakao.maps);
        } else {
          finish(reject, new Error("Kakao Maps SDK autoload failed"));
        }
      });
    };
    script.onerror = () => finish(reject, new Error("Kakao Maps SDK load failed"));
    document.head.appendChild(script);
  });
}

/** 나성동·정부세종청사 일대 */
export const SEJONG_DEFAULT_CENTER = { lat: 36.4855, lng: 127.2615 };
/** 나성동 중심, 세종시 전역이 보이도록 넓게 */
export const SEJONG_OFFICE_VIEW = { ...SEJONG_DEFAULT_CENTER, level: 6 };

export function waitForMapLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

export function waitForWindowReady() {
  if (document.readyState === "complete") {
    return waitForMapLayout();
  }
  return new Promise((resolve) => {
    window.addEventListener("load", () => waitForMapLayout().then(resolve), { once: true });
  });
}

/** #map 실제 픽셀 크기가 잡힐 때까지 대기 (카카오 타일 어긋남 방지) */
export function waitForMapContainer(containerId = "map", timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const el = document.getElementById(containerId);
      if (el && el.offsetWidth >= 240 && el.offsetHeight >= 300) {
        resolve(el);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(
          new Error(
            `#${containerId} 크기 미확정 (${el?.offsetWidth ?? 0}x${el?.offsetHeight ?? 0})`
          )
        );
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function createKakaoMap(maps, center, containerId = "map", level = SEJONG_OFFICE_VIEW.level) {
  const el = document.getElementById(containerId);
  const map = new maps.Map(el, {
    center: new maps.LatLng(center.lat, center.lng),
    level,
  });
  relayoutKakaoMap(map);
  return map;
}

export function relayoutKakaoMap(map) {
  try {
    map?.relayout();
  } catch {
    /* ignore */
  }
}

/** 타일·캔버스가 실제로 그려졌는지 확인 (도메인 미등록 시 빈 지도 방지) */
export function verifyKakaoMapReady(containerId = "map", timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const el = document.getElementById(containerId);
      const hasTiles =
        Boolean(el?.querySelector("img[src*='map.daum'], img[src*='kakao'], canvas")) ||
        (el?.childElementCount ?? 0) >= 2;
      if (hasTiles) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function focusKakaoOnOffice(maps, map, view = SEJONG_OFFICE_VIEW) {
  if (!map || !maps) return;
  relayoutKakaoMap(map);
  map.setCenter(new maps.LatLng(view.lat, view.lng));
  map.setLevel(view.level);
}

/** 마커·상호 클릭 시 해당 좌표를 지도 뷰포트 중앙에 맞춤 (줌 유지) */
export function centerMapOn(map, maps, lat, lng) {
  if (!map || !maps || lat == null || lng == null) return;
  map.setCenter(new maps.LatLng(lat, lng));
}

/** 첫 로딩 때만 중심 맞춤 (이후 pan/zoom 방해하지 않음) */
export function bootstrapKakaoView(maps, map, view = SEJONG_OFFICE_VIEW) {
  if (!map || !maps) return;
  const snap = () => focusKakaoOnOffice(maps, map, view);
  snap();
  [150, 500].forEach((ms) => setTimeout(snap, ms));
  const onTilesOnce = () => {
    snap();
    maps.event.removeListener(map, "tilesloaded", onTilesOnce);
  };
  maps.event.addListener(map, "tilesloaded", onTilesOnce);
}

function appendDropletBody(parent) {
  const body = document.createElement("span");
  body.className = "droplet-body";
  const shine = document.createElement("span");
  shine.className = "droplet-shine";
  body.appendChild(shine);
  parent.appendChild(body);
  return body;
}

function applyMarkerColor(el, color) {
  el.style.setProperty("--marker-color", color || "#007AFF");
}

function markerColor(style = {}) {
  return style.color || "#007AFF";
}

export function dropletPinHtml(style = {}) {
  if (style.isStack) {
    const count = style.count || '';
    const countBadge = count > 1 ? `<span class="stack-count">${count}</span>` : '';
    return `<div class="map-pin-wrap map-pin-stack tier-rainbow" data-count="${count}">
      <span class="map-marker"><span class="droplet-body droplet-rainbow"><span class="droplet-shine"></span></span></span>
      ${countBadge}
    </div>`;
  }
  const { tier = 5 } = style;
  return `<div class="map-pin-wrap tier-${tier}" style="--marker-color:${markerColor(style)}">
    <span class="map-marker"><span class="droplet-body"><span class="droplet-shine"></span></span></span>
  </div>`;
}

function createStackPinElement(style = {}) {
  const { zIndex = 8, count = '' } = style;
  const wrap = document.createElement("div");
  wrap.className = "map-pin-wrap map-pin-stack tier-rainbow";
  wrap.style.zIndex = String(zIndex);
  if (count) wrap.dataset.count = count;

  const marker = document.createElement("span");
  marker.className = "map-marker";
  const body = document.createElement("span");
  body.className = "droplet-body droplet-rainbow";
  const shine = document.createElement("span");
  shine.className = "droplet-shine";
  body.appendChild(shine);
  marker.appendChild(body);
  wrap.appendChild(marker);

  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "stack-count";
    badge.textContent = count;
    wrap.appendChild(badge);
  }

  return { wrap, pin: marker };
}

function createPinElement(style = {}) {
  if (style.isStack) return createStackPinElement(style);

  const { tier = 5, color = "#007AFF", zIndex = 2 } = style;
  const wrap = document.createElement("div");
  wrap.className = `map-pin-wrap tier-${tier}`;
  wrap.style.zIndex = String(zIndex);
  applyMarkerColor(wrap, color);

  const marker = document.createElement("span");
  marker.className = "map-marker";
  applyMarkerColor(marker, color);
  appendDropletBody(marker);
  wrap.appendChild(marker);
  return { wrap, pin: marker };
}

function findInfoWindowRoot() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return null;
  return (
    mapEl.querySelector(".infoview") ||
    mapEl.querySelector('[class*="InfoWindow"]') ||
    mapEl.querySelector('[class*="infoview"]')
  );
}

function bindInfoWindowHover(info, { onEnter, onLeave }) {
  let attempts = 0;
  const tryBind = () => {
    const root = findInfoWindowRoot();
    if (root) {
      root.addEventListener("mouseenter", onEnter);
      root.addEventListener("mouseleave", onLeave);
      return;
    }
    attempts += 1;
    if (attempts < 8) {
      requestAnimationFrame(tryBind);
    }
  };
  tryBind();
}

function restoreMarkerVisibility(markerEntry) {
  if (markerEntry?.wrap) markerEntry.wrap.style.visibility = "visible";
}

export function closeKakaoInfos(markers) {
  markers.forEach((m) => {
    try {
      m.info?.close();
    } catch {
      /* ignore */
    }
    if (m.setPopupOpen) m.setPopupOpen(false);
    restoreMarkerVisibility(m);
  });
}

export function closeOtherKakaoInfos(markers, { exceptRid, exceptClusterKey } = {}) {
  markers.forEach((m) => {
    if (exceptRid && m._rid === exceptRid) return;
    if (exceptClusterKey && m._clusterKey === exceptClusterKey) return;
    try {
      m.info?.close();
    } catch {
      /* ignore */
    }
    if (m.setPopupOpen) m.setPopupOpen(false);
    restoreMarkerVisibility(m);
  });
}

/** CustomOverlay는 InfoWindow.open(map, marker) 2번째 인자로 쓸 수 없음 → setPosition 후 open(map) */
export function openKakaoInfo(maps, map, markerEntry) {
  if (!markerEntry?.info || !markerEntry?.pos) return;
  const lat = markerEntry.pos.getLat() + POPUP_LAT_OFFSET;
  const lng = markerEntry.pos.getLng();
  markerEntry.info.setPosition(new maps.LatLng(lat, lng));
  markerEntry.info.open(map);
  requestAnimationFrame(() => {
    const root = findInfoWindowRoot();
    if (root) root.style.pointerEvents = "auto";
  });
}

function createKakaoMarker(
  maps,
  map,
  r,
  { onSelect, popupHtml, beforeOpen, enableHover, markerRegistry, onMarkerActivate }
) {
  const pos = new maps.LatLng(r.lat, r.lng);
  const style = popupHtml.markerStyle?.(r) || {
    tier: 4,
    rank: null,
    color: "#007AFF",
    zIndex: 2,
  };
  const { wrap, pin } = createPinElement(style);
  wrap.style.pointerEvents = "auto";
  wrap.style.cursor = "pointer";
  wrap.style.touchAction = "manipulation";
  const overlay = new maps.CustomOverlay({
    position: pos,
    content: wrap,
    yAnchor: 1,
    xAnchor: 0.5,
    clickable: true,
    zIndex: style.zIndex || 2,
  });
  overlay.setMap(map);

  const info = new maps.InfoWindow({
    content: popupHtml.build(r),
    removable: true,
    zIndex: 1000,
  });

  let hoverTimer = null;
  let pinHovered = false;
  let infoHovered = false;
  let popupOpen = false;
  const setPopupOpen = (open) => {
    popupOpen = open;
  };

  const clearHideTimer = () => clearTimeout(hoverTimer);

  const closePopup = () => {
    try {
      info.close();
    } catch {
      /* ignore */
    }
    setPopupOpen(false);
  };

  const scheduleHide = () => {
    clearHideTimer();
    hoverTimer = setTimeout(() => {
      if (!pinHovered && !infoHovered) {
        closePopup();
      }
    }, HOVER_HIDE_MS);
  };

  const showPopup = ({ hover = false, force = false } = {}) => {
    if (popupOpen && hover && !force) return;
    if (markerRegistry) {
      closeOtherKakaoInfos(markerRegistry, {
        exceptRid: r.restaurant_id,
        exceptClusterKey: r._clusterKey || null,
      });
    }
    info.setContent(popupHtml.build(r));
    openKakaoInfo(maps, map, { info, pos, wrap, pin });
    if (pin) {
      document
        .querySelectorAll(".map-marker.active")
        .forEach((el) => el.classList.remove("active"));
      pin.classList.add("active");
    }
    setPopupOpen(true);
  };

  const activateMarker = (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearHideTimer();
    pinHovered = false;
    infoHovered = false;
    closePopup();
    centerMapOn(map, maps, r.lat, r.lng);
    if (pin) {
      document
        .querySelectorAll(".map-marker.active")
        .forEach((el) => el.classList.remove("active"));
      pin.classList.add("active");
    }
    if (onMarkerActivate) {
      onMarkerActivate(r);
      return;
    }
    if (popupHtml.onMarkerActivate) {
      popupHtml.onMarkerActivate(r);
      return;
    }
    showPopup({ force: true });
    onSelect?.(r._listKey || (r._clusterKey ? `loc:${r._clusterKey}` : r.restaurant_id), false);
  };

  maps.event.addListener(info, "closeclick", () => {
    setPopupOpen(false);
    pin?.classList.remove("active");
  });

  if (enableHover) {
    bindInfoWindowHover(info, {
      onEnter: () => {
        infoHovered = true;
        clearHideTimer();
      },
      onLeave: () => {
        infoHovered = false;
        scheduleHide();
      },
    });

    wrap.addEventListener("mouseenter", () => {
      pinHovered = true;
      clearHideTimer();
      showPopup({ hover: true });
    });
    wrap.addEventListener("mouseleave", () => {
      pinHovered = false;
      scheduleHide();
    });
  }

  wrap.addEventListener("click", activateMarker);

  return {
    _rid: r.restaurant_id,
    _listKey: r._listKey || null,
    _clusterKey: r._clusterKey || null,
    _stackRids: r._stackMembers?.map((m) => m.restaurant_id) || null,
    _stackMembers: r._stackMembers || null,
    overlay,
    info,
    pos,
    pin,
    wrap,
    setPopupOpen,
    lat: r.lat,
    lng: r.lng,
  };
}

export function addKakaoMarkers(maps, map, items, { onSelect, popupHtml, beforeOpen, enableHover, onMarkerActivate }) {
  const withCoords = items.filter((r) => r.lat != null && r.lng != null);
  const markers = [];
  withCoords.forEach((r) => {
    markers.push(
      createKakaoMarker(maps, map, r, {
        onSelect,
        popupHtml,
        beforeOpen,
        enableHover,
        onMarkerActivate,
        markerRegistry: markers,
      })
    );
  });
  return markers;
}

export async function addKakaoMarkersBatched(
  maps,
  map,
  items,
  markerOpts = {},
  { batchSize = 40, onProgress } = {}
) {
  const { onSelect, popupHtml, beforeOpen, enableHover, onMarkerActivate } = markerOpts;
  const withCoords = items.filter((r) => r.lat != null && r.lng != null);
  const markers = [];
  for (let i = 0; i < withCoords.length; i += batchSize) {
    const batch = withCoords.slice(i, i + batchSize);
    batch.forEach((r) => {
      markers.push(
        createKakaoMarker(maps, map, r, {
          onSelect,
          popupHtml,
          beforeOpen,
          enableHover,
          onMarkerActivate,
          markerRegistry: markers,
        })
      );
    });
    onProgress?.(Math.min(i + batchSize, withCoords.length), withCoords.length);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return markers;
}

export function panKakaoTo(
  map,
  maps,
  lat,
  lng,
  markers,
  rid,
  { beforeOpen, clusterKey } = {}
) {
  if (!map || !maps) return;
  beforeOpen?.();
  centerMapOn(map, maps, lat, lng);
  const m = clusterKey
    ? markers.find((mk) => mk._clusterKey === clusterKey)
    : markers.find((mk) => mk._rid === rid);
  if (!m) return;
  closeOtherKakaoInfos(markers, {
    exceptRid: m._rid,
    exceptClusterKey: clusterKey || null,
  });
  openKakaoInfo(maps, map, m);
  if (m.pin) {
    document
      .querySelectorAll(".map-marker.active")
      .forEach((el) => el.classList.remove("active"));
    m.pin.classList.add("active");
  }
  if (m.setPopupOpen) m.setPopupOpen(true);
}