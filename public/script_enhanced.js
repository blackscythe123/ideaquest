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

// Network adaptation state
const networkStats = new Map(); // Store per-peer network statistics
const BANDWIDTH_THRESHOLDS = {
  LOW: 150000,    // 150 kbps - audio only (more conservative)
  MEDIUM: 500000, // 500 kbps - low quality video (more conservative)
  HIGH: 1000000   // 1 Mbps - high quality video (more conservative)
};

const VIDEO_CONSTRAINTS = {
  LOW: { width: 160, height: 120, frameRate: 15 },
  MEDIUM: { width: 320, height: 240, frameRate: 24 },
  HIGH: { width: 640, height: 480, frameRate: 30 }
};

let currentVideoQuality = 'HIGH';
let isAdaptiveMode = true;
let networkMonitoringInterval;
let initialConnectionPhase = true; // Give initial connections time to stabilize
let connectionStartTime = null;

// Active speaker detection state
let activeSpeaker = null;
let audioLevels = new Map(); // Store audio levels per participant
let activeSpeakerInterval;
const AUDIO_LEVEL_THRESHOLD = 0.01; // Minimum audio level to consider speaking
const SPEAKER_UPDATE_INTERVAL = 500; // Update active speaker every 500ms

// DOM elements
const videoGrid = document.getElementById('videoGrid');
const participantCount = document.getElementById('participantCount');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const micBtn = document.getElementById('micBtn');
const cameraBtn = document.getElementById('cameraBtn');
const statsPanel = document.getElementById('connectionStats');

// Network monitoring elements (will be created dynamically)
let networkQualityIndicator;
let videoQualityIndicator;
let adaptiveModeToggle;

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
    this.audioContext = null;
    this.audioAnalyser = null;
    this.audioLevel = 0;
    this.isSpeaking = false;
    
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
    
    // Set up audio level monitoring for this participant
    this.setupAudioMonitoring(stream);
    
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
  
  setupAudioMonitoring(stream) {
    if (!stream || !stream.getAudioTracks().length) return;
    
    try {
      // Don't monitor local audio to avoid feedback detection
      if (this.isLocal) return;
      
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.audioAnalyser = this.audioContext.createAnalyser();
      this.audioAnalyser.fftSize = 256;
      
      const source = this.audioContext.createMediaStreamSource(stream);
      source.connect(this.audioAnalyser);
      
      // Start monitoring audio levels
      this.monitorAudioLevel();
    } catch (error) {
      console.error(`Error setting up audio monitoring for ${this.id}:`, error);
    }
  }
  
  monitorAudioLevel() {
    if (!this.audioAnalyser) return;
    
    const dataArray = new Uint8Array(this.audioAnalyser.frequencyBinCount);
    
    const updateLevel = () => {
      if (!this.audioAnalyser) return;
      
      this.audioAnalyser.getByteFrequencyData(dataArray);
      
      // Calculate average audio level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      this.audioLevel = average / 255; // Normalize to 0-1
      
      // Store in global audio levels map
      audioLevels.set(this.id, {
        level: this.audioLevel,
        timestamp: Date.now()
      });
      
      // Continue monitoring
      if (this.audioContext && this.audioContext.state === 'running') {
        requestAnimationFrame(updateLevel);
      }
    };
    
    updateLevel();
  }
  
  remove() {
    // Clean up audio monitoring
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.audioAnalyser = null;
    
    // Remove from audio levels tracking
    audioLevels.delete(this.id);
    
    if (this.tileElement) {
      this.tileElement.remove();
      updateGridLayout();
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
  }
}

