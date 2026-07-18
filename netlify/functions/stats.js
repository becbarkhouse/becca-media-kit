// Netlify serverless function — pulls live creator stats from Phyllo.
// Keeps the Phyllo Client ID / Secret private on the server side.
// Set PHYLLO_CLIENT_ID and PHYLLO_SECRET as environment variables in your
// Netlify site settings (Site configuration > Environment variables).
// Do NOT put those values in this file or in git.

const PHYLLO_BASE = process.env.PHYLLO_BASE_URL || "https://api.staging.getphyllo.com/v1";

// Account IDs are not secret — safe to keep in code.
const ACCOUNTS = [
  { platform: "instagram", account_id: "a7cd6b12-6fbc-4a96-8d47-f26faa094df5" },
  { platform: "tiktok", account_id: "33728051-f1fe-4cb0-94cf-21d55fc7d1de" },
];

// ISO 3166-1 alpha-2 -> display name, for the countries Phyllo's audience
// endpoint returns. Falls back to the raw code for anything not listed.
const COUNTRY_NAMES = {
  US: "United States", CA: "Canada", GB: "United Kingdom", BZ: "Belize",
  IN: "India", AU: "Australia", NZ: "New Zealand", IE: "Ireland",
  FR: "France", DE: "Germany", IT: "Italy", ES: "Spain", NL: "Netherlands",
  SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland", PT: "Portugal",
  PL: "Poland", RO: "Romania", TR: "Turkey", GR: "Greece", CH: "Switzerland",
  AT: "Austria", BE: "Belgium", MX: "Mexico", BR: "Brazil", AR: "Argentina",
  CL: "Chile", CO: "Colombia", PE: "Peru", ZA: "South Africa", NG: "Nigeria",
  KE: "Kenya", EG: "Egypt", MA: "Morocco", DZ: "Algeria", TN: "Tunisia",
  PH: "Philippines", ID: "Indonesia", MY: "Malaysia", TH: "Thailand",
  VN: "Vietnam", SG: "Singapore", PK: "Pakistan", BD: "Bangladesh",
  LK: "Sri Lanka", AE: "United Arab Emirates", SA: "Saudi Arabia",
  IL: "Israel", IQ: "Iraq", IR: "Iran", SY: "Syria", JP: "Japan",
  KR: "South Korea", CN: "China", TW: "Taiwan", HK: "Hong Kong",
  RU: "Russia", UA: "Ukraine", PG: "Papua New Guinea", SV: "El Salvador",
  SI: "Slovenia",
};

