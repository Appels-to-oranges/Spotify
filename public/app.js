(() => {
  const $ = (sel) => document.querySelector(sel);
  let currentRange = "short_term";

  let rawArtists = [];
  let rawTracks = [];
  let rawGenres = [];

  async function api(path) {
    const res = await fetch(path);
    if (res.status === 401) {
      window.location.href = "/";
      return null;
    }
    return res.json();
  }

  function skeleton(count = 5) {
    return Array.from({ length: count }, () => '<li class="skeleton"></li>').join("");
  }

  function getDecade(track) {
    const year = parseInt(track.album?.release_date?.substring(0, 4), 10);
    if (!year) return null;
    return `${Math.floor(year / 10) * 10}s`;
  }

  // ---------- Renderers ----------

  function renderArtists(items) {
    if (!items.length) return '<li class="stat-item"><div class="stat-info"><div class="stat-sub">No artists match filters</div></div></li>';
    return items
      .map(
        (a, i) => `
      <li class="stat-item">
        <span class="stat-rank">${i + 1}</span>
        <img class="stat-img round" src="${a.images?.[2]?.url || a.images?.[0]?.url || ""}" alt="${a.name}" />
        <div class="stat-info">
          <div class="stat-title">${a.name}</div>
          <div class="stat-sub">${a.genres?.slice(0, 2).join(", ") || "—"}</div>
        </div>
      </li>`
      )
      .join("");
  }

  function renderTracks(items) {
    if (!items.length) return '<li class="stat-item"><div class="stat-info"><div class="stat-sub">No tracks match filters</div></div></li>';
    return items
      .map(
        (t, i) => `
      <li class="stat-item">
        <span class="stat-rank">${i + 1}</span>
        <img class="stat-img" src="${t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || ""}" alt="${t.name}" />
        <div class="stat-info">
          <div class="stat-title">${t.name}</div>
          <div class="stat-sub">${t.artists?.map((a) => a.name).join(", ")}</div>
        </div>
      </li>`
      )
      .join("");
  }

  function renderBarChart(items, labelKey, countKey) {
    if (!items.length) return '<li class="genre-item"><span class="genre-label">No data</span></li>';
    const max = items[0]?.[countKey] || 1;
    return items
      .map(
        (g) => `
      <li class="genre-item">
        <span class="genre-label">${g[labelKey]}</span>
        <div class="genre-bar-container">
          <div class="genre-bar" style="width:${(g[countKey] / max) * 100}%"></div>
        </div>
        <span class="genre-count">${g[countKey]}</span>
      </li>`
      )
      .join("");
  }

  function renderPlaylistAppearances(data) {
    if (!data.items.length) {
      return '<li class="stat-item"><div class="stat-info"><div class="stat-sub">No songs appear in multiple playlists</div></div></li>';
    }
    return data.items
      .map(
        (t, i) => `
      <li class="stat-item">
        <span class="stat-rank">${i + 1}</span>
        <img class="stat-img" src="${t.image}" alt="${t.name}" />
        <div class="stat-info">
          <div class="stat-title">${t.name}</div>
          <div class="stat-sub">${t.artists} · in ${t.count} of ${t.totalPlaylists} playlists</div>
        </div>
      </li>`
      )
      .join("");
  }

  function renderRecent(items) {
    return items
      .map((r) => {
        const t = r.track;
        const time = new Date(r.played_at).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        return `
      <li class="stat-item">
        <img class="stat-img" src="${t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || ""}" alt="${t.name}" />
        <div class="stat-info">
          <div class="stat-title">${t.name}</div>
          <div class="stat-sub">${t.artists?.map((a) => a.name).join(", ")} · ${time}</div>
        </div>
      </li>`;
      })
      .join("");
  }

  function renderLibraryStats(data) {
    return `
      <div class="library-stat">
        <span class="library-stat-number">${data.savedTracks.toLocaleString()}</span>
        <span class="library-stat-label">Saved Tracks</span>
      </div>
      <div class="library-stat">
        <span class="library-stat-number">${data.savedAlbums.toLocaleString()}</span>
        <span class="library-stat-label">Saved Albums</span>
      </div>`;
  }

  // ---------- Filters ----------

  function populateFilters() {
    const genreSelect = $("#genre-filter");
    const decadeSelect = $("#decade-filter");
    const currentGenre = genreSelect.value;
    const currentDecade = decadeSelect.value;

    const genres = new Set();
    rawArtists.forEach((a) => a.genres?.forEach((g) => genres.add(g)));
    const sortedGenres = [...genres].sort();

    genreSelect.innerHTML = '<option value="">All genres</option>' +
      sortedGenres.map((g) => `<option value="${g}">${g}</option>`).join("");

    const decades = new Set();
    rawTracks.forEach((t) => {
      const d = getDecade(t);
      if (d) decades.add(d);
    });
    const sortedDecades = [...decades].sort();

    decadeSelect.innerHTML = '<option value="">All decades</option>' +
      sortedDecades.map((d) => `<option value="${d}">${d}</option>`).join("");

    genreSelect.value = sortedGenres.includes(currentGenre) ? currentGenre : "";
    decadeSelect.value = sortedDecades.includes(currentDecade) ? currentDecade : "";
  }

  function applyFilters() {
    const genre = $("#genre-filter").value;
    const decade = $("#decade-filter").value;
    const clearBtn = $("#filter-clear");
    clearBtn.style.display = genre || decade ? "" : "none";

    let filteredArtists = rawArtists;
    let filteredTracks = rawTracks;

    if (genre) {
      const matchingArtistIds = new Set();
      filteredArtists = rawArtists.filter((a) => {
        const match = a.genres?.includes(genre);
        if (match) matchingArtistIds.add(a.id);
        return match;
      });
      filteredTracks = filteredTracks.filter((t) =>
        t.artists?.some((a) => matchingArtistIds.has(a.id))
      );
    }

    if (decade) {
      filteredTracks = filteredTracks.filter((t) => getDecade(t) === decade);
    }

    $("#top-artists").innerHTML = renderArtists(filteredArtists);
    $("#top-tracks").innerHTML = renderTracks(filteredTracks);

    if (genre) {
      const filtered = rawGenres.filter((g) => g.genre === genre);
      $("#genre-breakdown").innerHTML = renderBarChart(
        filtered.length ? filtered : rawGenres,
        "genre",
        "count"
      );
    } else {
      $("#genre-breakdown").innerHTML = renderBarChart(rawGenres, "genre", "count");
    }
  }

  // ---------- Loaders ----------

  async function loadProfile() {
    const me = await api("/api/me");
    if (!me) return;
    const img = me.images?.[0]?.url;
    $("#profile-info").innerHTML = `
      ${img ? `<img class="profile-avatar" src="${img}" alt="avatar" />` : ""}
      <span class="profile-name">${me.display_name}<small>${me.product === "premium" ? "Premium" : "Free"} · ${me.country || ""}</small></span>
    `;
  }

  async function loadLibraryStats() {
    const data = await api("/api/library-stats");
    if (data) {
      $("#library-stats").innerHTML = renderLibraryStats(data);
    }
  }

  async function loadStats() {
    const lists = ["top-artists", "top-tracks", "genre-breakdown", "decade-breakdown", "recently-played"];
    lists.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = skeleton();
    });

    const [artists, tracks, genres, decades, recent] = await Promise.all([
      api(`/api/top-artists?range=${currentRange}`),
      api(`/api/top-tracks?range=${currentRange}`),
      api(`/api/genre-breakdown?range=${currentRange}`),
      api(`/api/decade-breakdown?range=${currentRange}`),
      api("/api/recently-played"),
    ]);

    rawArtists = artists?.items || [];
    rawTracks = tracks?.items || [];
    rawGenres = genres || [];

    populateFilters();

    if (artists) $("#top-artists").innerHTML = renderArtists(rawArtists);
    if (tracks) $("#top-tracks").innerHTML = renderTracks(rawTracks);
    if (genres) $("#genre-breakdown").innerHTML = renderBarChart(rawGenres, "genre", "count");
    if (decades) $("#decade-breakdown").innerHTML = renderBarChart(decades, "decade", "count");
    if (recent) $("#recently-played").innerHTML = renderRecent(recent.items || []);

    applyFilters();
  }

  function loadPlaylists() {
    $("#playlist-appearances").innerHTML = "";
    $("#playlist-subtitle").innerHTML = `
      <span class="progress-text">Connecting…</span>
      <div class="progress-bar-container">
        <div class="progress-bar" style="width:0%"></div>
      </div>`;

    const source = new EventSource("/api/playlist-appearances");

    source.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.type === "progress") {
        $(".progress-text").textContent = data.phase;
        $(".progress-bar").style.width = data.percent + "%";
      } else if (data.type === "done") {
        source.close();
        $("#playlist-subtitle").textContent = `Songs appearing in 2+ of your ${data.totalPlaylists} playlists`;
        $("#playlist-appearances").innerHTML = renderPlaylistAppearances(data);
      } else if (data.type === "error") {
        source.close();
        $("#playlist-subtitle").textContent = "Failed to load playlist data";
      }
    };

    source.onerror = () => {
      source.close();
      if (!$("#playlist-appearances").children.length) {
        $("#playlist-subtitle").textContent = "Failed to connect";
      }
    };
  }

  // ---------- Event listeners ----------

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentRange = btn.dataset.range;
      $("#genre-filter").value = "";
      $("#decade-filter").value = "";
      $("#filter-clear").style.display = "none";
      loadStats();
    });
  });

  $("#genre-filter").addEventListener("change", applyFilters);
  $("#decade-filter").addEventListener("change", applyFilters);
  $("#filter-clear").addEventListener("click", () => {
    $("#genre-filter").value = "";
    $("#decade-filter").value = "";
    $("#filter-clear").style.display = "none";
    applyFilters();
  });

  loadProfile();
  loadLibraryStats();
  loadStats();
  loadPlaylists();
})();