// Update video grid layout based on participant count with new UI classes
function updateGridLayout() {
  const count = participants.size;
  
  // Remove all layout classes
  videoGrid.className = 'video-grid';
  
  // Apply appropriate layout class based on new UI system
  if (count === 0) {
    // No special class needed for empty grid
  } else if (count === 1) {
    videoGrid.classList.add('single');
  } else if (count === 2) {
    videoGrid.classList.add('double');
  } else if (count === 3) {
    videoGrid.classList.add('triple');
  } else if (count === 4) {
    videoGrid.classList.add('four');
  } else if (count === 5) {
    videoGrid.classList.add('five');
  } else if (count === 6) {
    videoGrid.classList.add('six');
  } else if (count === 7) {
    videoGrid.classList.add('seven');
  } else if (count === 8) {
    videoGrid.classList.add('eight');
  } else if (count === 9) {
    videoGrid.classList.add('nine');
  }
  // For more than 9, we rely on the default grid behavior
  
  // Update participant count display
  participantCount.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
  
  // Apply active speaker highlighting
  updateActiveSpeakerLayout();
  
  // Update stats
  updateStats();
}

// Detect and highlight active speaker
function updateActiveSpeaker() {
  if (audioLevels.size === 0) return;
  
  let maxLevel = 0;
  let speakerId = null;
  const now = Date.now();
  
  // Find participant with highest recent audio level
  audioLevels.forEach((data, participantId) => {
    // Only consider recent audio data (within last 2 seconds)
    if (now - data.timestamp < 2000 && data.level > maxLevel && data.level > AUDIO_LEVEL_THRESHOLD) {
      maxLevel = data.level;
      speakerId = participantId;
    }
  });
  
  // Update active speaker if changed
  if (speakerId !== activeSpeaker) {
    const previousSpeaker = activeSpeaker;
    activeSpeaker = speakerId;
    
    console.log(`🗣️ Active speaker changed: ${previousSpeaker} → ${activeSpeaker}`);
    updateActiveSpeakerLayout();
  }
}

// Apply visual highlighting to active speaker
function updateActiveSpeakerLayout() {
  const count = participants.size;
  
  participants.forEach((participant, participantId) => {
    const tile = participant.tileElement;
    const isActiveSpeaker = participantId === activeSpeaker;
    
    // Remove existing active speaker classes
    tile.classList.remove('active-speaker', 'background-participant');
    
    if (isActiveSpeaker) {
      // Highlight active speaker
      tile.classList.add('active-speaker');
      
      // For 3-person layout, make active speaker take the main position
      if (count === 3) {
        rearrangeForActiveSpeaker(participantId);
      }
      
      // Optimize bandwidth for active speaker (higher quality)
      optimizeBandwidthForParticipant(participantId, true);
    } else if (participants.size > 1) {
      // Style background participants
      tile.classList.add('background-participant');
      
      // Optimize bandwidth for background participants (lower quality)
      optimizeBandwidthForParticipant(participantId, false);
    }
  });
}

// Rearrange participants to put active speaker in the main position for 3-person layout
function rearrangeForActiveSpeaker(activeSpeakerId) {
  const participantsArray = Array.from(participants.entries());
  const count = participantsArray.length;
  
  if (count !== 3) return; // Only apply this for 3-person layout
  
  // Find the active speaker
  let activeSpeakerIndex = participantsArray.findIndex(([id]) => id === activeSpeakerId);
  if (activeSpeakerIndex === -1) return;
  
  // Rearrange so active speaker is first (gets the main position)
  if (activeSpeakerIndex !== 0) {
    // Move active speaker to first position
    const activeSpeakerEntry = participantsArray.splice(activeSpeakerIndex, 1)[0];
    participantsArray.unshift(activeSpeakerEntry);
    
    // The CSS grid layout will automatically handle the positioning
    // The .triple class ensures proper 3-person layout with active speaker prominence
  }
}

// Bandwidth optimization for active vs background participants
async function optimizeBandwidthForParticipant(participantId, isActiveSpeaker) {
  const pc = peerConnections.get(participantId);
  if (!pc || !isAdaptiveMode) return;
  
  const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
  if (!sender || !sender.track) return;
  
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings[0]) return;
    
    if (isActiveSpeaker) {
      // High quality for active speaker
      params.encodings[0].maxBitrate = 1200000; // 1.2 Mbps
      params.encodings[0].priority = 'high';
      params.encodings[0].maxFramerate = 30;
      
      // Apply high-quality video constraints to local track
      if (participantId !== 'local' && localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
          await videoTrack.applyConstraints(VIDEO_CONSTRAINTS.HIGH);
        }
      }
      
      console.log(`📹 High quality applied for active speaker: ${participantId}`);
    } else {
      // Lower quality for background participants
      params.encodings[0].maxBitrate = 300000; // 300 kbps
      params.encodings[0].priority = 'medium';
      params.encodings[0].maxFramerate = 15;
      
      console.log(`📹 Reduced quality applied for background: ${participantId}`);
    }
    
    await sender.setParameters(params);
  } catch (error) {
    console.error(`Error optimizing bandwidth for ${participantId}:`, error);
  }
}

