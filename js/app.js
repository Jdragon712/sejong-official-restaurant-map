import {
  addKakaoMarkersBatched,
  bootstrapKakaoView,
  closeKakaoInfos,
  createKakaoMap,
  loadKakaoSdk,
  openKakaoInfo,
  panKakaoTo,
  relayoutKakaoMap,
  SEJONG_DEFAULT_CENTER,
  SEJONG_OFFICE_VIEW,
  waitForMapContainer,
  waitForWindowReady,
  dropletPinHtml,
  centerMapOn,
  verifyKakaoMapReady,
} from "./map-kakao.js?v=20260707i";
import { refineRestaurantCoords } from "./map-geocode.js?v=20260707i";
import {
  haversineDistanceM,
  mergeOverlappingMarkerItems,
  OVERLAP_VISUAL_RADIUS_M,
} from "./map-overlap-stack.js?v=20260707i";

const SOURCES = [
  ["세종 일반음식점", "https://www.data.go.kr/data/15081905/fileData.do"],
  ["세종 휴게음식점", "https://www.data.go.kr/data/15098456/openapi.do"],
  ["세종 공공기관현황", "https://www.data.go.kr/data/3074664/fileData.do"],
];

const BUCKET_COLOR = { high: "#e85d4c", medium: "#f0a500", low: "#5cb85c" };
const MIN_MAP_VISITS = 10;
/** POI 없고 이 기간 내 업추비가 없으면 폐업·이전으로 보고 지도 마커 제외 */
const STALE_VENUE_MONTHS = 12;
/** 역사 매점·마트·푸드코트 법인명 등 — 식당이 아닌 업추비 결제 상대 */
const RETAIL_VENDOR_RE =
  /코레일\s*유통|코레일유통|하나로\s*마트|하나로마트|농협유통|우리\s*마트|우리마트/i;
/** 이마트 본점·24·에브리데이 결제 (회코너·매장 내 식당 인허가는 제외) */
const IMART_RETAIL_RE =
  /이마트\s*24|이마트24|이마트\s*에브리데이|이마트에브리데이|^(?:㈜|\(주\))?\s*이마트(?:\s*세종|\s*도담|$)|^이마트$/i;
/** 인허가 없이 지명·시설명만 잡힌 업추비 상호 (선운산풍천장어 등 식당은 제외) */
const NON_RESTAURANT_EXACT_NAMES = new Set(["운산"]);
let visitCountField = "visit_count_total";

function visitCount(r) {
  if (!r) return 0;
  return r[visitCountField] ?? r.visit_count_total ?? r.visit_count_6m ?? 0;
}
/** 1~5티어 무지개(빨·주·노·초·파) */
const TIER_COLORS = {
  1: "#FF3B30",
  2: "#FF9500",
  3: "#FFD60A",
  4: "#34C759",
  5: "#007AFF",
};

function tierLabel(tier) {
  return `${tier}티어`;
}
const TIER_ZINDEX = { 1: 7, 2: 6, 3: 5, 4: 4, 5: 2 };
const LIST_CAP = 500;
const LEAFLET_OFFICE_ZOOM = 12;
const FETCH_TIMEOUT_MS = 20000;
const KAKAO_SDK_TIMEOUT_MS = 8000;

let map;
let mapProvider = "leaflet";
let kakaoMaps = null;
let markers = [];
let restaurants = [];
let corpPermitLinks = new Map();
let visitRankMeta = new Map();
let locationClusters = new Map();
let memberVisitsByLocation = new Map();
let linkedVisitsByLocation = new Map();
let mergedMapVenueByKey = new Map();
let mapMarkerCount = 0;
let activeId = null;
let visitMode = false;
let toastTimer = null;
let drawerMarkerItem = null;
let drawerVenues = [];
const ENABLE_MARKER_HOVER = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const CORP_TOKEN_RE = /\(주\)([^()（）]+)|㈜([^()（）]+)|주식회사\s*([^\s,()]+)/g;

function setMapView(lat, lng, zoom = 12) {
  if (!map) return;
  if (mapProvider === "naver") {
    const nv = window.naver?.maps;
    if (nv) {
      map.setCenter(new nv.LatLng(lat, lng));
      map.setZoom(zoom);
    }
  } else if (map.setView) {
    map.setView([lat, lng], zoom, { animate: true });
  }
}

function setMetaStatus(text) {
  if (text) console.info("[map]", text);
  const toast = document.getElementById("map-toast");
  if (toast && text && !text.startsWith("오류")) {
    toast.textContent = "로딩중...";
    toast.classList.add("visible");
  }
}

function clearMetaStatus() {
  const toast = document.getElementById("map-toast");
  if (toast) toast.classList.remove("visible");
}

function getAppBasePath() {
  let path = window.location.pathname || "/";
  if (/\.html?$/i.test(path)) return path.slice(0, path.lastIndexOf("/") + 1);
  if (!path.endsWith("/")) path += "/";
  return path;
}

function resolvePublicUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${getAppBasePath()}${String(path).replace(/^\//, "")}`;
}

async function loadMapConfig() {
  const defaults = {
    kakaoJsKey: "",
    preferKakaoMap: true,
    // Naver Client ID (use ?ncpKeyId=... for the JS SDK per official docs)
    naverClientId: "",
    preferNaverMap: false,
  };
  try {
    const mod = await import("./config.js");
    return { ...defaults, ...(mod.MAP_CONFIG || {}) };
  } catch {
    return defaults;
  }
}

async function loadJson(path, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = resolvePublicUrl(path);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`${path} timeout (${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function locationKey(r) {
  if (!r || r.lat == null || r.lng == null) return null;
  const geo = cleanDisplayField(r.geocode_address);
  if (geo) return `geo:${geo.replace(/\s+/g, "")}`;
  return `ll:${r.lat.toFixed(5)},${r.lng.toFixed(5)}`;
}

function normalizeRestaurantName(name) {
  if (!name) return name;
  let n = String(name);
  // Strip descriptive parts like "소머리국밥" for cleaner names in display and Naver search
  n = n.replace(/소머리국밥/gi, '').replace(/\s+/g, ' ').trim();
  // General spacing normalization for Naver search compatibility
  n = n.replace(/([가-힣])(소머리국밥|국밥|곰탕|찜닭|냉면|갈비|만두|치킨|피자)/gi, '$1 $2');
  n = n.replace(/(나주|삼선미|소머리)(곰탕|국밥)/gi, '$1 $2');
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

/** 상호·주소가 같을 때만 묶음 (좌표만 같고 이름이 다르면 별도 마커) */
function normalizeClusterName(r) {
  const brand = mapDisplayName(r);
  const raw = cleanDisplayField(r.name);
  const base = brand.length >= 2 ? brand : raw;
  return extractCoreName(base).toLowerCase();
}

function normalizeClusterAddress(r) {
  let addr = cleanDisplayField(r.address_road);
  if (!addr) addr = cleanDisplayField(r.geocode_address);
  if (!addr) return "";
  return addr.replace(/세종특별자치시/g, "세종").replace(/\s+/g, "").toLowerCase();
}

/** 도로명+번지만 (층·호·동명 제거) — 동일 건물 판별 */
function buildingAddressKey(r) {
  if (r?._mapBuildingKey) return r._mapBuildingKey;
  let addr = cleanDisplayField(r.address_road);
  if (!addr) addr = cleanDisplayField(r.geocode_address);
  if (!addr) return "";
  const normalized = addr
    .replace(/세종특별자치시|세종특별시|세종시/g, "세종")
    .replace(/\([^)]*\)/g, "")
    .trim();
  const head = normalized.split(",")[0] || normalized;
  const matched = head.match(/^(.*?)(\d+(?:-\d+)?)/);
  const base = matched ? `${matched[1]}${matched[2]}` : head;
  return base.replace(/\s+/g, "").toLowerCase();
}

function brandMergeKey(r) {
  const brand = permitBrandName(r);
  return stripBranchSuffix(extractCoreName(brand)).toLowerCase();
}

/** 업추비 상호 괄호 안 실제 방문처 (예: 세종(송도갈비) → 송도갈비) */
function expenseVisitTarget(r) {
  const name = cleanDisplayField(r.name);
  const m = name.match(/[(\（]([^)）]+)[)\）]/);
  if (!m) return "";
  return stripBranchSuffix(extractCoreName(m[1])).toLowerCase();
}

function normalizedBrandKey(r) {
  const visitTarget = expenseVisitTarget(r);
  if (visitTarget) {
    if (visitTarget.includes("송도갈비")) return "송도갈비";
    return visitTarget;
  }
  const brand = brandMergeKey(r);
  if (brand.includes("송도갈비")) return "송도갈비";
  return brand;
}

/** 카카오맵 POI 상호 (지도 타일 표기와 동일) */
function mapPoiLabel(r) {
  const poi = cleanDisplayField(r?.geocode_place_name);
  return poi.length >= 2 ? poi : "";
}

function parseVisitDate(value) {
  const raw = cleanDisplayField(value);
  if (!raw) return null;
  const parts = raw.split("-").map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function staleCheckMembers(r) {
  if (r._mergedMembers?.length) return r._mergedMembers;
  return [r];
}

/** 방문 횟수가 가장 많은 상호 변형의 최근 방문일 (소수 최신 결제에 끌려가지 않도록) */
function dominantLastVisitDate(r) {
  const members = staleCheckMembers(r);
  const dominant = [...members].sort((a, b) => visitCount(b) - visitCount(a))[0];
  return dominant?.last_visit_date || r.last_visit_date;
}

function lastVisitWithinMonths(r, months) {
  const visited = parseVisitDate(dominantLastVisitDate(r));
  if (!visited) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  cutoff.setHours(0, 0, 0, 0);
  return visited >= cutoff;
}

/** 좌표를 다른 업소에서 빌려온 경우 POI로 치지 않음 */
function hasOwnMapPoi(r) {
  if (r._coordLinkedFrom || r._coordFromCorpToken || r._coordFromExpenseName) return false;
  return mapPoiLabel(r).length >= 2;
}

/** 카카오 POI 없음 + 최근 업추비 없음 → 폐업·이전 추정 */
function isLikelyClosedForMap(r) {
  if (hasOwnMapPoi(r)) return false;
  return !lastVisitWithinMonths(r, STALE_VENUE_MONTHS);
}

function venueNameBlobs(r) {
  return [r.name, r.permit_name, r._displayName, r.geocode_place_name]
    .map(cleanDisplayField)
    .filter(Boolean);
}

/** 회코너·매장 내 음식점 인허가가 있으면 이마트 결제라도 지도에 유지 */
function hasFoodCornerPermit(r) {
  const permit = cleanDisplayField(r.permit_name);
  if (/회코너/i.test(permit)) return true;
  if (permit && !/^(?:\(주\)|㈜)?\s*이마트(?:\s|세종|$)/i.test(permit)) {
    if (
      /음식|식당|베스킨|배스킨|애슐리|화백|숑숑|김선생|돈까스|돈가스|곰탕|냉면|복집|치킨|카페|커피|베이커|제과|아이스크림/i.test(
        permit
      )
    ) {
      return true;
    }
  }
  return false;
}

function isImartRetailRow(row) {
  if (hasFoodCornerPermit(row)) return false;
  return venueNameBlobs(row).some((text) => IMART_RETAIL_RE.test(text));
}

/** 코레일·마트·운산(지명) 등 — 세종 맛집 지도 대상 아님 */
function isNonRestaurantMapVenue(r) {
  return staleCheckMembers(r).some((row) => {
    const name = cleanDisplayField(row.name);
    if (NON_RESTAURANT_EXACT_NAMES.has(name)) return true;
    if (venueNameBlobs(row).some((text) => RETAIL_VENDOR_RE.test(text))) return true;
    if (isImartRetailRow(row)) return true;
    return false;
  });
}

function isExcludedFromMapMarkers(r) {
  return isLikelyClosedForMap(r) || isNonRestaurantMapVenue(r);
}

/** 인허가·업추비 상호 (POI 없을 때) */
function permitBrandName(venue) {
  if (!venue) return "";
  const permit = cleanDisplayField(venue.permit_name);
  if (permit) {
    let brand = permit.split(/\((?:주|유)\)|㈜|주식회사|농업회사법인/u)[0].trim();
    brand = brand
      .replace(/\s*(?:세종|시청|보람|나성|어진|정부청사|청사)?점\s*$/u, "")
      .trim();
    if (brand.length >= 2) return brand;
  }
  return cleanDisplayField(venue.name) || String(venue.name || "");
}

/** 드로어·팝업 표시명 — 카카오 POI → 괄호 방문처 → 인허가 순 */
function mapDisplayName(r) {
  const poi = mapPoiLabel(r);
  if (poi) return normalizeRestaurantName(poi);
  const visitTarget = expenseVisitTarget(r);
  const brand = brandMergeKey(r);
  if (visitTarget && visitTarget !== brand && !brandsAreSimilar(visitTarget, brand)) {
    const raw = cleanDisplayField(r.name);
    const m = raw.match(/[(\（]([^)）]+)[)\）]/);
    if (m) return normalizeRestaurantName(m[1].trim());
  }
  return normalizeRestaurantName(permitBrandName(r));
}

function brandsAreSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.includes(shorter);
}

function poiBuildingMergeKey(r) {
  const building = buildingAddressKey(r);
  const label = extractCoreName(mapDisplayName(r)).toLowerCase();
  if (!building || label.length < 2) return "";
  return `poi:${building}::${label}`;
}

function markerOverlapKey(r) {
  const poiKey = poiBuildingMergeKey(r);
  if (poiKey) return `ob:${poiKey}`;
  const building = buildingAddressKey(r);
  const brand = normalizedBrandKey(r);
  if (building && brand) return `ob:${building}::${brand}`;
  return venueClusterKey(r) || locationKey(r);
}

function venueClusterKey(r) {
  if (!r || r.lat == null || r.lng == null) return null;
  const name = normalizeClusterName(r);
  const addr = normalizeClusterAddress(r);
  if (!name || !addr) return null;
  return `vn:${name}::${addr}`;
}

/** 동일 건물·카카오 POI 상호 우선 합산 (업추비 상호 변형·유사 상호) */
function venueMergeKey(r) {
  if (!r) return null;
  const brand = normalizedBrandKey(r);
  if (brand === "송도갈비") return "brand:송도갈비";
  const poiKey = poiBuildingMergeKey(r);
  if (poiKey) return poiKey;
  const building = buildingAddressKey(r);
  if (building && brand) return `bld:${building}::${brand}`;
  if (r.restaurant_id) return `id:${r.restaurant_id}`;
  const clusterKey = venueClusterKey(r);
  if (clusterKey) return clusterKey;
  return `row:${listRowKey(r)}`;
}

function mergeVenueMemberNames(members, canonical) {
  const label = brandNameFromVenue(canonical);
  return [
    ...new Set(
      members
        .map((row) => cleanDisplayField(row.name))
        .filter((name) => name && name !== label)
    ),
  ];
}

function mergeVenueRows(members) {
  if (!members?.length) return null;
  if (members.length === 1) {
    const row = { ...members[0] };
    row._displayName = row._displayName || mapDisplayName(row);
    return row;
  }

  const canonical = pickCanonicalMember(members);
  const totalVisits = members.reduce((sum, row) => sum + visitCount(row), 0);
  let lastVisit = cleanDisplayField(canonical.last_visit_date) || null;
  members.forEach((row) => {
    const d = cleanDisplayField(row.last_visit_date);
    if (d && (!lastVisit || d > lastVisit)) lastVisit = d;
  });

  const aliasNames = mergeVenueMemberNames(members, canonical);
  return {
    ...canonical,
    _displayName: mapDisplayName(canonical),
    _mergedMembers: members,
    _mergeAliasNames: aliasNames,
    _listKey: canonical._listKey || listRowKey(canonical),
    _clusterKey: canonical._clusterKey || venueClusterKey(canonical),
    name: mapDisplayName(canonical),
    last_visit_date: lastVisit,
    [visitCountField]: totalVisits,
  };
}

function dedupeAndMergeVenues(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = venueMergeKey(row);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.values()].map((members) => mergeVenueRows(members)).filter(Boolean);
}

function sortByVisitRank(a, b) {
  const ta = getVisitRankInfo(a)?.tier ?? 5;
  const tb = getVisitRankInfo(b)?.tier ?? 5;
  return ta - tb || visitCount(b) - visitCount(a) || a.name.localeCompare(b.name, "ko");
}

let buildingCoordIndex = new Map();

function rebuildAddressCoordIndex() {
  buildingCoordIndex = new Map();
  restaurants.forEach((row) => {
    if (row.lat == null || row.lng == null) return;
    const key = buildingAddressKey(row);
    if (!key) return;
    const prev = buildingCoordIndex.get(key);
    if (!prev || visitCount(row) > visitCount(prev)) {
      buildingCoordIndex.set(key, row);
    }
  });
}

function corpTokensFromText(text) {
  const tokens = new Set();
  const raw = cleanDisplayField(text);
  if (!raw) return tokens;
  for (const match of raw.matchAll(CORP_TOKEN_RE)) {
    const piece = extractCoreName(match[1] || match[2] || match[3] || "");
    if (piece.length >= 4) tokens.add(piece);
  }
  const stripped = extractCoreName(raw.replace(/\(주\)|\(유\)|㈜/g, ""));
  if (stripped.length >= 4) tokens.add(stripped);
  return tokens;
}

function resolveCorpTokenCoords(r) {
  const query = corpTokensFromText(r.name);
  if (!query.size) return null;

  let best = null;
  let bestScore = 0;
  restaurants.forEach((x) => {
    if (x.lat == null || x.lng == null) return;
    const blobs = [cleanDisplayField(x.permit_name), cleanDisplayField(x.name)].filter(Boolean);
    blobs.forEach((blob) => {
      corpTokensFromText(blob).forEach((token) => {
        query.forEach((q) => {
          if (q === token || (q.length >= 4 && token.includes(q)) || (token.length >= 4 && q.includes(token))) {
            const score = 100 + visitCount(x);
            if (score > bestScore) {
              bestScore = score;
              best = x;
            }
          }
        });
      });
    });
  });
  return best;
}

function resolveExpenseNameCoords(r) {
  const target = expenseVisitTarget(r);
  if (!target || target.length < 3) return null;

  let best = null;
  let bestScore = 0;
  restaurants.forEach((x) => {
    if (x.lat == null || x.lng == null) return;
    const labels = [
      normalizedBrandKey(x),
      brandMergeKey(x),
      extractCoreName(cleanDisplayField(x.name)).toLowerCase(),
    ];
    labels.forEach((label) => {
      if (!label) return;
      let score = 0;
      if (label === target) score = 120;
      else if (label.includes(target) || target.includes(label)) score = 80;
      if (score > bestScore) {
        bestScore = score;
        best = x;
      }
    });
  });
  return bestScore >= 80 ? best : null;
}

function expenseVisitOverridesPermit(r) {
  const target = expenseVisitTarget(r);
  if (!target || target.length < 3) return false;
  const permitBrands = [
    brandMergeKey(r),
    extractCoreName(cleanDisplayField(r.permit_name || "")).toLowerCase(),
  ].filter(Boolean);
  return !permitBrands.some((brand) => brand.includes(target) || target.includes(brand));
}

function linkFromCoordPeer(r, src, { flag } = {}) {
  const poi = mapPoiLabel(src) || mapPoiLabel(r);
  const linked = {
    ...r,
    lat: src.lat,
    lng: src.lng,
    geocode_address:
      src.geocode_address || cleanDisplayField(src.address_road) || r.geocode_address,
    geocode_place_name: poi || r.geocode_place_name || "",
    _mapBuildingKey: buildingAddressKey(src),
    _coordLinkedFrom: permitBrandName(src) || permitBrandName(r),
    _displayName: poi || mapDisplayName(src),
  };
  if (flag) linked[flag] = true;
  return snapToBuildingCoord(linked);
}

function linkFromExpensePeer(r, expenseHit) {
  return linkFromCoordPeer(r, expenseHit, { flag: "_coordFromExpenseName" });
}

function snapToBuildingCoord(r) {
  if (!r || r.lat == null || r.lng == null) return r;
  // 카카오 키워드 POI는 건물 대표 좌표로 스냅하면 핀이 몰려 마커가 안 보이는 것처럼 보임
  if (r.geocode_provider === "kakao_kw" && mapPoiLabel(r)) return r;
  const bldKey = buildingAddressKey(r);
  if (!bldKey || !buildingCoordIndex.has(bldKey)) return r;
  const src = buildingCoordIndex.get(bldKey);
  if (src?.lat == null || src?.lng == null) return r;
  return { ...r, lat: src.lat, lng: src.lng };
}

/** 좌표 없으면 괄호 방문처 → 동일 건물·유사 브랜드 → 정확 인허가 연결 순으로 보강 */
function resolveVenueCoords(r) {
  if (!r) return r;

  if (r.lat != null && r.lng != null) {
    if (expenseVisitOverridesPermit(r)) {
      const expenseHit = resolveExpenseNameCoords(r);
      if (expenseHit) return linkFromExpensePeer(r, expenseHit);
    }
    return snapToBuildingCoord(r);
  }

  const expenseHit = resolveExpenseNameCoords(r);
  if (expenseHit) {
    return linkFromExpensePeer(r, expenseHit);
  }

  const corpHit = resolveCorpTokenCoords(r);
  if (corpHit) {
    return linkFromCoordPeer(r, corpHit, { flag: "_coordFromCorpToken" });
  }

  const bldKey = buildingAddressKey(r);
  if (bldKey && buildingCoordIndex.has(bldKey)) {
    const src = buildingCoordIndex.get(bldKey);
    if (brandsAreSimilar(brandMergeKey(r), brandMergeKey(src))) {
      return linkFromCoordPeer(r, src);
    }
  }

  const { mapTarget } = resolveMapTarget(r, { forCoords: true });
  if (mapTarget?.lat != null && mapTarget?.lng != null) {
    return linkFromCoordPeer(r, mapTarget);
  }

  return snapToBuildingCoord(r);
}

function isMapMarkerVenue(r) {
  const resolved = resolveVenueCoords(r);
  return (
    resolved.lat != null &&
    resolved.lng != null &&
    (visitCount(resolved) || 0) >= MIN_MAP_VISITS &&
    !isExcludedFromMapMarkers(resolved)
  );
}

function prepareIndividualMarkerItem(r) {
  const row = { ...r };
  row._displayName = row._displayName || mapDisplayName(row);
  row._clusterKey = row._clusterKey || venueClusterKey(row);
  row._listKey = row._listKey || listRowKey(row);
  row._overlapKey = row._overlapKey || markerOverlapKey(row);
  row._isStackMarker = false;
  return row;
}

function buildStackMarkerItem(members) {
  const deduped = dedupeAndMergeVenues(members);
  const sorted = [...deduped].sort(sortByVisitRank);
  const anchor = sorted[0];
  const stackKey = `overlap:${anchor.restaurant_id}:${sorted.length}`;
  return {
    ...anchor,
    lat: anchor.lat,
    lng: anchor.lng,
    restaurant_id: stackKey,
    _isStackMarker: true,
    _stackMembers: sorted,
    _clusterKey: stackKey,
    _listKey: stackKey,
    _displayName: `이 위치 ${sorted.length}곳`,
  };
}

/** 방문 10회+ & 좌표(직접·연결) 있는 업소 → 티어 마커 + 겹침 무지개 */
function restaurantsForMapMarkers() {
  const resolved = restaurants
    .map((r) => resolveVenueCoords(r))
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => prepareIndividualMarkerItem(r));
  const deduped = dedupeAndMergeVenues(resolved)
    .filter((r) => visitCount(r) >= MIN_MAP_VISITS)
    .filter((r) => !isExcludedFromMapMarkers(r));

  return mergeOverlappingMarkerItems(deduped, {
    prepareIndividual: prepareIndividualMarkerItem,
    buildStackItem: buildStackMarkerItem,
    shouldCluster: shouldStackMapMarkers,
  });
}

function venuesForMarkerItem(item) {
  if (item._stackMembers?.length) {
    return dedupeAndMergeVenues(item._stackMembers).sort(sortByVisitRank);
  }
  return [item];
}

function pickCanonicalMember(members) {
  return [...members].sort((a, b) => {
    const score = (row) => {
      const brand = brandNameFromVenue(row);
      let s = visitCount(row);
      if (row.name === brand) s += 10000;
      if (cleanDisplayField(row.permit_name)) s += 1000;
      if (brand.length >= 2 && row.name.includes(brand)) s += 500;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

function buildLocationClusters() {
  locationClusters = new Map();
  restaurants.forEach((row) => {
    const key = venueClusterKey(row);
    if (!key) return;
    if (!locationClusters.has(key)) {
      locationClusters.set(key, { locationKey: key, members: [] });
    }
    locationClusters.get(key).members.push(row);
  });
}

function rebuildLocationVisitCaches() {
  memberVisitsByLocation = new Map();
  locationClusters.forEach((cluster) => {
    const total = cluster.members.reduce((sum, row) => sum + visitCount(row), 0);
    memberVisitsByLocation.set(cluster.locationKey, total);
  });

  linkedVisitsByLocation = new Map();
  restaurants.forEach((row) => {
    if (row.lat != null && row.lng != null) return;
    const { mapTarget, linkedFrom } = resolveMapTarget(row);
    if (!linkedFrom || !mapTarget) return;
    const key = venueClusterKey(mapTarget);
    if (!key) return;
    const visits = visitCount(linkedFrom);
    linkedVisitsByLocation.set(key, Math.max(linkedVisitsByLocation.get(key) || 0, visits));
  });
}

function clusterEffectiveVisits(members) {
  const key = venueClusterKey(members[0]);
  const direct = members.reduce((sum, row) => sum + visitCount(row), 0);
  if (!key) return direct;
  return direct + (linkedVisitsByLocation.get(key) || 0);
}

function buildMergedMapVenue(cluster) {
  const merged = mergeVenueRows(cluster.members);
  return {
    ...merged,
    restaurant_id: `loc:${cluster.locationKey}`,
    _clusterKey: cluster.locationKey,
    _clusterMembers: cluster.members,
    _selectId: merged.restaurant_id,
    _listKey: `loc:${cluster.locationKey}`,
  };
}

function getClusterForVenue(r) {
  const key = venueClusterKey(r);
  if (!key) return null;
  return locationClusters.get(key) || null;
}

function getMergedMapVenue(cluster) {
  const cached = mergedMapVenueByKey.get(cluster.locationKey);
  if (cached) return cached;
  const merged = buildMergedMapVenue(cluster);
  mergedMapVenueByKey.set(cluster.locationKey, merged);
  return merged;
}

function buildVisitRankMeta() {
  const ranked = [];
  mergedMapVenueByKey = new Map();
  locationClusters.forEach((cluster) => {
    const visits = clusterEffectiveVisits(cluster.members);
    if (visits >= MIN_MAP_VISITS) {
      ranked.push({ locationKey: cluster.locationKey, visits });
    }
  });

  ranked.sort((a, b) => b.visits - a.visits || a.locationKey.localeCompare(b.locationKey));

  visitRankMeta = new Map();
  ranked.forEach(({ locationKey: key, visits }, index) => {
    const rank = index + 1;
    let tier = 5;
    if (rank <= 20) tier = 1;
    else if (rank <= 50) tier = 2;
    else if (rank <= 100) tier = 3;
    else if (rank <= 200) tier = 4;
    visitRankMeta.set(key, { rank, tier, visits, locationKey: key });
  });
  mapMarkerCount = ranked.length;
}

function getVisitRankInfo(r) {
  const key = r._clusterKey || venueClusterKey(r);
  if (key && visitRankMeta.has(key)) return visitRankMeta.get(key);
  return null;
}

function findMapMarker(mapTarget) {
  const rid = mapTarget.restaurant_id;
  const direct = markers.find((m) => m._rid === rid);
  if (direct) return direct;
  const rowKey = mapTarget._listKey || listRowKey(mapTarget);
  const byListKey = markers.find((m) => m._listKey === rowKey);
  if (byListKey) return byListKey;
  const relatedIds = new Set([rid]);
  mapTarget._mergedMembers?.forEach((row) => relatedIds.add(row.restaurant_id));
  mapTarget._clusterMembers?.forEach((row) => relatedIds.add(row.restaurant_id));
  const inStack = markers.find((m) => m._stackRids?.some((id) => relatedIds.has(id)));
  if (inStack) return inStack;
  return null;
}

function getMarkerStyle(r) {
  if (r._isStackMarker) {
    return { tier: "rainbow", isStack: true, rank: null, color: null, zIndex: 8 };
  }
  const info = getVisitRankInfo(r);
  const tier = info?.tier ?? 5;
  if (r._coordLinkedFrom) {
    return {
      tier,
      rank: info?.rank ?? null,
      color: TIER_COLORS[tier] || TIER_COLORS[5],
      zIndex: Math.max(2, (TIER_ZINDEX[tier] || 2) - 1),
    };
  }
  return {
    tier,
    rank: info?.rank ?? null,
    color: TIER_COLORS[tier] || TIER_COLORS[5],
    zIndex: TIER_ZINDEX[tier] || TIER_ZINDEX[5],
  };
}

function markerColor(r) {
  return getMarkerStyle(r).color;
}

/** 지도와 동일: 상호·주소가 같을 때만 1행 (이름이 다르면 각각 표시) */
function restaurantsForList() {
  const items = [];
  locationClusters.forEach((cluster) => {
    if (cluster.members.length > 1) {
      items.push(getMergedMapVenue(cluster));
      return;
    }
    const row = cluster.members[0];
    row._listKey = listRowKey(row);
    items.push(row);
  });
  restaurants.forEach((row) => {
    if (venueClusterKey(row)) return;
    row._listKey = listRowKey(row);
    items.push(row);
  });
  return items;
}

function venueMatchesQuery(r, q) {
  const blobs = [
    r.name,
    r._displayName,
    cleanDisplayField(r.address_road),
    cleanDisplayField(r.geocode_address),
    cleanDisplayField(r.permit_name),
  ];
  if (r._clusterMembers) {
    r._clusterMembers.forEach((m) => {
      blobs.push(m.name, m.permit_name, m.address_road, m.geocode_address);
    });
  } else {
    const { label } = displayVenueLabel(r);
    blobs.push(label);
  }
  return blobs
    .map((s) => String(s || "").toLowerCase())
    .filter(Boolean)
    .some((s) => s.includes(q));
}

function listSubtextForVenue(r, { label, isLinked }) {
  const members = r._clusterMembers;
  const cat = formatVenueCategory(r.category_app);
  const catLabel =
    cat?.cuisine ||
    (cat?.type !== "일반음식점" && cat?.type !== "휴게음식점" ? cat?.label : "");

  if (members && members.length > 1) {
    const addr =
      cleanDisplayField(r.geocode_address) ||
      cleanDisplayField(r.address_road).slice(0, 48);
    const visitLine = visitMode ? ` · 최근 방문 ${r.last_visit_date || "-"}` : "";
    const cuisineLine = catLabel && !visitMode ? ` · ${catLabel}` : "";
    return `이 위치 ${members.length}곳 · ${addr}${visitLine}${cuisineLine}`;
  }

  return visitMode
    ? [catLabel, `최근 방문 ${r.last_visit_date || "-"}`].filter(Boolean).join(" · ")
    : [catLabel || cleanDisplayField(r.category_app), cleanDisplayField(r.address_road).slice(0, 42)]
        .filter(Boolean)
        .join(" · ");
}

function cleanDisplayField(value) {
  const s = String(value ?? "").trim();
  return s && s.toLowerCase() !== "nan" ? s : "";
}

/** 인허가 업종명 → 음식점 유형·요리 종류 (대표메뉴 데이터는 없음) */
function formatVenueCategory(raw) {
  const text = cleanDisplayField(raw);
  if (!text) return null;
  const parts = text.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const sole = parts[0] || text;
    if (sole === "일반음식점" || sole === "휴게음식점") {
      return { type: sole, cuisine: null, label: sole };
    }
    return { type: sole, cuisine: sole, label: sole };
  }
  const type = parts[0];
  const cuisine = parts.slice(1).join(" · ");
  return { type, cuisine, label: cuisine };
}

function extractCoreName(name) {
  return String(name)
    .replace(/\(주\)|\(유\)|㈜|주식회사|농업회사법인/g, "")
    .replace(/[()（）]/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function stripBranchSuffix(core) {
  return String(core)
    .replace(
      /본점|지점|세종시청점|시청점|세종보람점|보람점|세종점|나성점|어진점|정부청사점|청사점|소담점|종촌점|외\d+개소?$/g,
      ""
    )
    .replace(/점$/g, "");
}

function linkNameVariants(name) {
  const core = extractCoreName(name);
  const variants = new Set([core]);
  const stripped = stripBranchSuffix(core);
  if (stripped.length >= 3) variants.add(stripped);
  return [...variants].filter((v) => v.length >= 3);
}

function registerCorpLink(token, target) {
  if (!token || token.length < 3 || target.lat == null) return;
  const prev = corpPermitLinks.get(token);
  if (!prev || visitCount(target) > visitCount(prev)) {
    corpPermitLinks.set(token, target);
  }
}

function buildCorpPermitLinks() {
  corpPermitLinks = new Map();
  restaurants.forEach((row) => {
    if (row.lat == null) return;
    const blobs = [cleanDisplayField(row.permit_name), cleanDisplayField(row.name)].filter(Boolean);
    blobs.forEach((blob) => {
      corpTokensFromText(blob).forEach((token) => registerCorpLink(token, row));
      const core = extractCoreName(blob);
      if (core.length >= 4 && blob.replace(/\s+/g, "").includes(core)) {
        registerCorpLink(core, row);
      }
    });
  });
}

function scoreLinkCandidate(queryVariants, x) {
  const labels = [
    cleanDisplayField(x.permit_name),
    cleanDisplayField(x.name),
    cleanDisplayField(x.address_road),
  ]
    .filter(Boolean)
    .map((s) => s.replace(/\s+/g, ""));

  let best = 0;
  queryVariants.forEach((query) => {
    labels.forEach((label) => {
      if (!label || !query) return;
      if (label === query) best = Math.max(best, 120 + visitCount(x));
      else if (label.includes(query)) best = Math.max(best, 80 + visitCount(x));
      else if (query.includes(label) && label.length >= 4) {
        best = Math.max(best, 70 + label.length + visitCount(x));
      }
    });
  });
  return best;
}

function mapTargetsShareBuilding(a, b) {
  const keyA = buildingAddressKey(a);
  const keyB = buildingAddressKey(b);
  return Boolean(keyA && keyB && keyA === keyB);
}

/** 지도 핀이 실제로 겹칠 때만 스택 (주소 같다고 묶지 않음) */
function shouldStackMapMarkers(a, b) {
  return haversineDistanceM(a, b) <= OVERLAP_VISUAL_RADIUS_M;
}

function isExactMapLink(r, target, score) {
  if (!target) return false;
  if (score >= 120) return true;
  return mapTargetsShareBuilding(r, target) && brandsAreSimilar(brandMergeKey(r), brandMergeKey(target));
}

function resolveMapTarget(r, { forCoords = false } = {}) {
  if (r.lat != null && r.lng != null) {
    return { mapTarget: r, linkedFrom: null };
  }

  const variants = linkNameVariants(r.name);
  for (const core of variants) {
    const indexed = corpPermitLinks.get(core);
    if (!indexed) continue;
    const score = scoreLinkCandidate(variants, indexed);
    if (!forCoords || isExactMapLink(r, indexed, score)) {
      return { mapTarget: indexed, linkedFrom: r };
    }
  }

  if (forCoords) {
    return { mapTarget: null, linkedFrom: r };
  }

  let best = null;
  let bestScore = 0;
  restaurants.forEach((x) => {
    if (x.lat == null || x.restaurant_id === r.restaurant_id) return;
    const score = scoreLinkCandidate(variants, x);
    if (score > bestScore) {
      bestScore = score;
      best = x;
    }
  });
  if (best && bestScore >= 70) {
    return { mapTarget: best, linkedFrom: r };
  }

  return { mapTarget: null, linkedFrom: r };
}

/** 카카오맵·인허가 기준 노출 상호 (POI 우선, 법인명→체인점 연결 시 브랜드명) */
function brandNameFromVenue(venue) {
  return mapDisplayName(venue);
}

function kakaoLabelForVenue(venue) {
  const cluster = getClusterForVenue(venue);
  if (cluster && cluster.members.length > 1) {
    return mapDisplayName(pickCanonicalMember(cluster.members));
  }
  return mapDisplayName(venue);
}

function displayVenueLabel(r) {
  const { mapTarget, linkedFrom } = resolveMapTarget(r);
  if (linkedFrom && mapTarget) {
    return {
      label: kakaoLabelForVenue(mapTarget),
      mapTarget,
      linkedFrom,
      isLinked: true,
    };
  }
  const target = r.lat != null ? r : mapTarget;
  const label = target ? kakaoLabelForVenue(target) : r.name;
  return {
    label,
    mapTarget: target,
    linkedFrom: null,
    isLinked: false,
  };
}

/** 카카오맵 웹에서 장소 카드(평점·사진)를 열 URL — link/map(좌표만)은 미니 팝업만 뜸 */
function kakaoSearchQueryForVenue(r) {
  const name = mapPoiLabel(r) || r._displayName || brandNameFromVenue(r);
  const road = cleanDisplayField(r.address_road) || cleanDisplayField(r.geocode_address);
  const head = road ? road.split(",")[0].trim() : "";
  if (name && head) return `${name} ${head}`;
  if (name) return `세종 ${name}`;
  return head || name || "";
}

function kakaoMapUrlForVenue(r) {
  const placeId = cleanDisplayField(r.geocode_place_id);
  if (placeId) {
    return `https://map.kakao.com/?itemId=${encodeURIComponent(placeId)}`;
  }
  const q = kakaoSearchQueryForVenue(r);
  if (q) {
    return `https://map.kakao.com/link/search/${encodeURIComponent(q)}`;
  }
  if (r.lat != null && r.lng != null) {
    const label = r._displayName || brandNameFromVenue(r);
    return `https://map.kakao.com/link/map/${encodeURIComponent(label)},${r.lat},${r.lng}`;
  }
  return "https://map.kakao.com/";
}

