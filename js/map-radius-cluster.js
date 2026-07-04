/** 1km 반경 기반 무지개 마커 클러스터 (최대 10곳, 2곳 이상일 때만 묶음) */

export const CLUSTER_RADII_M = [1000, 500, 100, 50, 25];
export const MIN_CLUSTER_MEMBERS = 2;
export const MAX_CLUSTER_MEMBERS = 10;

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

function partitionByRadius(items, radiusM, sortByRank) {
  const sorted = [...items].sort(sortByRank);
  const assigned = new Set();
  const groups = [];

  for (const seed of sorted) {
    if (assigned.has(seed.restaurant_id)) continue;
    const group = [];
    for (const item of items) {
      if (assigned.has(item.restaurant_id)) continue;
      if (haversineDistanceM(seed, item) <= radiusM) {
        group.push(item);
      }
    }
    if (group.length >= MIN_CLUSTER_MEMBERS) {
      group.forEach((row) => assigned.add(row.restaurant_id));
      groups.push(group);
    }
  }

  const singles = items.filter((row) => !assigned.has(row.restaurant_id));
  return { groups, singles };
}

function splitOversizedGroup(items, sortByRank, buildStackItem, prepareIndividual) {
  const remaining = [...items];
  const result = [];

  while (remaining.length > 0) {
    const seed = [...remaining].sort(sortByRank)[0];
    const chunk = remaining
      .map((row) => ({ row, dist: haversineDistanceM(seed, row) }))
      .sort((a, b) => a.dist - b.dist || sortByRank(a.row, b.row))
      .slice(0, MAX_CLUSTER_MEMBERS)
      .map((entry) => entry.row);

    if (chunk.length >= MIN_CLUSTER_MEMBERS) {
      result.push(buildStackItem(chunk));
      const ids = new Set(chunk.map((row) => row.restaurant_id));
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (ids.has(remaining[i].restaurant_id)) remaining.splice(i, 1);
      }
    } else {
      result.push(prepareIndividual(seed));
      const idx = remaining.findIndex((row) => row.restaurant_id === seed.restaurant_id);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  return result;
}

function clusterRecursive(items, radiusIdx, sortByRank, buildStackItem, prepareIndividual) {
  if (!items.length) return [];

  const radius = CLUSTER_RADII_M[radiusIdx];
  const { groups, singles } = partitionByRadius(items, radius, sortByRank);
  const result = [];

  for (const group of groups) {
    if (group.length > MAX_CLUSTER_MEMBERS) {
      if (radiusIdx < CLUSTER_RADII_M.length - 1) {
        result.push(
          ...clusterRecursive(group, radiusIdx + 1, sortByRank, buildStackItem, prepareIndividual)
        );
      } else {
        result.push(...splitOversizedGroup(group, sortByRank, buildStackItem, prepareIndividual));
      }
    } else {
      result.push(buildStackItem(group));
    }
  }

  singles.forEach((row) => result.push(prepareIndividual(row)));
  return result;
}

/**
 * @param {object[]} items 좌표 있는 식당
 * @param {{ sortByRank: Function, prepareIndividual: Function, buildStackItem: Function }} hooks
 */
export function buildRadiusClusterMarkerItems(items, { sortByRank, prepareIndividual, buildStackItem }) {
  const withCoords = items.filter((row) => row.lat != null && row.lng != null);
  return clusterRecursive(withCoords, 0, sortByRank, buildStackItem, prepareIndividual);
}