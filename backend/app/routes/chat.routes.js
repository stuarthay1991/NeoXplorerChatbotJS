const express = require("express");
const { chatPost } = require("../controllers/chat.controller.js");

module.exports = (app) => {
  const router = express.Router();
  router.post("/", chatPost);
  app.use("/api/chat", router);
};