// Network monitoring and adaptation functions
async function monitorNetworkQuality() {
  // Skip monitoring during initial connection phase
  if (initialConnectionPhase && connectionStartTime && (Date.now() - connectionStartTime) > 10000) {
    initialConnectionPhase = false;
    console.log('🎯 Network adaptation enabled after initial connection phase');
  }
  
  for (const [peerId, pc] of peerConnections) {
    try {
      const stats = await pc.getStats();
      const networkMetrics = analyzeStats(stats, peerId);
      
      if (networkMetrics) {
        networkStats.set(peerId, networkMetrics);
      }
    } catch (error) {
      console.error(`Error monitoring ${peerId}:`, error);
    }
  }
  
  // Perform adaptation based on overall network conditions
  if (networkStats.size > 0) {
    await adaptToNetworkConditions();
  }
  
  updateNetworkIndicators();
}

function analyzeStats(stats, peerId) {
  let outboundVideo = null;
  let outboundAudio = null;
  let inboundVideo = null;
  let inboundAudio = null;
  let candidate = null;
  
  stats.forEach(report => {
    if (report.type === 'outbound-rtp' && report.mediaType === 'video') {
      outboundVideo = report;
    } else if (report.type === 'outbound-rtp' && report.mediaType === 'audio') {
      outboundAudio = report;
    } else if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
      inboundVideo = report;
    } else if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
      inboundAudio = report;
    } else if (report.type === 'candidate-pair' && report.selected) {
      candidate = report;
    }
  });
  
  if (!outboundVideo && !outboundAudio) return null;
  
  const now = Date.now();
  const previousStats = networkStats.get(peerId);
  
  let metrics = {
    timestamp: now,
    videoBitrate: 0,
    audioBitrate: 0,
    videoPacketLoss: 0,
    audioPacketLoss: 0,
    rtt: 0,
    jitter: 0,
    quality: 'HIGH'
  };
  
  if (outboundVideo && previousStats && previousStats.outboundVideo) {
    const timeDelta = (now - previousStats.timestamp) / 1000;
    const bytesDelta = outboundVideo.bytesSent - previousStats.outboundVideo.bytesSent;
    metrics.videoBitrate = (bytesDelta * 8) / timeDelta; // bits per second
    
    const packetsDelta = outboundVideo.packetsSent - previousStats.outboundVideo.packetsSent;
    const packetsLostDelta = (outboundVideo.packetsLost || 0) - (previousStats.outboundVideo.packetsLost || 0);
    metrics.videoPacketLoss = packetsDelta > 0 ? (packetsLostDelta / packetsDelta) * 100 : 0;
  }
  
  if (outboundAudio && previousStats && previousStats.outboundAudio) {
    const timeDelta = (now - previousStats.timestamp) / 1000;
    const bytesDelta = outboundAudio.bytesSent - previousStats.outboundAudio.bytesSent;
    metrics.audioBitrate = (bytesDelta * 8) / timeDelta;
    
    const packetsDelta = outboundAudio.packetsSent - previousStats.outboundAudio.packetsSent;
    const packetsLostDelta = (outboundAudio.packetsLost || 0) - (previousStats.outboundAudio.packetsLost || 0);
    metrics.audioPacketLoss = packetsDelta > 0 ? (packetsLostDelta / packetsDelta) * 100 : 0;
  }
  
  if (candidate) {
    metrics.rtt = candidate.currentRoundTripTime ? candidate.currentRoundTripTime * 1000 : 0;
  }
  
  if (inboundAudio) {
    metrics.jitter = inboundAudio.jitter || 0;
  }
  
  // Determine overall network quality - be more conservative
  const totalBitrate = metrics.videoBitrate + metrics.audioBitrate;
  const totalPacketLoss = Math.max(metrics.videoPacketLoss, metrics.audioPacketLoss);
  
  // Don't adapt during initial connection phase (first 10 seconds)
  if (initialConnectionPhase) {
    metrics.quality = 'HIGH';
    return metrics;
  }
  
  // More conservative thresholds to prevent unnecessary quality drops
  if (totalBitrate < BANDWIDTH_THRESHOLDS.LOW && totalPacketLoss > 8 && metrics.rtt > 500) {
    metrics.quality = 'LOW';
  } else if (totalBitrate < BANDWIDTH_THRESHOLDS.MEDIUM && totalPacketLoss > 5 && metrics.rtt > 300) {
    metrics.quality = 'MEDIUM';
  } else {
    metrics.quality = 'HIGH';
  }
  
  // Store raw stats for next comparison
  metrics.outboundVideo = outboundVideo;
  metrics.outboundAudio = outboundAudio;
  
  return metrics;
}