function kakaoMapLinkHtml(r, className) {
  if (r.lat == null || r.lng == null) return "";
  const name = mapPoiLabel(r) || r._displayName || brandNameFromVenue(r);
  const road = cleanDisplayField(r.address_road) || cleanDisplayField(r.geocode_address);
  const placeId = cleanDisplayField(r.geocode_place_id);
  const attrs = [
    `class="${className} kakao-map-open"`,
    `href="${escapeHtml(kakaoMapUrlForVenue(r))}"`,
    'target="_blank"',
    'rel="noopener"',
    `data-kakao-name="${escapeHtml(name)}"`,
    road ? `data-kakao-road="${escapeHtml(road.split(",")[0].trim())}"` : "",
    placeId ? `data-kakao-place-id="${escapeHtml(placeId)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<a ${attrs}>카카오맵에서 열기</a>`;
}

/** Naver Maps search query — 식당 이름 중심으로 검색.
 * 세종시 네이버 지도 특성: 식당이름만 정확해도 위치(세종) 기반으로 주변부터 검색됨.
 * 단, 이름만으로 안 나오는 경우(은주식당 등 조치원/소규모)는 주소 힌트(읍/길) 추가.
 */
function naverSearchQueryForVenue(r) {
  // Prefer geocode_place_name (from Kakao POI) as it is often the name Naver also recognizes.
  let base = cleanDisplayField(r.geocode_place_name);
  if (!base) {
    const display = mapDisplayName(r) || mapPoiLabel(r) || brandNameFromVenue(r) || cleanDisplayField(r.name) || "";
    let searchDisplay = display.replace(/\s*\([A-Za-z][^)]*\)/g, '').trim();
    const core = extractCoreName(searchDisplay);
    base = stripBranchSuffix(core);
    base = base.replace(/본점|지점|본$/g, "").replace(/\s+/g, " ").trim();
    if (base.length < 2) base = core.replace(/본점|지점/g, "").trim();
  }

  if (!base) {
    const road = cleanDisplayField(r.address_road) || cleanDisplayField(r.geocode_address) || "";
    const short = road ? road.split(",")[0].trim() : "";
    return short ? `세종 ${short}` : "";
  }

  base = normalizeRestaurantName(base);

  let q = /세종/i.test(base) ? base : `세종 ${base}`;

  // 이름만으로 검색 안 되는 경우(은주식당 등) → Naver는 이름 검색이 약하니 주소 중심으로
  const road = cleanDisplayField(r.address_road) || cleanDisplayField(r.geocode_address) || "";
  const isHardCase = base.length <= 6 || road.includes('조치원') || road.includes('침천');
  if (isHardCase && road) {
    // 주소로 직접 검색하면 위치는 정확히 나옴 (비즈니스 핀이 없어도 지도 중심 이동)
    const shortRoad = road.replace(/세종특별자치시\s*/, '').split(',')[0].trim();
    if (shortRoad) {
      q = shortRoad;   // e.g. "조치원읍 침천길 15"
    } else if (!q.includes('조치원')) {
      q = `${base} 조치원읍`;
    }
  }

  return q;
}

