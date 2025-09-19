// WebSocket connection
const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(wsProtocol + "://" + window.location.host);

// State management
let localStream;
let myId;
let isMicMuted = false;
let isCameraOff = false;
const participants = new Map(); // Store participant data
const peerConnections = new Map(); // Store WebRTC connections

// DOM elements
const videoGrid = document.getElementById('videoGrid');
const participantCount = document.getElementById('participantCount');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const micBtn = document.getElementById('micBtn');
const cameraBtn = document.getElementById('cameraBtn');
const statsPanel = document.getElementById('connectionStats');

// WebSocket event handlers
ws.onopen = () => console.log('🔌 Connected to server');
ws.onerror = (error) => console.error('❌ WebSocket error:', error);
ws.onclose = () => console.log('🔌 Disconnected from server');

// Participant class to manage individual participants
class Participant {
  constructor(id, isLocal = false) {
    this.id = id;
    this.isLocal = isLocal;
    this.stream = null;
    this.videoElement = null;
    this.tileElement = null;
    this.name = isLocal ? 'You' : `User ${id.substring(0, 8)}`;
    
    this.createTile();
  }
  
  createTile() {
    // Create participant tile
    this.tileElement = document.createElement('div');
    this.tileElement.className = `participant-tile ${this.isLocal ? 'local-participant' : 'remote-participant'}`;
    this.tileElement.id = `participant-${this.id}`;
    
    // Create video element
    this.videoElement = document.createElement('video');
    this.videoElement.className = 'participant-video';
    this.videoElement.autoplay = true;
    this.videoElement.playsInline = true;
    if (this.isLocal) {
      this.videoElement.muted = true; // Always mute local video to prevent feedback
    }
    
    // Create info overlay
    const infoElement = document.createElement('div');
    infoElement.className = 'participant-info';
    infoElement.textContent = this.name;
    
    // Create no-video placeholder
    const noVideoElement = document.createElement('div');
    noVideoElement.className = 'no-video';
    noVideoElement.textContent = '👤';
    
    this.tileElement.appendChild(this.videoElement);
    this.tileElement.appendChild(noVideoElement);
    this.tileElement.appendChild(infoElement);
    
    videoGrid.appendChild(this.tileElement);
    updateGridLayout();
  }
  
  setStream(stream) {
    this.stream = stream;
    this.videoElement.srcObject = stream;
    
    // Hide no-video placeholder when stream is available
    const noVideo = this.tileElement.querySelector('.no-video');
    if (stream && stream.getVideoTracks().length > 0) {
      this.videoElement.style.display = 'block';
      noVideo.style.display = 'none';
    } else {
      this.videoElement.style.display = 'none';
      noVideo.style.display = 'flex';
    }
  }
  