async function adaptToNetworkConditions() {
  if (!localStream || !isAdaptiveMode) return;
  
  // Calculate overall network quality from all peers
  let totalBitrate = 0;
  let maxPacketLoss = 0;
  let maxRtt = 0;
  let peerCount = 0;
  let worstQuality = 'HIGH';
  
  networkStats.forEach((metrics, peerId) => {
    totalBitrate += metrics.videoBitrate + metrics.audioBitrate;
    maxPacketLoss = Math.max(maxPacketLoss, Math.max(metrics.videoPacketLoss, metrics.audioPacketLoss));
    maxRtt = Math.max(maxRtt, metrics.rtt);
    peerCount++;
    
    if (metrics.quality === 'LOW') worstQuality = 'LOW';
    else if (metrics.quality === 'MEDIUM' && worstQuality === 'HIGH') worstQuality = 'MEDIUM';
  });
  
  if (peerCount === 0) return;
  
  // Only adapt if we have consistent bad quality across multiple measurement cycles
  let targetQuality = currentVideoQuality;
  
  // Be more conservative - require multiple bad conditions
  if (worstQuality === 'LOW' && maxPacketLoss > 10) {
    targetQuality = 'AUDIO_ONLY';
  } else if (worstQuality === 'MEDIUM' && maxPacketLoss > 7 && currentVideoQuality === 'HIGH') {
    targetQuality = 'MEDIUM';
  } else if (worstQuality === 'HIGH' && maxPacketLoss < 3 && currentVideoQuality !== 'HIGH') {
    // Recovery condition - network has improved
    targetQuality = 'HIGH';
  }
  
  // Only change quality if it's different from current
  if (targetQuality !== currentVideoQuality) {
    console.log(`🔄 Network adaptation: ${currentVideoQuality} → ${targetQuality} (peers: ${peerCount}, loss: ${maxPacketLoss.toFixed(1)}%)`);
    await adjustVideoQualityForAllPeers(targetQuality);
  }
}

async function adjustVideoQualityForAllPeers(quality) {
  // Apply video quality changes to all peer connections
  const videoSenders = [];
  
  peerConnections.forEach((pc, peerId) => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && sender.track) {
      videoSenders.push({ sender, peerId });
    }
  });
  
  // Adjust all video senders
  for (const { sender, peerId } of videoSenders) {
    try {
      await adjustVideoQuality(quality, sender);
    } catch (error) {
      console.error(`Error adjusting video quality for ${peerId}:`, error);
    }
  }
}

