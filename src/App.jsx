import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

const socket = io('https://streamingbackend-eh65.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

const iceServers = {
  iceServers: [
    {
      urls: 'turn:coturn.streamalong.live:3478?transport=udp',
      username: 'vikram',
      credential: 'vikram',
    },
  ],
};

const App = () => {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [loading, setLoading] = useState(false);
  const [hasRequestedStream, setHasRequestedStream] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnections = useRef({});
  const localStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);

  const requestPermissions = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.play().catch(err => console.error('Local video play error:', err));
      }
      return stream;
    } catch (err) {
      console.error('Permission error:', err);
      setError('Camera and microphone permissions are required.');
      return null;
    }
  };

  // Sync remoteStream to remoteVideoRef and log track details
  useEffect(() => {
    if (remoteStream && remoteVideoRef.current) {
      console.log('Setting remoteStream to video element:', remoteStream);
      console.log('Remote stream tracks:', {
        video: remoteStream.getVideoTracks().map(t => ({
          id: t.id,
          enabled: t.enabled,
          readyState: t.readyState,
        })),
        audio: remoteStream.getAudioTracks().map(t => ({
          id: t.id,
          enabled: t.enabled,
          readyState: t.readyState,
        })),
      });
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current.play().catch(err => {
        console.error('Remote video play error:', err);
        setError('Failed to play stream. Check browser permissions or try refreshing.');
      });
    }
  }, [remoteStream]);

  useEffect(() => {
    socket.on('room-created', ({ roomId }) => {
      console.log('Room created:', roomId);
      setJoined(true);
      setIsHost(true);
      setHostId(socket.id);
      setLoading(false);
    });

    socket.on('room-joined', ({ roomId, hostId, viewerCount, isHostStreaming }) => {
      console.log('Room joined:', roomId, 'Host streaming:', isHostStreaming);
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setIsStreaming(isHostStreaming);
      setLoading(false);
      if (isHostStreaming) {
        const peerConnection = new RTCPeerConnection(iceServers);
        peerConnection.ontrack = (event) => {
          console.log('Viewer received track:', event.streams);
          const stream = event.streams[0];
          if (stream) {
            setRemoteStream(stream);
          }
        };
        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            console.log('Viewer sending ICE candidate to host:', hostId);
            socket.emit('ice-candidate', { target: hostId, candidate: event.candidate });
          }
        };
        peerConnectionRef.current = peerConnection;
      }
    });

    socket.on('room-full', () => {
      setError('Room is full. Cannot join.');
      setLoading(false);
    });

    socket.on('invalid-room', () => {
      setError('Invalid room ID.');
      setLoading(false);
    });

    socket.on('room-exists', () => {
      setError('Room already exists.');
      setLoading(false);
    });

    socket.on('room-info', ({ viewerCount }) => {
      setViewerCount(viewerCount);
    });

    socket.on('user-joined', (viewerId) => {
      if (!isHost) return;
      console.log('Host: Viewer joined:', viewerId);
      if (!localStreamRef.current || !localStreamRef.current.getTracks().length) {
        console.warn('Host: No local stream available');
        return;
      }

      const peerConnection = new RTCPeerConnection(iceServers);
      localStreamRef.current.getTracks().forEach(track => {
        console.log('Host: Adding track to peer connection for viewer:', viewerId);
        peerConnection.addTrack(track, localStreamRef.current);
      });

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Host: Sending ICE candidate to viewer:', viewerId);
          socket.emit('ice-candidate', { target: viewerId, candidate: event.candidate });
        }
      };

      peerConnections.current[viewerId] = peerConnection;

      if (isStreaming) {
        console.log('Host: Sending offer to viewer:', viewerId);
        setTimeout(async () => {
          try {
            const offer = await peerConnection.createOffer({
              offerToReceiveAudio: false,
              offerToReceiveVideo: false,
            });
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', { target: viewerId, sdp: offer });
          } catch (err) {
            console.error('Host: Offer creation error:', err);
          }
        }, 500);
      }
    });

    socket.on('user-left', (viewerId) => {
      if (peerConnections.current[viewerId]) {
        peerConnections.current[viewerId].close();
        delete peerConnections.current[viewerId];
        console.log('Viewer left:', viewerId);
      }
    });

    socket.on('host-started-streaming', () => {
      console.log('Viewer: Host started streaming');
      setIsStreaming(true);
      if (!peerConnectionRef.current) {
        const peerConnection = new RTCPeerConnection(iceServers);
        peerConnection.ontrack = (event) => {
          console.log('Viewer: Received track after host started streaming');
          const stream = event.streams[0];
          if (stream) {
            setRemoteStream(stream);
          }
        };
        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit('ice-candidate', { target: hostId, candidate: event.candidate });
          }
        };
        peerConnectionRef.current = peerConnection;
      }
    });

    socket.on('ice-candidate', async ({ candidate, sender }) => {
      const pc = peerConnections.current[sender] || peerConnectionRef.current;
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('Added ICE candidate from:', sender);
        } catch (err) {
          console.error('ICE candidate error:', err);
        }
      }
    });

    socket.on('offer', async ({ sdp, sender }) => {
      if (isHost) return;
      console.log('Viewer: Received offer from host:', sender);
      let peerConnection = peerConnectionRef.current;
      if (!peerConnection) {
        peerConnection = new RTCPeerConnection(iceServers);
        peerConnection.ontrack = (event) => {
          console.log('Viewer: Received track from offer');
          const stream = event.streams[0];
          if (stream) {
            setRemoteStream(stream);
          }
        };
        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit('ice-candidate', { target: sender, candidate: event.candidate });
          }
        };
        peerConnectionRef.current = peerConnection;
      }
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { target: sender, sdp: answer });
        console.log('Viewer: Sent answer to host:', sender);
      } catch (err) {
        console.error('Viewer: Offer handling error:', err);
      }
    });

    socket.on('answer', async ({ sdp, sender }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          console.log('Host: Received answer from viewer:', sender);
        } catch (err) {
          console.error('Host: Answer handling error:', err);
        }
      }
    });

    socket.on('host-left', () => {
      setError('Host has left the room.');
      setJoined(false);
      setIsStreaming(false);
      setRemoteStream(null);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
    });

    socket.on('room-closed', () => {
      setError('Room has been closed.');
      setJoined(false);
      setIsStreaming(false);
      setRemoteStream(null);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
    });

    socket.on('stream-request', ({ viewerId }) => {
      if (isHost) {
        if (window.confirm(`Viewer ${viewerId} wants to stream. Allow?`)) {
          socket.emit('stream-permission', { viewerId, allowed: true });
        } else {
          socket.emit('stream-permission', { viewerId, allowed: false });
        }
      }
    });

    socket.on('stream-permission', ({ allowed }) => {
      if (allowed) {
        startStreaming();
        setHasRequestedStream(false);
      } else {
        setError('Streaming permission denied by host.');
        setHasRequestedStream(false);
      }
    });

    return () => {
      socket.removeAllListeners();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, isStreaming, hostId]);

  const createRoom = () => {
    if (roomId.trim() === '') {
      setError('Please enter a room ID.');
      return;
    }
    setLoading(true);
    socket.emit('create-room', roomId);
  };

  const joinRoom = () => {
    if (roomId.trim() === '') {
      setError('Please enter a room ID.');
      return;
    }
    setLoading(true);
    socket.emit('join-room', roomId);
  };

  const requestStreamPermission = () => {
    socket.emit('stream-request', { roomId, viewerId: socket.id });
    setHasRequestedStream(true);
  };

  const startStreaming = async () => {
    try {
      const stream = await requestPermissions();
      if (!stream) return;
      const peerConnection = new RTCPeerConnection(iceServers);
      stream.getTracks().forEach(track => {
        peerConnection.addTrack(track, stream);
      });
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Host: ICE candidate generated');
        }
      };
      peerConnectionRef.current = peerConnection;
      socket.emit('host-streaming', roomId);
      setIsStreaming(true);
    } catch (err) {
      console.error('Streaming error:', err);
      setError('Failed to start streaming.');
    }
  };

  const stopStreaming = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      localStreamRef.current = null;
    }
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
    setIsStreaming(false);
    socket.emit('stop-streaming', roomId);
  };

  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsStreaming(false);
    setRoomId('');
    setHasRequestedStream(false);
    setError('');
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      localStreamRef.current = null;
    }
    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop());
      setRemoteStream(null);
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(prev => !prev);
    }
  };

  const switchCamera = async () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        const currentDeviceId = videoTrack.getSettings().deviceId;
        const nextDevice = videoDevices.find(device => device.deviceId !== currentDeviceId) || videoDevices[0];

        try {
          const newStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: nextDevice.deviceId },
            audio: true,
          });
          const newVideoTrack = newStream.getVideoTracks()[0];
          localStreamRef.current.removeTrack(videoTrack);
          localStreamRef.current.addTrack(newVideoTrack);
          setLocalStream(localStreamRef.current);
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current;
            localVideoRef.current.play().catch(err => console.error('Local video play error:', err));
          }
          setIsFrontCamera(prev => !prev);
          Object.values(peerConnections.current).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track.kind === 'video');
            if (sender) {
              sender.replaceTrack(newVideoTrack);
            }
          });
          if (peerConnectionRef.current) {
            const sender = peerConnectionRef.current.getSenders().find(s => s.track.kind === 'video');
            if (sender) {
              sender.replaceTrack(newVideoTrack);
            }
          }
        } catch (err) {
          console.error('Switch camera error:', err);
        }
      }
    }
  };

  return (
    <div className="app-container">
      <h1 className="app-title">
        <span role="img" aria-label="camera">🎥</span> Live Streaming Hub
      </h1>

      {!joined ? (
        <div className="join-card">
          <input
            type="text"
            placeholder="Enter Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="room-input"
          />
          {loading ? (
            <div className="loader-container">
              <svg className="loader" viewBox="0 0 24 24">
                <circle className="loader-circle" cx="12" cy="12" r="10" />
                <path className="loader-path" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 11-8 8h4l-3 3 3 3h-4a12 12 0 10 12-12z" />
              </svg>
            </div>
          ) : (
            <div className="button-group">
              <button onClick={createRoom} className="action-button">
                Create Room
              </button>
              <button onClick={joinRoom} className="action-button">
                Join Room
              </button>
            </div>
          )}
          {error && <p className="error-message">{error}</p>}
        </div>
      ) : (
        <div className="room-container">
          <div className="room-info">
            <div className="info-section">
              <p>Room ID: <span className="highlight">{roomId}</span></p>
              <p>Role: <span className="highlight">{isHost ? 'Host' : 'Viewer'}</span></p>
            </div>
            <p className="viewer-count">
              <span role="img" aria-label="eye">👁️</span> Viewers: <span className="highlight">{viewerCount}</span>
            </p>
          </div>

          {isHost && (
            <div className="stream-card">
              {localStream ? (
                <div className="video-container">
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="video-player"
                    style={{ transform: isFrontCamera ? 'scaleX(-1)' : 'none' }}
                  />
                  {isStreaming && (
                    <div className="streaming-indicator">
                      <span className="pulse-dot"></span> Streaming Live
                    </div>
                  )}
                </div>
              ) : (
                <div className="video-placeholder">
                  <p>Camera not active</p>
                </div>
              )}
              <div className="control-buttons">
                <button onClick={toggleMute} className="control-button">
                  <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={isMuted ? 'M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707A1 1 0 0112 5v14a1 1 0 01-1.707.707L5.586 15zM17 9l4 4m0-4l-4 4' : 'M19 11v2a7 7 0 01-7 7m7-9a7 7 0 01-7-7m7 9H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707A1 1 0 0112 5v14a1 1 0 01-1.707.707L5.586 15H4'} />
                  </svg>
                  {isMuted ? 'Unmute' : 'Mute'}
                </button>
                <button onClick={switchCamera} className="control-button">
                  <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  Switch Camera
                </button>
              </div>
              <div className="stream-buttons">
                {!isStreaming ? (
                  <button onClick={startStreaming} className="stream-button start">
                    <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14m-6 2V8m0 8H6a2 2 0 01-2-2V8a2 2 0 012-2h3" />
                    </svg>
                    Start Streaming
                  </button>
                ) : (
                  <button onClick={stopStreaming} className="stream-button stop">
                    <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Stop Streaming
                  </button>
                )}
              </div>
            </div>
          )}

          {!isHost && (
            <div className="stream-card">
              {isStreaming && remoteStream ? (
                <>
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="video-player"
                  />
                  <p className="status-text">
                    <span role="img" aria-label="satellite">📡</span> Watching stream...
                  </p>
                </>
              ) : localStream ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="video-player"
                  style={{ transform: isFrontCamera ? 'scaleX(-1)' : 'none' }}
                />
              ) : (
                <div className="video-placeholder">
                  <p>Camera not active</p>
                </div>
              )}
              {!isStreaming && (
                <button
                  onClick={requestStreamPermission}
                  disabled={hasRequestedStream}
                  className={`stream-button request ${hasRequestedStream ? 'disabled' : ''}`}
                >
                  {hasRequestedStream ? 'Awaiting Permission...' : (
                    <>
                      <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14m-6 2V8m0 8H6a2 2 0 01-2-2V8a2 2 0 012-2h3" />
                      </svg>
                      Request to Stream
                    </>
                  )}
                </button>
              )}
              {localStream && (
                <div className="control-buttons">
                  <button onClick={toggleMute} className="control-button">
                    <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={isMuted ? 'M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707A1 1 0 0112 5v14a1 1 0 01-1.707.707L5.586 15zM17 9l4 4m0-4l-4 4' : 'M19 11v2a7 7 0 01-7 7m7-9a7 7 0 01-7-7m7 9H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707A1 1 0 0112 5v14a1 1 0 01-1.707.707L5.586 15H4'} />
                    </svg>
                    {isMuted ? 'Unmute' : 'Mute'}
                  </button>
                  <button onClick={switchCamera} className="control-button">
                    <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    Switch Camera
                  </button>
                </div>
              )}
            </div>
          )}

          <button onClick={leaveRoom} className="leave-button">
            <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Leave Room
          </button>
        </div>
      )}
    </div>
  );
};

export default App;