const express = require("express");
const { chatPost, chatCompletePost } = require("../controllers/chat.controller.js");

module.exports = (app) => {
  const router = express.Router();
  router.post("/", chatPost);
  router.post("/complete", chatCompletePost);
  app.use("/api/chat", router);
};
