# Wavestation

Internet radio, zero friction. Search thousands of live radio streams, save favorites, and listen — all from the browser.

Powered by the [Radio Browser](https://www.radio-browser.info/) community directory.

## Features

- Search stations by name or browse by genre
- One-click playback with volume control
- Save favorites (persisted in localStorage)
- Mobile-friendly responsive design
- No account required

## Setup

```bash
npm install
npm start
```

The server starts at `http://127.0.0.1:3000`.

## Deploying to Railway

Set these environment variables:

| Variable   | Value        |
|------------|--------------|
| `NODE_ENV` | `production` |
| `PORT`     | `3000`       |

Custom domain: point your domain to the Railway deployment.

## License

MIT
