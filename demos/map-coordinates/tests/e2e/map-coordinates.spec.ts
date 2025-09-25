import { expect, test, Browser, BrowserContext, Page } from "@playwright/test";

const RELAY_URL = process.env.PLAYWRIGHT_RELAY_URL ?? process.env.VITE_RELAY_URL ?? "https://moq.justinmoon.com/anon";
const FORGE_POINT = { x: 160, y: 160 };
const LIBRARY_POINT = { x: 480, y: 160 };
const AVATAR_RED = "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
const AVATAR_BLUE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

interface TestIdentity {
  pubkey: string;
  displayName: string;
  picture: string;
}

async function createPlayerContext(browser: Browser, identity: TestIdentity): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(({ pubkey, displayName, picture }) => {
    window.nostr = {
      async getPublicKey() {
        return pubkey;
      },
      async getProfile(requested: string) {
        if (requested !== pubkey) {
          throw new Error(`unexpected pubkey ${requested}`);
        }
        return {
          display_name: displayName,
          name: displayName,
          picture,
        };
      },
      async getRelays() {
        return {};
      },
    };
  }, identity);
  return context;
}

async function login(page: Page) {
  const loginButton = page.locator("#login");
  await expect(loginButton).toBeEnabled({ timeout: 20_000 });
  await loginButton.click();
  await expect(loginButton).toHaveClass(/success/, { timeout: 30_000 });
}

async function waitForPlayerCount(page: Page, expected: number) {
  await expect.poll(async () => {
    return page.evaluate(() => window.__mapDemo?.getPlayers().length ?? 0);
  }, { timeout: 45_000 }).toBeGreaterThanOrEqual(expected);
}

async function setPosition(page: Page, point: { x: number; y: number }) {
  await page.evaluate(({ x, y }) => {
    window.__mapDemo?.setLocalPosition(x, y);
  }, point);
}

async function getRemoteZones(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const api = window.__mapDemo;
    if (!api) return null;
    const players = api.getPlayers();
    const remote = players.find((player) => !player.isLocal);
    return remote ? remote.zones : null;
  });
}

async function getRemoteVolume(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const api = window.__mapDemo;
    if (!api) return null;
    const players = api.getPlayers();
    const remote = players.find((player) => !player.isLocal);
    if (!remote) return null;
    const volumes = api.getVolumes();
    const value = volumes[remote.key];
    return typeof value === "number" ? value : null;
  });
}

async function getRemoteKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const api = window.__mapDemo;
    if (!api) return null;
    const players = api.getPlayers();
    const remote = players.find((player) => !player.isLocal);
    return remote?.key ?? null;
  });
}

async function getAudioStatsFor(page: Page, key: string): Promise<{ framesDecoded: number; bufferedAhead: number; underruns: number } | null> {
  return page.evaluate((targetKey) => {
    const api = window.__mapDemo;
    if (!api || !api.getAudioStats) return null;
    const stats = api.getAudioStats();
    return stats[targetKey] ?? null;
  }, key);
}

async function waitForHealthyAudio(
  page: Page,
  key: string,
  baseline: { framesDecoded: number; underruns: number },
) {
  await expect.poll(async () => {
    const stats = await getAudioStatsFor(page, key);
    if (!stats) return null;
    const framesDelta = stats.framesDecoded - baseline.framesDecoded;
    const underrunsDelta = stats.underruns - baseline.underruns;
    const buffered = stats.bufferedAhead;
    const targetLead = stats.targetLead ?? 0;
    const healthy =
      framesDelta > 200 &&
      underrunsDelta === 0 &&
      buffered >= Math.max(0.1, targetLead - 0.05);
    return healthy;
  }, { timeout: 15_000 }).toBeTruthy();
}

test("connects via WebTransport and gates audio by zone", async ({ browser }) => {
  const logsA: string[] = [];
  const logsB: string[] = [];

  const contextA = await createPlayerContext(browser, {
    pubkey: "a".repeat(64),
    displayName: "Tester A",
    picture: AVATAR_RED,
  });
  const pageA = await contextA.newPage();
  pageA.on("console", (msg) => {
    logsA.push(msg.text());
  });

  const contextB = await createPlayerContext(browser, {
    pubkey: "b".repeat(64),
    displayName: "Tester B",
    picture: AVATAR_BLUE,
  });
  const pageB = await contextB.newPage();
  pageB.on("console", (msg) => {
    logsB.push(msg.text());
  });

  try {
    await pageA.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);
    await login(pageA);

    await pageB.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);
    await login(pageB);

    await waitForPlayerCount(pageA, 2);
    await waitForPlayerCount(pageB, 2);

    await setPosition(pageA, FORGE_POINT);
    await setPosition(pageB, { x: FORGE_POINT.x + 24, y: FORGE_POINT.y + 24 });

    await expect.poll(async () => {
      const zones = await getRemoteZones(pageA);
      return zones?.includes("forge") ?? false;
    }, { timeout: 30_000 }).toBeTruthy();
    await expect.poll(async () => {
      const zones = await getRemoteZones(pageB);
      return zones?.includes("forge") ?? false;
    }, { timeout: 30_000 }).toBeTruthy();

    const remoteKeyForB = await getRemoteKey(pageB);
    expect(remoteKeyForB).not.toBeNull();
    const remoteKey = remoteKeyForB!;
    const baselineStats = (await getAudioStatsFor(pageB, remoteKey)) ?? {
      framesDecoded: 0,
      bufferedAhead: 0,
      underruns: 0,
    };

    const toneButton = pageA.getByRole("button", { name: /play test tone/i });
    await expect(toneButton).toBeEnabled();
    await toneButton.click();
    await expect(pageA.getByRole("button", { name: /stop test tone/i })).toBeVisible();

    await expect.poll(async () => {
      const volume = await getRemoteVolume(pageB);
      return volume ?? -1;
    }, { timeout: 45_000 }).toBeGreaterThan(0.5);

    await waitForHealthyAudio(pageB, remoteKey, baselineStats);

    await setPosition(pageA, LIBRARY_POINT);

    await expect.poll(async () => {
      const zones = await getRemoteZones(pageB);
      return zones?.includes("library") ?? false;
    }, { timeout: 45_000 }).toBeTruthy();
    await expect.poll(async () => {
      const volume = await getRemoteVolume(pageB);
      return volume ?? -1;
    }, { timeout: 45_000 }).toBe(0);

    for (const message of [...logsA, ...logsB]) {
      expect(message).not.toContain("using WebSocket fallback");
    }
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
