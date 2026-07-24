import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSentimentSearchSettings } from "../../vendor/opinx-sentiment/plugins/sentiment/sentiment-store.js";
import { JsonConfigStore } from "../../vendor/opinx-sentiment/standalone/sentiment-backend/src/config-store.js";

const tempDirs: string[] = [];

function makeConfig(initial: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentiment-cookie-persistence-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "sentiment-config.json");
  fs.writeFileSync(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  return { filePath, store: new JsonConfigStore(filePath) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("browser auth cookie persistence", () => {
  it("merges Node writes into the latest config written by another process", () => {
    const { filePath, store } = makeConfig({
      sentimentSearch: { browserFallback: { profiles: [] } },
      marker: "startup",
    });
    expect(store.get("marker")).toBe("startup");

    fs.writeFileSync(filePath, `${JSON.stringify({
      sentimentSearch: {
        browserFallback: {
          profiles: [{
            key: "instagram",
            cookies: [{ name: "sessionid", value: "fresh-session", domain: ".instagram.com" }],
          }],
        },
      },
      marker: "browser-auth-sync",
    }, null, 2)}\n`, "utf8");

    store.set("unrelatedSetting", { enabled: true });
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(saved.marker).toBe("browser-auth-sync");
    expect(saved.sentimentSearch.browserFallback.profiles[0].cookies).toEqual([
      expect.objectContaining({ name: "sessionid", value: "fresh-session" }),
    ]);
  });

  it("preserves the latest sessionid when stale settings are saved", () => {
    const instagramProfile = {
      key: "instagram",
      label: "Instagram",
      platform: "instagram",
      sourceKey: "instagram",
      domain: "instagram.com",
      urlTemplate: "https://www.instagram.com/explore/search/keyword/?q={query}",
    };
    const { filePath, store } = makeConfig({
      sentimentSearch: {
        browserFallback: {
          profiles: [{
            ...instagramProfile,
            cookies: [{ name: "sessionid", value: "fresh-session", domain: ".instagram.com" }],
            lastAuthorizedAt: "2026-07-24T12:00:00.000Z",
          }],
        },
      },
    });

    writeSentimentSearchSettings(store, {
      browserFallback: {
        profiles: [{ ...instagramProfile, cookies: [] }],
      },
    });

    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const instagram = saved.sentimentSearch.browserFallback.profiles
      .find((profile: { key?: string }) => profile.key === "instagram");
    expect(instagram.cookies).toEqual([
      expect.objectContaining({ name: "sessionid", value: "fresh-session" }),
    ]);
    expect(instagram.lastAuthorizedAt).toBe("2026-07-24T12:00:00.000Z");
  });

  it("binds cookie reads to the active tab store and requires Instagram sessionid", () => {
    const backgroundPath = path.resolve(
      "vendor/opinx-sentiment/standalone/sentiment-backend/public/browser-auth-extension/background.js",
    );
    const source = fs.readFileSync(backgroundPath, "utf8");
    expect(source).toContain("chrome.cookies.getAllCookieStores()");
    expect(source).toContain("cookieStoreIdForTab(tab?.id)");
    expect(source).toContain("getCookiesForDomain(domain, options.storeId)");
    expect(source).toContain("Instagram sessionid was not found in the current tab cookie store");
  });
});
