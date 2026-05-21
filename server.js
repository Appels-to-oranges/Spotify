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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
