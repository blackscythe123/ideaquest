# WebRTC Video Conference Application with Adaptive Network Optimization

A modern, Google Meet-style WebRTC video conferencing application with advanced network adaptation features, active speaker detection, real-time activity monitoring (awake/asleep detection), and intelligent quality management.

## 🎯 Key Features

### ✨ Modern UI Design
- **Google Meet-inspired interface** with Inter font and dark theme (#0f1113)
- **Responsive CSS Grid layout** that adapts to 1-9 participants
- **Hover effects and smooth animations** with backdrop filters
- **Professional participant tiles** with rounded corners and shadows

### 🔄 Adaptive Network Management
- **Real-time network monitoring** every 3 seconds
- **Intelligent quality adaptation** based on bandwidth, RTT, and packet loss
- **Audio-only fallback** for severe network conditions
- **Smart recovery logic** that prevents quality flapping

### 🎵 Active Speaker Detection
- **Web Audio API integration** for real-time audio level monitoring
- **Visual highlighting** of active speakers with blue borders
- **Bandwidth optimization** prioritizing active speakers
- **3-person layout optimization** with main speaker positioning

### �️ Activity Detection (Awake/Asleep)
- **MediaPipe FaceMesh integration** for real-time eye tracking
- **Eye Aspect Ratio (EAR) calculation** to detect eye closure
- **Visual status indicators**: 🙂 Active, 😴 Slept, ⏳ Checking...
- **Smart dwell time logic** to prevent false positives
- **Works with network adaptation** - continues during audio-only mode for local user

### �📊 Network Statistics Display
- **Real-time stats panel** in top-right corner
- **Comprehensive metrics**: Participant count, bandwidth, packet loss, RTT
- **Quality indicators** with color-coded status
- **Adaptive mode status** showing ON/OFF state

## 🛠️ Technical Architecture

### Network Quality Thresholds

```javascript
const BANDWIDTH_THRESHOLDS = {
  LOW: 150000,    // 150 kbps - minimum for low quality video
  MEDIUM: 500000, // 500 kbps - medium quality video threshold  
  HIGH: 1000000   // 1 Mbps - high quality video threshold
};
```

### Quality Assessment Criteria

#### 🔴 AUDIO_ONLY Mode
- **RTT > 3000** OR **Packet Loss > 15%**
- Video transmission disabled, audio prioritized
- Local video preview maintained for user positioning

#### 🟡 LOW Quality (160x120@15fps)
- **RTT: 400-500ms** OR **Packet Loss: 8-15%** OR **Bitrate: 60-150 kbps**
- Max bitrate: 200 kbps, priority: low

#### 🟠 MEDIUM Quality (320x240@24fps) 
- **RTT: 200-400ms** OR **Packet Loss: 3-8%** OR **Bitrate: 150-500 kbps**
- Max bitrate: 600 kbps, priority: medium

#### 🟢 HIGH Quality (640x480@30fps)
- **RTT < 150ms** AND **Packet Loss < 2%** AND **Good bitrate**
- Max bitrate: 1.2 Mbps, priority: high

### Video Quality Constraints

```javascript
const VIDEO_CONSTRAINTS = {
  LOW:    { width: 160, height: 120, frameRate: 15 },
  MEDIUM: { width: 320, height: 240, frameRate: 24 },
  HIGH:   { width: 640, height: 480, frameRate: 30 }
};
```

## 🎵 Audio-Only Mode Features

### Smart Local Video Handling
- **Local camera preview**: Always visible when camera is on
- **Visual indicator**: Orange "🎵 Not Transmitting" badge
- **No bandwidth usage**: Local preview doesn't consume network resources
- **Camera controls**: Remain fully functional

### Remote Participant Experience
- **Video placeholder**: 🎵 "Audio Only" symbol with text
- **Audio maintained**: Full audio communication continues
- **Bandwidth savings**: ~90% reduction in data usage
- **Visual feedback**: Orange styling indicates audio-only state

## 📊 Network Monitoring System

### Statistics Collection
- **Outbound RTP stats**: Packet sending rates, bytes transmitted
- **Remote inbound stats**: Packet loss from receiver perspective  
- **Candidate pair stats**: Round-trip time measurements
- **Audio level monitoring**: Active speaker detection

### Packet Loss Calculation Priority
1. **Remote-inbound-rtp reports** (most accurate)
2. **Inbound-rtp reports** (fallback)
3. **Outbound-rtp reports** (last resort)

### Safety Mechanisms
- **Initial connection protection**: No adaptation for first 10 seconds
- **Minimum sample size**: Requires >100 packets for loss calculation
- **Value capping**: Packet loss limited to 0-50% range
- **Negative delta protection**: Prevents counter reset issues

## 🔄 Adaptive Logic Flow

### Quality Degradation Path
```
HIGH → MEDIUM → LOW → AUDIO_ONLY
```

### Recovery Intelligence
- **Connection quality focus**: Uses RTT and packet loss for recovery decisions
- **Bitrate filtering**: Ignores low bitrate when in audio-only mode (prevents trap)
- **Gradual upgrades**: AUDIO_ONLY → LOW → MEDIUM → HIGH
- **Stability requirements**: Sustained good conditions needed for upgrades

### Recovery Triggers
```javascript
// From AUDIO_ONLY to LOW
if (currentVideoQuality === 'AUDIO_ONLY' && 
    maxPacketLoss < 2 && maxRtt < 150) {
    targetQuality = 'LOW';
}
```

## 🎯 Active Speaker Detection

### Audio Level Monitoring
- **Sample rate**: Updated every 200ms
- **Threshold**: -50 dB for voice activity detection
- **Smoothing**: Exponential moving average to prevent flicker
- **Silence detection**: Automatic fallback when no one speaks

### Bandwidth Optimization
```javascript
// Active speaker gets high quality
params.encodings[0].maxBitrate = 1200000; // 1.2 Mbps
params.encodings[0].priority = 'high';

// Background participants get reduced quality  
params.encodings[0].maxBitrate = 600000; // 600 kbps
params.encodings[0].priority = 'medium';
```

## �️ Activity Detection System

### Eye Aspect Ratio (EAR) Algorithm
```javascript
// Detection thresholds
const EYE_EAR_THRESHOLD = 0.30; // Higher threshold detects closures sooner
const SLEEP_MS = 800;           // Time before marking as 'slept' 
const WAKE_MS = 250;            // Time before marking as 'active'

// MediaPipe FaceMesh eye landmarks
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
```

### Activity Status Logic
- **🙂 Active**: Eyes open for > 250ms
- **😴 Slept**: Eyes closed for > 800ms  
- **⏳ Checking**: Initial state or transitioning
- **Fallback**: Defaults to 'active' after 1200ms if no face detected

### MediaPipe Integration
```javascript
// FaceMesh configuration
fm.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});
```

### Network Mode Compatibility
- **Normal mode**: Activity detection for all participants with video
- **Audio-only mode**: Local user activity detection continues, remote participants paused
- **Camera off**: Activity detection automatically disabled
- **Reconnection**: Activity detection restarts when video streams resume

## �📱 Responsive Grid Layouts

### Participant Count Adaptations
- **Single (1)**: Centered video, max 900px width, 16:9 aspect ratio
- **Double (2)**: Side-by-side layout, equal columns
- **Triple (3)**: 2 top + 1 bottom spanning, active speaker prominence
- **Quad (4)**: 2x2 grid layout
- **5-6**: 3-column layouts with strategic spanning
- **7-8**: 4x2 grid for optimal space usage
- **9+**: Auto-fit grid with 240px minimum tile size

### Mobile Responsiveness
```css
@media (max-width: 768px) {
  .video-grid {
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    grid-auto-rows: minmax(100px, auto);
  }
}
```

## 🛡️ Connection Resilience

### ICE Configuration
```javascript
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.services.mozilla.com' },
  { urls: 'stun:stun.stunprotocol.org:3478' },
  { urls: 'stun:openrelay.metered.ca:80' }
]
```

### Error Handling & Recovery
- **Connection timeout**: 15-second limit with automatic retry
- **ICE failure recovery**: Automatic ICE restart on connection failure
- **Peer reconnection**: 3-second delay before reconnection attempt
- **Data channel heartbeat**: 30-second ping/pong for connection monitoring

## 🎨 UI/UX Features

### Visual Feedback
- **Connection status colors**: Green (connected), Yellow (connecting), Red (failed)
- **Quality indicators**: Color-coded network status with emoji icons  
- **Participant info**: Hover effects and connection state display
- **Mute indicators**: Visual feedback for audio/video states

### Control Interface
- **Join/Leave buttons**: One-click meeting access
- **Audio/Video toggles**: Instant mute/unmute functionality
- **Adaptive mode control**: Manual override for network adaptation
- **Stats panel**: Real-time network information display

## 🔧 Configuration Options

### Network Monitoring Intervals
- **Quality monitoring**: Every 3000ms (3 seconds)
- **Active speaker detection**: Every 200ms  
- **Stats panel update**: Every 2000ms (2 seconds)
- **Connection heartbeat**: Every 30000ms (30 seconds)

### Customizable Thresholds
All thresholds can be adjusted by modifying the constants at the top of `script.js`:

```javascript
// Bandwidth thresholds for quality decisions
const BANDWIDTH_THRESHOLDS = { ... }

// Video quality constraints
const VIDEO_CONSTRAINTS = { ... }

// Active speaker detection sensitivity
const VOICE_ACTIVITY_THRESHOLD = -50; // dB

// Update intervals
const SPEAKER_UPDATE_INTERVAL = 200; // ms
```

## 🚀 Getting Started

### Prerequisites
- Modern web browser with WebRTC support
- Camera and microphone access
- Local server for development (due to WebRTC security requirements)
- Internet connection for MediaPipe FaceMesh CDN access

### Installation
1. Clone the repository
2. Start a local server (e.g., `npx http-server` or `python -m http.server`)
3. Open `index.html` in your browser
4. Grant camera/microphone permissions
5. Click "Join Meeting" to start

### Development Setup
```bash
# Using Node.js http-server
npm install -g http-server
http-server -p 3000

# Using Python
python -m http.server 3000

# Using Node.js with WebSocket support
node server.js
```

## 📈 Performance Optimizations

### Bandwidth Management
- **Dynamic bitrate adjustment**: Based on network conditions
- **Audio prioritization**: Maintains call quality in poor conditions  
- **Background participant optimization**: Reduces quality for non-speakers
- **Adaptive frame rates**: Adjusts based on network capacity

### Memory Efficiency
- **Stream cleanup**: Proper disposal of media tracks
- **Event listener management**: Prevents memory leaks
- **Participant object lifecycle**: Clean creation and removal

### CPU Optimization  
- **Efficient audio analysis**: Optimized FFT processing
- **Throttled updates**: Prevents excessive re-renders
- **Smart grid recalculation**: Only when participant count changes

## 🐛 Troubleshooting

### Common Issues

#### Video Not Displaying
- Check camera permissions in browser
- Verify HTTPS/localhost requirement for WebRTC
- Toggle camera button to refresh stream

#### Audio-Only Mode Stuck
- Fixed in latest version with smart recovery logic
- Monitor console for quality assessment logs
- Check RTT and packet loss values in stats panel

#### Connection Problems
- Verify STUN server accessibility
- Check firewall settings for WebRTC traffic
- Review browser console for detailed error messages

### Debug Information
Enable debug logging by opening browser console (F12) to see:
- Network quality assessments
- Connection state changes
- Audio level measurements
- Quality adaptation decisions

## 🔬 Technical Implementation Details

### WebRTC Stack
- **Peer-to-peer connections** with fallback STUN servers
- **Unified Plan SDP** for modern browser compatibility
- **Bundle policy**: Maximized for connection efficiency
- **RTCP mux policy**: Required for optimal performance

### Audio Processing
- **Web Audio API**: Real-time audio level analysis
- **Echo cancellation**: Enabled by default
- **Noise suppression**: Hardware-accelerated when available
- **Auto gain control**: Maintains consistent audio levels

### Video Processing
- **Hardware acceleration**: Utilizes GPU when available
- **Constraint-based adaptation**: Dynamic resolution/framerate
- **Encoding parameter control**: Bitrate and priority management
- **Track management**: Enable/disable without stream recreation

## 📊 Metrics & Analytics

### Collected Metrics
- **Video bitrate**: Bytes per second transmitted/received
- **Audio bitrate**: Audio data transmission rates
- **Packet loss**: Percentage of lost packets
- **Round-trip time**: Network latency measurements
- **Jitter**: Variation in packet arrival times
- **Connection states**: Detailed peer connection status

### Performance Monitoring
- **Frame rate tracking**: Actual vs target frame rates
- **Resolution tracking**: Current video dimensions
- **Audio levels**: Real-time voice activity detection
- **Network adaptation events**: Quality change logging

## 🔒 Security Considerations

### Privacy
- **Peer-to-peer**: No server-side media processing
- **Local preview**: Camera feed never leaves device unnecessarily
- **Permission-based**: Explicit user consent for media access

### Network Security  
- **STUN-only**: No TURN servers reduce privacy exposure
- **Encrypted connections**: All WebRTC traffic is encrypted
- **Origin restrictions**: Same-origin policy enforcement

---

## 📄 License

MIT License - Feel free to use, modify, and distribute.

## 🤝 Contributing

Contributions welcome! Please read the code structure and follow the established patterns for network adaptation and UI management.

---

*Built with ❤️ using modern WebRTC APIs, advanced network optimization, and responsive design principles.*