async function adjustVideoQuality(quality, sender) {
  if (!sender || !sender.track) return;
  
  try {
    if (quality === 'AUDIO_ONLY') {
      // Disable video track for audio-only mode
      sender.track.enabled = false;
      console.log('📹 Switched to audio-only mode');
      currentVideoQuality = 'AUDIO_ONLY';
    } else {
      // Enable video and apply constraints
      sender.track.enabled = !isCameraOff; // Respect user's camera setting
      
      const constraints = VIDEO_CONSTRAINTS[quality];
      const track = sender.track;
      
      await track.applyConstraints({
        width: { ideal: constraints.width },
        height: { ideal: constraints.height },
        frameRate: { ideal: constraints.frameRate }
      });
      
      // Adjust encoding parameters
      const params = sender.getParameters();
      if (params.encodings && params.encodings[0]) {
        switch (quality) {
          case 'LOW':
            params.encodings[0].maxBitrate = 200000; // 200 kbps
            params.encodings[0].priority = 'low';
            break;
          case 'MEDIUM':
            params.encodings[0].maxBitrate = 600000; // 600 kbps
            params.encodings[0].priority = 'medium';
            break;
          case 'HIGH':
            params.encodings[0].maxBitrate = 1200000; // 1.2 Mbps
            params.encodings[0].priority = 'high';
            break;
        }
        await sender.setParameters(params);
      }
      
      console.log(`📹 Adjusted video quality to ${quality}`);
      currentVideoQuality = quality;
    }
  } catch (error) {
    console.error('Error adjusting video quality:', error);
  }
}

function updateNetworkIndicators() {
  if (!networkQualityIndicator) return;
  
  // Calculate overall network quality from all peers
  let worstQuality = 'HIGH';
  let totalBitrate = 0;
  let avgPacketLoss = 0;
  let avgRtt = 0;
  let peerCount = 0;
  
  networkStats.forEach((metrics, peerId) => {
    if (metrics.quality === 'LOW') worstQuality = 'LOW';
    else if (metrics.quality === 'MEDIUM' && worstQuality === 'HIGH') worstQuality = 'MEDIUM';
    
    totalBitrate += metrics.videoBitrate + metrics.audioBitrate;
    avgPacketLoss += Math.max(metrics.videoPacketLoss, metrics.audioPacketLoss);
    avgRtt += metrics.rtt;
    peerCount++;
  });
  
  if (peerCount > 0) {
    avgPacketLoss /= peerCount;
    avgRtt /= peerCount;
  }
  
  // Update network quality indicator
  const qualityColors = {
    HIGH: '#28a745',    // Green
    MEDIUM: '#ffc107',  // Yellow
    LOW: '#dc3545',     // Red
    OFFLINE: '#6c757d'  // Gray
  };
  
  networkQualityIndicator.style.color = qualityColors[worstQuality];
  networkQualityIndicator.textContent = `📶 ${worstQuality}`;
  
  // Update video quality indicator
  if (videoQualityIndicator) {
    const qualityText = currentVideoQuality === 'AUDIO_ONLY' ? '🎵 Audio Only' : `📹 ${currentVideoQuality}`;
    videoQualityIndicator.textContent = qualityText;
    videoQualityIndicator.style.color = currentVideoQuality === 'AUDIO_ONLY' ? '#ffc107' : '#28a745';
  }
  
  // Update stats panel with network details
  updateNetworkStats(totalBitrate, avgPacketLoss, avgRtt);
}

function updateNetworkStats(totalBitrate, avgPacketLoss, avgRtt) {
  const bitrateKbps = Math.round(totalBitrate / 1000);
  const networkInfo = `
Network: ${bitrateKbps} kbps
Packet Loss: ${avgPacketLoss.toFixed(1)}%
RTT: ${Math.round(avgRtt)}ms
Quality: ${currentVideoQuality}
Adaptive: ${isAdaptiveMode ? 'ON' : 'OFF'}
  `.trim();
  
  statsPanel.textContent = networkInfo;
}

