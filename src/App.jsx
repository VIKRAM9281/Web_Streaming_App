import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import './App.css';

// Socket connection
const socket = io('https://streamingbackend-eh65.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

// STUN/TURN server configuration
const iceServers = {
  iceServers: [
    {
      urls: 'turn:coturn.streamalong.live:3478?transport=udp',
      username: 'vikram',
      credential: 'vikram',
    },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

function App() {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [reactions, setReactions] = useState([]);
  const [streamQuality, setStreamQuality] = useState('720p');
  const [viewerList, setViewerList] = useState([]);
  const [streamStats, setStreamStats] = useState({ duration: 0, peakViewers: 0 });
  const [hasRequestedStream, setHasRequestedStream] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [approvedStreamers, setApprovedStreamers] = useState([]);

  const localVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnections = useRef({});
  const chatScrollRef = useRef(null);

  // Start audio stream (and video for host)
  const startAudioStream = async () => {
    try {
      const constraints = {
        audio: true,
        video: isHost ? { width: streamQuality === '720p' ? 1280 : 640, height: streamQuality === '720p' ? 720 : 360 } : false,
      };
      console.log('Requesting media with constraints:', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('Got stream:', stream);

      if (isHost && localVideoRef.current) {
        console.log('Assigning stream to local video element');
        localVideoRef.current.srcObject = stream;
      }
      localStreamRef.current = stream;

      // Create WebRTC peer connection
      peerConnectionRef.current = new RTCPeerConnection(iceServers);
      console.log('Created peer connection:', peerConnectionRef.current);

      stream.getTracks().forEach(track => {
        console.log('Adding track:', track);
        peerConnectionRef.current.addTrack(track, stream);
      });

      // Handle ICE candidates
      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('ICE candidate generated:', event.candidate);
          viewerList.forEach(viewerId => {
            if (viewerId !== socket.id) {
              socket.emit('ice-candidate', { target: viewerId, candidate: event.candidate });
            }
          });
        }
      };

      // Monitor connection state
      peerConnectionRef.current.onconnectionstatechange = () => {
        console.log('Peer connection state:', peerConnectionRef.current.connectionState);
        if (peerConnectionRef.current.connectionState === 'failed') {
          setError('WebRTC connection failed. Please try again.');
        }
      };

      if (isHost) {
        console.log('Emitting host-streaming for room:', roomId);
        socket.emit('host-streaming', roomId);
        setIsStreaming(true);
      }
    } catch (err) {
      console.error('Audio stream error:', err.name, err.message);
      setError(`Failed to start audio stream: ${err.message}`);
    }
  };

  // Start video stream for approved viewers
  const startVideoStream = async () => {
    try {
      const constraints = {
        video: { width: streamQuality === '720p' ? 1280 : 640, height: streamQuality === '720p' ? 720 : 360 },
        audio: true,
      };
      console.log('Requesting video stream with constraints:', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (localVideoRef.current) {
        console.log('Assigning video stream to local video element');
        localVideoRef.current.srcObject = stream;
      }
      localStreamRef.current = stream;

      peerConnectionRef.current = new RTCPeerConnection(iceServers);
      stream.getTracks().forEach(track => {
        peerConnectionRef.current.addTrack(track, stream);
      });

      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          viewerList.forEach(viewerId => {
            if (viewerId !== socket.id) {
              socket.emit('ice-candidate', { target: viewerId, candidate: event.candidate });
            }
          });
        }
      };

      console.log('Emitting user-started-streaming for room:', roomId);
      socket.emit('user-started-streaming', { roomId, streamerId: socket.id });
      setIsStreaming(true);
    } catch (err) {
      console.error('Video stream error:', err.name, err.message);
      setError(`Failed to start video stream: ${err.message}`);
      setHasRequestedStream(false);
    }
  };

  // Socket and WebRTC event handlers
  useEffect(() => {
    // Start stream when host joins
    if (isHost && joined && !isStreaming) {
      startAudioStream();
    }

    // Handle socket reconnection
    const handleReconnect = () => {
      console.log('Reconnected to server');
      if (roomId && joined) {
        socket.emit(isHost ? 'create-room' : 'join-room', roomId);
      }
    };

    // Socket event handlers
    const handleRoomCreated = () => {
      console.log('Room created:', roomId);
      setJoined(true);
      setIsHost(true);
      setHostId(socket.id);
      setViewerCount(1); // Host is the first viewer
    };

    const handleRoomJoined = ({ hostId, isHostStreaming, viewerCount, viewerList, messages }) => {
      console.log('Room joined data:', { hostId, isHostStreaming, viewerCount, viewerList, messages });
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(Number(viewerCount) || 0);
      setViewerList(viewerList || []);
      setIsStreaming(isHostStreaming);
      setChatMessages(messages || []);
      startAudioStream();
    };

    const handleRoomInfo = ({ viewerCount, viewerList }) => {
      console.log('Room info data:', { viewerCount, viewerList });
      setViewerCount(Number(viewerCount) || 0);
      setViewerList(viewerList || []);
      setStreamStats(prev => ({
        ...prev,
        peakViewers: Math.max(Number(prev.peakViewers) || 0, Number(viewerCount) || 0),
      }));
    };

    const handleUserJoined = async (viewerId) => {
      if (viewerId === socket.id || !localStreamRef.current) {
        console.warn('User joined but local stream not ready or self');
        return;
      }

      try {
        const peerConnection = new RTCPeerConnection(iceServers);
        localStreamRef.current.getTracks().forEach(track => {
          peerConnection.addTrack(track, localStreamRef.current);
        });

        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit('ice-candidate', { target: viewerId, candidate: event.candidate });
          }
        };

        peerConnection.ontrack = (event) => {
          setRemoteStreams(prev => {
            const existing = prev.find(s => s.id === viewerId);
            if (!existing) {
              console.log(`Adding stream from ${viewerId}`);
              return [...prev, { id: viewerId, stream: event.streams[0], isVideo: event.streams[0].getVideoTracks().length > 0 }];
            }
            return prev;
          });
        };

        peerConnections.current[viewerId] = peerConnection;

        const offer = await peerConnection.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await peerConnection.setLocalDescription(offer);
        socket.emit('offer', { target: viewerId, sdp: offer });
      } catch (err) {
        console.error('Error handling user joined:', err);
        setError('Failed to connect to viewer.');
      }
    };

    const handleUserLeft = (viewerId) => {
      console.log('User left:', viewerId);
      setViewerList(prev => prev.filter(id => id !== viewerId));
      setApprovedStreamers(prev => prev.filter(s => s !== viewerId));
      setRemoteStreams(prev => prev.filter(s => s.id !== viewerId));
      if (peerConnections.current[viewerId]) {
        peerConnections.current[viewerId].close();
        delete peerConnections.current[viewerId];
      }
    };

    const handleIceCandidate = async ({ candidate, sender }) => {
      try {
        const pc = peerConnections.current[sender] || peerConnectionRef.current;
        if (pc && candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    };

    const handleOffer = async ({ sdp, sender }) => {
      try {
        const peerConnection = new RTCPeerConnection(iceServers);

        peerConnection.ontrack = (event) => {
          setRemoteStreams(prev => {
            const existing = prev.find(s => s.id === sender);
            if (!existing) {
              console.log(`Adding stream from ${sender}`);
              return [...prev, { id: sender, stream: event.streams[0], isVideo: event.streams[0].getVideoTracks().length > 0 }];
            }
            return prev;
          });
        };

        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit('ice-candidate', { target: sender, candidate: event.candidate });
          }
        };

        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { target: sender, sdp: answer });
        peerConnections.current[sender] = peerConnection;
      } catch (err) {
        console.error('Error handling offer:', err);
        setError('Failed to establish stream connection.');
      }
    };

    const handleAnswer = async ({ sdp, sender }) => {
      try {
        const pc = peerConnections.current[sender];
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        }
      } catch (err) {
        console.error('Error handling answer:', err);
      }
    };

    const handleStreamRequest = ({ viewerId }) => {
      if (isHost) {
        if (window.confirm(`Viewer ${viewerId} wants to stream video. Allow?`)) {
          socket.emit('stream-permission', { viewerId, allowed: true });
        } else {
          socket.emit('stream-permission', { viewerId, allowed: false });
        }
      }
    };

    const handleStreamPermission = ({ allowed }) => {
      if (allowed) {
        startVideoStream();
        setHasRequestedStream(false);
      } else {
        setError('Video streaming permission denied by host.');
        setHasRequestedStream(false);
      }
    };

    const handleChatMessage = ({ senderId, message }) => {
      setChatMessages(prev => [...prev, { id: `${senderId}-${Date.now()}`, senderId, message }]);
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    };

    const handleReaction = ({ senderId, type }) => {
      const reactionId = `${senderId}-${Date.now()}`;
      setReactions(prev => [...prev, { id: reactionId, senderId, type }]);
      setTimeout(() => {
        setReactions(prev => prev.filter(r => r.id !== reactionId));
      }, 1000);
    };

    const handleUserStartedStreaming = ({ streamerId }) => {
      setApprovedStreamers(prev => [...new Set([...prev, streamerId])]);
    };

    // Register socket event listeners
    socket.on('reconnect', handleReconnect);
    socket.on('room-created', handleRoomCreated);
    socket.on('room-joined', handleRoomJoined);
    socket.on('room-full', () => setError('Room is full. Cannot join.'));
    socket.on('invalid-room', () => setError('Invalid room ID.'));
    socket.on('room-exists', () => setError('Room already exists.'));
    socket.on('room-info', handleRoomInfo);
    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('host-started-streaming', () => setIsStreaming(true));
    socket.on('host-stopped-streaming', () => {
      setIsStreaming(false);
      setRemoteStreams(prev => prev.filter(s => s.id !== hostId));
    });
    socket.on('user-started-streaming', handleUserStartedStreaming);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('stream-request', handleStreamRequest);
    socket.on('stream-permission', handleStreamPermission);
    socket.on('chat-message', handleChatMessage);
    socket.on('reaction', handleReaction);
    socket.on('host-left', () => {
      setError('Host has left the room.');
      leaveRoom();
    });
    socket.on('room-closed', () => {
      setError('Room has been closed.');
      leaveRoom();
    });

    // Stream stats interval
    const statsInterval = setInterval(() => {
      if (isStreaming) {
        setStreamStats(prev => ({ ...prev, duration: prev.duration + 1 }));
      }
    }, 1000);

    // Cleanup on unmount
    return () => {
      clearInterval(statsInterval);
      socket.off('reconnect', handleReconnect);
      socket.off('room-created', handleRoomCreated);
      socket.off('room-joined', handleRoomJoined);
      socket.off('room-full');
      socket.off('invalid-room');
      socket.off('room-exists');
      socket.off('room-info', handleRoomInfo);
      socket.off('user-joined', handleUserJoined);
      socket.off('user-left', handleUserLeft);
      socket.off('host-started-streaming');
      socket.off('host-stopped-streaming');
      socket.off('user-started-streaming', handleUserStartedStreaming);
      socket.off('ice-candidate', handleIceCandidate);
      socket.off('offer', handleOffer);
      socket.off('answer', handleAnswer);
      socket.off('stream-request', handleStreamRequest);
      socket.off('stream-permission', handleStreamPermission);
      socket.off('chat-message', handleChatMessage);
      socket.off('reaction', handleReaction);
      socket.off('host-left');
      socket.off('room-closed');

      // Clean up WebRTC resources
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
    };
  }, [isHost, joined, isStreaming, hostId, roomId, viewerList]);

  const createRoom = () => {
    if (roomId.trim() === '') {
      setError('Please enter a room ID.');
      return;
    }
    socket.emit('create-room', roomId);
  };

  const joinRoom = () => {
    if (roomId.trim() === '') {
      setError('Please enter a room ID.');
      return;
    }
    socket.emit('join-room', roomId);
  };

  const stopStreaming = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    setIsStreaming(false);
    if (isHost) {
      socket.emit('stop-streaming', roomId);
    }
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(prev => !prev);
    }
  };

  const requestStreamPermission = () => {
    socket.emit('stream-request', { roomId, viewerId: socket.id });
    setHasRequestedStream(true);
  };

  const sendChatMessage = () => {
    if (chatInput.trim() === '') return;
    socket.emit('chat-message', { roomId, message: chatInput });
    setChatInput('');
  };

  const sendReaction = (type) => {
    socket.emit('reaction', { roomId, type });
  };

  const changeStreamQuality = (quality) => {
    setStreamQuality(quality);
    if (isStreaming && (isHost || approvedStreamers.includes(socket.id))) {
      stopStreaming();
      setTimeout(startVideoStream, 500);
    }
  };

  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsHost(false);
    setIsStreaming(false);
    setViewerList([]);
    setApprovedStreamers([]);
    setRemoteStreams([]);
    setRoomId('');
    setHostId('');
    setChatMessages([]);
    setReactions([]);
    setStreamStats({ duration: 0, peakViewers: 0 });
    setHasRequestedStream(false);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
  };

  return (
    <div className="app">
      {!joined ? (
        <div className="join-container">
          <h1 className="title">LiveStream</h1>
          <input
            type="text"
            placeholder="Enter Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="input"
          />
          <div className="button-container">
            <button onClick={createRoom} className="button">Create Room</button>
            <button onClick={joinRoom} className="button">Join Room</button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      ) : (
        <div className="stream-container">
          <div className="video-container">
            {isHost && localStreamRef.current && localStreamRef.current.getVideoTracks().length > 0 ? (
              <video ref={localVideoRef} autoPlay muted className="video" />
            ) : remoteStreams.find(s => s.id === hostId && s.isVideo) ? (
              <video
                srcObject={remoteStreams.find(s => s.id === hostId).stream}
                autoPlay
                className="video"
              />
            ) : (
              <div className="video-placeholder">
                <p>{isStreaming ? 'Waiting for stream...' : 'No stream active'}</p>
              </div>
            )}
            <div className="video-overlay">
              <div className="top-bar">
                <span>Room: {roomId}</span>
                <span>👥 {viewerCount}</span>
              </div>
              {reactions.map(reaction => (
                <span key={reaction.id} className="reaction">
                  {reaction.type === 'like' ? '👍' : '❤️'}
                </span>
              ))}
            </div>
          </div>

          <div className="content-container">
            {isHost ? (
              <div className="host-controls">
                <div className="control-row">
                  <button className="control-button" onClick={toggleMute}>
                    {isMuted ? '🔇 Unmute' : '🔈 Mute'}
                  </button>
                  {!isStreaming ? (
                    <button className="action-button" onClick={startVideoStream}>
                      Start Video Stream
                    </button>
                  ) : (
                    <button className="action-button stop-button" onClick={stopStreaming}>
                      Stop Video Stream
                    </button>
                  )}
                </div>
                <div className="stats-container">
                  <p>Duration: {Math.floor(streamStats.duration / 60)}:{(streamStats.duration % 60).toString().padStart(2, '0')}</p>
                  <p>Peak Viewers: {streamStats.peakViewers}</p>
                </div>
              </div>
            ) : (
              <div className="viewer-controls">
                <div className="control-row">
                  <button className="control-button" onClick={toggleMute}>
                    {isMuted ? '🔇 Unmute' : '🔈 Mute'}
                  </button>
                  <button
                    className={`action-button ${hasRequestedStream ? 'disabled' : ''}`}
                    onClick={requestStreamPermission}
                    disabled={hasRequestedStream}
                  >
                    {hasRequestedStream ? 'Awaiting Video Permission...' : 'Request to Stream Video'}
                  </button>
                </div>
                {(isStreaming || approvedStreamers.includes(socket.id)) && (
                  <div className="quality-selector">
                    <span>Quality:</span>
                    {['720p', '480p'].map(quality => (
                      <button
                        key={quality}
                        className={`quality-button ${streamQuality === quality ? 'active' : ''}`}
                        onClick={() => changeStreamQuality(quality)}
                      >
                        {quality}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="chat-container">
              <div className="chat-list" ref={chatScrollRef}>
                {chatMessages.map(msg => (
                  <div key={msg.id} className="chat-message">
                    <span className="chat-sender">{msg.senderId}: </span>
                    <span>{msg.message}</span>
                  </div>
                ))}
              </div>
              <div className="chat-input-container">
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  className="chat-input"
                  onKeyPress={(e) => e.key === 'Enter' && sendChatMessage()}
                />
                <button className="send-button" onClick={sendChatMessage}>Send</button>
              </div>
            </div>

            <div className="viewer-list-container">
              <h3>Viewers</h3>
              <div className="viewer-list">
                {viewerList.map(id => (
                  <div key={id} className="viewer-item">
                    {id}
                    {remoteStreams.find(s => s.id === id && s.stream.getAudioTracks().length > 0) && (
                      <span className="speaking-indicator">🎙️</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {approvedStreamers.length > 0 && (
              <div className="streams-container">
                <h3>Users' Stream Video</h3>
                <div className="streams-list">
                  {remoteStreams
                    .filter(s => s.id !== hostId && s.isVideo)
                    .map(s => (
                      <div key={s.id} className="stream-item">
                        <video srcObject={s.stream} autoPlay className="stream-video" />
                        <span className="streamer-id">{s.id}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {isStreaming && (
              <div className="reaction-container">
                <button className="reaction-button" onClick={() => sendReaction('like')}>
                  👍
                </button>
                <button className="reaction-button" onClick={() => sendReaction('heart')}>
                  ❤️
                </button>
              </div>
            )}
          </div>

          <button className="leave-button" onClick={leaveRoom}>Leave Room</button>
        </div>
      )}
    </div>
  );
}

export default App;