function naverMapUrlForVenue(r) {
  const q = naverSearchQueryForVenue(r);
  if (q) {
    return `https://map.naver.com/p/search/${encodeURIComponent(q)}`;
  }
  if (r.lat != null && r.lng != null) {
    const label = mapDisplayName(r) || brandNameFromVenue(r) || r.name;
    return `https://map.naver.com/p/search/${encodeURIComponent(label)}`;
  }
  return "https://map.naver.com/";
}

function naverMapLinkHtml(r, className) {
  if (r.lat == null || r.lng == null) return "";
  const name = normalizeRestaurantName(mapDisplayName(r) || brandNameFromVenue(r));
  const url = naverMapUrlForVenue(r);
  const attrs = [
    `class="${className} naver-map-open"`,
    `href="${escapeHtml(url)}"`,
    'target="_blank"',
    'rel="noopener"',
    `data-naver-name="${escapeHtml(name)}"`,
  ]
    .filter(Boolean)
    .join(" ");
  return `<a ${attrs}>네이버 지도에서 열기</a>`;
}

function externalMapLinkHtml(r, className) {
  if (!r || r.lat == null) return "";
  const kakaoLink = kakaoMapLinkHtml(r, className);
  if (mapProvider === "naver") {
    const naverLink = naverMapLinkHtml(r, className);
    // 네이버 링크가 있어도 Kakao를 항상 보조로 제공 (은주식당처럼 네이버에 없는 경우 대비)
    if (naverLink && kakaoLink) {
      return `${naverLink} · ${kakaoLink}`;
    }
    return naverLink || kakaoLink;
  }
  return kakaoLink;
}

