# Spotify Stats

A Node.js web app that lets you sign in with your Spotify account and view a dashboard of your listening stats — top artists, top tracks, genre breakdown, and recently played.

## Setup

### 1. Create a Spotify App

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Set the **Redirect URI** to `http://localhost:3000/callback`
4. Note your **Client ID** and **Client Secret**

### 2. Configure Environment Variables

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your Spotify app credentials:

```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://localhost:3000/callback
SESSION_SECRET=any_random_string
```

### 3. Install & Run

```bash
npm install
node server.js
```

Open [http://localhost:3000](http://localhost:3000) and sign in with Spotify.

## Features

- **Top Artists** — your most-listened artists (4 weeks / 6 months / all time)
- **Top Tracks** — your most-played tracks with album art
- **Genre Breakdown** — visual bar chart of your top genres
- **Recently Played** — your last 20 played tracks with timestamps
