const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// Resolve next to the backend folder so it works no matter what cwd is when you start Node.
const credentialsPath = path.join(__dirname, "..", "..", "credentials.txt");
const currentFileContents = fs.readFileSync(credentialsPath, "utf-8");
const credentials = currentFileContents.split("#").map((s) => s.trim());

const dbCredentials = new Pool({
  user: credentials[0],
  database: credentials[1],
  password: credentials[2],
  host: credentials[3],
  port: credentials[4] ? Number(credentials[4]) : 5432,
});

module.exports = { dbCredentials };
