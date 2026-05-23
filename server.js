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

// In-memory store: userId -> { tracks, artists, playlists, scannedAt }
const userDataStore = new Map();

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

    res.redirect("/loading.html");
  } catch (err) {
    console.error("Token exchange failed:", err.response?.data || err.message);
    res.status(500).send("Authentication failed");
  }
});

app.get("/logout", (req, res) => {
  if (req.session.userId) userDataStore.delete(req.session.userId);
  req.session.destroy();
  res.redirect("/");
});

// ---------- Scan endpoint (SSE) ----------

app.get("/api/scan", requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    const token = req.session.accessToken;
    const me = await spotifyApi("/me", token);
    const userId = me.id;
    req.session.userId = userId;

    if (userDataStore.has(userId) && Date.now() - userDataStore.get(userId).scannedAt < 600000) {
      send("done", {});
      return res.end();
    }

    send("progress", { phase: "Fetching your playlists…", percent: 0 });

    // 1. Fetch all user playlists
    const allPlaylists = [];
    let plUrl = "/me/playlists?limit=50";
    while (plUrl) {
      const page = await spotifyApi(plUrl, token);
      allPlaylists.push(...page.items);
      plUrl = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
    }

    const ownedPlaylists = allPlaylists.filter((pl) => pl.owner?.id === userId);
    const excluded = allPlaylists.length - ownedPlaylists.length;

    send("progress", {
      phase: `Found ${ownedPlaylists.length} playlists (${excluded} followed excluded). Scanning tracks…`,
      percent: 5,
    });

    // 2. Scan all tracks from owned playlists (batches of 5)
    const trackMap = {};    // trackId -> { id, name, artistIds[], albumName, albumImage, releaseDate, playlistCount }
    const artistIdSet = new Set();
    let processed = 0;
    const scanWeight = 70; // 5-75% for playlist scanning

    async function processPlaylist(pl) {
      let tUrl = `/playlists/${pl.id}/tracks?fields=items(added_at,track(id,name,artists(id,name),album(name,images,release_date))),next&limit=100`;
      while (tUrl) {
        const page = await spotifyApi(tUrl, token);
        for (const item of page.items) {
          const t = item.track;
          if (!t || !t.id) continue;

          const addedAt = item.added_at || null;

          if (!trackMap[t.id]) {
            trackMap[t.id] = {
              id: t.id,
              name: t.name,
              artistIds: t.artists?.map((a) => a.id) || [],
              artistNames: t.artists?.map((a) => a.name) || [],
              albumName: t.album?.name || "",
              albumImage: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || "",
              releaseDate: t.album?.release_date || "",
              playlistCount: 0,
              firstAdded: addedAt,
              lastAdded: addedAt,
            };
            t.artists?.forEach((a) => artistIdSet.add(a.id));
          }
          if (addedAt) {
            if (!trackMap[t.id].firstAdded || addedAt < trackMap[t.id].firstAdded) trackMap[t.id].firstAdded = addedAt;
            if (!trackMap[t.id].lastAdded || addedAt > trackMap[t.id].lastAdded) trackMap[t.id].lastAdded = addedAt;
          }
          trackMap[t.id].playlistCount++;
        }
        tUrl = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
      }
      processed++;
      const percent = Math.round(5 + (processed / ownedPlaylists.length) * scanWeight);
      send("progress", {
        phase: `Scanning playlist ${processed} of ${ownedPlaylists.length}…`,
        percent,
      });
    }

    const BATCH_SIZE = 5;
    for (let i = 0; i < ownedPlaylists.length; i += BATCH_SIZE) {
      const batch = ownedPlaylists.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(processPlaylist));
    }

    // 3. Fetch artist details for genres (Spotify allows 50 IDs per request)
    send("progress", { phase: "Fetching artist details…", percent: 76 });

    const artistMap = {};
    const artistIds = [...artistIdSet].filter(Boolean);
    const artistBatches = [];
    for (let i = 0; i < artistIds.length; i += 50) {
      artistBatches.push(artistIds.slice(i, i + 50));
    }

    for (let i = 0; i < artistBatches.length; i++) {
      const ids = artistBatches[i].join(",");
      const data = await spotifyApi(`/artists?ids=${ids}`, token);
      data.artists.forEach((a) => {
        if (!a) return;
        artistMap[a.id] = {
          id: a.id,
          name: a.name,
          genres: a.genres || [],
          image: a.images?.[2]?.url || a.images?.[0]?.url || "",
          popularity: a.popularity || 0,
        };
      });
      const percent = Math.round(76 + ((i + 1) / artistBatches.length) * 19);
      send("progress", {
        phase: `Fetching artist details… (${Math.min((i + 1) * 50, artistIds.length)} of ${artistIds.length})`,
        percent,
      });
    }

    // 4. Fetch library counts
    send("progress", { phase: "Fetching library stats…", percent: 96 });
    let savedTracks = 0, savedAlbums = 0;
    try {
      const [tr, al] = await Promise.all([
        spotifyApi("/me/tracks?limit=1", token),
        spotifyApi("/me/albums?limit=1", token),
      ]);
      savedTracks = tr.total || 0;
      savedAlbums = al.total || 0;
    } catch (_) { /* non-critical */ }

    // 5. Store everything
    userDataStore.set(userId, {
      tracks: trackMap,
      artists: artistMap,
      totalPlaylists: ownedPlaylists.length,
      savedTracks,
      savedAlbums,
      scannedAt: Date.now(),
    });

    send("progress", { phase: "Done!", percent: 100 });
    send("done", {});
    res.end();
  } catch (err) {
    console.error("Scan error:", err.response?.data || err.message);
    send("error", { message: err.message });
    res.end();
  }
});

