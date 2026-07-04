/** 카카오맵 POI(키워드) 좌표로 마커 위치 보정 */

const POI_CACHE_VERSION = 2;
const POI_CACHE_KEY = "venue-poi-coords-v2";
const REFINE_DELAY_MS = 110;

function normalizeName(s) {
  return String(s || "")
    .replace(/주식회사|\(주\)|\(유\)|㈜|유한회사|법인/gi, "")
    .replace(/[^\w가-힣]/g, "")
    .toLowerCase();
}

function displayName(r) {
  const permit = String(r.permit_name || "").trim();
  const name = String(r.name || "").trim();
  return permit.length >= 2 ? permit : name;
}

function shortRoad(r) {
  const road = String(r.address_road || r.geocode_address || "").trim();
  return road ? road.split(",")[0].trim() : "";
}

function nameScore(placeName, hint) {
  const place = normalizeName(placeName);
  const target = normalizeName(hint);
  if (!place || !target) return 0;
  if (place === target) return 120;
  if (place.includes(target) || target.includes(place)) return 75;
  let matches = 0;
  const minLen = Math.min(place.length, target.length);
  for (let i = 0; i < minLen; i += 1) {
    if (place[i] === target[i]) matches += 1;
  }
  return Math.round((matches / Math.max(place.length, target.length)) * 55);
}

function loadPoiCache(dataAsOf) {
  try {
    const raw = localStorage.getItem(POI_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed?.version !== POI_CACHE_VERSION || parsed?.data_as_of !== dataAsOf) {
      return {};
    }
    return parsed.coords || {};
  } catch {
    return {};
  }
}

function savePoiCache(dataAsOf, coords) {
  try {
    localStorage.setItem(
      POI_CACHE_KEY,
      JSON.stringify({
        version: POI_CACHE_VERSION,
        data_as_of: dataAsOf,
        coords,
      })
    );
  } catch {
    /* ignore quota */
  }
}

function needsPoiRefine(r) {
  if (r.lat == null || r.lng == null) return false;
  if (r.geocode_provider === "kakao_kw" && r.geocode_place_name) return false;
  return true;
}

function keywordQueries(r) {
  const name = displayName(r);
  const road = shortRoad(r);
  const seen = new Set();
  const out = [];
  const add = (q) => {
    const s = String(q || "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (name && road) {
    add(`${name} ${road}`);
    add(`세종 ${name} ${road}`);
  }
  if (name) {
    add(`세종 ${name}`);
    add(name);
  }
  return out;
}

function pickBestPlace(places, r) {
  const hint = displayName(r);
  const road = shortRoad(r).replace(/\s+/g, "");
  let best = null;
  let bestScore = -1;
  places.forEach((p) => {
    let score = nameScore(p.place_name, hint);
    const addr = String(p.road_address_name || p.address_name || "").replace(/\s+/g, "");
    if (road && addr.includes(road.slice(0, 12))) score += 20;
    if (String(p.category_name || "").match(/음식|카페|술집|베이커리|분식/)) score += 6;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return bestScore >= 35 ? best : places[0] || null;
}

function searchKeyword(placesService, query) {
  return new Promise((resolve) => {
    placesService.keywordSearch(
      query,
      (data, status) => {
        if (status === window.kakao.maps.services.Status.OK && data?.length) {
          resolve(data);
          return;
        }
        resolve(null);
      },
      { size: 10 }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function refineRestaurantCoords(restaurants, { dataAsOf = "-", onRefined } = {}) {
  if (!window.kakao?.maps?.services?.Places) return { refined: 0, cached: 0 };

  const cache = loadPoiCache(dataAsOf);
  let cached = 0;
  let refined = 0;

  restaurants.forEach((r) => {
    const cachedLoc = cache[r.restaurant_id];
    if (!cachedLoc?.lat || !cachedLoc?.lng) return;
    r.lat = cachedLoc.lat;
    r.lng = cachedLoc.lng;
    r.geocode_provider = "kakao_kw";
    r.geocode_place_name = cachedLoc.place_name || r.geocode_place_name || "";
    cached += 1;
  });

  const queue = restaurants
    .filter(needsPoiRefine)
    .sort(
      (a, b) =>
        (b.visit_count_total || b.visit_count_6m || 0) -
        (a.visit_count_total || a.visit_count_6m || 0)
    );
  if (!queue.length) return { refined, cached };

  const placesService = new window.kakao.maps.services.Places();

  for (const r of queue) {
    if (cache[r.restaurant_id]?.lat) continue;
    const name = displayName(r);
    const queries = keywordQueries(r);
    let picked = null;

    for (const q of queries) {
      const results = await searchKeyword(placesService, q);
      if (!results?.length) {
        await sleep(REFINE_DELAY_MS);
        continue;
      }
      picked = pickBestPlace(results, r);
      if (picked) break;
      await sleep(REFINE_DELAY_MS);
    }

    if (picked?.y && picked?.x) {
      const lat = parseFloat(picked.y);
      const lng = parseFloat(picked.x);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        r.lat = lat;
        r.lng = lng;
        r.geocode_provider = "kakao_kw";
        r.geocode_place_name = picked.place_name || "";
        cache[r.restaurant_id] = {
          lat,
          lng,
          place_name: picked.place_name || "",
        };
        refined += 1;
        onRefined?.(r);
      }
    }
    await sleep(REFINE_DELAY_MS);
  }

  savePoiCache(dataAsOf, cache);
  return { refined, cached };
}