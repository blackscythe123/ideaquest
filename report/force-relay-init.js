(function () {
  const NativeRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = function (config, ...rest) {
    const patched = Object.assign({}, config, { iceTransportPolicy: 'relay' });
    console.log('🧪 [force-relay-init] Forcing iceTransportPolicy=relay for new RTCPeerConnection');
    return new NativeRTCPeerConnection(patched, ...rest);
  };
  window.RTCPeerConnection.prototype = NativeRTCPeerConnection.prototype;
})();