// ---------- Dashboard endpoint ----------

app.get("/api/scan-status", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const hasData = userId && userDataStore.has(userId);
  res.json({ scanned: hasData });
});

app.get("/api/dashboard", requireAuth, (req, res) => {
  const userId = req.session.userId;
  if (!userId || !userDataStore.has(userId)) {
    return res.status(400).json({ error: "No scan data. Please scan first." });
  }

  const store = userDataStore.get(userId);
  const { tracks: trackMap, artists: artistMap } = store;
  const genreFilter = req.query.genre || "";
  const decadeFilter = req.query.decade || "";

  let tracks = Object.values(trackMap);

  // Resolve genres for each track via their artists
  tracks = tracks.map((t) => {
    const genres = new Set();
    t.artistIds.forEach((aid) => {
      artistMap[aid]?.genres?.forEach((g) => genres.add(g));
    });
    const year = parseInt(t.releaseDate?.substring(0, 4), 10) || 0;
    const decade = year ? `${Math.floor(year / 10) * 10}s` : null;
    return { ...t, genres: [...genres], decade };
  });

  // Apply filters
  if (decadeFilter) {
    tracks = tracks.filter((t) => t.decade === decadeFilter);
  }
  if (genreFilter) {
    tracks = tracks.filter((t) => t.genres.includes(genreFilter));
  }

  // Top tracks by playlist appearances
  const topTracks = [...tracks]
    .sort((a, b) => b.playlistCount - a.playlistCount)
    .slice(0, 10)
    .map((t) => ({
      name: t.name,
      artists: t.artistNames.join(", "),
      image: t.albumImage,
      playlistCount: t.playlistCount,
      decade: t.decade,
      firstAdded: t.firstAdded,
    }));

  // Top artists by number of tracks in playlists
  const artistTrackCount = {};
  const artistPlaylistCount = {};
  tracks.forEach((t) => {
    t.artistIds.forEach((aid) => {
      artistTrackCount[aid] = (artistTrackCount[aid] || 0) + 1;
      artistPlaylistCount[aid] = (artistPlaylistCount[aid] || 0) + t.playlistCount;
    });
  });

  const topArtists = Object.entries(artistPlaylistCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => {
      const a = artistMap[id] || {};
      return {
        name: a.name || "Unknown",
        image: a.image || "",
        genres: (a.genres || []).slice(0, 2),
        trackCount: artistTrackCount[id] || 0,
        totalAppearances: count,
      };
    });

  // Genre breakdown
  const genreCount = {};
  tracks.forEach((t) => {
    t.genres.forEach((g) => {
      genreCount[g] = (genreCount[g] || 0) + 1;
    });
  });
  const genres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([genre, count]) => ({ genre, count }));

  // Decade breakdown
  const decadeCount = {};
  tracks.forEach((t) => {
    if (t.decade) decadeCount[t.decade] = (decadeCount[t.decade] || 0) + 1;
  });
  const decades = Object.entries(decadeCount)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([decade, count]) => ({ decade, count }));

  // Available filter options (computed from unfiltered data for stable dropdowns)
  const allTracks = Object.values(trackMap);
  const allGenres = new Set();
  const allDecades = new Set();
  allTracks.forEach((t) => {
    t.artistIds.forEach((aid) => {
      artistMap[aid]?.genres?.forEach((g) => allGenres.add(g));
    });
    const yr = parseInt(t.releaseDate?.substring(0, 4), 10) || 0;
    if (yr) allDecades.add(`${Math.floor(yr / 10) * 10}s`);
  });

  res.json({
    topTracks,
    topArtists,
    genres,
    decades,
    savedTracks: store.savedTracks,
    savedAlbums: store.savedAlbums,
    totalPlaylists: store.totalPlaylists,
    totalUniqueTracksScanned: allTracks.length,
    totalUniqueArtistsScanned: Object.keys(artistMap).length,
    filterOptions: {
      genres: [...allGenres].sort(),
      decades: [...allDecades].sort(),
    },
    activeFilters: { genre: genreFilter, decade: decadeFilter },
  });
});

