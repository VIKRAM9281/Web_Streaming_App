import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

const socket = io('https://streamingbacknedforwebapp.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

const iceServers = {
  iceServers: [
    {
      urls: "stun:stun.relay.metered.ca:80"
    },
    {
      urls: "turn:in.relay.metered.ca:80",
      username: "92b58ddc6becca9a7458fe50",
      credential: "f0VH3WmLtV6ZANec"
    }
  ],
};

const App = () => {
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isViewerStreaming, setIsViewerStreaming] = useState(false);
  const [error, setError] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [loading, setLoading] = useState(false);
  const [hasRequestedStream, setHasRequestedStream] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [users, setUsers] = useState({});

  const localVideoRef = useRef(null);
  const messageContainerRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnections = useRef({});

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

  useEffect(() => {
    socket.on('room-created', ({ roomId }) => {
      console.log('Room created:', roomId);
      setJoined(true);
      setIsHost(true);
      setHostId(socket.id);
      setLoading(false);
    });

    socket.on('room-joined', ({ roomId, hostId, viewerCount, isHostStreaming, users }) => {
      console.log('Room joined:', roomId);
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setIsStreaming(isHostStreaming);
      setUsers(users);
      setLoading(false);
      requestPermissions(); // Automatically request permissions for voice chat
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

    socket.on('room-info', ({ viewerCount, users }) => {
      setViewerCount(viewerCount);
      setUsers(users);
    });

    socket.on('user-joined', ({ userId, userName }) => {
      setUsers(prev => ({ ...prev, [userId]: userName }));
      if (isHost && localStreamRef.current) {
        const peerConnection = new RTCPeerConnection(iceServers);
        localStreamRef.current.getTracks().forEach(track => {
          peerConnection.addTrack(track, localStreamRef.current);
        });
        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit('ice-candidate', { target: userId, candidate: event.candidate });
          }
        };
        peerConnections.current[userId] = peerConnection;
        if (isStreaming) {
          setTimeout(async () => {
            try {
              const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
              });
              await peerConnection.setLocalDescription(offer);
              socket.emit('offer', { target: userId, sdp: offer });
            } catch (err) {
              console.error('Offer creation error:', err);
            }
          }, 500);
        }
      }
    });

    socket.on('user-left', (userId) => {
      if (peerConnections.current[userId]) {
        peerConnections.current[userId].close();
        delete peerConnections.current[userId];
      }
      setUsers(prev => {
        const newUsers = { ...prev };
        delete newUsers[userId];
        return newUsers;
      });
      setRemoteStreams(prev => {
        const newStreams = { ...prev };
        delete newStreams[userId];
        return newStreams;
      });
    });

    socket.on('host-started-streaming', () => {
      setIsStreaming(true);
      const peerConnection = new RTCPeerConnection(iceServers);
      peerConnection.ontrack = (event) => {
        const stream = event.streams[0];
        setRemoteStreams(prev => ({ ...prev, [hostId]: stream }));
      };
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { target: hostId, candidate: event.candidate });
        }
      };
      peerConnections.current[hostId] = peerConnection;
    });

    socket.on('ice-candidate', async ({ candidate, sender }) => {
      const pc = peerConnections.current[sender];
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('ICE candidate error:', err);
        }
      }
    });

    socket.on('offer', async ({ sdp, sender }) => {
      const peerConnection = new RTCPeerConnection(iceServers);
      peerConnection.ontrack = (event) => {
        const stream = event.streams[0];
        setRemoteStreams(prev => ({ ...prev, [sender]: stream }));
      };
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { target: sender, candidate: event.candidate });
        }
      };
      peerConnections.current[sender] = peerConnection;
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { target: sender, sdp: answer });
      } catch (err) {
        console.error('Offer handling error:', err);
      }
    });

    socket.on('answer', async ({ sdp, sender }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (err) {
          console.error('Answer handling error:', err);
        }
      }
    });

    socket.on('host-left', () => {
      setError('Host has left the room.');
      setJoined(false);
      setIsStreaming(false);
      setRemoteStreams({});
    });

    socket.on('room-closed', () => {
      setError('Room has been closed.');
      setJoined(false);
      setIsStreaming(false);
      setRemoteStreams({});
    });

    socket.on('new-message', ({ sender, message }) => {
      setMessages(prev => [...prev, { sender, message }]);
    });

    socket.on('stream-permission', ({ allowed }) => {
      if (allowed) {
        startStreaming();
        setHasRequestedStream(false);
        setIsViewerStreaming(true);
      } else {
        setError('Streaming permission denied by host.');
        setHasRequestedStream(false);
      }
    });

    return () => {
      socket.removeAllListeners();
    };
  }, [isHost, isStreaming, hostId]);

  useEffect(() => {
    if (messageContainerRef.current) {
      messageContainerRef.current.scrollTop = messageContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const createRoom = () => {
    if (roomId.trim() === '' || userName.trim() === '') {
      setError('Please enter a room ID and your name.');
      return;
    }
    setLoading(true);
    socket.emit('create-room', { roomId, userName });
  };

  const joinRoom = () => {
    if (roomId.trim() === '' || userName.trim() === '') {
      setError('Please enter a room ID and your name.');
      return;
    }
    setLoading(true);
    socket.emit('join-room', { roomId, userName });
  };

  const requestStreamPermission = () => {
    socket.emit('stream-request', { roomId, viewerId: socket.id });
    setHasRequestedStream(true);
  };

  const startStreaming = async () => {
    const stream = await requestPermissions();
    if (!stream) return;
    const peerConnection = new RTCPeerConnection(iceServers);
    stream.getTracks().forEach(track => {
      peerConnection.addTrack(track, stream);
    });
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { target: hostId, candidate: event.candidate });
      }
    };
    peerConnections.current[hostId] = peerConnection;
    if (isHost) {
      socket.emit('host-streaming', roomId);
      setIsStreaming(true);
    }
  };

  const stopStreaming = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      localStreamRef.current = null;
    }
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
    setIsStreaming(false);
    setIsViewerStreaming(false);
    socket.emit('stop-streaming', roomId);
  };

  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsStreaming(false);
    setIsViewerStreaming(false);
    setRoomId('');
    setUserName('');
    setError('');
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      localStreamRef.current = null;
    }
    setRemoteStreams({});
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      if (audioTracks.length === 0) {
        setError('No audio input available. Check microphone permissions.');
        return;
      }
      audioTracks.forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(prev => !prev);
    } else {
      setError('No active stream. Please enable microphone first.');
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
        } catch (err) {
          console.error('Switch camera error:', err);
          setError('Failed to switch camera.');
        }
      }
    }
  };

  const sendMessage = (e) => {
    e.preventDefault();
    if (newMessage.trim()) {
      socket.emit('send-message', newMessage);
      setNewMessage('');
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
            placeholder="Enter Your Name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            className="room-input"
          />
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
              <p>Name: <span className="highlight">{userName}</span></p>
            </div>
            <p className="viewer-count">
              <span role="img" aria-label="eye">👁️</span> Viewers: <span className="highlight">{viewerCount}</span>
            </p>
          </div>

          <div className="video-chat-container">
            <div className="video-container">
              {localStream && (
                <div className="video-card">
                  <h3>{userName} (You)</h3>
                  <div className="video-wrapper">
                    <video
                      ref={localVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="video-player"
                      style={{ transform: isFrontCamera ? 'scaleX(-1)' : 'none' }}
                    />
                    <div className={`mute-indicator ${isMuted ? 'muted' : ''}`}>
                      <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={isMuted ? 'M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707A1 1 0 0112 5v14a1 1 0 01-1.707.707L5.586 15zM17 9l4 4m0-4l-4 4' : 'M19 11v2a7 7 0 01-7 7m7-9a7 7 0 01-7-7m7 9H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707A1 1 0 0112 5v14a1 1 0 01-1.707.707L5.586 15H4'} />
                      </svg>
                    </div>
                  </div>
                </div>
              )}
              {Object.entries(remoteStreams).map(([userId, stream]) => (
                <div key={userId} className="video-card">
                  <h3>{users[userId] || 'Unknown'}</h3>
                  <div className="video-wrapper">
                    <video
                      autoPlay
                      playsInline
                      className="video-player"
                      ref={(video) => {
                        if (video && stream) {
                          video.srcObject = stream;
                          video.play().catch(err => console.error('Video play error:', err));
                        }
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="chat-container">
              <div className="chat-header">Chat</div>
              <div className="message-container" ref={messageContainerRef}>
                {messages.map((msg, index) => (
                  <div key={index} className={`message ${msg.sender === socket.id ? 'sent' : 'received'}`}>
                    <span className="sender">{users[msg.sender] || 'Unknown'}: </span>
                    <span>{msg.message}</span>
                  </div>
                ))}
              </div>
              <form onSubmit={sendMessage} className="message-form">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type a message..."
                  className="message-input"
                />
                <button type="submit" className="send-button">
                  Send
                </button>
              </form>
            </div>
          </div>

          <div className="control-buttons">
            <button onClick={toggleMute} className="control-button">
              <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={isMuted ? 'M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707A1 1 0 0112 5v14a1 1 0 01-1.707.707L5.586 15zM17 9l4 4m0-4l-4 4' : 'M19 11v2a7 7 0 01-7 7m7-9a7 7 0 01-7-7m7 9H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707A1 1 0 0112 5v14a1 1 0 01-1.707.707L5.586 15H4'} />
              </svg>
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
            {(isHost || isViewerStreaming) && (
              <button onClick={switchCamera} className="control-button">
                <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                Switch Camera
              </button>
            )}
            {isHost ? (
              <>
                {!isStreaming ? (
                  <button onClick={startStreaming} className="stream-button start">
                    Start Streaming
                  </button>
                ) : (
                  <button onClick={stopStreaming} className="stream-button stop">
                    Stop Streaming
                  </button>
                )}
              </>
            ) : (
              !isViewerStreaming && (
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
              )
            )}
            <button onClick={leaveRoom} className="leave-button">
              Leave Room
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;