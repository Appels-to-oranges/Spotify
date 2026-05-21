(() => {
  const $ = (sel) => document.querySelector(sel);
  let currentRange = "short_term";

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

  function renderArtists(items) {
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

  function renderGenres(items) {
    const max = items[0]?.count || 1;
    return items
      .map(
        (g) => `
      <li class="genre-item">
        <span class="genre-label">${g.genre}</span>
        <div class="genre-bar-container">
          <div class="genre-bar" style="width:${(g.count / max) * 100}%"></div>
        </div>
        <span class="genre-count">${g.count}</span>
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

  async function loadProfile() {
    const me = await api("/api/me");
    if (!me) return;
    const img = me.images?.[0]?.url;
    $("#profile-info").innerHTML = `
      ${img ? `<img class="profile-avatar" src="${img}" alt="avatar" />` : ""}
      <span class="profile-name">${me.display_name}<small>${me.product === "premium" ? "Premium" : "Free"} · ${me.country || ""}</small></span>
    `;
  }

  async function loadStats() {
    const lists = ["top-artists", "top-tracks", "genre-breakdown", "recently-played"];
    lists.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = skeleton();
    });

    const [artists, tracks, genres, recent] = await Promise.all([
      api(`/api/top-artists?range=${currentRange}`),
      api(`/api/top-tracks?range=${currentRange}`),
      api(`/api/genre-breakdown?range=${currentRange}`),
      api("/api/recently-played"),
    ]);

    if (artists) $("#top-artists").innerHTML = renderArtists(artists.items || []);
    if (tracks) $("#top-tracks").innerHTML = renderTracks(tracks.items || []);
    if (genres) $("#genre-breakdown").innerHTML = renderGenres(genres || []);
    if (recent) $("#recently-played").innerHTML = renderRecent(recent.items || []);
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentRange = btn.dataset.range;
      loadStats();
    });
  });

  loadProfile();
  loadStats();
})();
