const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(wsProtocol + "://" + window.location.host);

let pc, localStream;
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const statsBox = document.getElementById("stats");

// Utility: create peer connection
function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" } // free Google STUN server
    ]
  });

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      ws.send(JSON.stringify({ type: "candidate", candidate }));
    }
  };

  return pc;
}

document.getElementById("join").onclick = async () => {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;

  createPeerConnection();

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "offer", offer }));
};

document.getElementById("leave").onclick = () => {
  if (pc) {
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
};

ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data);

  if (msg.type === "offer") {
    createPeerConnection();

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    await pc.setRemoteDescription(msg.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: "answer", answer }));

  } else if (msg.type === "answer") {
    await pc.setRemoteDescription(msg.answer);

  } else if (msg.type === "candidate") {
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (e) {
      console.error("Error adding ICE candidate", e);
    }
  }
};

// Show bitrate / packet stats
setInterval(async () => {
  if (pc) {
    const stats = await pc.getStats();
    stats.forEach(report => {
      if (report.type === "outbound-rtp" && !report.isRemote) {
        statsBox.innerText =
          `Bitrate: ${report.bytesSent} bytes, Packets: ${report.packetsSent}`;
      }
    });
  }
}, 2000);
