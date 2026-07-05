/**
 * 마커 스택: 지도 핀 겹침만 (~10m). 주소·반경(30m) 기준 전이 묶음은 사용하지 않음.
 */

export const OVERLAP_RADIUS_M = 30;
export const OVERLAP_VISUAL_RADIUS_M = 10;

export function haversineDistanceM(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function findConnectedGroups(items, shouldCluster) {
  const n = items.length;
  if (n === 0) return [];

  const parent = items.map((_, index) => index);

  const find = (index) => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };

  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (shouldCluster(items[i], items[j])) {
        union(i, j);
      }
    }
  }

  const buckets = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(items[i]);
  }

  return [...buckets.values()];
}

/**
 * @param {object[]} items
 * @param {{ buildStackItem: Function, prepareIndividual: Function }} hooks
 */
export function mergeOverlappingMarkerItems(
  items,
  { buildStackItem, prepareIndividual, shouldCluster }
) {
  const cluster =
    shouldCluster ||
    ((a, b) => haversineDistanceM(a, b) <= OVERLAP_RADIUS_M);
  const groups = findConnectedGroups(items, cluster);
  const result = [];

  for (const group of groups) {
    if (group.length >= 2) {
      result.push(buildStackItem(group));
    } else {
      result.push(prepareIndividual(group[0]));
    }
  }

  return result;
}