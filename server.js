const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

if (IS_PROD) app.set("trust proxy", 1);

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, IS_PROD ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`Wavestation running on port ${PORT}`);
});
