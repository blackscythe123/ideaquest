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
    
    // Only manage video/no-video display if not in audio-only mode
    // In audio-only mode, the updateVideoDisplayForAudioOnly function handles this
    if (currentVideoQuality !== 'AUDIO_ONLY' || this.isLocal) {
      const noVideo = this.tileElement.querySelector('.no-video');
      if (stream && stream.getVideoTracks().length > 0) {
        // For local user, also check if video track is enabled and camera isn't off
        const shouldShowVideo = !this.isLocal || (!isCameraOff && stream.getVideoTracks()[0].enabled);
        
        if (shouldShowVideo) {
          this.videoElement.style.display = 'block';
          noVideo.style.display = 'none';
        } else {
          this.videoElement.style.display = 'none';
          noVideo.style.display = 'flex';
        }
      } else {
        this.videoElement.style.display = 'none';
        noVideo.style.display = 'flex';
      }
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
  let remoteInboundVideo = null;
  let remoteInboundAudio = null;
  
  stats.forEach(report => {
    if (report.type === 'outbound-rtp' && report.mediaType === 'video') {
      outboundVideo = report;
    } else if (report.type === 'outbound-rtp' && report.mediaType === 'audio') {
      outboundAudio = report;
    } else if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
      inboundVideo = report;
    } else if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
      inboundAudio = report;
    } else if (report.type === 'remote-inbound-rtp' && report.mediaType === 'video') {
      remoteInboundVideo = report;
    } else if (report.type === 'remote-inbound-rtp' && report.mediaType === 'audio') {
      remoteInboundAudio = report;
    } else if (report.type === 'candidate-pair' && report.selected) {
      candidate = report;
    }
  });
  
  if (!outboundVideo && !outboundAudio && !inboundVideo && !inboundAudio) return null;
  
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
  
  // Calculate video metrics
  if (outboundVideo && previousStats && previousStats.outboundVideo) {
    const timeDelta = (now - previousStats.timestamp) / 1000;
    const bytesDelta = outboundVideo.bytesSent - previousStats.outboundVideo.bytesSent;
    metrics.videoBitrate = (bytesDelta * 8) / timeDelta; // bits per second
    
    const packetsDelta = outboundVideo.packetsSent - previousStats.outboundVideo.packetsSent;
    const packetsLostDelta = (outboundVideo.packetsLost || 0) - (previousStats.outboundVideo.packetsLost || 0);
    
    // Be more careful with packet loss calculation - avoid division by zero or negative values
    if (packetsDelta > 0 && packetsLostDelta >= 0) {
      metrics.videoPacketLoss = Math.min(100, (packetsLostDelta / packetsDelta) * 100);
    } else {
      metrics.videoPacketLoss = 0;
    }
  }
  
  // Calculate audio metrics
  if (outboundAudio && previousStats && previousStats.outboundAudio) {
    const timeDelta = (now - previousStats.timestamp) / 1000;
    const bytesDelta = outboundAudio.bytesSent - previousStats.outboundAudio.bytesSent;
    metrics.audioBitrate = (bytesDelta * 8) / timeDelta;
    
    const packetsDelta = outboundAudio.packetsSent - previousStats.outboundAudio.packetsSent;
    const packetsLostDelta = (outboundAudio.packetsLost || 0) - (previousStats.outboundAudio.packetsLost || 0);
    
    // Be more careful with packet loss calculation
    if (packetsDelta > 0 && packetsLostDelta >= 0) {
      metrics.audioPacketLoss = Math.min(100, (packetsLostDelta / packetsDelta) * 100);
    } else {
      metrics.audioPacketLoss = 0;
    }
  }
  
  // Try to get RTT from multiple sources
  if (candidate && candidate.currentRoundTripTime) {
    metrics.rtt = candidate.currentRoundTripTime * 1000; // Convert to ms
  } else if (remoteInboundVideo && remoteInboundVideo.roundTripTime) {
    metrics.rtt = remoteInboundVideo.roundTripTime * 1000;
  } else if (remoteInboundAudio && remoteInboundAudio.roundTripTime) {
    metrics.rtt = remoteInboundAudio.roundTripTime * 1000;
  }
  
  // Try to get packet loss from multiple sources - be more careful about calculations
  let videoPacketLossFromRemote = 0;
  let audioPacketLossFromRemote = 0;
  let hasRemoteInboundStats = false;
  
  if (remoteInboundVideo) {
    const packetsLost = remoteInboundVideo.packetsLost || 0;
    // Try different field names for packets received
    const packetsReceived = remoteInboundVideo.packetsReceived || 
                          remoteInboundVideo.packetsRecieved || // Common typo in some implementations
                          0;
    
    if (packetsReceived > 0 || packetsLost > 0) {
      const totalPackets = packetsLost + packetsReceived;
      if (totalPackets > 0) {
        videoPacketLossFromRemote = (packetsLost / totalPackets) * 100;
        hasRemoteInboundStats = true;
      }
    }
  }
  
  if (remoteInboundAudio) {
    const packetsLost = remoteInboundAudio.packetsLost || 0;
    const packetsReceived = remoteInboundAudio.packetsReceived || 
                          remoteInboundAudio.packetsRecieved || 
                          0;
                          
    if (packetsReceived > 0 || packetsLost > 0) {
      const totalPackets = packetsLost + packetsReceived;
      if (totalPackets > 0) {
        audioPacketLossFromRemote = (packetsLost / totalPackets) * 100;
        hasRemoteInboundStats = true;
      }
    }
  }
  
  // Use remote stats if available, otherwise fall back to outbound stats
  if (hasRemoteInboundStats) {
    // Only use remote stats if they seem reasonable
    if (videoPacketLossFromRemote < 100) {
      metrics.videoPacketLoss = videoPacketLossFromRemote;
    }
    if (audioPacketLossFromRemote < 100) {
      metrics.audioPacketLoss = audioPacketLossFromRemote;
    }
  }
  
  // Additional fallback: use inbound stats for packet loss if available
  if ((metrics.videoPacketLoss >= 100 || metrics.audioPacketLoss >= 100) && inboundVideo) {
    // For inbound stats, packetsLost and packetsReceived should be total counts
    const packetsLost = inboundVideo.packetsLost || 0;
    const packetsReceived = inboundVideo.packetsReceived || 0;
    const totalPackets = packetsLost + packetsReceived;
    
    if (totalPackets > 100) { // Only use if we have a reasonable sample size
      metrics.videoPacketLoss = (packetsLost / totalPackets) * 100;
    }
  }
  
  if ((metrics.audioPacketLoss >= 100) && inboundAudio) {
    const packetsLost = inboundAudio.packetsLost || 0;
    const packetsReceived = inboundAudio.packetsReceived || 0;
    const totalPackets = packetsLost + packetsReceived;
    
    if (totalPackets > 100) { // Only use if we have a reasonable sample size
      metrics.audioPacketLoss = (packetsLost / totalPackets) * 100;
    }
  }
  
  // Final safety check - cap packet loss at reasonable values
  metrics.videoPacketLoss = Math.min(50, Math.max(0, metrics.videoPacketLoss));
  metrics.audioPacketLoss = Math.min(50, Math.max(0, metrics.audioPacketLoss));
  // If no remote stats available, the outbound calculation from earlier will be used
  
  // Debug logging for packet loss issues (temporary)
  if (metrics.videoPacketLoss > 50 || metrics.audioPacketLoss > 50) {
    console.log(`🐛 High packet loss detected for ${peerId}:`, {
      videoLoss: metrics.videoPacketLoss.toFixed(1),
      audioLoss: metrics.audioPacketLoss.toFixed(1),
      hasRemoteStats: hasRemoteInboundStats,
      remoteVideoStats: remoteInboundVideo ? {
        packetsLost: remoteInboundVideo.packetsLost,
        packetsReceived: remoteInboundVideo.packetsReceived
      } : null,
      outboundVideoStats: outboundVideo ? {
        packetsSent: outboundVideo.packetsSent,
        packetsLost: outboundVideo.packetsLost
      } : null
    });
  }
  
  if (inboundAudio) {
    metrics.jitter = inboundAudio.jitter || 0;
  }
  
  // Determine overall network quality with audio-only fallback for severe conditions
  const totalBitrate = metrics.videoBitrate + metrics.audioBitrate;
  const totalPacketLoss = Math.max(metrics.videoPacketLoss, metrics.audioPacketLoss);
  
  // Don't adapt during initial connection phase (first 10 seconds)
  if (initialConnectionPhase) {
    metrics.quality = 'HIGH';
  } else {
    // Enhanced thresholds - be smarter about audio-only decisions
    
    // For AUDIO_ONLY decisions, focus on connection quality (RTT/packet loss) not bitrate
    // because low bitrate might be due to being in audio-only mode already
    if (metrics.rtt > 500 || totalPacketLoss > 15) {
      // Very poor connection quality: fallback to audio-only
      metrics.quality = 'AUDIO_ONLY';
      console.log(`📶 Network severely degraded for ${peerId}: rtt=${Math.round(metrics.rtt)}ms, loss=${totalPacketLoss.toFixed(1)}% - switching to audio-only`);
    } else if (totalPacketLoss > 8 || metrics.rtt > 400 || (totalBitrate < BANDWIDTH_THRESHOLDS.LOW && totalBitrate > 60000)) {
      // Poor conditions: low quality video (only consider low bitrate if it's above audio-only range)
      metrics.quality = 'LOW';
    } else if (totalPacketLoss > 3 || metrics.rtt > 200 || (totalBitrate < BANDWIDTH_THRESHOLDS.MEDIUM && totalBitrate > 60000)) {
      // Moderate conditions: medium quality video (only consider low bitrate if it's above audio-only range)
      metrics.quality = 'MEDIUM';
    } else if (totalPacketLoss < 2 && metrics.rtt < 150) {
      // Good connection quality: allow high quality video
      metrics.quality = 'HIGH';
    } else {
      // Default to medium for uncertain conditions
      metrics.quality = 'MEDIUM';
    }
  }
  
  // Store raw stats for next comparison
  metrics.outboundVideo = outboundVideo;
  metrics.outboundAudio = outboundAudio;
  metrics.remoteInboundVideo = remoteInboundVideo;
  metrics.remoteInboundAudio = remoteInboundAudio;
  
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
    
    // Update worst quality including AUDIO_ONLY
    if (metrics.quality === 'AUDIO_ONLY') worstQuality = 'AUDIO_ONLY';
    else if (metrics.quality === 'LOW' && worstQuality !== 'AUDIO_ONLY') worstQuality = 'LOW';
    else if (metrics.quality === 'MEDIUM' && worstQuality === 'HIGH') worstQuality = 'MEDIUM';
  });
  
  if (peerCount === 0) return;
  
  // Determine target quality based on network conditions
  let targetQuality = currentVideoQuality;
  
  // Enhanced adaptation logic with smarter audio-only recovery
  if (worstQuality === 'AUDIO_ONLY' || maxPacketLoss > 15 || maxRtt > 3000) {
  // 🚨 Severe network issues -> force audio-only
  targetQuality = 'AUDIO_ONLY';

} else if (currentVideoQuality === 'AUDIO_ONLY' && maxPacketLoss <= 10 && maxRtt <= 1000) {
  // ✅ Recovery from audio-only: if connection quality is clearly better, upgrade slowly
  targetQuality = 'LOW';

} else if (worstQuality === 'LOW' || (maxPacketLoss > 8 || maxRtt > 500)) {
  // ⚠️ Poor conditions but not severe enough for audio-only
  if (currentVideoQuality !== 'AUDIO_ONLY') {
    targetQuality = 'LOW';
  }

} else if (worstQuality === 'MEDIUM' || (maxPacketLoss > 3 || maxRtt > 200)) {
  // ➡️ Moderate conditions
  if (currentVideoQuality === 'HIGH' || currentVideoQuality === 'LOW') {
    targetQuality = 'MEDIUM';
  }

} else if ((worstQuality === 'HIGH' || currentVideoQuality !== 'HIGH') 
           && maxPacketLoss < 2 && maxRtt < 150) {
  // 🌟 Good conditions - can upgrade to high
  targetQuality = 'HIGH';
}

  
  // Only change quality if it's different from current
  if (targetQuality !== currentVideoQuality) {
    console.log(`🔄 Network adaptation: ${currentVideoQuality} → ${targetQuality} (peers: ${peerCount}, loss: ${maxPacketLoss.toFixed(1)}%, rtt: ${Math.round(maxRtt)}ms, bitrate: ${Math.round(totalBitrate/1000)}kbps)`);
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
      // Disable video transmission but keep local video display
      sender.track.enabled = false;
      console.log('📹 Switched to audio-only mode - disabling video transmission');
      currentVideoQuality = 'AUDIO_ONLY';
      
      // Update UI to show audio-only state while preserving local video
      updateVideoDisplayForAudioOnly(true);
      
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
      
      // Restore normal video display
      updateVideoDisplayForAudioOnly(false);
    }
  } catch (error) {
    console.error('Error adjusting video quality:', error);
  }
}

