// Netlify serverless function — pulls live creator stats from Phyllo.
// Keeps the Phyllo Client ID / Secret private on the server side.
// Set PHYLLO_CLIENT_ID and PHYLLO_SECRET as environment variables in your
// Netlify site settings (Site configuration > Environment variables).
// Do NOT put those values in this file or in git.

const PHYLLO_BASE = process.env.PHYLLO_BASE_URL || "https://api.staging.getphyllo.com/v1";

// Account IDs are not secret — safe to keep in code.
// Add the TikTok account_id here once it's connected in Phyllo.
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
        return {
          platform,
          username: profile.platform_username || null,
          full_name: profile.full_name || null,
          followers: rep.follower_count ?? null,
          following: rep.following_count ?? null,
          posts: rep.content_count ?? null,
          avg_likes: rep.like_count ?? null,
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