function kakaoPlaceSearchOnce(placesService, query) {
  return new Promise((resolve) => {
    placesService.keywordSearch(
      query,
      (data, status) => {
        if (status === window.kakao?.maps?.services?.Status?.OK && data?.length) {
          resolve(data);
          return;
        }
        resolve(null);
      },
      { size: 10 }
    );
  });
}

function kakaoPickPlaceId(places, r) {
  if (!places?.length) return null;
  const hint = mapPoiLabel(r) || r._displayName || brandNameFromVenue(r);
  const road = (cleanDisplayField(r.address_road) || cleanDisplayField(r.geocode_address))
    .replace(/\s+/g, "");
  let best = null;
  let bestScore = -1;
  places.forEach((p) => {
    if (!p?.id) return;
    const place = String(p.place_name || "").replace(/\s+/g, "");
    const target = String(hint || "").replace(/\s+/g, "");
    let score = 0;
    if (place && target) {
      if (place === target) score = 120;
      else if (place.includes(target) || target.includes(place)) score = 80;
    }
    const addr = String(p.road_address_name || p.address_name || "").replace(/\s+/g, "");
    if (road && addr.includes(road.slice(0, 14))) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return bestScore >= 35 ? best?.id : places[0]?.id || null;
}

async function resolveKakaoPlaceIdForVenue(r) {
  const cached = cleanDisplayField(r.geocode_place_id);
  if (cached) return cached;
  if (!window.kakao?.maps?.services?.Places) return null;
  const placesService = new window.kakao.maps.services.Places();
  const name = mapPoiLabel(r) || r._displayName || brandNameFromVenue(r);
  const road = cleanDisplayField(r.address_road) || cleanDisplayField(r.geocode_address);
  const head = road ? road.split(",")[0].trim() : "";
  const queries = [];
  const seen = new Set();
  const add = (q) => {
    const s = String(q || "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    queries.push(s);
  };
  if (name && head) {
    add(`${name} ${head}`);
    add(`세종 ${name} ${head}`);
  }
  if (name) {
    add(`세종 ${name}`);
    add(name);
  }
  for (const q of queries) {
    const results = await kakaoPlaceSearchOnce(placesService, q);
    const id = kakaoPickPlaceId(results, r);
    if (id) {
      r.geocode_place_id = id;
      return id;
    }
  }
  return null;
}

async function openKakaoMapForVenue(r) {
  const placeId = await resolveKakaoPlaceIdForVenue(r);
  const url = placeId
    ? `https://map.kakao.com/?itemId=${encodeURIComponent(placeId)}`
    : kakaoMapUrlForVenue(r);
  window.open(url, "_blank", "noopener");
}

function setupKakaoMapLinkHandler() {
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a.kakao-map-open");
    if (!link || link.dataset.kakaoPlaceId) return;
    if (!window.kakao?.maps?.services?.Places) return;
    e.preventDefault();
    const venue = {
      geocode_place_id: link.dataset.kakaoPlaceId || "",
      geocode_place_name: link.dataset.kakaoName || "",
      _displayName: link.dataset.kakaoName || "",
      address_road: link.dataset.kakaoRoad || "",
      geocode_address: link.dataset.kakaoRoad || "",
      lat: 0,
      lng: 0,
    };
    openKakaoMapForVenue(venue);
  });
}

function showMapToast(message, ms = 4200) {
  const el = document.getElementById("map-toast");
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = message;
  el.classList.add("visible");
  toastTimer = setTimeout(() => el.classList.remove("visible"), ms);
}

function buildPopupHtml(r, { linkedFrom = null } = {}) {
  const displayName = r._displayName || brandNameFromVenue(r);
  const visitSource = linkedFrom || r;
  const rankInfo = getVisitRankInfo(r);
  const visits = linkedFrom
    ? visitCount(linkedFrom)
    : visitCount(visitSource) ?? rankInfo?.visits;
  const visit =
    visitMode && visits != null
      ? `<span class="card-visit">방문 ${visits}회</span>`
      : "";
  const tierBadge =
    visitMode && rankInfo
      ? `<span class="card-rank tier-${rankInfo.tier}">${escapeHtml(tierLabel(rankInfo.tier))}</span>`
      : "";
  const cat = formatVenueCategory(r.category_app);
  const categoryLine = cat
    ? cat.cuisine
      ? `<div class="card-category"><span class="card-cuisine">${escapeHtml(cat.cuisine)}</span><span class="card-license">${escapeHtml(cat.type)}</span></div>`
      : `<div class="card-category"><span class="card-license">${escapeHtml(cat.label)}</span></div>`
    : "";
  const addr = cleanDisplayField(r.address_road) || cleanDisplayField(r.geocode_address) || "";
  const link = externalMapLinkHtml(r, "card-link");
  return `<div class="map-popup-card">
    <div class="card-head">
      <p class="card-title">${escapeHtml(displayName)}</p>
      <div class="card-badges">${visit}${tierBadge}</div>
    </div>
    <div class="card-body">
      ${categoryLine}
      ${addr ? `<p class="card-addr">${escapeHtml(addr)}</p>` : ""}
      ${link}
    </div>
  </div>`;
}

function fitInitialView() {
  if (mapProvider === "kakao" && kakaoMaps) {
    bootstrapKakaoView(kakaoMaps, map, SEJONG_OFFICE_VIEW);
    return;
  }
  if (mapProvider === "naver" && map) {
    const nv = window.naver?.maps;
    if (nv) {
      map.setCenter(new nv.LatLng(SEJONG_OFFICE_VIEW.lat, SEJONG_OFFICE_VIEW.lng));
      map.setZoom(LEAFLET_OFFICE_ZOOM);
    }
    return;
  }
  if (map) {
    setMapView(SEJONG_OFFICE_VIEW.lat, SEJONG_OFFICE_VIEW.lng, LEAFLET_OFFICE_ZOOM);
    if (map.invalidateSize) map.invalidateSize();
  }
}

function setupMapResize() {
  let timer;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (mapProvider === "kakao" && map) {
        relayoutKakaoMap(map);
      } else if (mapProvider === "naver" && map) {
        // Naver handles resize automatically; nudge center to refresh
        map.setCenter(map.getCenter());
      } else if (map?.invalidateSize) {
        map.invalidateSize();
        setMapView(SEJONG_OFFICE_VIEW.lat, SEJONG_OFFICE_VIEW.lng, LEAFLET_OFFICE_ZOOM);
      }
    }, 150);
  });
}

