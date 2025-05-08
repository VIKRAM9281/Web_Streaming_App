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
  const [streamRequest, setStreamRequest] = useState(null);
  const [hasRequestedStream, setHasRequestedStream] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnections = useRef({});
  const chatScrollRef = useRef(null);

  useEffect(() => {
    console.log(streamRequest);
    // Socket event handlers
    const handleRoomCreated = () => {
      setJoined(true);
      setIsHost(true);
      setHostId(socket.id);
    };

    const handleRoomJoined = ({hostId, isHostStreaming, viewerCount, viewerList, messages }) => {
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setViewerList(viewerList || []);
      setIsStreaming(isHostStreaming);
      setChatMessages(messages || []);
    };

    const handleRoomInfo = ({ viewerCount, viewerList }) => {
      setViewerCount(viewerCount);
      setViewerList(viewerList || []);
      setStreamStats(prev => ({ ...prev, peakViewers: Math.max(prev.peakViewers, viewerCount) }));
    };

    const handleUserJoined = async (viewerId) => {
      if (!localStreamRef.current) return;

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

        peerConnections.current[viewerId] = peerConnection;
        setViewerList(prev => [...new Set([...prev, viewerId])]);

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        socket.emit('offer', { target: viewerId, sdp: offer });
      } catch (err) {
        console.error('Error handling user joined:', err);
        setError('Failed to connect to viewer.');
      }
    };

    const handleUserLeft = (viewerId) => {
      setViewerList(prev => prev.filter(id => id !== viewerId));
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
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
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
        peerConnectionRef.current = peerConnection;
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
        setStreamRequest({ viewerId });
        if (window.confirm(`Viewer ${viewerId} wants to stream. Allow?`)) {
          socket.emit('stream-permission', { viewerId, allowed: true });
          setStreamRequest(null);
        } else {
          socket.emit('stream-permission', { viewerId, allowed: false });
          setStreamRequest(null);
        }
      }
    };

    const handleStreamPermission = ({ allowed }) => {
      if (allowed) {
        startStreaming();
        setHasRequestedStream(false);
      } else {
        setError('Streaming permission denied by host.');
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

    // Register socket event listeners
    socket.on('room-created', handleRoomCreated);
    socket.on('room-joined', handleRoomJoined);
    socket.on('room-full', () => setError('Room is full. Cannot join.'));
    socket.on('invalid-room', () => setError('Invalid room ID.'));
    socket.on('room-exists', () => setError('Room already exists.'));
    socket.on('room-info', handleRoomInfo);
    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('host-started-streaming', () => setIsStreaming(true));
    socket.on('host-stopped-streaming', () => setIsStreaming(false));
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('stream-request', handleStreamRequest);
    socket.on('stream-permission', handleStreamPermission);
    socket.on('chat-message', handleChatMessage);
    socket.on('reaction', handleReaction);
    socket.on('host-left', () => {
      setError('Host has left the room.');
      setJoined(false);
      setIsStreaming(false);
    });
    socket.on('room-closed', () => {
      setError('Room has been closed.');
      setJoined(false);
      setIsStreaming(false);
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
  }, [isStreaming, isHost]);

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

  const startStreaming = async () => {
    try {
      const constraints = {
        video: { width: streamQuality === '720p' ? 1280 : 640, height: streamQuality === '720p' ? 720 : 360 },
        audio: true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      localStreamRef.current = stream;

      peerConnectionRef.current = new RTCPeerConnection(iceServers);

      stream.getTracks().forEach(track => {
        peerConnectionRef.current.addTrack(track, stream);
      });

      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { target: hostId, candidate: event.candidate });
        }
      };

      socket.emit('host-streaming', roomId);
      setIsStreaming(true);
    } catch (err) {
      console.error('Error starting stream:', err);
      setError('Failed to start streaming. Please check camera/microphone permissions.');
    }
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
    socket.emit('stop-streaming', roomId);
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
    if (isStreaming) {
      stopStreaming();
      setTimeout(startStreaming, 500);
    }
  };

  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsStreaming(false);
    setViewerList([]);
    setRoomId('');
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
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
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
            {isHost && localStreamRef.current ? (
              <video ref={localVideoRef} autoPlay muted className="video" />
            ) : !isHost && isStreaming && remoteVideoRef.current?.srcObject ? (
              <video ref={remoteVideoRef} autoPlay className="video" />
            ) : !isHost && localStreamRef.current ? (
              <video ref={localVideoRef} autoPlay muted className="video" />
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
                  {!isStreaming ? (
                    <button className="action-button" onClick={startStreaming}>
                      Start Stream
                    </button>
                  ) : (
                    <button className="action-button stop-button" onClick={stopStreaming}>
                      Stop Stream
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
                {!isStreaming && (
                  <button
                    className={`action-button ${hasRequestedStream ? 'disabled' : ''}`}
                    onClick={requestStreamPermission}
                    disabled={hasRequestedStream}
                  >
                    {hasRequestedStream ? 'Awaiting Permission...' : 'Request to Stream'}
                  </button>
                )}
                {isStreaming && (
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
                  <div key={id} className="viewer-item">{id}</div>
                ))}
              </div>
            </div>

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