// Update connection stats
function updateStats() {
  let statsText = `Connected: ${peerConnections.size} peers\n`;
  
  peerConnections.forEach((pc, peerId) => {
    const state = pc.connectionState;
    const iceState = pc.iceConnectionState;
    statsText += `${peerId.substring(0, 8)}: ${state}/${iceState}\n`;
  });
  
  if (networkStats.size === 0) {
    statsPanel.textContent = statsText;
  }
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
      { urls: 'stun:stun.stunprotocol.org:3478' },
      { urls: 'stun:openrelay.metered.ca:80' }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
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
          infoElement.style.background = 'rgba(0,0,0,0.55)'; // Default
      }
    }
    
    updateStats();
  };

  pc.oniceconnectionstatechange = () => {
    const iceState = pc.iceConnectionState;
    console.log(`🧊 ICE connection with ${participantId}: ${iceState}`);
    
    if (iceState === 'failed') {
      console.log(`❌ ICE connection failed with ${participantId}, attempting restart`);
      pc.restartIce();
    }
  };

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
    console.log(`📨 Data channel opened with ${participantId}`);
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
    
    // Get user media with initial high quality settings
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: VIDEO_CONSTRAINTS.HIGH.width },
        height: { ideal: VIDEO_CONSTRAINTS.HIGH.height },
        frameRate: { ideal: VIDEO_CONSTRAINTS.HIGH.frameRate }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    
    console.log('🎥 Got local stream');
    
    // Create local participant
    const localParticipant = new Participant('local', true);
    localParticipant.setStream(localStream);
    participants.set('local', localParticipant);
    
    // Create network monitoring UI indicators
    createNetworkIndicators();
    
    // Initialize connection timing
    connectionStartTime = Date.now();
    initialConnectionPhase = true;
    
    // Start network quality monitoring
    networkMonitoringInterval = setInterval(monitorNetworkQuality, 3000); // Increased to 3 seconds for less aggressive monitoring
    
    // Start active speaker detection
    activeSpeakerInterval = setInterval(updateActiveSpeaker, SPEAKER_UPDATE_INTERVAL);
    
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
  
  // Stop network monitoring
  if (networkMonitoringInterval) {
    clearInterval(networkMonitoringInterval);
    networkMonitoringInterval = null;
  }
  
  // Stop active speaker monitoring
  if (activeSpeakerInterval) {
    clearInterval(activeSpeakerInterval);
    activeSpeakerInterval = null;
  }
  
  // Clear active speaker data
  activeSpeaker = null;
  audioLevels.clear();
  
  // Remove network indicators
  removeNetworkIndicators();
  
  // Clear network stats
  networkStats.clear();
  
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
  
  // Reset state
  currentVideoQuality = 'HIGH';
  initialConnectionPhase = true;
  connectionStartTime = null;
  
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
      
      for (let i = 0; i < message.users.length; i++) {
        const user = message.users[i];
        setTimeout(() => {
          createOfferFor(user.id);
        }, i * 500);
      }
      break;

    case 'user-joined':
      console.log(`👋 User ${message.userId} joined`);
      const newParticipant = new Participant(message.userId);
      participants.set(message.userId, newParticipant);
      break;

    case 'user-left':
      console.log(`👋 User ${message.userId} left`);
      const participant = participants.get(message.userId);
      if (participant) {
        participant.remove();
        participants.delete(message.userId);
      }
      
      const pc = peerConnections.get(message.userId);
      if (pc) {
        pc.close();
        peerConnections.delete(message.userId);
      }
      
      // Remove network stats for this peer
      networkStats.delete(message.userId);
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
      setTimeout(() => {
        if (participants.has(message.fromId)) {
          reconnectToPeer(message.fromId);
        }
      }, 2000);
      break;
  }
};

// Reconnect to a peer that has connection issues
async function reconnectToPeer(participantId) {
  console.log(`🔄 Reconnecting to ${participantId}`);
  
  const existingPc = peerConnections.get(participantId);
  if (existingPc) {
    existingPc.close();
    peerConnections.delete(participantId);
  }
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  if (participants.has(participantId) && localStream) {
    console.log(`🔄 Creating new offer for ${participantId}`);
    await createOfferFor(participantId);
  }
}

// Create offer for a specific peer with enhanced error handling
async function createOfferFor(peerId) {
  console.log(`📤 Creating offer for ${peerId}`);
  
  if (!participants.has(peerId)) {
    const participant = new Participant(peerId);
    participants.set(peerId, participant);
  }
  
  const pc = createPeerConnection(peerId);
  
  if (localStream) {
    localStream.getTracks().forEach(track => {
      console.log(`Adding ${track.kind} track to ${peerId}`);
      pc.addTrack(track, localStream);
    });
  }

  try {
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
    
    setTimeout(() => {
      if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
        console.log(`⏰ Connection timeout for ${peerId}, attempting reconnect`);
        reconnectToPeer(peerId);
      }
    }, 15000);
    
  } catch (error) {
    console.error(`❌ Error creating offer for ${peerId}:`, error);
    
    setTimeout(() => {
      console.log(`🔄 Retrying offer creation for ${peerId}`);
      createOfferFor(peerId);
    }, 5000);
  }
}

