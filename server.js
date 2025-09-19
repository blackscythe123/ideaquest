const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const os = require("os");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store connected users and rooms
const users = new Map();
const rooms = new Map();

wss.on("connection", (ws) => {
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
});

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
