require("dotenv").config();
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-top-read",
  "user-read-recently-played",
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 },
  })
);

app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

async function spotifyApi(endpoint, accessToken) {
  const res = await axios.get(`https://api.spotify.com/v1${endpoint}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data;
}

// ---------- Auth routes ----------

app.get("/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (state !== req.session.oauthState) {
    return res.status(403).send("State mismatch");
  }

  try {
    const tokenRes = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
        },
      }
    );

    req.session.accessToken = tokenRes.data.access_token;
    req.session.refreshToken = tokenRes.data.refresh_token;
    req.session.tokenExpiry = Date.now() + tokenRes.data.expires_in * 1000;

    res.redirect("/dashboard.html");
  } catch (err) {
    console.error("Token exchange failed:", err.response?.data || err.message);
    res.status(500).send("Authentication failed");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

// ---------- API routes ----------

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const data = await spotifyApi("/me", req.session.accessToken);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/top-artists", requireAuth, async (req, res) => {
  const range = req.query.range || "medium_term";
  try {
    const data = await spotifyApi(
      `/me/top/artists?limit=20&time_range=${range}`,
      req.session.accessToken
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/top-tracks", requireAuth, async (req, res) => {
  const range = req.query.range || "medium_term";
  try {
    const data = await spotifyApi(
      `/me/top/tracks?limit=20&time_range=${range}`,
      req.session.accessToken
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/recently-played", requireAuth, async (req, res) => {
  try {
    const data = await spotifyApi(
      "/me/player/recently-played?limit=20",
      req.session.accessToken
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/genre-breakdown", requireAuth, async (req, res) => {
  const range = req.query.range || "medium_term";
  try {
    const artists = await spotifyApi(
      `/me/top/artists?limit=50&time_range=${range}`,
      req.session.accessToken
    );

    const genreCount = {};
    artists.items.forEach((artist) => {
      artist.genres.forEach((genre) => {
        genreCount[genre] = (genreCount[genre] || 0) + 1;
      });
    });

    const sorted = Object.entries(genreCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([genre, count]) => ({ genre, count }));

    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/playlist-appearances", requireAuth, async (req, res) => {
  try {
    if (req.session.playlistCache && Date.now() - req.session.playlistCacheTime < 300000) {
      return res.json(req.session.playlistCache);
    }

    const token = req.session.accessToken;

    // Fetch all user playlists (paginated)
    const playlists = [];
    let url = "/me/playlists?limit=50";
    while (url) {
      const page = await spotifyApi(url, token);
      playlists.push(...page.items);
      url = page.next
        ? page.next.replace("https://api.spotify.com/v1", "")
        : null;
    }

    // Fetch tracks from each playlist and count appearances per track ID
    const trackCounts = {};
    const trackMeta = {};

    for (const pl of playlists) {
      let tracksUrl = `/playlists/${pl.id}/tracks?fields=items(track(id,name,artists(name),album(images))),next&limit=100`;
      while (tracksUrl) {
        const page = await spotifyApi(tracksUrl, token);
        for (const item of page.items) {
          const t = item.track;
          if (!t || !t.id) continue;
          trackCounts[t.id] = (trackCounts[t.id] || 0) + 1;
          if (!trackMeta[t.id]) {
            trackMeta[t.id] = {
              name: t.name,
              artists: t.artists?.map((a) => a.name).join(", "),
              image:
                t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || "",
            };
          }
        }
        tracksUrl = page.next
          ? page.next.replace("https://api.spotify.com/v1", "")
          : null;
      }
    }

    const sorted = Object.entries(trackCounts)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, count]) => ({
        id,
        count,
        totalPlaylists: playlists.length,
        ...trackMeta[id],
      }));

    const result = { items: sorted, totalPlaylists: playlists.length };
    req.session.playlistCache = result;
    req.session.playlistCacheTime = Date.now();
    res.json(result);
  } catch (err) {
    console.error("Playlist appearances error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
});