// Handle incoming offer with improved error handling
async function handleOffer(fromId, offer) {
  console.log(`📥 Handling offer from ${fromId}`);
  
  if (!participants.has(fromId)) {
    const participant = new Participant(fromId);
    participants.set(fromId, participant);
  }
  
  const pc = createPeerConnection(fromId);
  
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  try {
    await pc.setRemoteDescription(offer);
    
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
    
    pc.close();
    peerConnections.delete(fromId);
    
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

// Create network monitoring UI indicators
function createNetworkIndicators() {
  // Create network quality indicator
  networkQualityIndicator = document.createElement('div');
  networkQualityIndicator.className = 'network-indicator';
  networkQualityIndicator.textContent = '📶 HIGH';
  networkQualityIndicator.style.cssText = `
    position: fixed;
    bottom: 120px;
    right: 10px;
    background: rgba(18,18,19,0.92);
    color: #28a745;
    padding: 8px 12px;
    border-radius: 20px;
    font-size: 14px;
    z-index: 1000;
    backdrop-filter: blur(6px);
  `;
  document.body.appendChild(networkQualityIndicator);
  
  // Create video quality indicator
  videoQualityIndicator = document.createElement('div');
  videoQualityIndicator.className = 'video-quality-indicator';
  videoQualityIndicator.textContent = '📹 HIGH';
  videoQualityIndicator.style.cssText = `
    position: fixed;
    bottom: 80px;
    right: 10px;
    background: rgba(18,18,19,0.92);
    color: #28a745;
    padding: 8px 12px;
    border-radius: 20px;
    font-size: 14px;
    z-index: 1000;
    backdrop-filter: blur(6px);
  `;
  document.body.appendChild(videoQualityIndicator);
  
  // Create adaptive mode toggle
  adaptiveModeToggle = document.createElement('button');
  adaptiveModeToggle.className = 'adaptive-toggle';
  adaptiveModeToggle.textContent = '🔄 Adaptive: ON';
  adaptiveModeToggle.style.cssText = `
    position: fixed;
    bottom: 40px;
    right: 10px;
    background: rgba(33,150,243,0.8);
    color: white;
    border: none;
    padding: 8px 12px;
    border-radius: 20px;
    font-size: 14px;
    cursor: pointer;
    z-index: 1000;
    backdrop-filter: blur(6px);
  `;
  
  adaptiveModeToggle.onclick = () => {
    isAdaptiveMode = !isAdaptiveMode;
    adaptiveModeToggle.textContent = `🔄 Adaptive: ${isAdaptiveMode ? 'ON' : 'OFF'}`;
    adaptiveModeToggle.style.background = isAdaptiveMode ? 'rgba(33,150,243,0.8)' : 'rgba(108,117,125,0.8)';
    console.log(`🔄 Adaptive mode ${isAdaptiveMode ? 'enabled' : 'disabled'}`);
    
    // If disabling adaptive mode, reset to high quality immediately
    if (!isAdaptiveMode && currentVideoQuality !== 'HIGH') {
      console.log('📹 Resetting to HIGH quality (adaptive mode disabled)');
      adjustVideoQualityForAllPeers('HIGH');
    }
  };
  
  document.body.appendChild(adaptiveModeToggle);
}

// Remove network monitoring UI indicators
function removeNetworkIndicators() {
  if (networkQualityIndicator) {
    networkQualityIndicator.remove();
    networkQualityIndicator = null;
  }
  if (videoQualityIndicator) {
    videoQualityIndicator.remove();
    videoQualityIndicator = null;
  }
  if (adaptiveModeToggle) {
    adaptiveModeToggle.remove();
    adaptiveModeToggle = null;
  }
}

// Update stats periodically
setInterval(updateStats, 2000);