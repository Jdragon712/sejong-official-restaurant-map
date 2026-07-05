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
} from "./map-kakao.js?v=20260717";
import { refineRestaurantCoords } from "./map-geocode.js?v=20260717";
import {
  haversineDistanceM,
  mergeOverlappingMarkerItems,
  OVERLAP_VISUAL_RADIUS_M,
} from "./map-overlap-stack.js?v=20260717";

const SOURCES = [
  ["세종 일반음식점", "https://www.data.go.kr/data/15081905/fileData.do"],
  ["세종 휴게음식점", "https://www.data.go.kr/data/15098456/openapi.do"],
  ["세종 공공기관현황", "https://www.data.go.kr/data/3074664/fileData.do"],
];

const BUCKET_COLOR = { high: "#e85d4c", medium: "#f0a500", low: "#5cb85c" };
const MIN_MAP_VISITS = 10;
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

function setMetaStatus(text) {
  if (text) console.info("[map]", text);
  const toast = document.getElementById("map-toast");
  if (toast && text && !text.startsWith("오류")) {
    toast.textContent = text;
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
  const defaults = { kakaoJsKey: "", preferKakaoMap: true };
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
  if (poi) return poi;
  const visitTarget = expenseVisitTarget(r);
  const brand = brandMergeKey(r);
  if (visitTarget && visitTarget !== brand && !brandsAreSimilar(visitTarget, brand)) {
    const raw = cleanDisplayField(r.name);
    const m = raw.match(/[(\（]([^)）]+)[)\）]/);
    if (m) return m[1].trim();
  }
  return permitBrandName(r);
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

main().catch((err) => {
  setMetaStatus(`오류: ${err.message}`);
  console.error(err);
});