// ---------- Trends endpoint ----------

app.get("/api/trends", requireAuth, (req, res) => {
  const userId = req.session.userId;
  if (!userId || !userDataStore.has(userId)) {
    return res.status(400).json({ error: "No scan data." });
  }

  const store = userDataStore.get(userId);
  const { tracks: trackMap, artists: artistMap } = store;
  const artistFilter = req.query.artist || "";
  const genreFilter = req.query.genre || "";
  const decadeFilter = req.query.decade || "";

  const allTracks = Object.values(trackMap);

  // Resolve genres/decade and group by month
  const enriched = allTracks
    .filter((t) => t.firstAdded)
    .map((t) => {
      const genres = new Set();
      t.artistIds.forEach((aid) => {
        artistMap[aid]?.genres?.forEach((g) => genres.add(g));
      });
      const year = parseInt(t.releaseDate?.substring(0, 4), 10) || 0;
      const decade = year ? `${Math.floor(year / 10) * 10}s` : null;
      const month = t.firstAdded.substring(0, 7);
      return { ...t, genres: [...genres], decade, month };
    })
    .sort((a, b) => a.month.localeCompare(b.month));

  // Helper: trim months where all series values are 0
  function trimSeries(months, seriesArr) {
    if (!months.length) return { months: [], series: seriesArr };
    let first = 0;
    let last = months.length - 1;
    while (first < months.length && seriesArr.every((s) => !s.data[first])) first++;
    while (last > first && seriesArr.every((s) => !s.data[last])) last--;
    const trimmedMonths = months.slice(first, last + 1);
    const trimmedSeries = seriesArr.map((s) => ({
      ...s,
      data: s.data.slice(first, last + 1),
    }));
    return { months: trimmedMonths, series: trimmedSeries };
  }

  function trimFlat(months, dataArr) {
    if (!months.length) return { months: [], data: [] };
    let first = 0;
    let last = months.length - 1;
    while (first < months.length && !dataArr[first]) first++;
    while (last > first && !dataArr[last]) last--;
    return { months: months.slice(first, last + 1), data: dataArr.slice(first, last + 1) };
  }

  // Apply genre/decade filters
  let filtered = enriched;
  if (decadeFilter) filtered = filtered.filter((t) => t.decade === decadeFilter);
  if (genreFilter) filtered = filtered.filter((t) => t.genres.includes(genreFilter));

  // Build month list from filtered data only
  const filteredMonthSet = new Set();
  filtered.forEach((t) => filteredMonthSet.add(t.month));
  const filteredMonths = [...filteredMonthSet].sort();

  // Genre over time (uses filtered tracks + filtered months)
  const genreTotals = {};
  filtered.forEach((t) => {
    t.genres.forEach((g) => { genreTotals[g] = (genreTotals[g] || 0) + 1; });
  });
  const topGenreNames = genreFilter
    ? [genreFilter]
    : Object.entries(genreTotals).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g]) => g);

  const genreOverTime = {};
  topGenreNames.forEach((g) => { genreOverTime[g] = {}; });
  filtered.forEach((t) => {
    t.genres.forEach((g) => {
      if (genreOverTime[g]) {
        genreOverTime[g][t.month] = (genreOverTime[g][t.month] || 0) + 1;
      }
    });
  });

  const rawGenreSeries = topGenreNames.map((genre) => ({
    label: genre,
    data: filteredMonths.map((m) => genreOverTime[genre][m] || 0),
  }));
  const genreTrimmed = trimSeries(filteredMonths, rawGenreSeries);

  // Decade over time (also uses filtered tracks)
  const decadeSet = new Set();
  filtered.forEach((t) => { if (t.decade) decadeSet.add(t.decade); });
  const decadeNames = [...decadeSet].sort();

  const decadeOverTime = {};
  decadeNames.forEach((d) => { decadeOverTime[d] = {}; });
  filtered.forEach((t) => {
    if (t.decade && decadeOverTime[t.decade]) {
      decadeOverTime[t.decade][t.month] = (decadeOverTime[t.decade][t.month] || 0) + 1;
    }
  });

  const rawDecadeSeries = decadeNames.map((decade) => ({
    label: decade,
    data: filteredMonths.map((m) => decadeOverTime[decade][m] || 0),
  }));
  const decadeTrimmed = trimSeries(filteredMonths, rawDecadeSeries);

  // Artist timeline (if requested) — uses full enriched data, not filtered
  let artistTimeline = null;
  let artistMonths = null;
  let artistName = "";
  if (artistFilter && artistMap[artistFilter]) {
    artistName = artistMap[artistFilter].name;
    const perMonth = {};
    const artistMonthSet = new Set();
    enriched.forEach((t) => {
      if (t.artistIds.includes(artistFilter)) {
        perMonth[t.month] = (perMonth[t.month] || 0) + 1;
        artistMonthSet.add(t.month);
      }
    });
    const sortedArtistMonths = [...artistMonthSet].sort();
    artistMonths = sortedArtistMonths;
    artistTimeline = sortedArtistMonths.map((m) => perMonth[m] || 0);
  }

  // Filter option lists for the trends section (genres sorted by track count)
  const trendGenreCounts = {};
  const trendDecadeSet = new Set();
  enriched.forEach((t) => {
    t.genres.forEach((g) => { trendGenreCounts[g] = (trendGenreCounts[g] || 0) + 1; });
    if (t.decade) trendDecadeSet.add(t.decade);
  });
  const trendGenresSorted = Object.entries(trendGenreCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([g, count]) => ({ name: g, count }));

  // Artist list for dropdown
  const artistTrackCounts = {};
  allTracks.forEach((t) => {
    t.artistIds.forEach((aid) => {
      artistTrackCounts[aid] = (artistTrackCounts[aid] || 0) + 1;
    });
  });

  const artistList = Object.entries(artistTrackCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([id, count]) => ({
      id,
      name: artistMap[id]?.name || "Unknown",
      trackCount: count,
    }));

  res.json({
    genreMonths: genreTrimmed.months,
    genreSeries: genreTrimmed.series,
    decadeMonths: decadeTrimmed.months,
    decadeSeries: decadeTrimmed.series,
    artistMonths,
    artistTimeline,
    artistName,
    artistList,
    filterOptions: {
      genres: trendGenresSorted,
      decades: [...trendDecadeSet].sort(),
    },
  });
});