exports.handler = async function () {
  const clientId = process.env.PHYLLO_CLIENT_ID;
  const secret = process.env.PHYLLO_SECRET;

  if (!clientId || !secret) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          "Phyllo credentials not configured. Set PHYLLO_CLIENT_ID and PHYLLO_SECRET in Netlify environment variables.",
      }),
    };
  }

  const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");

  // Fetches ALL of an account's content items published since `days` ago —
  // paginated, so accounts that post more than one page's worth within the
  // window still get a complete, uncapped total rather than being silently
  // truncated at a fixed item count. Uses Phyllo's server-side `from_date`
  // filter so the API itself does the date filtering. Returns [] if the
  // platform's engagement product hasn't finished syncing yet, or on any
  // API error — callers treat an empty list as "not available yet" and
  // leave static fallback numbers in place rather than showing zeroes.
  async function fetchContentSince(account_id, days) {
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const pageSize = 100;
    const maxPages = 20; // safety cap: up to 2,000 items, well beyond any realistic 90-day volume
    let all = [];
    try {
      for (let page = 0; page < maxPages; page++) {
        const offset = page * pageSize;
        const res = await fetch(
          `${PHYLLO_BASE}/social/contents?account_id=${account_id}&limit=${pageSize}&offset=${offset}&from_date=${fromDate}`,
          { headers: { Authorization: `Basic ${auth}` } }
        );
        if (!res.ok) break;
        const json = await res.json();
        const batch = json.data || [];
        all = all.concat(batch);
        if (batch.length < pageSize) break; // reached the last page
      }
    } catch (e) {
      // Return whatever was fetched before the error rather than nothing.
    }
    return all;
  }

  // Sums view/like/comment/share counts for items published within the
  // last `days` days. This is a direct sum of Phyllo's per-post data —
  // it measures something narrower than a platform's own in-app
  // analytics (e.g. it can't see replays/unique-reach the way the
  // platform's own dashboard can), so it's kept as a separate,
  // clearly-labeled "live" figure rather than overwriting official
  // platform analytics.
  function sumWindow(items, days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const recent = items.filter(
      (i) => i.published_at && new Date(i.published_at).getTime() >= cutoff
    );
    return {
      views: recent.reduce((s, i) => s + ((i.engagement && i.engagement.view_count) || 0), 0),
      likes: recent.reduce((s, i) => s + ((i.engagement && i.engagement.like_count) || 0), 0),
      comments: recent.reduce((s, i) => s + ((i.engagement && i.engagement.comment_count) || 0), 0),
      shares: recent.reduce((s, i) => s + ((i.engagement && i.engagement.share_count) || 0), 0),
      posts: recent.length,
    };
  }

  // Picks the top-viewed Reels published within the last `days` days.
  // Uses Phyllo's `type` field (e.g. "REELS" vs "STORY") to exclude
  // Stories, which otherwise pollute a "top performing" ranking.
  function topReels(items, days, count) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const reels = items.filter(
      (i) =>
        i.type === "REELS" &&
        i.published_at &&
        new Date(i.published_at).getTime() >= cutoff
    );
    reels.sort(
      (a, b) => ((b.engagement && b.engagement.view_count) || 0) - ((a.engagement && a.engagement.view_count) || 0)
    );
    return reels.slice(0, count).map((r) => {
      const e = r.engagement || {};
      const interactions = (e.like_count || 0) + (e.comment_count || 0) + (e.share_count || 0);
      const rawTitle = (r.title || r.description || "").replace(/\s+/g, " ").trim();
      const title = rawTitle.length > 70 ? rawTitle.slice(0, 67) + "..." : rawTitle;
      return {
        views: e.view_count ?? null,
        reach: e.reach_organic_count ?? null,
        likes: e.like_count ?? null,
        comments: e.comment_count ?? null,
        shares: e.share_count ?? null,
        interactions,
        title,
      };
    });
  }

  // Fetches Phyllo's audience-demographics data for an account (top
  // countries, gender/age split). Requires the IDENTITY.AUDIENCE product;
  // returns null if unavailable or on error, so callers fall back to
  // whatever static numbers are already in the page.
  async function fetchAudience(account_id) {
    try {
      const res = await fetch(`${PHYLLO_BASE}/audience?account_id=${account_id}`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Shapes raw Phyllo audience data into exactly what the page's
  // audience section needs: top 5 country names (no percentages, to match
  // the existing design), Women/Men percentage split, and a 5-bucket age
  // breakdown matching the page's existing age ranges (55-64 and 65+ are
  // combined into "55+"; the 13-17 bucket is dropped since the page never
  // displayed a minors bucket).
  function processAudience(raw) {
    if (!raw) return null;
    const countries = raw.countries || [];
    const top_countries = [...countries]
      .sort((a, b) => (b.value || 0) - (a.value || 0))
      .slice(0, 5)
      .map((c) => COUNTRY_NAMES[c.code] || c.code);

    const gad = raw.gender_age_distribution || [];
    let women = 0;
    let men = 0;
    const ageBuckets = { "18-24": 0, "25-34": 0, "35-44": 0, "45-54": 0, "55+": 0 };
    gad.forEach((g) => {
      if (g.gender === "FEMALE") women += g.value || 0;
      if (g.gender === "MALE") men += g.value || 0;
      if (g.age_range === "55-64" || g.age_range === "65-") {
        ageBuckets["55+"] += g.value || 0;
      } else if (Object.prototype.hasOwnProperty.call(ageBuckets, g.age_range)) {
        ageBuckets[g.age_range] += g.value || 0;
      }
    });
    const round1 = (n) => Math.round(n * 10) / 10;
    const age_buckets = {};
    Object.keys(ageBuckets).forEach((k) => {
      age_buckets[k] = round1(ageBuckets[k]);
    });

    if (!top_countries.length && !gad.length) return null;

    return {
      top_countries,
      women_pct: Math.round(women),
      men_pct: Math.round(men),
      age_buckets,
    };
  }

  const stats = await Promise.all(
    ACCOUNTS.map(async ({ platform, account_id }) => {
      try {
        const res = await fetch(`${PHYLLO_BASE}/profiles?account_id=${account_id}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!res.ok) {
          return { platform, account_id, error: `Phyllo API returned ${res.status}` };
        }
        const json = await res.json();
        const profile = (json.data && json.data[0]) || {};
        const rep = profile.reputation || {};

        const items = await fetchContentSince(account_id, 90);
        const has60d = items.length > 0;
        const w60 = has60d ? sumWindow(items, 60) : null;
        const w30 = has60d ? sumWindow(items, 30) : null;

        const audience =
          platform === "instagram" ? processAudience(await fetchAudience(account_id)) : null;

        return {
          platform,
          username: profile.platform_username || null,
          full_name: profile.full_name || null,
          followers: rep.follower_count ?? null,
          following: rep.following_count ?? null,
          posts: rep.content_count ?? null,
          avg_likes: rep.like_count ?? null,
          views_30d: w30 ? w30.views : null,
          views_60d: w60 ? w60.views : null,
          likes_60d: w60 ? w60.likes : null,
          comments_60d: w60 ? w60.comments : null,
          shares_60d: w60 ? w60.shares : null,
          posts_60d: w60 ? w60.posts : null,
          top_reels: platform === "instagram" && has60d ? topReels(items, 90, 6) : null,
          audience,
        };
      } catch (err) {
        return { platform, account_id, error: String(err) };
      }
    })
  );

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=180",
    },
    body: JSON.stringify({ updated_at: new Date().toISOString(), stats }),
  };
};
