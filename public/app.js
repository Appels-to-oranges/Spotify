(() => {
  "use strict";

  const RADIO_API = "https://de1.api.radio-browser.info/json/stations/search";
  const FAV_KEY = "wavestation_favorites";
  const VOL_KEY = "wavestation_volume";
  const MUTE_KEY = "wavestation_mute";

  const audio = new Audio();
  let currentStation = null;
  let favorites = [];

  // DOM refs
  const searchInput = document.getElementById("search-input");
  const searchBtn = document.getElementById("search-btn");
  const genrePills = document.getElementById("genre-pills");
  const resultsList = document.getElementById("results-list");
  const resultsEmpty = document.getElementById("results-empty");
  const resultsPanel = document.getElementById("results-panel");
  const favoritesPanel = document.getElementById("favorites-panel");
  const favoritesList = document.getElementById("favorites-list");
  const favoritesEmpty = document.getElementById("favorites-empty");
  const tabs = document.querySelectorAll(".tab");

  // Now playing
  const npBar = document.getElementById("now-playing-bar");
  const npFavicon = document.getElementById("np-favicon");
  const npName = document.getElementById("np-name");
  const npMeta = document.getElementById("np-meta");
  const npStopBtn = document.getElementById("np-stop-btn");
  const npVolume = document.getElementById("np-volume");
  const npMute = document.getElementById("np-mute");
  const muteIconOn = document.getElementById("mute-icon-on");
  const muteIconOff = document.getElementById("mute-icon-off");

  /* ---------- Favorites ---------- */
  function loadFavorites() {
    try {
      favorites = JSON.parse(localStorage.getItem(FAV_KEY)) || [];
    } catch {
      favorites = [];
    }
  }

  function saveFavorites() {
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  }

  function isFav(url) {
    return favorites.some((f) => f.url === url);
  }

  function toggleFav(station) {
    const idx = favorites.findIndex((f) => f.url === station.url);
    if (idx >= 0) {
      favorites.splice(idx, 1);
    } else {
      favorites.push({
        name: station.name,
        url: station.url,
        favicon: station.favicon || "",
        country: station.country || "",
        tags: station.tags || "",
      });
    }
    saveFavorites();
    renderFavorites();
    refreshFavButtons();
  }

  function refreshFavButtons() {
    document.querySelectorAll(".fav-btn").forEach((btn) => {
      const url = btn.dataset.url;
      if (!url) return;
      const fav = isFav(url);
      btn.classList.toggle("is-fav", fav);
      btn.innerHTML = fav ? "&#9733;" : "&#9734;";
    });
  }

  /* ---------- Volume ---------- */
  function initVolume() {
    const saved = parseInt(localStorage.getItem(VOL_KEY), 10);
    const vol = isNaN(saved) ? 80 : Math.max(0, Math.min(100, saved));
    const muted = localStorage.getItem(MUTE_KEY) === "1";

    npVolume.value = vol;
    audio.volume = muted ? 0 : vol / 100;
    updateMuteIcon(muted);

    npVolume.addEventListener("input", () => {
      const v = parseInt(npVolume.value, 10);
      audio.volume = isMuted() ? 0 : v / 100;
      localStorage.setItem(VOL_KEY, v);
    });

    npMute.addEventListener("click", () => {
      const next = !isMuted();
      localStorage.setItem(MUTE_KEY, next ? "1" : "");
      audio.volume = next ? 0 : parseInt(npVolume.value, 10) / 100;
      updateMuteIcon(next);
    });
  }

  function isMuted() {
    return localStorage.getItem(MUTE_KEY) === "1";
  }

  function updateMuteIcon(muted) {
    muteIconOn.classList.toggle("hidden", muted);
    muteIconOff.classList.toggle("hidden", !muted);
  }

  /* ---------- Playback ---------- */
  function playStation(station) {
    if (!station?.url) return;
    currentStation = station;
    audio.src = station.url;
    audio.play().catch(() => {});

    npName.textContent = station.name || "Unknown Station";
    npMeta.textContent = [station.country, station.tags]
      .filter(Boolean)
      .join(" · ");

    if (station.favicon) {
      npFavicon.src = station.favicon;
      npFavicon.style.display = "";
      npFavicon.onerror = () => {
        npFavicon.style.display = "none";
      };
    } else {
      npFavicon.style.display = "none";
    }

    npBar.classList.remove("hidden");
    highlightPlaying();
  }

  function stopStation() {
    audio.pause();
    audio.src = "";
    currentStation = null;
    npBar.classList.add("hidden");
    highlightPlaying();
  }

  function highlightPlaying() {
    document.querySelectorAll(".station-card").forEach((card) => {
      const url = card.dataset.url;
      card.classList.toggle("playing", currentStation && url === currentStation.url);
    });
  }

  npStopBtn.addEventListener("click", stopStation);

  /* ---------- Search / Browse ---------- */
  let abortCtrl = null;

  function searchStations(query, tag) {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    resultsList.innerHTML = "";
    resultsEmpty.innerHTML = "";
    resultsList.innerHTML =
      '<div class="loading"><div class="spinner"></div>Searching...</div>';

    const params = new URLSearchParams({
      limit: "30",
      order: "votes",
      reverse: "true",
      hidebroken: "true",
    });
    if (query) params.set("name", query);
    if (tag) params.set("tag", tag);

    const timeout = setTimeout(() => abortCtrl.abort(), 10000);

    fetch(`${RADIO_API}?${params}`, { signal: abortCtrl.signal })
      .then((r) => r.json())
      .then((stations) => {
        clearTimeout(timeout);
        const secure = (stations || []).filter((st) => {
          const u = st.url_resolved || st.url;
          return u && u.startsWith("https");
        });
        renderResults(secure);
      })
      .catch((err) => {
        clearTimeout(timeout);
        if (err.name === "AbortError") return;
        resultsList.innerHTML = "";
        resultsEmpty.innerHTML = "<p>Search failed — try again</p>";
        resultsEmpty.style.display = "";
      });
  }

  function renderResults(stations) {
    resultsList.innerHTML = "";
    if (!stations.length) {
      resultsEmpty.innerHTML = "<p>No stations found</p>";
      resultsEmpty.style.display = "";
      return;
    }
    resultsEmpty.style.display = "none";
    stations.forEach((st) => {
      const url = st.url_resolved || st.url;
      const card = makeStationCard({
        name: st.name,
        url,
        favicon: st.favicon || "",
        country: st.country || "",
        tags: st.tags || "",
      });
      resultsList.appendChild(card);
    });
    highlightPlaying();
  }

  /* ---------- Station Card ---------- */
  function makeStationCard(station) {
    const card = document.createElement("div");
    card.className = "station-card";
    card.dataset.url = station.url;

    if (station.favicon) {
      const img = document.createElement("img");
      img.className = "station-icon";
      img.src = station.favicon;
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => {
        const ph = document.createElement("div");
        ph.className = "station-icon-placeholder";
        ph.innerHTML = "&#x1F4FB;";
        img.replaceWith(ph);
      };
      card.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "station-icon-placeholder";
      ph.innerHTML = "&#x1F4FB;";
      card.appendChild(ph);
    }

    const info = document.createElement("div");
    info.className = "station-info";

    const name = document.createElement("div");
    name.className = "station-name";
    name.textContent = station.name;

    const meta = document.createElement("div");
    meta.className = "station-meta";
    meta.textContent = [station.country, station.tags]
      .filter(Boolean)
      .join(" · ");

    info.appendChild(name);
    info.appendChild(meta);
    card.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "station-actions";

    // EQ playing indicator
    const eq = document.createElement("div");
    eq.className = "play-indicator";
    eq.innerHTML =
      '<div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div>';
    actions.appendChild(eq);

    // Fav button
    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = "fav-btn" + (isFav(station.url) ? " is-fav" : "");
    fav.dataset.url = station.url;
    fav.innerHTML = isFav(station.url) ? "&#9733;" : "&#9734;";
    fav.title = "Favorite";
    fav.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFav(station);
    });
    actions.appendChild(fav);

    card.appendChild(actions);

    card.addEventListener("click", () => playStation(station));

    return card;
  }

  /* ---------- Favorites rendering ---------- */
  function renderFavorites() {
    favoritesList.innerHTML = "";
    if (!favorites.length) {
      favoritesEmpty.style.display = "";
      return;
    }
    favoritesEmpty.style.display = "none";
    favorites.forEach((st) => {
      const card = makeStationCard(st);
      favoritesList.appendChild(card);
    });
    highlightPlaying();
  }

  /* ---------- Tabs ---------- */
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      resultsPanel.classList.toggle("hidden", which !== "results");
      favoritesPanel.classList.toggle("hidden", which !== "favorites");
    });
  });

  /* ---------- Genre pills ---------- */
  genrePills.addEventListener("click", (e) => {
    const pill = e.target.closest(".pill");
    if (!pill) return;
    genrePills.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");

    // Switch to Stations tab
    tabs.forEach((t) => t.classList.remove("active"));
    document.querySelector('[data-tab="results"]').classList.add("active");
    resultsPanel.classList.remove("hidden");
    favoritesPanel.classList.add("hidden");

    const genre = pill.dataset.genre;
    if (genre) {
      searchInput.value = "";
      searchStations("", genre);
    } else {
      resultsList.innerHTML = "";
      resultsEmpty.innerHTML = "<p>Search for a station or pick a genre above</p>";
      resultsEmpty.style.display = "";
    }
  });

  /* ---------- Search submit ---------- */
  function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    genrePills.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));

    // Switch to Stations tab
    tabs.forEach((t) => t.classList.remove("active"));
    document.querySelector('[data-tab="results"]').classList.add("active");
    resultsPanel.classList.remove("hidden");
    favoritesPanel.classList.add("hidden");

    searchStations(q, "");
  }

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  /* ---------- Init ---------- */
  loadFavorites();
  renderFavorites();
  initVolume();
})();
