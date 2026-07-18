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

  // Fetches an account's recent content items (posts/videos) with their
  // engagement counts. Returns [] if the platform's engagement product
  // hasn't finished syncing yet in Phyllo, or on any API error — callers
  // treat an empty list as "not available yet" and leave static fallback
  // numbers in place rather than showing zeroes.
  async function fetchRecentContent(account_id) {
    try {
      const res = await fetch(
        `${PHYLLO_BASE}/social/contents?account_id=${account_id}&limit=100`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    } catch (e) {
      return [];
    }
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

        const items = await fetchRecentContent(account_id);
        const has60d = items.length > 0;
        const w60 = has60d ? sumWindow(items, 60) : null;
        const w30 = has60d ? sumWindow(items, 30) : null;

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
