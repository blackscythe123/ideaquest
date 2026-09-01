require("dotenv").config();

const express = require("express");
const { WebSocketServer } = require("ws");
const https = require("https");
const os = require("os");
const crypto = require("crypto");
const selfsigned = require("selfsigned");

const app = express();

// Store connected users and rooms
const users = new Map();
const rooms = new Map();

function handleConnection(ws) {
  const userId = crypto.randomUUID();
  users.set(ws, { id: userId, room: null });

  console.log(`User ${userId} connected`);

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      const user = users.get(ws);

      if (!user) return;

      switch (data.type) {
        case "join-room":
          handleJoinRoom(ws, user, data.room || "default");
          break;

        case "offer":
        case "answer":
        case "candidate":
          // Forward signaling messages to specific target
          if (data.targetId) {
            const targetWs = findUserByIdInRoom(user.room, data.targetId);
            if (targetWs) {
              const forwardData = { ...data, fromId: user.id };
              targetWs.send(JSON.stringify(forwardData));
            }
          }
          break;

        case "leave-room":
          handleLeaveRoom(ws, user);
          break;
      }
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  ws.on("close", () => {
    const user = users.get(ws);
    if (user) {
      console.log(`User ${user.id} disconnected`);
      handleLeaveRoom(ws, user);
      users.delete(ws);
    }
  });
}

function handleJoinRoom(ws, user, roomId) {
  // Leave current room if in one
  if (user.room) {
    handleLeaveRoom(ws, user);
  }

  // Create room if it doesn't exist
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const room = rooms.get(roomId);
  room.add(ws);
  user.room = roomId;

  console.log(`User ${user.id} joined room ${roomId}`);

  // Send current users in room to the new user
  const otherUsers = [];
  room.forEach((clientWs) => {
    const clientUser = users.get(clientWs);
    if (clientUser && clientWs !== ws) {
      otherUsers.push({ id: clientUser.id });
    }
  });

  // Notify new user of existing users
  ws.send(JSON.stringify({
    type: "room-joined",
    users: otherUsers,
    yourId: user.id
  }));

  // Notify existing users of new user
  room.forEach((clientWs) => {
    if (clientWs !== ws && clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({
        type: "user-joined",
        userId: user.id
      }));
    }
  });
}

function handleLeaveRoom(ws, user) {
  if (!user.room) return;

  const room = rooms.get(user.room);
  if (room) {
    room.delete(ws);

    // Notify other users in room
    room.forEach((clientWs) => {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({
          type: "user-left",
          userId: user.id
        }));
      }
    });

    // Clean up empty rooms
    if (room.size === 0) {
      rooms.delete(user.room);
    }
  }

  user.room = null;
}

function findUserByIdInRoom(roomId, userId) {
  if (!rooms.has(roomId)) return null;

  const room = rooms.get(roomId);
  for (const ws of room) {
    const user = users.get(ws);
    if (user && user.id === userId) {
      return ws;
    }
  }
  return null;
}

// Fetch fresh TURN/STUN credentials from Metered server-side, so the API key
// never has to be embedded in client-facing script.js.
app.get("/api/turn-credentials", async (req, res) => {
  const { METERED_DOMAIN, METERED_API_KEY } = process.env;

  if (!METERED_DOMAIN || !METERED_API_KEY) {
    res.status(503).json({ error: "TURN credentials not configured" });
    return;
  }

  try {
    const meteredRes = await fetch(
      `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
    );

    if (!meteredRes.ok) {
      throw new Error(`Metered API responded with ${meteredRes.status}`);
    }

    const iceServers = await meteredRes.json();
    res.json({ iceServers });
  } catch (error) {
    console.error("Error fetching TURN credentials:", error);
    res.status(502).json({ error: "Failed to fetch TURN credentials" });
  }
});

app.use(express.static("public"));

const PORT = 3000;

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

// getUserMedia (camera/mic) only works in a "secure context": HTTPS, or the
// special-cased http://localhost. A plain http:// LAN address (used to join
// from a second device) is NOT secure, so the browser disables the camera
// API entirely and won't even offer a permission prompt for it. Serving
// over HTTPS - even with a self-signed cert - fixes that for every address
// the server answers on.
async function createHttpsServer(lanAddresses) {
  const altNames = [
    { type: 2, value: "localhost" }, // DNS
    { type: 7, ip: "127.0.0.1" },    // IP
    ...lanAddresses.map((ip) => ({ type: 7, ip })),
  ];

  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      days: 365,
      keySize: 2048,
      extensions: [{ name: "subjectAltName", altNames }],
    }
  );

  return https.createServer({ key: pems.private, cert: pems.cert }, app);
}

async function start() {
  const lanAddresses = getLanAddresses();
  const server = await createHttpsServer(lanAddresses);
  const wss = new WebSocketServer({ server });

  wss.on("connection", handleConnection);

  server.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 Server running on (HTTPS, self-signed certificate):");
    console.log(`   Local:   https://localhost:${PORT}`);
    for (const ip of lanAddresses) {
      console.log(`   Network: https://${ip}:${PORT}`);
    }
    console.log("");
    console.log("⚠️  Your browser will warn that the certificate isn't trusted (self-signed).");
    console.log("   Click Advanced -> Proceed, once per device, to continue - this is expected for local dev.");
  });
}

start();
