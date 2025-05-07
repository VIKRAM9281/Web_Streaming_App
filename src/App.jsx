import React, { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import './App.css';

const socket = io('https://streamingbackend-eh65.onrender.com', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

function App() {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState('');
  const [viewerCount, setViewerCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');
  const [viewers, setViewers] = useState([]);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnections = useRef({});
  useEffect(() => {
    // Handle room creation confirmation
    socket.on('room-created', ({ roomId }) => {
      console.log(`Room ${roomId} created`);
      setJoined(true);
      setIsHost(true);
      setHostId(socket.id);
    });

    // Handle room join confirmation
    socket.on('room-joined', ({ roomId, hostId, isHostStreaming, viewerCount }) => {
      console.log(`Joined room ${roomId}`);
      setJoined(true);
      setIsHost(false);
      setHostId(hostId);
      setViewerCount(viewerCount);
      setIsStreaming(isHostStreaming);
    });

    // Handle room full error
    socket.on('room-full', () => {
      setError('Room is full. Cannot join.');
    });

    // Handle invalid room error
    socket.on('invalid-room', () => {
      setError('Invalid room ID.');
    });

    // Handle room already exists error
    socket.on('room-exists', () => {
      setError('Room already exists.');
    });

    // Handle room info updates
    socket.on('room-info', ({ viewerCount }) => {
      setViewerCount(viewerCount);
    });

    // Handle user joined notification
    socket.on('user-joined',async (viewerId) => {
      setViewers((prev) => [...prev, viewerId]);
      const peerConnection = new RTCPeerConnection();

      // Add local stream tracks to the peer connection
      localStreamRef.current.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStreamRef.current);
      });
    
      // Handle ICE candidates
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            target: viewerId,
            candidate: event.candidate,
          });
        }
      };
    
      // Save peer connection
      peerConnections.current[viewerId] = peerConnection;
    
      // Create and send offer
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
    
      socket.emit('offer', {
        target: viewerId,
        sdp: offer,
      });
    });

    // Handle user left notification
    socket.on('user-left', (viewerId) => {
      setViewers((prev) => prev.filter((id) => id !== viewerId));
    });

    // Handle host started streaming
    socket.on('host-started-streaming', () => {
      setIsStreaming(true);
    });

    // Handle ICE candidates
    socket.on('ice-candidate', ({ candidate, sender }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    // Handle offer from the host
    socket.on('offer', async ({ sdp, sender }) => {
      const peerConnection = new RTCPeerConnection();
    
      peerConnection.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      };
    
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            target: sender,
            candidate: event.candidate,
          });
        }
      };
    
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
    
      socket.emit('answer', {
        target: sender,
        sdp: answer,
      });
    
      peerConnectionRef.current = peerConnection;
    });
    

    // Handle answer from the viewer
    socket.on('answer', async ({ sdp, sender }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
    });

    // Handle remote stream
    socket.on('remote-stream', (stream) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
    });

    // Handle host left
    socket.on('host-left', () => {
      setError('Host has left the room.');
      setJoined(false);
      setIsStreaming(false);
    });

    // Handle room closed
    socket.on('room-closed', () => {
      setError('Room has been closed.');
      setJoined(false);
      setIsStreaming(false);
    });

    return () => {
      socket.off('room-created');
      socket.off('room-joined');
      socket.off('room-full');
      socket.off('invalid-room');
      socket.off('room-exists');
      socket.off('room-info');
      socket.off('user-joined');
      socket.off('user-left');
      socket.off('host-started-streaming');
      socket.off('ice-candidate');
      socket.off('offer');
      socket.off('answer');
      socket.off('remote-stream');
      socket.off('host-left');
      socket.off('room-closed');
    };
  }, []);

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
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideoRef.current.srcObject = stream;
      localStreamRef.current = stream;

      // Initialize peer connection
      peerConnectionRef.current = new RTCPeerConnection();

      // Add tracks to peer connection
      stream.getTracks().forEach((track) => {
        peerConnectionRef.current.addTrack(track, stream);
      });

      // Handle ICE candidates
      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            target: hostId,
            candidate: event.candidate,
          });
        }
      };

      // Handle remote stream
      peerConnectionRef.current.ontrack = (event) => {
        socket.emit('remote-stream', event.streams[0]); // Send stream to viewers
      };

      // Create offer
      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);

      // Send offer to server
      socket.emit('offer', {
        target: hostId,
        sdp: offer,
      });

      // Notify server that host started streaming
      socket.emit('host-streaming', roomId);
    } catch (err) {
      console.error('Error starting stream:', err);
      setError('Failed to start streaming.');
    }
  };

  const leaveRoom = () => {
    socket.emit('leave-room');
    setJoined(false);
    setIsStreaming(false);
    setViewers([]);
    setRoomId('');
    if (localVideoRef.current && localVideoRef.current.srcObject) {
      localVideoRef.current.srcObject.getTracks().forEach((track) => track.stop());
    }
    if (remoteVideoRef.current && remoteVideoRef.current.srcObject) {
      remoteVideoRef.current.srcObject.getTracks().forEach((track) => track.stop());
    }
  };

  return (
    <div className="App">
      <h1>Live Streaming App</h1>
      {!joined ? (
        <div className="input-section">
          <input
            type="text"
            placeholder="Enter Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="input"
          />
          <div className="button-row">
            <button onClick={createRoom}>Create Room</button>
            <button onClick={joinRoom}>Join Room</button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      ) : (
        <div className="stream-section">
          <p>
            Room ID: <strong>{roomId}</strong>
          </p>
          <p>
            You are the <strong>{isHost ? 'Host' : 'Viewer'}</strong>
          </p>
          <p>
            Viewers: <strong>{viewerCount}</strong> / 5
          </p>
          {isHost && (
            <div>
              <video ref={localVideoRef} autoPlay muted className="video" />
              {!isStreaming ? (
                <button onClick={startStreaming}>Start Streaming</button>
              ) : (
                <p>Streaming...</p>
              )}
              <h3>Viewers:</h3>
              <ul>
                {viewers.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </div>
          )}
          {!isHost && isStreaming && (
            <div>
              <video ref={remoteVideoRef} autoPlay className="video" />
              <p>Watching the stream...</p>
            </div>
          )}
          <button onClick={leaveRoom}>Leave Room</button>
        </div>
      )}
    </div>
  );
}

export default App;
