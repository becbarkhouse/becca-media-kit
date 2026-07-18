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

  // Sums this account's video view/like counts over the last N days from
  // Phyllo's content-level engagement data. This measures something
  // narrower than a platform's own in-app analytics (e.g. it can't see
  // replays/live views the way TikTok's own dashboard can), so it's kept
  // as a separate, clearly-labeled "live" figure rather than overwriting
  // official platform analytics.
  async function recentContentTotals(account_id, days) {
    const res = await fetch(
      `${PHYLLO_BASE}/social/contents?account_id=${account_id}&limit=50`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const items = json.data || [];
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const recent = items.filter(
      (i) => i.published_at && new Date(i.published_at).getTime() >= cutoff
    );
    return {
      views_60d: recent.reduce((s, i) => s + ((i.engagement && i.engagement.view_count) || 0), 0),
      likes_60d: recent.reduce((s, i) => s + ((i.engagement && i.engagement.like_count) || 0), 0),
      comments_60d: recent.reduce((s, i) => s + ((i.engagement && i.engagement.comment_count) || 0), 0),
      shares_60d: recent.reduce((s, i) => s + ((i.engagement && i.engagement.share_count) || 0), 0),
      posts_60d: recent.length,
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

        let content60d = null;
        if (platform === "tiktok") {
          try {
            content60d = await recentContentTotals(account_id, 60);
          } catch (e) {
            content60d = null;
          }
        }

        return {
          platform,
          username: profile.platform_username || null,
          full_name: profile.full_name || null,
          followers: rep.follower_count ?? null,
          following: rep.following_count ?? null,
          posts: rep.content_count ?? null,
          avg_likes: rep.like_count ?? null,
          views_60d: content60d ? content60d.views_60d : null,
          likes_60d: content60d ? content60d.likes_60d : null,
          comments_60d: content60d ? content60d.comments_60d : null,
          shares_60d: content60d ? content60d.shares_60d : null,
          posts_60d: content60d ? content60d.posts_60d : null,
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