function initLeafletMap(center) {
  mapProvider = "leaflet";
  map = L.map("map", { zoomControl: true }).setView(
    [SEJONG_OFFICE_VIEW.lat, SEJONG_OFFICE_VIEW.lng],
    LEAFLET_OFFICE_ZOOM
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap",
    maxZoom: 19,
  }).addTo(map);
}

async function initKakaoMap(jsKey) {
  await waitForWindowReady();
  await waitForMapContainer("map");
  kakaoMaps = await loadKakaoSdk(jsKey, KAKAO_SDK_TIMEOUT_MS);
  mapProvider = "kakao";
  map = createKakaoMap(kakaoMaps, SEJONG_OFFICE_VIEW);
  const ready = await verifyKakaoMapReady("map", 3000);
  if (!ready) {
    throw new Error("Kakao map tiles did not load (check Web domain whitelist)");
  }
}

function loadNaverSdk(clientId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error("naverClientId missing"));
      return;
    }
    if (window.naver?.maps?.Map) {
      resolve(window.naver.maps);
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
      finish(reject, new Error(`Naver Maps SDK load timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const script = document.createElement("script");
    // Use the new unified NCP format as per official getting started:
    // https://navermaps.github.io/maps.js.ncp/docs/tutorial-2-Getting-Started.html
    // New: ?ncpKeyId= (unified for personal/general)
    // Old ncpClientId / gov / fin are deprecated.
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(clientId)}`;
    script.async = true;
    script.onload = () => {
      if (window.naver?.maps?.Map) {
        finish(resolve, window.naver.maps);
      } else {
        finish(reject, new Error("Naver Maps SDK loaded but naver.maps missing"));
      }
    };
    script.onerror = (e) => {
      console.error('[Naver] Script load error details:', e);
      finish(reject, new Error("Naver Maps SDK load failed"));
    };
    document.head.appendChild(script);

    // Recommended in official docs for auth failure detection
    window.navermap_authFailure = function () {
      console.error('Naver Maps auth failed (navermap_authFailure). Check Client ID and registered Web 서비스 URLs.');
    };
  });
}

async function initNaverMap(clientId) {
  await waitForWindowReady();
  await waitForMapContainer("map");
  const naverMaps = await loadNaverSdk(clientId);
  mapProvider = "naver";
  map = new naverMaps.Map("map", {
    center: new naverMaps.LatLng(SEJONG_OFFICE_VIEW.lat, SEJONG_OFFICE_VIEW.lng),
    zoom: 12,
    mapTypeControl: true,
    mapTypeControlOptions: {
      position: naverMaps.Position.TOP_RIGHT,
    },
    zoomControl: true,
    zoomControlOptions: {
      position: naverMaps.Position.RIGHT_BOTTOM,
      style: naverMaps.ZoomControlStyle.SMALL,
    },
    scaleControl: true,
  });

  // Mobile-friendly zoom control positioning: move to bottom-right, a bit lower
  // to avoid overlap with category pills, Naver badge, drawer, or attribution.
  setTimeout(() => {
    try {
      const mapEl = document.getElementById('map');
      if (!mapEl) return;
      const controls = mapEl.querySelectorAll(':scope > div');
      controls.forEach((ctrl) => {
        const style = ctrl.getAttribute('style') || '';
        if (style.includes('position: absolute') && style.includes('right:')) {
          if (window.innerWidth <= 768) {
            const h = ctrl.offsetHeight || 0;
            if (h > 35) {
              // Zoom control (taller) - lower it a bit
              ctrl.style.bottom = '58px';
              ctrl.style.top = 'auto';
              ctrl.style.right = '8px';
            } else {
              // Scale / small controls - keep very bottom
              ctrl.style.bottom = '8px';
              ctrl.style.top = 'auto';
              ctrl.style.right = '8px';
            }
          }
        }
      });
    } catch (e) {}
  }, 350);
}

function closeOpenPopups() {
  if (mapProvider === "kakao") {
    closeKakaoInfos(markers);
  }
}

function clearMarkers() {
  if (mapProvider === "kakao") {
    closeKakaoInfos(markers);
    markers.forEach((m) => {
      m.overlay.setMap(null);
    });
  } else if (mapProvider === "naver" && map) {
    markers.forEach((m) => {
      if (m.setMap) m.setMap(null);
    });
  } else if (map) {
    markers.forEach((m) => map.removeLayer(m));
  }
  markers = [];
}

function buildInlineDetailHtml(r, { linkedFrom = null } = {}) {
  const displayName = r._displayName || brandNameFromVenue(r);
  const rankInfo = getVisitRankInfo(r);
  const visits = linkedFrom ? visitCount(linkedFrom) : visitCount(r);
  const tierBadge =
    visitMode && rankInfo
      ? `<span class="panel-tier tier-${rankInfo.tier}">${escapeHtml(tierLabel(rankInfo.tier))}</span>`
      : "";
  const visitBadge =
    visitMode && visits != null ? `<span class="panel-visit">방문 ${visits}회</span>` : "";
  const cat = formatVenueCategory(r.category_app);
  const categoryLine = cat
    ? cat.cuisine
      ? `<p class="panel-line"><span class="panel-label">업종</span>${escapeHtml(cat.cuisine)} · ${escapeHtml(cat.type)}</p>`
      : `<p class="panel-line"><span class="panel-label">업종</span>${escapeHtml(cat.label)}</p>`
    : "";
  const addr = cleanDisplayField(r.address_road) || cleanDisplayField(r.geocode_address) || "";
  const link = externalMapLinkHtml(r, "panel-link");
  return `<div class="venue-inline-detail">
    <div class="venue-detail-badges">${tierBadge}${visitBadge}</div>
    ${categoryLine}
    ${addr ? `<p class="panel-line"><span class="panel-label">주소</span>${escapeHtml(addr)}</p>` : ""}
    ${link}
  </div>`;
}

function collapseDrawerRows(listEl, exceptRow = null) {
  if (!listEl) return;
  listEl.querySelectorAll(".venue-drawer-row").forEach((row) => {
    if (exceptRow && row === exceptRow) return;
    row.classList.remove("expanded");
    row.querySelector(".venue-drawer-item")?.classList.remove("active");
    const detail = row.querySelector(".venue-drawer-item-detail");
    if (detail) detail.hidden = true;
  });
}

function toggleDrawerRow(row, venue, rowKey) {
  const listEl = document.getElementById("venue-drawer-list");
  const wasExpanded = row.classList.contains("expanded");
  collapseDrawerRows(listEl);
  if (wasExpanded) {
    activeId = null;
    return;
  }
  row.classList.add("expanded");
  row.querySelector(".venue-drawer-item")?.classList.add("active");
  const detail = row.querySelector(".venue-drawer-item-detail");
  if (detail) {
    detail.hidden = false;
    detail.innerHTML = buildInlineDetailHtml(venue);
  }
  activeId = rowKey;
  const scrollEl = document.getElementById("venue-drawer-scroll");
  if (scrollEl) {
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const viewTop = scrollEl.scrollTop;
    const viewBottom = viewTop + scrollEl.clientHeight;
    if (rowTop < viewTop || rowBottom > viewBottom) {
      scrollEl.scrollTo({
        top: Math.max(0, rowTop - 8),
        behavior: "smooth",
      });
    }
  }
}

