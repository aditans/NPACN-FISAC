// mongodbPing.js
// Beginner-friendly MongoDB Atlas connectivity check.
//
// Install command used by this script:
//   npm install mongodb
//
// Run command used by this script:
//   node mongodbPing.js
//
// Before running, set MONGODB_URI in your shell.
// If MONGODB_URI is not set, this script will try to read mongodb.config.json
// and use the value at: { "MONGODB_URI": "your-uri-here" }
// Do not put any real URI in source control.

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

/**
 * Read MONGODB_URI from environment first, then fallback to mongodb.config.json.
 * We prefer environment variables because they keep secrets out of code and repos.
 */
function getMongoUri() {
  if (process.env.MONGODB_URI && process.env.MONGODB_URI.trim()) {
    console.log("[1/5] Found MONGODB_URI in environment variables.");
    return process.env.MONGODB_URI.trim();
  }

  const configPath = path.join(process.cwd(), "mongodb.config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      "MONGODB_URI not found in environment, and mongodb.config.json was not found in the current folder."
    );
  }

  console.log("[1/5] MONGODB_URI not in environment. Trying mongodb.config.json...");
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed.MONGODB_URI || typeof parsed.MONGODB_URI !== "string" || !parsed.MONGODB_URI.trim()) {
    throw new Error('mongodb.config.json exists, but key "MONGODB_URI" is missing or empty.');
  }

  console.log("[1/5] Loaded MONGODB_URI from mongodb.config.json.");
  return parsed.MONGODB_URI.trim();
}

async function runPingCheck() {
  let client;

  try {
    console.log("[0/5] Starting MongoDB Atlas connectivity check...");
    const uri = getMongoUri();

    // serverSelectionTimeoutMS keeps failures fast and beginner-friendly to diagnose.
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });

    console.log("[2/5] Connecting to MongoDB Atlas...");
    await client.connect();
    console.log("[3/5] Connected. Running ping command...");

    // Ping is a lightweight command that verifies the connection is actually usable.
    const result = await client.db("admin").command({ ping: 1 });

    if (result.ok === 1) {
      console.log("[4/5] Ping succeeded.");
      console.log("SUCCESS: MongoDB Atlas connection is working.");
    } else {
      console.error("[4/5] Ping returned an unexpected response:", result);
      console.error("ERROR: Connected, but ping did not return ok: 1.");
    }
  } catch (error) {
    console.error("ERROR: MongoDB connection or ping failed.");
    console.error("Details:", error.message);
    process.exitCode = 1;
  } finally {
    if (client) {
      console.log("[5/5] Closing MongoDB connection...");
      try {
        await client.close();
        console.log("Done: Connection closed.");
      } catch (closeError) {
        console.error("Warning: Could not close connection cleanly:", closeError.message);
      }
    }
  }
}

runPingCheck();