// Update video display for audio-only mode
function updateVideoDisplayForAudioOnly(isAudioOnly) {
  participants.forEach((participant, participantId) => {
    if (!participant.tileElement) return;
    
    const videoElement = participant.tileElement.querySelector('.participant-video');
    const noVideoElement = participant.tileElement.querySelector('.no-video');
    const infoElement = participant.tileElement.querySelector('.participant-info');
    
    if (participantId === 'local') {
      console.log(`🎥 Updating local video display - Audio Only: ${isAudioOnly}, Camera Off: ${isCameraOff}, Has Stream: ${!!localStream}, Has Video Tracks: ${localStream ? localStream.getVideoTracks().length : 0}`);
      
      // Local participant: Always show their own video if camera is on and stream exists
      if (!isCameraOff && localStream && localStream.getVideoTracks().length > 0) {
        // For local display, we want to show video regardless of audio-only mode
        // The video track might be disabled for transmission but should still display locally
        
        // Force video display for local user
        videoElement.style.display = 'block';
        noVideoElement.style.display = 'none';
        
        // Ensure the video element has the stream and try to play it
        if (videoElement.srcObject !== localStream) {
          videoElement.srcObject = localStream;
          videoElement.play().catch(e => console.log('Video play error (usually safe to ignore):', e));
        }
        
        console.log(`🎥 Local video should be visible: video element display = ${videoElement.style.display}`);
        
        // Add visual indicator that they're in audio-only mode
        if (isAudioOnly) {
          // Keep normal "You" text - just add subtle audio-only indicator
          infoElement.textContent = 'You';
          infoElement.style.background = 'rgba(0,0,0,0.7)'; // Keep normal background
          
          // Add subtle top-right indicator that video transmission is off
          if (!participant.tileElement.querySelector('.audio-only-overlay')) {
            const overlay = document.createElement('div');
            overlay.className = 'audio-only-overlay';
            overlay.innerHTML = `
              <div style="
                position: absolute;
                top: 10px;
                right: 10px;
                background: rgba(255, 152, 0, 0.9);
                color: white;
                padding: 3px 6px;
                border-radius: 12px;
                font-size: 10px;
                font-weight: bold;
                z-index: 10;
                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
              ">🎵 Not Transmitting</div>
            `;
            participant.tileElement.appendChild(overlay);
          }
        } else {
          // Remove audio-only indicators when not in audio-only mode
          infoElement.textContent = 'You';
          infoElement.style.background = 'rgba(0,0,0,0.7)';
          
          const overlay = participant.tileElement.querySelector('.audio-only-overlay');
          if (overlay) overlay.remove();
        }
      } else {
        // Camera is off - show no-video placeholder
        videoElement.style.display = 'none';
        noVideoElement.style.display = 'flex';
        infoElement.textContent = isCameraOff ? 'You (Camera Off)' : 'You';
        
        console.log(`🎥 Local video hidden - Camera off: ${isCameraOff}`);
        
        // Remove overlay if camera is off
        const overlay = participant.tileElement.querySelector('.audio-only-overlay');
        if (overlay) overlay.remove();
      }
      
    } else {
      // Remote participants: Black out their video in audio-only mode
      if (isAudioOnly) {
        videoElement.style.display = 'none';
        noVideoElement.style.display = 'flex';
        noVideoElement.innerHTML = `
          <div style="
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: #fff;
            text-align: center;
          ">
            <div style="font-size: 48px; margin-bottom: 10px;">🎵</div>
            <div style="font-size: 14px;">Audio Only</div>
          </div>
        `;
        infoElement.style.background = 'rgba(255, 152, 0, 0.8)'; // Orange
        
      } else {
        // Normal mode - show video if available
        if (participant.stream && participant.stream.getVideoTracks().length > 0) {
          videoElement.style.display = 'block';
          noVideoElement.style.display = 'none';
          noVideoElement.innerHTML = '👤'; // Reset to default
        } else {
          videoElement.style.display = 'none';
          noVideoElement.style.display = 'flex';
          noVideoElement.innerHTML = '👤';
        }
        infoElement.style.background = 'rgba(0,0,0,0.7)'; // Default
      }
    }
  });
}

