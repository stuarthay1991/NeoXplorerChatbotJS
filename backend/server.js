require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const cors = require("cors");

const defaultCorsOrigins = [
  "http://localhost:5173",
  "http://localhost:8087",
  "http://127.0.0.1:5173",
];
const extraCorsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

var corsOptions = {
  origin: [...defaultCorsOrigins, ...extraCorsOrigins],
};

app.use(cors(corsOptions));

// parse requests of content-type - application/json
app.use(bodyParser.json({limit: '2000mb'}));

// parse requests of content-type - application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({limit: '2000mb', extended: true}));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

app.get("/", (req, res) => {
  res.json({ message: "Welcome to the Oncosplice Web Application backend." });
});

require("./app/routes/chat.routes.js")(app);

const PORT = process.env.PORT || 8087;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});