import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { handleOffer, initPeerConnection, sendFile } from "./lib/peer.js";
import FileTransferToast from "./components/FileTransferToast.jsx";
import FileTransferProgress from "./components/FileTransferProgress.jsx";
import SendingQueue from "./components/SendingQueue.jsx";

const DEFAULT_WS_URL = "ws://localhost:4000";

const getWsUrl = () => import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL;

function App() {
  const [deviceName, setDeviceName] = useState(null);
  const [availablePeers, setAvailablePeers] = useState([]);
  const [isLoadingPeers, setIsLoadingPeers] = useState(true);
  const [selectedPeerId, setSelectedPeerId] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [connectionStates, setConnectionStates] = useState({});
  const [incomingFileRequest, setIncomingFileRequest] = useState(null);
  const [receivingFileProgress, setReceivingFileProgress] = useState(null);
  const [sendingQueue, setSendingQueue] = useState([]);
  const [currentSendingFile, setCurrentSendingFile] = useState(null);

  const socketRef = useRef(null);
  const peersRef = useRef({});
  const myIdRef = useRef(null);
  const fileInputRef = useRef(null);

  const selectedPeer = useMemo(
    () => availablePeers.find((peer) => peer.id === selectedPeerId) ?? null,
    [availablePeers, selectedPeerId]
  );

  const updateConnectionState = useCallback((peerId, state) => {
    setConnectionStates((prev) => ({ ...prev, [peerId]: state }));

    if (state === "failed" || state === "closed") {
      delete peersRef.current[peerId];
    }
  }, []);

  const triggerFileDownload = useCallback(({ name, blob }) => {
    const fileName = name || "received_file";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    setStatusMessage(`Received "${fileName}"`);
    
    // Clear progress after download
    setTimeout(() => {
      setReceivingFileProgress(null);
    }, 1000);
  }, []);

  const handleIncomingFileRequest = useCallback((metadata, onAccept, onReject) => {
    setIncomingFileRequest({
      fileName: metadata.name,
      fileSize: metadata.size,
      totalChunks: metadata.totalChunks,
      onAccept,
      onReject,
    });
  }, []);

  const handleAcceptFile = useCallback(() => {
    if (incomingFileRequest?.onAccept) {
      incomingFileRequest.onAccept();
      setStatusMessage(`Accepting file "${incomingFileRequest.fileName}"...`);
      
      // Initialize progress tracking
      setReceivingFileProgress({
        fileName: incomingFileRequest.fileName,
        progress: 0,
        receivedBytes: 0,
        totalBytes: incomingFileRequest.fileSize,
        receivedChunks: 0,
        totalChunks: incomingFileRequest.totalChunks,
      });
    }
    setIncomingFileRequest(null);
  }, [incomingFileRequest]);

  const handleRejectFile = useCallback(() => {
    if (incomingFileRequest?.onReject) {
      incomingFileRequest.onReject();
      setStatusMessage(`Rejected file "${incomingFileRequest.fileName}"`);
    }
    setIncomingFileRequest(null);
  }, [incomingFileRequest]);

  const handleReceiveProgress = useCallback((progressData) => {
    if (progressData.direction === "inbound") {
      const progress = (progressData.receivedBytes / progressData.totalBytes) * 100;
      setReceivingFileProgress({
        fileName: progressData.metadata.name,
        progress,
        receivedBytes: progressData.receivedBytes,
        totalBytes: progressData.totalBytes,
        receivedChunks: progressData.receivedChunks,
        totalChunks: progressData.totalChunks,
      });
    }
  }, []);

  const registerPeer = useCallback(
    (peerId, peerObj) => {
      peersRef.current[peerId] = peerObj;

      if (peerObj.peer) {
        const handleStateChange = () => {
          updateConnectionState(peerId, peerObj.peer.connectionState);
        };

        peerObj.peer.onconnectionstatechange = handleStateChange;
        handleStateChange();
      }
    },
    [updateConnectionState]
  );

  const handleSocketMessage = useCallback(
    (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case "init": {
            myIdRef.current = message.id;
            setDeviceName(message.name ?? "Device-???");
            break;
          }

          case "users": {
            setIsLoadingPeers(false);
            setAvailablePeers(message.users ?? []);
            break;
          }

          case "offer": {
            if (!socketRef.current) return;

            handleOffer({
              socket: socketRef.current,
              fromId: message.from,
              offer: message.offer,
              registerPeer,
              onFileReceived: triggerFileDownload,
              onFileRequest: handleIncomingFileRequest,
              onProgress: handleReceiveProgress,
            });
            break;
          }

          case "answer":
          case "ice": {
            const peer = peersRef.current[message.from];

            if (peer?.handleSignal) {
              peer
                .handleSignal(message)
                .catch((error) =>
                  console.error(`Error handling ${message.type}`, error)
                );
            }
            break;
          }

          default:
            console.warn("Unhandled message type", message);
        }
      } catch (error) {
        console.error("Failed to process signaling message", error);
      }
    },
    [registerPeer, triggerFileDownload, handleIncomingFileRequest, handleReceiveProgress]
  );

  useEffect(() => {
    const socket = new WebSocket(getWsUrl());

    socketRef.current = socket;
    setIsLoadingPeers(true);
    setStatusMessage("Connecting to signaling server...");

    socket.addEventListener("message", handleSocketMessage);
    socket.addEventListener("open", () => {
      setStatusMessage("Connected. Searching for devices...");
    });
    socket.addEventListener("close", () => {
      setStatusMessage("Disconnected from signaling server");
    });
    socket.addEventListener("error", (event) => {
      console.error("WebSocket error", event);
      setStatusMessage("Error communicating with signaling server");
    });

    return () => {
      socket.removeEventListener("message", handleSocketMessage);
      socket.close();
      socketRef.current = null;
    };
  }, [handleSocketMessage]);

  useEffect(() => {
    if (!selectedPeerId) return;

    const stillAvailable = availablePeers.some(
      (peer) => peer.id === selectedPeerId
    );
    if (!stillAvailable) {
      setSelectedPeerId(null);
    }
  }, [availablePeers, selectedPeerId]);

  const handlePeerSelection = useCallback(
    (peer) => {
      setSelectedPeerId(peer.id);
      setStatusMessage(`Connecting to ${peer.name}...`);

      if (
        !socketRef.current ||
        socketRef.current.readyState !== WebSocket.OPEN
      ) {
        setStatusMessage("Signaling server is not connected");
        return;
      }

      if (peersRef.current[peer.id]) {
        setStatusMessage(`Ready to send files to ${peer.name}`);
        return;
      }

      updateConnectionState(peer.id, "connecting");

      initPeerConnection({
        socket: socketRef.current,
        targetId: peer.id,
        registerPeer,
        onFileReceived: triggerFileDownload,
        onFileRequest: handleIncomingFileRequest,
        onProgress: handleReceiveProgress,
      }).catch((error) => {
        console.error("Failed to start peer connection", error);
        setStatusMessage(`Unable to connect to ${peer.name}`);
        updateConnectionState(peer.id, "failed");
      });
    },
    [registerPeer, triggerFileDownload, handleIncomingFileRequest, handleReceiveProgress, updateConnectionState]
  );

  const handleSendButtonClick = useCallback(() => {
    if (!selectedPeer) {
      setStatusMessage("Select a device to send files");
      return;
    }

    fileInputRef.current?.click();
  }, [selectedPeer]);

  const handleFileInputChange = useCallback(
    async (event) => {
      const files = Array.from(event.target.files || []);
      if (files.length === 0 || !selectedPeer) return;

      // Add files to queue
      const fileQueue = files.map((file, index) => ({
        id: `${Date.now()}-${index}`,
        file,
        targetId: selectedPeer.id,
        targetName: selectedPeer.name,
        status: 'pending',
        progress: 0,
      }));

      setSendingQueue(prev => [...prev, ...fileQueue]);
      setStatusMessage(`Added ${files.length} file(s) to queue`);
      event.target.value = "";
    },
    [selectedPeer]
  );

  // Process sending queue
  useEffect(() => {
    if (isSending || sendingQueue.length === 0) return;

    const nextFile = sendingQueue.find(f => f.status === 'pending');
    if (!nextFile) return;

    const sendNextFile = async () => {
      setIsSending(true);
      setCurrentSendingFile(nextFile);
      
      // Update status to sending
      setSendingQueue(prev => 
        prev.map(f => f.id === nextFile.id ? { ...f, status: 'sending' } : f)
      );

      setStatusMessage(`Sending "${nextFile.file.name}" to ${nextFile.targetName}...`);

      try {
        await sendFile({
          file: nextFile.file,
          targetId: nextFile.targetId,
          peers: peersRef.current,
          onProgress: ({ sentBytes, totalBytes }) => {
            const percent = totalBytes
              ? Math.min(100, Math.round((sentBytes / totalBytes) * 100))
              : 100;

            setStatusMessage(
              `Sending "${nextFile.file.name}" to ${nextFile.targetName} (${percent}%)`
            );

            // Update progress in queue
            setSendingQueue(prev =>
              prev.map(f => f.id === nextFile.id ? { ...f, progress: percent } : f)
            );
          },
        });

        // Mark as completed
        setSendingQueue(prev =>
          prev.map(f => f.id === nextFile.id ? { ...f, status: 'completed', progress: 100 } : f)
        );

        setStatusMessage(`Sent "${nextFile.file.name}" to ${nextFile.targetName}`);
        
        // Remove completed file after a delay
        setTimeout(() => {
          setSendingQueue(prev => prev.filter(f => f.id !== nextFile.id));
        }, 2000);

      } catch (error) {
        console.error("Failed to send file", error);
        
        // Mark as failed
        setSendingQueue(prev =>
          prev.map(f => f.id === nextFile.id ? { ...f, status: 'failed' } : f)
        );

        setStatusMessage(`Failed to send "${nextFile.file.name}": ${error.message}`);
        
        // Remove failed file after delay
        setTimeout(() => {
          setSendingQueue(prev => prev.filter(f => f.id !== nextFile.id));
        }, 3000);
      } finally {
        setIsSending(false);
        setCurrentSendingFile(null);
      }
    };

    sendNextFile();
  }, [sendingQueue, isSending]);

  const appClassName = useMemo(() => {
    if (isLoadingPeers && availablePeers.length === 0) {
      return "app loading";
    }

    return "app";
  }, [availablePeers.length, isLoadingPeers]);

  return (
    <>
      {incomingFileRequest && (
        <FileTransferToast
          fileName={incomingFileRequest.fileName}
          fileSize={incomingFileRequest.fileSize}
          totalChunks={incomingFileRequest.totalChunks}
          onAccept={handleAcceptFile}
          onReject={handleRejectFile}
        />
      )}

      {receivingFileProgress && (
        <FileTransferProgress
          fileName={receivingFileProgress.fileName}
          progress={receivingFileProgress.progress}
          receivedBytes={receivingFileProgress.receivedBytes}
          totalBytes={receivingFileProgress.totalBytes}
          receivedChunks={receivingFileProgress.receivedChunks}
          totalChunks={receivingFileProgress.totalChunks}
        />
      )}

      <SendingQueue queue={sendingQueue} />

      <header>
        <i
          className="bi bi-file-earmark-arrow-up-fill"
          style={{ fontSize: 48, width: 48, height: 48 }}
        />
        <div className="logo">
          <h1>SnapIt</h1>
          <p>Share files with nearby devices</p>
        </div>
      </header>

      <main className={appClassName}>
        <section className="device-indicator" role="status" aria-live="polite">
          <span className="indicator-dot" aria-hidden="true" />
          <div className="indicator-text">
            <span className="indicator-label">Your device is</span>
            <div className="indicator-value">
              {(() => {
                const label = deviceName ?? "Device-???";
                if (!label.includes("-")) {
                  return <span className="indicator-prefix">{label}</span>;
                }

                const [prefix, suffix = "---"] = label.split("-");
                return (
                  <>
                    <span className="indicator-prefix">{`${prefix}-`}</span>
                    <span className="indicator-number">{suffix || "---"}</span>
                  </>
                );
              })()}
            </div>
          </div>
        </section>

        <h3>Available Devices</h3>

        <div id="peers">
          {availablePeers
            .filter((peer) => peer.id !== myIdRef.current)
            .map((peer) => {
              const isSelected = peer.id === selectedPeerId;
              const connectionState = connectionStates[peer.id];

              return (
                <div
                  key={peer.id}
                  className={`peer${isSelected ? " selected" : ""}`}
                  onClick={() => handlePeerSelection(peer)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handlePeerSelection(peer);
                    }
                  }}
                  aria-pressed={isSelected}
                >
                  <span>{peer.name}</span>
                  {connectionState && (
                    <small
                      style={{
                        marginLeft: "auto",
                        color: "var(--color-accent)",
                        fontWeight: 500,
                      }}
                    >
                      {connectionState}
                    </small>
                  )}
                </div>
              );
            })}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          id="fileInput"
          multiple
          style={{ display: "none" }}
          onChange={handleFileInputChange}
        />

        <button
          id="sendFileBtn"
          type="button"
          onClick={handleSendButtonClick}
          disabled={!selectedPeer}
        >
          {selectedPeer
            ? sendingQueue.length > 0
              ? `Send More to ${selectedPeer.name}`
              : `Send Files to ${selectedPeer.name}`
            : "Select Files"}
        </button>

        {statusMessage && (
          <p
            style={{
              marginTop: "1rem",
              textAlign: "center",
              color: "#fff",
              opacity: 0.85,
            }}
          >
            {statusMessage}
          </p>
        )}
      </main>
    </>
  );
}

export default App;
