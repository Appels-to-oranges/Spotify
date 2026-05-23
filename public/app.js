(() => {
  const $ = (sel) => document.querySelector(sel);
  let currentRange = "short_term";

  async function api(path) {
    const res = await fetch(path);
    if (res.status === 401) {
      window.location.href = "/";
      return null;
    }
    if (res.status === 400) {
      window.location.href = "/loading.html";
      return null;
    }
    return res.json();
  }

  function skeleton(count = 4) {
    return Array.from({ length: count }, () => '<li class="skeleton"></li>').join("");
  }

  // ---------- Renderers ----------

  function renderListeningArtists(items) {
    if (!items.length) return '<li class="stat-item"><div class="stat-info"><div class="stat-sub">No data</div></div></li>';
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

  function renderListeningTracks(items) {
    if (!items.length) return '<li class="stat-item"><div class="stat-info"><div class="stat-sub">No data</div></div></li>';
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

  function renderCuratedArtists(items) {
    if (!items.length) return '<li class="stat-item"><div class="stat-info"><div class="stat-sub">No artists match filters</div></div></li>';
    return items
      .map(
        (a, i) => `
      <li class="stat-item">
        <span class="stat-rank">${i + 1}</span>
        ${a.image ? `<img class="stat-img round" src="${a.image}" alt="${a.name}" />` : '<div class="stat-img round" style="background:var(--surface-hover)"></div>'}
        <div class="stat-info">
          <div class="stat-title">${a.name}</div>
          <div class="stat-sub">${a.genres.join(", ") || "—"} · ${a.trackCount} tracks · ${a.totalAppearances} appearances</div>
        </div>
      </li>`
      )
      .join("");
  }

  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function renderCuratedTracks(items) {
    if (!items.length) return '<li class="stat-item"><div class="stat-info"><div class="stat-sub">No tracks match filters</div></div></li>';
    return items
      .map(
        (t, i) => `
      <li class="stat-item">
        <span class="stat-rank">${i + 1}</span>
        <img class="stat-img" src="${t.image}" alt="${t.name}" />
        <div class="stat-info">
          <div class="stat-title">${t.name}</div>
          <div class="stat-sub">${t.artists} · in ${t.playlistCount} playlists${t.firstAdded ? ` · added ${formatDate(t.firstAdded)}` : ""}</div>
        </div>
      </li>`
      )
      .join("");
  }

  function renderBarChart(items, labelKey, countKey) {
    if (!items.length) return '<li class="genre-item"><span class="genre-label">No data</span></li>';
    const max = Math.max(...items.map((g) => g[countKey])) || 1;
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
    const stats = [
      [data.totalUniqueTracksScanned, "Tracks"],
      [data.totalUniqueArtistsScanned, "Artists"],
      [data.totalPlaylists, "Playlists"],
      [data.savedTracks, "Saved"],
      [data.savedAlbums, "Albums"],
    ];
    return stats.map(([n, l]) =>
      `<div class="library-stat"><span class="library-stat-number">${n.toLocaleString()}</span><span class="library-stat-label">${l}</span></div>`
    ).join("");
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

  async function loadListeningHistory() {
    ["listening-artists", "listening-tracks", "recently-played"].forEach((id) => {
      document.getElementById(id).innerHTML = skeleton();
    });

    const [artists, tracks, recent] = await Promise.all([
      api(`/api/top-artists?range=${currentRange}`),
      api(`/api/top-tracks?range=${currentRange}`),
      api("/api/recently-played"),
    ]);

    if (artists) $("#listening-artists").innerHTML = renderListeningArtists(artists.items || []);
    if (tracks) $("#listening-tracks").innerHTML = renderListeningTracks(tracks.items || []);
    if (recent) $("#recently-played").innerHTML = renderRecent(recent.items || []);
  }

  async function loadPlaylistAnalysis() {
    const genre = $("#genre-filter").value;
    const decade = $("#decade-filter").value;

    ["top-artists", "top-tracks", "genre-breakdown", "decade-breakdown"].forEach((id) => {
      document.getElementById(id).innerHTML = skeleton();
    });

    const params = new URLSearchParams();
    if (genre) params.set("genre", genre);
    if (decade) params.set("decade", decade);

    const data = await api(`/api/dashboard?${params}`);
    if (!data) return;

    if (!genre && !decade) {
      $("#library-stats").innerHTML = renderLibraryStats(data);
    }

    populateFilters(data.filterOptions, genre, decade);

    $("#top-artists").innerHTML = renderCuratedArtists(data.topArtists || []);
    $("#top-tracks").innerHTML = renderCuratedTracks(data.topTracks || []);
    $("#genre-breakdown").innerHTML = renderBarChart(data.genres || [], "genre", "count");
    $("#decade-breakdown").innerHTML = renderBarChart(data.decades || [], "decade", "count");

    $("#filter-clear").style.display = genre || decade ? "" : "none";
  }

  function populateFilters(options, currentGenre, currentDecade) {
    const genreSelect = $("#genre-filter");
    const decadeSelect = $("#decade-filter");

    genreSelect.innerHTML = '<option value="">All genres</option>' +
      options.genres.map((g) => `<option value="${g}"${g === currentGenre ? " selected" : ""}>${g}</option>`).join("");

    decadeSelect.innerHTML = '<option value="">All decades</option>' +
      options.decades.map((d) => `<option value="${d}"${d === currentDecade ? " selected" : ""}>${d}</option>`).join("");
  }

  // ---------- Chart helpers ----------

  const CHART_COLORS = [
    "#1db954", "#818cf8", "#f472b6", "#fb923c", "#22d3ee",
    "#facc15", "#c084fc", "#34d399", "#f87171", "#38bdf8",
  ];

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: "bottom",
        labels: { color: "#888", boxWidth: 12, padding: 12, font: { size: 11 } },
      },
      tooltip: {
        backgroundColor: "#1e1e1e",
        titleColor: "#e4e4e4",
        bodyColor: "#e4e4e4",
        borderColor: "#2a2a2a",
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        ticks: { color: "#888", font: { size: 10 }, maxTicksLimit: 12 },
        grid: { color: "rgba(255,255,255,0.05)" },
      },
      y: {
        ticks: { color: "#888", font: { size: 10 } },
        grid: { color: "rgba(255,255,255,0.05)" },
        beginAtZero: true,
      },
    },
  };

  let genreChart = null;
  let decadeChart = null;
  let artistChart = null;
  let cachedTrendsData = null;

  function formatMonth(m) {
    const [y, mo] = m.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(mo, 10) - 1]} ${y.slice(2)}`;
  }

  function makeLineDatasets(series) {
    return series.map((s, i) => ({
      label: s.label,
      data: s.data,
      borderColor: CHART_COLORS[i % CHART_COLORS.length],
      backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + "20",
      borderWidth: 2,
      tension: 0.3,
      fill: false,
      pointRadius: 0,
      pointHitRadius: 8,
    }));
  }

  async function loadTrends() {
    const data = await api("/api/trends");
    if (!data) return;
    cachedTrendsData = data;

    renderGenreChart(data);
    renderDecadeChart(data);
    populateTrendFilters(data.filterOptions);
    populateArtistPicker(data.artistList);
    initSearchableGenre();
  }

  function renderGenreChart(data) {
    if (genreChart) genreChart.destroy();
    const labels = (data.genreMonths || []).map(formatMonth);
    genreChart = new Chart(document.getElementById("genre-trends-chart"), {
      type: "line",
      data: { labels, datasets: makeLineDatasets(data.genreSeries || []) },
      options: chartDefaults,
    });
  }

  function renderDecadeChart(data) {
    if (decadeChart) decadeChart.destroy();
    const labels = (data.decadeMonths || []).map(formatMonth);
    decadeChart = new Chart(document.getElementById("decade-trends-chart"), {
      type: "line",
      data: { labels, datasets: makeLineDatasets(data.decadeSeries || []) },
      options: chartDefaults,
    });
  }

  let trendGenreOptions = [];

  function initSearchableGenre() {
    const wrapper = document.getElementById("trend-genre-picker");
    const input = wrapper.querySelector(".searchable-input");
    const dropdown = wrapper.querySelector(".searchable-dropdown");
    const hidden = $("#trend-genre-filter");

    function render(filter) {
      const q = (filter || "").toLowerCase();
      const filtered = q
        ? trendGenreOptions.filter((g) => g.name.toLowerCase().includes(q))
        : trendGenreOptions;

      const allItem = `<div class="searchable-option${!hidden.value ? " active" : ""}" data-value="">All genres</div>`;
      dropdown.innerHTML = allItem + filtered.map((g) =>
        `<div class="searchable-option${hidden.value === g.name ? " active" : ""}" data-value="${g.name}">${g.name}<span class="genre-count-badge">${g.count}</span></div>`
      ).join("");
    }

    input.addEventListener("focus", () => {
      render(input.value);
      dropdown.classList.add("open");
    });

    input.addEventListener("input", () => {
      render(input.value);
      dropdown.classList.add("open");
    });

    dropdown.addEventListener("click", (e) => {
      const opt = e.target.closest(".searchable-option");
      if (!opt) return;
      const val = opt.dataset.value;
      hidden.value = val;
      input.value = val || "";
      input.placeholder = val ? "Search genres…" : "Search genres…";
      dropdown.classList.remove("open");
      reloadTrendCharts();
    });

    document.addEventListener("click", (e) => {
      if (!wrapper.contains(e.target)) dropdown.classList.remove("open");
    });
  }

  function populateTrendFilters(options) {
    trendGenreOptions = options.genres;
    const df = $("#trend-decade-filter");
    const currentD = df.value;

    df.innerHTML = '<option value="">All decades</option>' +
      options.decades.map((d) => `<option value="${d}"${d === currentD ? " selected" : ""}>${d}</option>`).join("");
  }

  function populateArtistPicker(artistList) {
    const picker = $("#artist-picker-select");
    const current = picker.value;
    picker.innerHTML = '<option value="">Select an artist…</option>' +
      artistList.map((a) =>
        `<option value="${a.id}"${a.id === current ? " selected" : ""}>${a.name} (${a.trackCount} tracks)</option>`
      ).join("");
  }

  async function reloadTrendCharts() {
    const genre = $("#trend-genre-filter").value;
    const decade = $("#trend-decade-filter").value;
    const params = new URLSearchParams();
    if (genre) params.set("genre", genre);
    if (decade) params.set("decade", decade);

    const data = await api(`/api/trends?${params}`);
    if (!data) return;
    renderGenreChart(data);
    renderDecadeChart(data);
  }

  async function loadArtistTimeline(artistId) {
    const emptyMsg = $("#artist-timeline-empty");
    if (!artistId) {
      if (artistChart) { artistChart.destroy(); artistChart = null; }
      emptyMsg.style.display = "";
      return;
    }

    const data = await api(`/api/trends?artist=${artistId}`);
    if (!data || !data.artistTimeline) return;

    emptyMsg.style.display = "none";
    const labels = (data.artistMonths || []).map(formatMonth);

    if (artistChart) artistChart.destroy();
    artistChart = new Chart(document.getElementById("artist-timeline-chart"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: `${data.artistName} — tracks added`,
          data: data.artistTimeline,
          backgroundColor: "#1db954" + "80",
          borderColor: "#1db954",
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        ...chartDefaults,
        plugins: {
          ...chartDefaults.plugins,
          legend: { display: false },
        },
      },
    });
  }

  // ---------- Momentum ----------

  let momentumData = null;
  let currentMomentumPeriod = "1 year";
  let currentMomentumCat = "genres";

  function renderMomentumList(items, direction) {
    if (!items || !items.length) {
      return `<div class="momentum-empty">Nothing ${direction === "up" ? "trending up" : "cooling down"} in this period</div>`;
    }
    return items.map((m) => {
      const arrow = m.change > 0 ? "↑" : "↓";
      const cls = m.change > 0 ? "momentum-up" : "momentum-down";
      const pct = m.change > 0 ? `+${m.change}%` : `${m.change}%`;
      const expected = Math.round(m.expectedCount);
      return `<div class="momentum-item">
        <span class="momentum-arrow ${cls}">${arrow}</span>
        <span class="momentum-genre">${m.name}</span>
        <span class="momentum-detail">${m.windowCount} added · avg ${expected}</span>
        <span class="momentum-pct ${cls}">${pct}</span>
      </div>`;
    }).join("");
  }

  function renderMomentum() {
    if (!momentumData?.periods) return;
    const periodData = momentumData.periods[currentMomentumPeriod];
    if (!periodData) return;

    const all = periodData[currentMomentumCat] || [];
    const sortBy = document.getElementById("momentum-sort").value;
    let sorted;
    if (sortBy === "total") {
      sorted = [...all].sort((a, b) => b.totalCount - a.totalCount);
    } else {
      sorted = [...all].sort((a, b) => b.change - a.change);
    }

    const trending = sorted.filter((m) => m.change > 0).slice(0, 10);
    const cooling = sorted.filter((m) => m.change < 0).slice(0, 10);

    document.getElementById("momentum-trending").innerHTML = renderMomentumList(trending, "up");
    document.getElementById("momentum-cooling").innerHTML = renderMomentumList(cooling, "down");
  }

  async function loadMomentum() {
    document.getElementById("momentum-trending").innerHTML = skeleton(3);
    document.getElementById("momentum-cooling").innerHTML = skeleton(3);
    const data = await api("/api/momentum");
    if (!data) return;
    momentumData = data;
    renderMomentum();
  }

  // ---------- Event listeners ----------

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentRange = btn.dataset.range;
      loadListeningHistory();
    });
  });

  document.querySelectorAll(".momentum-cat").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".momentum-cat").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentMomentumCat = btn.dataset.cat;
      renderMomentum();
    });
  });

  document.querySelectorAll(".momentum-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".momentum-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentMomentumPeriod = btn.dataset.period;
      renderMomentum();
    });
  });

  $("#momentum-sort").addEventListener("change", renderMomentum);

  $("#genre-filter").addEventListener("change", loadPlaylistAnalysis);
  $("#decade-filter").addEventListener("change", loadPlaylistAnalysis);
  $("#filter-clear").addEventListener("click", () => {
    $("#genre-filter").value = "";
    $("#decade-filter").value = "";
    $("#filter-clear").style.display = "none";
    loadPlaylistAnalysis();
  });

  $("#trend-decade-filter").addEventListener("change", reloadTrendCharts);

  $("#artist-picker-select").addEventListener("change", (e) => {
    loadArtistTimeline(e.target.value);
  });

  // ---------- Init ----------

  async function init() {
    const status = await api("/api/scan-status");
    if (!status?.scanned) {
      window.location.href = "/loading.html";
      return;
    }

    loadProfile();
    loadListeningHistory();
    loadPlaylistAnalysis();
    loadMomentum();
    loadTrends();
  }

  init();
})();