function highlightMarkerForItem(item) {
  document
    .querySelectorAll(".map-marker.active")
    .forEach((el) => el.classList.remove("active"));
  const m = item ? findMapMarker(item) : null;
  if (m?.pin) {
    m.pin.classList.add("active");
    return;
  }
  // Naver custom HTML markers: locate via data-rid we injected on .map-pin-wrap
  if (mapProvider === "naver" && m && m._rid != null) {
    const rid = String(m._rid).replace(/"/g, "");
    const pin = document.querySelector(`.map-pin-wrap[data-rid="${rid}"] .map-marker`);
    if (pin) pin.classList.add("active");
  }
}

function centerMapOnItem(item) {
  const resolved = resolveVenueCoords(item);
  if (resolved?.lat == null || resolved?.lng == null) return;
  const { lat, lng } = resolved;
  if (mapProvider === "kakao" && kakaoMaps && map) {
    centerMapOn(map, kakaoMaps, lat, lng);
    return;
  }
  if (mapProvider === "naver" && map) {
    const nv = window.naver?.maps;
    if (nv) {
      map.setCenter(new nv.LatLng(lat, lng));
      map.setZoom(Math.max(map.getZoom() || 12, 15));
    }
    return;
  }
  if (map?.setView) {
    setMapView(lat, lng, Math.max(map.getZoom?.() || LEAFLET_OFFICE_ZOOM, 15));
  }
}

function setDrawerOpen(open) {
  const drawer = document.getElementById("venue-drawer");
  const mapPanel = document.querySelector(".map-panel");
  const toggle = document.getElementById("venue-drawer-toggle");
  const icon = document.getElementById("venue-drawer-toggle-icon");
  if (!drawer) return;
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  mapPanel?.classList.toggle("drawer-open", open);
  if (toggle) {
    toggle.setAttribute("aria-label", open ? "목록 닫기" : "목록 열기");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (icon) icon.textContent = open ? "‹" : "›";
  if (open && mapProvider === "kakao" && map) {
    setTimeout(() => relayoutKakaoMap(map), 280);
  }
}

function renderDrawerList(venues, expandRowKey = activeId) {
  const listEl = document.getElementById("venue-drawer-list");
  const titleEl = document.getElementById("venue-drawer-title");
  const addrEl = document.getElementById("venue-drawer-addr");
  if (!listEl || !titleEl || !addrEl) return;

  const addr =
    cleanDisplayField(venues[0]?.geocode_address) ||
    cleanDisplayField(venues[0]?.address_road) ||
    "";
  titleEl.textContent = venues.length > 1 ? `이 위치 ${venues.length}곳` : brandNameFromVenue(venues[0]);
  addrEl.textContent = addr;
  listEl.innerHTML = "";

  venues.forEach((venue) => {
    const rowKey = venue._listKey || listRowKey(venue);
    const info = getVisitRankInfo(venue);
    const tier = info?.tier ?? 5;
    const name = normalizeRestaurantName(venue._displayName || mapDisplayName(venue));
    const li = document.createElement("li");
    li.className = "venue-drawer-row";
    const expanded = rowKey === expandRowKey;
    if (expanded) li.classList.add("expanded");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `venue-drawer-item${expanded ? " active" : ""}`;
    btn.innerHTML = `
      <span class="panel-droplet tier-${tier}"></span>
      <span class="venue-drawer-item-main">
        <span class="venue-drawer-item-name">${escapeHtml(name)}</span>
        <span class="venue-drawer-item-meta">${escapeHtml(tierLabel(tier))}${visitMode ? ` · 방문 ${visitCount(venue)}회` : ""}</span>
      </span>
      <span class="venue-drawer-chevron" aria-hidden="true"></span>`;

    const detail = document.createElement("div");
    detail.className = "venue-drawer-item-detail";
    detail.hidden = !expanded;
    if (expanded) detail.innerHTML = buildInlineDetailHtml(venue);

    btn.addEventListener("click", () => toggleDrawerRow(li, venue, rowKey));
    li.append(btn, detail);
    listEl.appendChild(li);
  });
}

function openMarkerDrawer(markerItem) {
  drawerMarkerItem = resolveVenueCoords(markerItem);
  drawerVenues = venuesForMarkerItem(drawerMarkerItem);
  closeOpenPopups();
  highlightMarkerForItem(markerItem);
  centerMapOnItem(markerItem);
  setDrawerOpen(true);
  activeId = null;
  renderDrawerList(drawerVenues);
}

function openVenueDrawerPanel() {
  if (drawerMarkerItem) {
    setDrawerOpen(true);
    renderDrawerList(drawerVenues, activeId);
    return;
  }
  setDrawerOpen(true);
  const titleEl = document.getElementById("venue-drawer-title");
  const addrEl = document.getElementById("venue-drawer-addr");
  const listEl = document.getElementById("venue-drawer-list");
  if (titleEl) titleEl.textContent = "마커를 선택하세요";
  if (addrEl) addrEl.textContent = "지도의 물방울 마커를 누르면 식당 목록이 표시됩니다.";
  if (listEl) listEl.innerHTML = "";
}

function setupVenueDrawer() {
  document.getElementById("venue-drawer-toggle")?.addEventListener("click", () => {
    const drawer = document.getElementById("venue-drawer");
    const isOpen = drawer?.classList.contains("open");
    if (isOpen) {
      setDrawerOpen(false);
      document
        .querySelectorAll(".map-marker.active")
        .forEach((el) => el.classList.remove("active"));
      return;
    }
    openVenueDrawerPanel();
  });
  setDrawerOpen(false);
}

function addLeafletMarkers(markerItems) {
  markerItems.forEach((r) => {
    const style = getMarkerStyle(r);
    const pinHtml = dropletPinHtml(style);
    const iconW = 32;
    const iconH = 40;
    const icon = L.divIcon({
      className: "pin leaflet-droplet-icon",
      html: pinHtml,
      iconSize: [iconW, iconH],
      iconAnchor: [iconW / 2, iconH - 2],
    });
    const m = L.marker([r.lat, r.lng], { icon }).addTo(map);
    m._rid = r.restaurant_id;
    m._listKey = r._listKey;
    m._stackRids = r._stackMembers?.map((row) => row.restaurant_id) || null;
    m._stackMembers = r._stackMembers || null;
    m.lat = r.lat;
    m.lng = r.lng;
    m.pin = m.getElement?.()?.querySelector(".map-marker") || null;
    m.on("click", () => openMarkerDrawer(r));
    markers.push(m);
  });
}

function updateMarkerPosition(markerEntry, lat, lng) {
  if (!markerEntry || lat == null || lng == null) return;
  markerEntry.lat = lat;
  markerEntry.lng = lng;
  if (mapProvider === "kakao" && kakaoMaps && markerEntry.overlay) {
    const pos = new kakaoMaps.LatLng(lat, lng);
    markerEntry.pos = pos;
    markerEntry.overlay.setPosition(pos);
    return;
  }
  if (mapProvider === "leaflet" && markerEntry.setLatLng) {
    markerEntry.setLatLng([lat, lng]);
  }
}

async function addMarkers() {
  clearMarkers();
  const markerItems = restaurantsForMapMarkers();
  mapMarkerCount = markerItems.length;
  const popupApi = {
    markerStyle: getMarkerStyle,
    build: buildPopupHtml,
    onMarkerActivate: openMarkerDrawer,
  };

  if (mapProvider === "kakao" && kakaoMaps) {
    const withCoords = markerItems.filter((r) => r.lat != null && r.lng != null);
    if (withCoords.length > 0) {
      setMetaStatus(`지도 마커 배치 중… (0/${withCoords.length})`);
    }
    try {
      markers = await addKakaoMarkersBatched(
        kakaoMaps,
        map,
        markerItems,
        {
          onSelect: selectRestaurant,
          popupHtml: popupApi,
          beforeOpen: closeOpenPopups,
          enableHover: false,
          onMarkerActivate: openMarkerDrawer,
        },
        {
          batchSize: 80,
          onProgress: (done, total) => {
            if (total > 0 && (done === total || done % 80 === 0)) {
              setMetaStatus(`지도 마커 배치 중… (${done}/${total})`);
            }
          },
        }
      );
    } catch (err) {
      console.error("Kakao marker batch failed:", err);
      throw new Error(`마커 배치 실패: ${err.message}`);
    }
    return;
  }

  if (mapProvider === "naver") {
    addNaverMarkers(markerItems);
    return;
  }

  addLeafletMarkers(markerItems);
}

function addNaverMarkers(items) {
  if (!map || !window.naver?.maps) return;

  const naverMaps = window.naver.maps;

  items.forEach((r) => {
    if (r.lat == null || r.lng == null) return;

    const style = getMarkerStyle(r);
    let pinHtml = dropletPinHtml(style);
    // Inject data-rid so highlight can find the exact .map-marker for Naver custom HTML icons
    const ridForData = String(r.restaurant_id || "").replace(/"/g, "");
    pinHtml = pinHtml.replace(
      /class="map-pin-wrap([^"]*)"/,
      (match, extraClasses) => `class="map-pin-wrap${extraClasses}" data-rid="${ridForData}"`
    );

    const marker = new naverMaps.Marker({
      position: new naverMaps.LatLng(r.lat, r.lng),
      map: map,
      title: r.name || "",
      icon: {
        content: pinHtml,
        anchor: new naverMaps.Point(16, 38),
      },
    });

    // attach for findMapMarker, stacks etc. (to make clicks and drawer work like Kakao)
    marker._rid = r.restaurant_id;
    marker._listKey = r._listKey;
    if (r._stackMembers && r._stackMembers.length) {
      marker._stackRids = r._stackMembers.map((row) => row.restaurant_id);
      marker._stackMembers = r._stackMembers;
    }
    marker.lat = r.lat;
    marker.lng = r.lng;
    // .pin kept null for Naver (we use data-rid query in highlight for active state)

    markers.push(marker);

    naverMaps.Event.addListener(marker, "click", () => {
      openMarkerDrawer(r);
    });
  });
}

async function refineAndSyncMarkerCoords(dataAsOf) {
  if (mapProvider !== "kakao" || !kakaoMaps) return;
  const mapVenues = restaurants.filter(isMapMarkerVenue).map((r) => resolveVenueCoords(r));
  const { refined, cached } = await refineRestaurantCoords(mapVenues, { dataAsOf });
  if (refined > 0) {
    console.info(`POI 좌표 보정: ${refined}건 갱신, ${cached}건 캐시 — 겹침 재계산`);
    await addMarkers();
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}



function listRowKey(r) {
  if (r._clusterKey) return `loc:${r._clusterKey}`;
  if (String(r.restaurant_id || "").startsWith("loc:")) return r.restaurant_id;
  return `${r.restaurant_id}::${r.name}`;
}

function sortRestaurants(list) {
  if (visitMode) {
    return [...list].sort(
      (a, b) =>
        visitCount(b) - visitCount(a) ||
        a.name.localeCompare(b.name, "ko")
    );
  }
  return [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function renderList(filter = "") {
  const q = filter.trim().toLowerCase();
  const list = document.getElementById("restaurant-list");
  list.innerHTML = "";
  const sorted = sortRestaurants(restaurantsForList()).filter((r) => {
    if (!q) return true;
    return venueMatchesQuery(r, q);
  });
  const capped = q ? sorted : sorted.slice(0, LIST_CAP);
  const fragment = document.createDocumentFragment();

  if (!q) {
    const hint = document.createElement("li");
    hint.className = "stats list-meta";
    hint.textContent =
      sorted.length > LIST_CAP
        ? `목록 ${capped.length}곳 표시 · 전체 ${sorted.length}곳 (검색으로 더 찾기)`
        : `목록 ${capped.length}곳 표시 · 전체 ${sorted.length}곳`;
    fragment.appendChild(hint);
  }

  capped.forEach((r) => {
    const rowKey = r._listKey || listRowKey(r);
    const li = document.createElement("li");
    li.dataset.id = rowKey;
    if (rowKey === activeId) li.classList.add("active");
    const hasCoords = r.lat != null && r.lng != null;
    const isCluster = Boolean(r._clusterMembers?.length > 1);
    const { label, mapTarget, linkedFrom, isLinked } = isCluster
      ? { label: r._displayName || brandNameFromVenue(r), mapTarget: r, linkedFrom: null, isLinked: false }
      : displayVenueLabel(r);
    const canMap = Boolean(mapTarget);
    if (!canMap) li.classList.add("nomap-item");
    if (isLinked) li.classList.add("linked-item");
    if (isCluster) li.classList.add("cluster-item");

    const badges = [];
    if (visitMode && visitCount(r) > 0) {
      badges.push(
        `<span class="badge ${r.visit_rank_bucket || "medium"}">방문 ${visitCount(r)}회</span>`
      );
    }
    if (isCluster) {
      badges.push(`<span class="badge cluster">${r._clusterMembers.length}건</span>`);
    }
    if (canMap) {
      badges.push(`<span class="badge mapok">지도</span>`);
    } else {
      badges.push(`<span class="badge nomap">좌표 없음</span>`);
    }

    const sub = listSubtextForVenue(r, { label, isLinked });

    li.innerHTML = `
      <div class="name">${escapeHtml(label)}
        <span class="badges">${badges.join("")}</span>
      </div>
      <div class="stats">${escapeHtml(sub || "")}</div>`;
    li.addEventListener("click", () => selectRestaurant(rowKey, true));
    fragment.appendChild(li);
  });
  list.appendChild(fragment);
}

function popupVenueFor(target, linkedFrom) {
  const cluster = getClusterForVenue(target);
  const merged =
    cluster && cluster.members.length > 1 ? getMergedMapVenue(cluster) : target;
  return { ...merged, lat: target.lat, lng: target.lng };
}

function openMapPopupFor(target, linkedFrom) {
  document
    .querySelectorAll(".map-marker.active")
    .forEach((el) => el.classList.remove("active"));
  const mapMarker = findMapMarker(target);
  if (mapMarker?._stackMembers?.length > 1) {
    openMarkerDrawer({
      lat: mapMarker.lat,
      lng: mapMarker.lng,
      restaurant_id: mapMarker._rid,
      _listKey: mapMarker._listKey,
      _stackMembers: mapMarker._stackMembers,
      _isStackMarker: true,
    });
    return;
  }
  const popupVenue = popupVenueFor(target, linkedFrom);
  const clusterKey = target._clusterKey || venueClusterKey(target);
  if (mapProvider === "kakao") {
    const m = findMapMarker(target);
    const html = buildPopupHtml(popupVenue, { linkedFrom });
    if (m?.info) m.info.setContent(html);
    panKakaoTo(map, kakaoMaps, target.lat, target.lng, markers, popupVenue.restaurant_id, {
      clusterKey,
      beforeOpen: () => {
        closeOpenPopups();
        if (m?.info) m.info.setContent(html);
      },
    });
    return;
  }
  if (mapProvider === "naver" && map) {
    const nv = window.naver?.maps;
    if (nv) {
      map.setCenter(new nv.LatLng(target.lat, target.lng));
      map.setZoom(16);
    }
    // Use custom drawer for consistency with our designed UI (same as Kakao version)
    openMarkerDrawer(popupVenue);
    return;
  } else if (map?.setView) {
    setMapView(target.lat, target.lng, 16);
    const m = findMapMarker(target);
    if (m) {
      m.bindPopup(buildPopupHtml(popupVenue, { linkedFrom })).openPopup();
    }
  }
}

function findRestaurantByRowKey(rowKey) {
  const key = String(rowKey);
  if (key.startsWith("loc:")) {
    const clusterKey = key.slice(4);
    const cluster = locationClusters.get(clusterKey);
    if (cluster) return getMergedMapVenue(cluster);
  }
  const [restaurantId, ...nameParts] = key.split("::");
  const name = nameParts.join("::");
  if (name) {
    return restaurants.find((x) => x.restaurant_id === restaurantId && x.name === name);
  }
  const byId = restaurants.find((x) => x.restaurant_id === restaurantId);
  if (byId) return byId;
  return restaurantsForList().find((x) => (x._listKey || listRowKey(x)) === key) || null;
}

function selectRestaurant(rowKey, panMap) {
  const r = findRestaurantByRowKey(rowKey);
  if (!r) return;
  activeId = r._listKey || listRowKey(r);
  if (!panMap) return;

  const { mapTarget, linkedFrom } = r._clusterMembers?.length
    ? { mapTarget: r, linkedFrom: null }
    : resolveMapTarget(r);
  if (!mapTarget) {
    showMapToast(
      `「${r.name}」은 주소·좌표가 없습니다. 인허가 DB에 없거나 매칭·지오코딩이 필요합니다.`
    );
    return;
  }
  openMapPopupFor(mapTarget, linkedFrom);
}

function renderMapLegend() {
  const el = document.getElementById("map-legend");
  if (!el) return;
  if (!visitMode) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <ul class="map-legend-list">
      <li><span class="legend-droplet tier-rainbow"></span>단골 밀집</li>
      <li><span class="legend-droplet tier-1"></span>1티어</li>
      <li><span class="legend-droplet tier-2"></span>2티어</li>
      <li><span class="legend-droplet tier-3"></span>3티어</li>
      <li><span class="legend-droplet tier-4"></span>4티어</li>
      <li><span class="legend-droplet tier-5"></span>5티어</li>
    </ul>`;
}

function mapProviderLabel() {
  if (mapProvider === "kakao") return "카카오맵";
  if (mapProvider === "naver") return "네이버맵";
  return "OSM (fallback)";
}

function renderSources(asOf) {
  const el = document.getElementById("sources");
  if (!el) return;
  const links = SOURCES.map(
    ([label, url]) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`
  ).join(" · ");
  el.innerHTML = `출처: ${links} · 데이터 기준일: ${asOf} · ${mapProviderLabel()}`;
}

function applyMode(mapData) {
  visitCountField = mapData.visit_count_field || "visit_count_total";
  visitMode = mapData.visit_counts_available !== false && mapData.mode !== "permit_only";
}

async function main() {
  try {
    setMetaStatus("데이터 불러오는 중…");

    const [mapConfig, manifest] = await Promise.all([
      loadMapConfig(),
      loadJson("data/manifest.json").catch(() => ({})),
    ]);

    let mapData;
    try {
      setMetaStatus("음식점 목록 불러오는 중…");
      mapData = await loadJson("data/restaurants.map.json");
    } catch (err) {
      console.warn("restaurants.map.json fallback:", err);
      mapData = await loadJson("data/restaurants.public.json");
      mapData.map_center = SEJONG_DEFAULT_CENTER;
      mapData.geocoded_count = 0;
    }

    restaurants = mapData.restaurants || [];
    setMetaStatus("목록·지도 인덱스 구성 중…");
    rebuildAddressCoordIndex();
    buildCorpPermitLinks();
    buildLocationClusters();
    rebuildLocationVisitCaches();
    buildVisitRankMeta();

    applyMode(mapData);
    setupVenueDrawer();
    setupKakaoMapLinkHandler();
    renderMapLegend();

    const asOf = manifest.data_as_of || mapData.data_as_of || "-";
    renderSources(asOf);

    // Naver Maps 우선 (use ncpKeyId for the JS SDK)
    if (mapConfig.preferNaverMap && mapConfig.naverClientId) {
      try {
        console.log("[Naver] Trying to load with ncpKeyId:", mapConfig.naverClientId);
        setMetaStatus("네이버맵 연결 중…");
        await initNaverMap(mapConfig.naverClientId);
        console.log("[Naver] Map initialized successfully. Provider:", mapProvider);
      } catch (err) {
        console.error("[Naver] Load failed:", err);
        showMapToast("네이버맵 로드 실패. Naver Cloud 콘솔에서 ncpKeyId용 도메인 등록 확인 (http://localhost:5173 등 정확히).", 12000);
        // Do not fallback to Leaflet to keep Naver as primary
      }
    } else if (mapConfig.preferKakaoMap && mapConfig.kakaoJsKey) {
      try {
        setMetaStatus("카카오맵 연결 중…");
        await initKakaoMap(mapConfig.kakaoJsKey);
      } catch (err) {
        console.warn("Kakao map fallback to Leaflet:", err);
        initLeafletMap(SEJONG_OFFICE_VIEW);
        showMapToast(
          "카카오맵을 불러오지 못해 OSM 지도로 표시합니다. 카카오 Developers → JavaScript 키 → Web 사이트 도메인에 이 사이트 주소를 등록하면 로컬과 동일한 카카오맵이 열립니다.",
          9000
        );
      }
    } else {
      initLeafletMap(SEJONG_OFFICE_VIEW);
    }

    await addMarkers();
    if (map) {
      fitInitialView();
    }
    refineAndSyncMarkerCoords(asOf).catch((err) => {
      console.warn("POI coord refine skipped:", err);
    });
    setupMapResize();
    renderSources(asOf);
    clearMetaStatus();
  } catch (err) {
    setMetaStatus(`오류: ${err.message}`);
    showMapToast(`지도를 불러오지 못했습니다: ${err.message}`, 12000);
    console.error(err);
  }
}

main().catch((err) => {
  setMetaStatus(`오류: ${err.message}`);
  console.error(err);
});