  remove() {
    if (this.tileElement) {
      this.tileElement.remove();
      updateGridLayout();
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
  }
}

// Update video grid layout based on participant count
function updateGridLayout() {
  const count = participants.size;
  videoGrid.className = `video-grid grid-${Math.min(count, 9)}`;
  participantCount.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
  
  // Update stats
  updateStats();
}

// Create peer connection for a specific participant
function createPeerConnection(participantId) {
  console.log(`📡 Creating peer connection for ${participantId}`);
  
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.services.mozilla.com' },
      // Add more STUN servers for better connectivity
      { urls: 'stun:stun.stunprotocol.org:3478' },
      { urls: 'stun:openrelay.metered.ca:80' }
    ],
    iceCandidatePoolSize: 10, // Pre-generate ICE candidates
    iceTransportPolicy: 'all', // Use both UDP and TCP
    bundlePolicy: 'max-bundle', // Bundle all media streams
    rtcpMuxPolicy: 'require' // Multiplex RTP and RTCP
  });

  // Enhanced connection state monitoring
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log(`🔗 Connection with ${participantId}: ${state}`);
    
    // Update participant tile with connection status
    const participant = participants.get(participantId);
    if (participant) {
      const infoElement = participant.tileElement.querySelector('.participant-info');
      const baseText = participant.name;
      
      switch (state) {
        case 'connecting':
          infoElement.textContent = `${baseText} (connecting...)`;
          infoElement.style.background = 'rgba(255, 193, 7, 0.8)'; // Yellow
          break;
        case 'connected':
          infoElement.textContent = baseText;
          infoElement.style.background = 'rgba(40, 167, 69, 0.8)'; // Green
          break;
        case 'disconnected':
        case 'failed':
          infoElement.textContent = `${baseText} (disconnected)`;
          infoElement.style.background = 'rgba(220, 53, 69, 0.8)'; // Red
          
          // Attempt to reconnect after a short delay
          setTimeout(() => {
            console.log(`🔄 Attempting to reconnect to ${participantId}`);
            reconnectToPeer(participantId);
          }, 3000);
          break;
        default:
          infoElement.textContent = `${baseText} (${state})`;
          infoElement.style.background = 'rgba(0,0,0,0.7)'; // Default
      }
    }
    
    updateStats();
  };

  // ICE connection state monitoring
  pc.oniceconnectionstatechange = () => {
    const iceState = pc.iceConnectionState;
    console.log(`🧊 ICE connection with ${participantId}: ${iceState}`);
    
    // Handle ICE connection failures
    if (iceState === 'failed') {
      console.log(`❌ ICE connection failed with ${participantId}, attempting restart`);
      pc.restartIce(); // Restart ICE gathering
    }
  };

  // ICE gathering state monitoring  
  pc.onicegatheringstatechange = () => {
    console.log(`❄️ ICE gathering with ${participantId}: ${pc.iceGatheringState}`);
  };

  pc.ontrack = (event) => {
    console.log(`📹 Received track from ${participantId}`);
    const participant = participants.get(participantId);
    if (participant) {
      participant.setStream(event.streams[0]);
    }
  };

  // Enhanced ICE candidate handling
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log(`🧊 Sending ICE candidate to ${participantId}:`, event.candidate.type);
      ws.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate,
        targetId: participantId
      }));
    } else {
      console.log(`🧊 All ICE candidates sent to ${participantId}`);
    }
  };

  // Handle data channel (optional - for better connectivity testing)
  const dataChannel = pc.createDataChannel('ping', { ordered: true });
  dataChannel.onopen = () => {
    console.log(`� Data channel opened with ${participantId}`);
    // Send periodic pings to maintain connection
    const pingInterval = setInterval(() => {
      if (dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Ping every 30 seconds
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'ping') {
        // Respond to ping
        channel.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    };
  };

  peerConnections.set(participantId, pc);
  return pc;
}

// Join the meeting
joinBtn.onclick = async () => {
  try {
    console.log('🚀 Joining meeting...');
    
    // Get user media
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    
    console.log('� Got local stream');
    
    // Create local participant
    const localParticipant = new Participant('local', true);
    localParticipant.setStream(localStream);
    participants.set('local', localParticipant);
    
    // Join room
    ws.send(JSON.stringify({ type: 'join-room', room: 'default' }));
    
    // Update UI
    joinBtn.style.display = 'none';
    updateGridLayout();
    
  } catch (error) {
    console.error('❌ Error joining meeting:', error);
    alert('Could not access camera/microphone. Please check permissions.');
  }
};

// Leave the meeting
leaveBtn.onclick = () => {
  console.log('👋 Leaving meeting...');
  
  // Send leave message
  ws.send(JSON.stringify({ type: 'leave-room' }));
  
  // Clean up all peer connections
  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();
  
  // Remove all participants
  participants.forEach((participant) => participant.remove());
  participants.clear();
  
  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  // Reset UI
  joinBtn.style.display = 'block';
  updateGridLayout();
};

// Toggle microphone
micBtn.onclick = () => {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      isMicMuted = !isMicMuted;
      audioTrack.enabled = !isMicMuted;
      micBtn.textContent = isMicMuted ? '🎤' : '🎤';
      micBtn.className = `control-btn ${isMicMuted ? 'muted' : ''}`;
      
      // Update local participant info
      const localParticipant = participants.get('local');
      if (localParticipant) {
        const infoElement = localParticipant.tileElement.querySelector('.participant-info');
        infoElement.textContent = `You ${isMicMuted ? '(muted)' : ''}`;
      }
    }
  }
};

// Toggle camera
cameraBtn.onclick = () => {
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      isCameraOff = !isCameraOff;
      videoTrack.enabled = !isCameraOff;
      cameraBtn.textContent = isCameraOff ? '📹' : '📹';
      cameraBtn.className = `control-btn ${isCameraOff ? 'muted' : ''}`;
      
      // Update local video display
      const localParticipant = participants.get('local');
      if (localParticipant) {
        localParticipant.setStream(localStream);
      }
    }
  }
};

// Handle WebSocket messages
ws.onmessage = async ({ data }) => {
  const message = JSON.parse(data);
  console.log('📨 Received:', message.type, message);

  switch (message.type) {
    case 'room-joined':
      myId = message.yourId;
      console.log(`🎉 Joined as ${myId}`);
      
      // Create offers for existing users with a small delay to avoid race conditions
      for (let i = 0; i < message.users.length; i++) {
        const user = message.users[i];
        setTimeout(() => {
          createOfferFor(user.id);
        }, i * 500); // Stagger offers by 500ms each
      }
      break;

    case 'user-joined':
      console.log(`👋 User ${message.userId} joined`);
      
      // Create participant tile for new user
      const newParticipant = new Participant(message.userId);
      participants.set(message.userId, newParticipant);
      break;

    case 'user-left':
      console.log(`👋 User ${message.userId} left`);
      
      // Remove participant
      const participant = participants.get(message.userId);
      if (participant) {
        participant.remove();
        participants.delete(message.userId);
      }
      
      // Close peer connection
      const pc = peerConnections.get(message.userId);
      if (pc) {
        pc.close();
        peerConnections.delete(message.userId);
      }
      break;

    case 'offer':
      await handleOffer(message.fromId, message.offer);
      break;

    case 'answer':
      await handleAnswer(message.fromId, message.answer);
      break;

    case 'candidate':
      await handleCandidate(message.fromId, message.candidate);
      break;
      
    case 'connection-failed':
      console.log(`🔄 Connection failed message from ${message.fromId}, retrying...`);
      // Retry connection after a delay
      setTimeout(() => {
        if (participants.has(message.fromId)) {
          reconnectToPeer(message.fromId);
        }
      }, 2000);
      break;
      
    default:
      console.warn(`❓ Unknown message type: ${message.type}`);
  }
};

