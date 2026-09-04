// DISPOSABLE, READ-ONLY diagnostic endpoint — 2026-09-04.
//
// Fetches a LinkedIn job detail url using the EXACT same plain HTTP request
// shape as _linkedin_core.mjs's fetchText (same headers, no cookies, no JS),
// then reports signals that could distinguish a login-wall/teaser response
// from a normal full job page — so the "forced login" detection can be
// precise instead of the current no-tech+no-experience proxy heuristic.
// No writes. Delete after use.

import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { extractTechnologies, extractLinkedInExperience } from "./_experience_core.mjs";

const TOKEN = "b7f2c9e14a6d8031f5e7c2a90b4d6f18c3a5e7b9";

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;
        const location = res.headers.location || null;
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (data += c));
        stream.on("end", () => resolve({ code, location, html: data }));
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const url = new URL(request.url).searchParams.get("url");
  if (!url) return new Response("missing ?url=", { status: 400 });

  const { code, location, html } = await fetchRaw(url);
  const $ = cheerioLoad(html);

  const descText = $(".description, .job-description, #job-details, .show-more-less-html__markup").first().text().trim();

  const report = {
    status: code,
    redirectLocation: location,
    htmlLength: html.length,
    title: $("title").text().trim(),
    hasAuthwallString: /authwall/i.test(html),
    hasSignInHref: (html.match(/href="[^"]*authwall[^"]*"/gi) || []).slice(0, 5),
    descriptionContainerFound: descText.length > 0,
    descriptionTextLength: descText.length,
    descriptionTextSample: descText.slice(0, 300),
    bodyClassAttr: $("body").attr("class") || null,
    canonicalLink: $('link[rel="canonical"]').attr("href") || null,
    metaRobots: $('meta[name="robots"]').attr("content") || null,
    firstH1: $("h1").first().text().trim(),
    scriptCount: $("script").length,
    hasJoinFormClass: $(".join-form, .authwall-join-form, .sign-in-form").length,
    hasTopCardClass: $(".top-card-layout, .topcard, [class*='top-card']").length,
    realExtractTechnologies: extractTechnologies(html),
    realExtractLinkedInExperience: extractLinkedInExperience(html),
  };

  return new Response(JSON.stringify(report, null, 2), { headers: { "content-type": "application/json" } });
};
