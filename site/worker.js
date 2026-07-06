import { handleShareRequest } from "./share-api.js";

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

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-share-token",
    "access-control-max-age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === "www.codexhub.uk") {
      url.hostname = "codexhub.uk";
      return Response.redirect(url.toString(), 301);
    }

    if (request.method === "OPTIONS" && (url.pathname.startsWith("/v1/shares") || url.pathname.startsWith("/share/"))) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const shareResponse = await handleShareRequest(request, env);
    if (shareResponse) {
      const headers = new Headers(shareResponse.headers);
      for (const [key, value] of Object.entries(corsHeaders())) {
        if (!headers.has(key)) headers.set(key, value);
      }
      return new Response(shareResponse.body, {
        status: shareResponse.status,
        statusText: shareResponse.statusText,
        headers,
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("不支持的请求方法", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
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
