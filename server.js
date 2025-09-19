const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const os = require("os");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === 1) {
        client.send(message.toString());
      }
    });
  });
});

app.use(express.static("public"));

// Listen on all interfaces
const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  console.log("🚀 Server running on:");
  console.log(`   Local:   http://localhost:${PORT}`);
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`   Network: http://${net.address}:${PORT}`);
      }
    }
  }
});
