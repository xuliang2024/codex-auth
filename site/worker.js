const INDEX_DOCUMENT = "index.html";

function objectKeyFromPath(pathname) {
  const trimmed = pathname.replace(/^\/+/, "");

  if (trimmed === "") {
    return INDEX_DOCUMENT;
  }

  if (trimmed === "telemetry") {
    return `telemetry/${INDEX_DOCUMENT}`;
  }

  if (trimmed.endsWith("/")) {
    return `${trimmed}${INDEX_DOCUMENT}`;
  }

  return trimmed;
}

function isUnsafeKey(key) {
  return key.split("/").some((part) => part === "..");
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("不支持的请求方法", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);

    if (url.hostname === "www.codexhub.uk") {
      url.hostname = "codexhub.uk";
      return Response.redirect(url.toString(), 301);
    }

    let key;

    try {
      key = decodeURIComponent(objectKeyFromPath(url.pathname));
    } catch {
      return new Response("请求无效", { status: 400 });
    }

    if (isUnsafeKey(key)) {
      return new Response("请求无效", { status: 400 });
    }

    const object = await env.SITE_BUCKET.get(key);

    if (!object) {
      return new Response("未找到", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    if (!headers.has("cache-control")) {
      headers.set("cache-control", key === INDEX_DOCUMENT ? "public, max-age=60" : "public, max-age=300");
    }

    return new Response(request.method === "HEAD" ? null : object.body, {
      headers,
    });
  },
};