function updateNetworkIndicators() {
  // Calculate overall network quality from all peers
  let worstQuality = 'HIGH';
  let totalBitrate = 0;
  let avgPacketLoss = 0;
  let avgRtt = 0;
  let peerCount = 0;
  
  networkStats.forEach((metrics, peerId) => {
    // Handle AUDIO_ONLY as the worst quality level
    if (metrics.quality === 'AUDIO_ONLY') worstQuality = 'AUDIO_ONLY';
    else if (metrics.quality === 'LOW' && worstQuality !== 'AUDIO_ONLY') worstQuality = 'LOW';
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
  
  // Update network quality indicator if it exists
  if (networkQualityIndicator) {
    const qualityColors = {
      HIGH: '#28a745',        // Green
      MEDIUM: '#ffc107',      // Yellow
      LOW: '#dc3545',         // Red
      AUDIO_ONLY: '#ff9800',  // Orange
      OFFLINE: '#6c757d'      // Gray
    };
    
    networkQualityIndicator.style.color = qualityColors[worstQuality] || qualityColors.OFFLINE;
    networkQualityIndicator.textContent = `📶 ${worstQuality}`;
  }
  
  // Update video quality indicator if it exists
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
  const count = participants.size;
  
  // Update top-left participant count to stay in sync
  participantCount.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
  
  // Calculate overall network quality based on actual metrics
  let overallQuality = 'HIGH';
  if (networkStats.size > 0) {
    networkStats.forEach((metrics) => {
      if (metrics.quality === 'AUDIO_ONLY') overallQuality = 'AUDIO_ONLY';
      else if (metrics.quality === 'LOW' && overallQuality !== 'AUDIO_ONLY') overallQuality = 'LOW';
      else if (metrics.quality === 'MEDIUM' && overallQuality === 'HIGH') overallQuality = 'MEDIUM';
    });
  }
  
  // Create more detailed and properly formatted network info
  const participantCountText = `Participants: ${count}`;
  const networkText = `Network: ${bitrateKbps > 0 ? bitrateKbps : 0} kbps`;
  const packetLossText = `Packet Loss: ${avgPacketLoss.toFixed(1)}%`;
  const rttText = `RTT: ${Math.round(avgRtt)}ms`;
  const qualityText = `Quality: ${overallQuality}`;
  const adaptiveText = `Adaptive: ${isAdaptiveMode ? 'ON' : 'OFF'}`;
  
  const networkInfo = [
    participantCountText,
    networkText,
    packetLossText,
    rttText,
    qualityText,
    adaptiveText
  ].join('\n');
  
  statsPanel.textContent = networkInfo;
}

// Update connection stats
function updateStats() {
  // If we have network stats, use the detailed view
  if (networkStats.size > 0) {
    // Network stats will be updated by updateNetworkIndicators
    return;
  }
  
  // Fallback for basic connection info when no network stats available
  const participantCountText = `Participants: ${participants.size}`;
  const connectionText = `Connected: ${peerConnections.size} peers`;
  
  let peerStates = [];
  peerConnections.forEach((pc, peerId) => {
    const state = pc.connectionState;
    const iceState = pc.iceConnectionState;
    peerStates.push(`${peerId.substring(0, 8)}: ${state}/${iceState}`);
  });
  
  const statsText = [
    participantCountText,
    connectionText,
    ...peerStates
  ].join('\n');
  
  statsPanel.textContent = statsText;
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
    
    // If we're already in audio-only mode, make sure local video is displayed correctly
    if (currentVideoQuality === 'AUDIO_ONLY') {
      setTimeout(() => updateVideoDisplayForAudioOnly(true), 100);
    }
    
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
        
        // If in audio-only mode, update the display to reflect camera state
        if (currentVideoQuality === 'AUDIO_ONLY') {
          updateVideoDisplayForAudioOnly(true);
        }
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