// ---------- Momentum endpoint (genres, decades, artists) ----------

app.get("/api/momentum", requireAuth, (req, res) => {
  const userId = req.session.userId;
  if (!userId || !userDataStore.has(userId)) {
    return res.status(400).json({ error: "No scan data." });
  }

  const store = userDataStore.get(userId);
  const { tracks: trackMap, artists: artistMap } = store;

  const allTracks = Object.values(trackMap)
    .filter((t) => t.firstAdded)
    .map((t) => {
      const genres = new Set();
      t.artistIds.forEach((aid) => {
        artistMap[aid]?.genres?.forEach((g) => genres.add(g));
      });
      const year = parseInt(t.releaseDate?.substring(0, 4), 10) || 0;
      const decade = year ? `${Math.floor(year / 10) * 10}s` : null;
      return { genres: [...genres], decade, artistIds: t.artistIds, addedAt: new Date(t.firstAdded) };
    });

  if (!allTracks.length) return res.json({ periods: {} });

  const now = new Date();
  const windows = {
    "4 weeks": new Date(now - 28 * 86400000),
    "6 months": new Date(now - 182 * 86400000),
    "1 year": new Date(now - 365 * 86400000),
  };

  const earliest = allTracks.reduce((min, t) => t.addedAt < min ? t.addedAt : min, allTracks[0].addedAt);
  const totalDays = Math.max(1, (now - earliest) / 86400000);

  function computeMomentum(totalCounts, windowCounts, windowDays, minCount) {
    return Object.entries(totalCounts)
      .filter(([, c]) => c >= minCount)
      .map(([name, totalCount]) => {
        const windowCount = windowCounts[name] || 0;
        const historicalRate = totalCount / totalDays;
        const windowRate = windowCount / windowDays;
        const expectedCount = Math.round(historicalRate * windowDays * 10) / 10;
        const change = historicalRate > 0
          ? Math.round(((windowRate - historicalRate) / historicalRate) * 100)
          : (windowCount > 0 ? 100 : 0);
        return { name, windowCount, expectedCount, totalCount, change };
      });
  }

  // All-time totals
  const genreTotals = {};
  const decadeTotals = {};
  const artistTotals = {};
  allTracks.forEach((t) => {
    t.genres.forEach((g) => { genreTotals[g] = (genreTotals[g] || 0) + 1; });
    if (t.decade) decadeTotals[t.decade] = (decadeTotals[t.decade] || 0) + 1;
    t.artistIds.forEach((aid) => { artistTotals[aid] = (artistTotals[aid] || 0) + 1; });
  });

  const result = {};

  for (const [label, cutoff] of Object.entries(windows)) {
    const windowDays = Math.max(1, (now - cutoff) / 86400000);
    const windowTracks = allTracks.filter((t) => t.addedAt >= cutoff);

    const genreWindow = {};
    const decadeWindow = {};
    const artistWindow = {};
    windowTracks.forEach((t) => {
      t.genres.forEach((g) => { genreWindow[g] = (genreWindow[g] || 0) + 1; });
      if (t.decade) decadeWindow[t.decade] = (decadeWindow[t.decade] || 0) + 1;
      t.artistIds.forEach((aid) => { artistWindow[aid] = (artistWindow[aid] || 0) + 1; });
    });

    const genres = computeMomentum(genreTotals, genreWindow, windowDays, 5);
    const decades = computeMomentum(decadeTotals, decadeWindow, windowDays, 3);
    const artists = computeMomentum(artistTotals, artistWindow, windowDays, 3)
      .map((a) => ({ ...a, name: artistMap[a.name]?.name || a.name }));

    result[label] = { genres, decades, artists };
  }

  res.json({ periods: result });
});

// ---------- Spotify listening history (live from API, supports time range) ----------

app.get("/api/top-artists", requireAuth, async (req, res) => {
  const range = req.query.range || "medium_term";
  try {
    const data = await spotifyApi(
      `/me/top/artists?limit=10&time_range=${range}`,
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
      `/me/top/tracks?limit=10&time_range=${range}`,
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
      "/me/player/recently-played?limit=8",
      req.session.accessToken
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const data = await spotifyApi("/me", req.session.accessToken);
    req.session.userId = data.id;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
});
