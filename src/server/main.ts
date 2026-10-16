import express from "express";
import ViteExpress from "vite-express";

const app = express();

// Set the port to 8080 (checks process.env first, then defaults to 8080)
const PORT = Number(process.env.PORT) || 8080;

app.get("/hello", (_, res) => {
  res.send("Hello World!");
});

// Pass the PORT variable here
ViteExpress.listen(app, PORT, () =>
  console.log(`Server is listening on port ${PORT}...`),
);
