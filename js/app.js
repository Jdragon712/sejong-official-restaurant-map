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
} from "./map-kakao.js?v=20260718";
import { refineRestaurantCoords } from "./map-geocode.js?v=20260718";
import {
  haversineDistanceM,
  mergeOverlappingMarkerItems,
  OVERLAP_VISUAL_RADIUS_M,
} from "./map-overlap-stack.js?v=20260718";

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
    toast.textContent = "로딩중...";
    toast.classList.add("visible");
  }
}