// Reconnect to a peer that has connection issues
async function reconnectToPeer(participantId) {
  console.log(`🔄 Reconnecting to ${participantId}`);
  
  // Close existing connection
  const existingPc = peerConnections.get(participantId);
  if (existingPc) {
    existingPc.close();
    peerConnections.delete(participantId);
  }
  
  // Wait a bit before reconnecting
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Create new offer if this peer is still in participants
  if (participants.has(participantId) && localStream) {
    console.log(`🔄 Creating new offer for ${participantId}`);
    await createOfferFor(participantId);
  }
}

// Create offer for a specific peer with enhanced error handling
async function createOfferFor(peerId) {
  console.log(`📤 Creating offer for ${peerId}`);
  
  // Create participant if not exists
  if (!participants.has(peerId)) {
    const participant = new Participant(peerId);
    participants.set(peerId, participant);
  }
  
  const pc = createPeerConnection(peerId);
  
  // Add local stream tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      console.log(`Adding ${track.kind} track to ${peerId}`);
      pc.addTrack(track, localStream);
    });
  }

  try {
    // Create offer with enhanced options
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
      voiceActivityDetection: true,
      iceRestart: false
    });
    
    await pc.setLocalDescription(offer);
    
    console.log(`📤 Sending offer to ${peerId}`);
    ws.send(JSON.stringify({
      type: 'offer',
      offer: offer,
      targetId: peerId
    }));
    
    // Set up connection timeout
    setTimeout(() => {
      if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
        console.log(`⏰ Connection timeout for ${peerId}, attempting reconnect`);
        reconnectToPeer(peerId);
      }
    }, 15000); // 15 second timeout
    
  } catch (error) {
    console.error(`❌ Error creating offer for ${peerId}:`, error);
    
    // Retry after a delay
    setTimeout(() => {
      console.log(`🔄 Retrying offer creation for ${peerId}`);
      createOfferFor(peerId);
    }, 5000);
  }
}

// Handle incoming offer with improved error handling
async function handleOffer(fromId, offer) {
  console.log(`📥 Handling offer from ${fromId}`);
  
  // Create participant if not exists
  if (!participants.has(fromId)) {
    const participant = new Participant(fromId);
    participants.set(fromId, participant);
  }
  
  const pc = createPeerConnection(fromId);
  
  // Add local stream tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  try {
    await pc.setRemoteDescription(offer);
    
    // Create answer with enhanced options
    const answer = await pc.createAnswer({
      voiceActivityDetection: true
    });
    
    await pc.setLocalDescription(answer);
    
    console.log(`📤 Sending answer to ${fromId}`);
    ws.send(JSON.stringify({
      type: 'answer',
      answer: answer,
      targetId: fromId
    }));
    
  } catch (error) {
    console.error(`❌ Error handling offer from ${fromId}:`, error);
    
    // Clean up failed connection
    pc.close();
    peerConnections.delete(fromId);
    
    // Notify the other peer to retry
    ws.send(JSON.stringify({
      type: 'connection-failed',
      targetId: fromId
    }));
  }
}

// Handle incoming answer
async function handleAnswer(fromId, answer) {
  console.log(`📥 Handling answer from ${fromId}`);
  
  const pc = peerConnections.get(fromId);
  if (pc) {
    try {
      await pc.setRemoteDescription(answer);
    } catch (error) {
      console.error(`❌ Error handling answer from ${fromId}:`, error);
    }
  }
}

// Handle incoming ICE candidate
async function handleCandidate(fromId, candidate) {
  console.log(`📥 Handling candidate from ${fromId}`);
  
  const pc = peerConnections.get(fromId);
  if (pc) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.error(`❌ Error handling candidate from ${fromId}:`, error);
    }
  }
}

// Update connection stats
function updateStats() {
  let statsText = `Connected: ${peerConnections.size} peers\n`;
  
  peerConnections.forEach((pc, peerId) => {
    const state = pc.connectionState;
    const iceState = pc.iceConnectionState;
    statsText += `${peerId.substring(0, 8)}: ${state}/${iceState}\n`;
  });
  
  statsPanel.textContent = statsText;
}

// Update stats periodically
setInterval(updateStats, 2000);
