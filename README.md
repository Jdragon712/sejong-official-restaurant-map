# Web MVP (정적)

Leaflet + OpenStreetMap. **방문 횟수**만 표시.

## 데이터 반영

```bash
cd ~/Desktop/헤르메스\ 비서/앱개발/맛집앱
.venv/bin/python scripts/export_agencies.py
# 선택: KAKAO_REST_API_KEY=... .venv/bin/python scripts/geocode_venues.py --limit 80
.venv/bin/python scripts/geocode_venues.py --limit 50   # Nominatim (느림)
.venv/bin/python scripts/sync_web_data.py
```

## 로컬 미리보기

```bash
cd web && python3 -m http.server 5173
```

브라우저: http://127.0.0.1:5173

`file://` 로 열면 fetch가 막힐 수 있어 **반드시 HTTP 서버** 사용.

## 배포

`web/` 전체 + `web/data/*.json` 을 정적 호스팅 (GitHub Pages, Cloudflare Pages 등).

Kakao 지도로 바꾸려면 `KAKAO_REST_API_KEY`로 geocode 품질을 올린 뒤 JS SDK 연동(Phase 1.1).