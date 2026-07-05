const isLocal =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1" ||
  location.hostname.endsWith(".local");

if (isLocal) {
  await import("./app.js?v=20260718");
} else {
  await import(
    "https://cdn.jsdelivr.net/gh/Jdragon712/sejong-official-restaurant-map@59a4ad9f4be45d7710f4009c58426aef03435fe5/js/app.js"
  );
}