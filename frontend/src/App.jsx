import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { handleOffer, initPeerConnection, sendFile, sendBatchMetadata, sendFileChunksOnly } from "./lib/peer.js";
import IncomingFilesDialog from "./components/IncomingFilesDialog.jsx";
import ReceivingProgress from "./components/ReceivingProgress.jsx";
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
  const [pendingIncomingFiles, setPendingIncomingFiles] = useState([]);
  const [activeReceivingTransfers, setActiveReceivingTransfers] = useState([]);
  const [sendingQueue, setSendingQueue] = useState([]);
  const [currentSendingFile, setCurrentSendingFile] = useState(null);
  
  const pendingFileRequestsRef = useRef(new Map()); // fileId -> { metadata, onAccept, onReject }
  const incomingBatchBufferRef = useRef([]); // temp buffer to batch incoming file metadata
  const batchTimerRef = useRef(null); // debounce timer for batching
  const hasShownDialogRef = useRef(false); // track if we've shown dialog for current batch

  const socketRef = useRef(null);
  const peersRef = useRef({});
  const myIdRef = useRef(null);
  const fileInputRef = useRef(null);

  const selectedPeer = useMemo(
    () => availablePeers.find((peer) => peer.id === selectedPeerId) ?? null,
    [availablePeers, selectedPeerId]
  );

  // Handle file rejection from receiver
  useEffect(() => {
    window.handleFileRejection = (transferId) => {
      console.log(`File ${transferId} was rejected by receiver`);
      
      // Remove from sending queue or mark as rejected
      setSendingQueue(prev => {
        const updated = prev.map(f => {
          if (f.id === transferId) {
            return { ...f, status: 'rejected', progress: 0 };
          }
          return f;
        });
        
        // Remove rejected file after a short delay
        setTimeout(() => {
          setSendingQueue(current => current.filter(f => f.id !== transferId));
        }, 2000);
        
        return updated;
      });
      
      setStatusMessage(`File was rejected by receiver`);
    };

    return () => {
      delete window.handleFileRejection;
    };
  }, []);

  const updateConnectionState = useCallback((peerId, state) => {
    setConnectionStates((prev) => ({ ...prev, [peerId]: state }));

    if (state === "failed" || state === "closed") {
      delete peersRef.current[peerId];
    }
  }, []);

  const triggerFileDownload = useCallback(({ name, blob, transferId }) => {
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
    
    // Remove from active transfers
    if (transferId) {
      setActiveReceivingTransfers(prev => prev.filter(t => t.id !== transferId));
    }
  }, []);

  const handleIncomingFileRequest = useCallback((metadata, onAccept, onReject) => {
    console.log('handleIncomingFileRequest called with metadata:', metadata);
    
    const fileData = {
      id: metadata.id,
      name: metadata.name,
      size: metadata.size,
      totalChunks: metadata.totalChunks,
    };

    // Store callbacks for this file id
    pendingFileRequestsRef.current.set(metadata.id, { metadata, onAccept, onReject });

    // Push into batch buffer if not present
    const existsInBuffer = incomingBatchBufferRef.current.some((f) => f.id === fileData.id);
    if (!existsInBuffer) {
      incomingBatchBufferRef.current.push(fileData);
      console.log('Added file to buffer:', fileData.name, 'Buffer size:', incomingBatchBufferRef.current.length);
    }

    // Update state function
    const updateState = () => {
      // Create a copy of the buffer to work with
      const bufferCopy = [...incomingBatchBufferRef.current];
      console.log('Updating pendingIncomingFiles. Buffer:', bufferCopy.map(f => f.name));
      
      // Mark that we've started showing dialog BEFORE state update
      if (bufferCopy.length > 0) {
        hasShownDialogRef.current = true;
      }
      
      setPendingIncomingFiles((prev) => {
        // Merge existing pending list with buffer (unique by id)
        const byId = new Map(prev.map((f) => [f.id, f]));
        for (const f of bufferCopy) {
          byId.set(f.id, f);
        }
        const newFiles = Array.from(byId.values());
        console.log('New pendingIncomingFiles count:', newFiles.length, 'prev count:', prev.length, 'buffer count:', bufferCopy.length);
        // Clear buffer only after we've used it
        incomingBatchBufferRef.current = [];
        return newFiles;
      });
      batchTimerRef.current = null;
    };

    // Always debounce, but use a shorter delay if dialog hasn't been shown yet
    // This ensures all files arriving in quick succession are grouped together
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
    }
    
    // Use shorter delay (100ms) if this is the first batch, longer (250ms) if dialog already showing
    const delay = hasShownDialogRef.current ? 250 : 100;
    console.log(`Scheduling state update in ${delay}ms. Buffer size:`, incomingBatchBufferRef.current.length, 'hasShownDialog:', hasShownDialogRef.current);
    
    batchTimerRef.current = setTimeout(() => {
      // Double-check buffer still has items before updating
      if (incomingBatchBufferRef.current.length > 0) {
        updateState();
      } else {
        console.log('Timer fired but buffer is empty, skipping update');
        batchTimerRef.current = null;
      }
    }, delay);
  }, []);

  const handleAcceptFiles = useCallback((selectedFiles) => {
    selectedFiles.forEach(file => {
      const request = pendingFileRequestsRef.current.get(file.id);
      if (request) {
        request.onAccept();
        
        // Add to active transfers
        setActiveReceivingTransfers(prev => [...prev, {
          id: file.id,
          fileName: file.name,
          totalBytes: file.size,
          receivedBytes: 0,
          totalChunks: file.totalChunks,
          receivedChunks: 0,
        }]);
        
        pendingFileRequestsRef.current.delete(file.id);
      }
    });
    
    // Clear dialog list and any in-flight buffer/timer
    setPendingIncomingFiles([]);
    incomingBatchBufferRef.current = [];
    hasShownDialogRef.current = false;
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    setStatusMessage(`Accepting ${selectedFiles.length} file(s)...`);
  }, []);

  const handleRejectFiles = useCallback((rejectedFiles) => {
    // Reject the specified files
    rejectedFiles.forEach(file => {
      const request = pendingFileRequestsRef.current.get(file.id);
      if (request) {
        request.onReject();
        pendingFileRequestsRef.current.delete(file.id);
      }
    });
    
    setPendingIncomingFiles([]);
    hasShownDialogRef.current = false;
    
    if (rejectedFiles.length > 0) {
      setStatusMessage(`Rejected ${rejectedFiles.length} file(s)`);
    }
  }, []);

  const handleReceiveProgress = useCallback((progressData) => {
    if (progressData.direction === "inbound") {
      setActiveReceivingTransfers(prev => 
        prev.map(transfer => {
          if (transfer.id === progressData.metadata.id) {
            return {
              ...transfer,
              receivedBytes: progressData.receivedBytes,
              receivedChunks: progressData.receivedChunks,
            };
          }
          return transfer;
        })
      );
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

      try {
        // Send batch metadata first so receiver sees all files at once
        const filesMetadata = await sendBatchMetadata({
          files,
          targetId: selectedPeer.id,
          peers: peersRef.current,
        });

        // Add files to queue with their metadata
        const fileQueue = files.map((file, index) => ({
          id: filesMetadata[index].id,
          file,
          metadata: filesMetadata[index],
          targetId: selectedPeer.id,
          targetName: selectedPeer.name,
          status: 'pending',
          progress: 0,
        }));

        setSendingQueue(prev => [...prev, ...fileQueue]);
        setStatusMessage(`Added ${files.length} file(s) to queue`);
      } catch (error) {
        console.error("Failed to send batch metadata", error);
        setStatusMessage(`Failed to prepare files: ${error.message}`);
      }
      
      event.target.value = "";
    },
    [selectedPeer]
  );

  // Process sending queue
  useEffect(() => {
    if (isSending || sendingQueue.length === 0) return;

    // Skip rejected files and find next pending file
    const nextFile = sendingQueue.find(f => f.status === 'pending');
    if (!nextFile) {
      // Check if there are any rejected files to clean up
      const hasRejected = sendingQueue.some(f => f.status === 'rejected');
      if (hasRejected) {
        // Clean up rejected files
        setTimeout(() => {
          setSendingQueue(prev => prev.filter(f => f.status !== 'rejected'));
        }, 100);
      }
      return;
    }

    const sendNextFile = async () => {
      setIsSending(true);
      setCurrentSendingFile(nextFile);
      
      // Update status to sending
      setSendingQueue(prev => 
        prev.map(f => f.id === nextFile.id ? { ...f, status: 'sending' } : f)
      );

      setStatusMessage(`Sending "${nextFile.file.name}" to ${nextFile.targetName}...`);

      try {
        // Use sendFileChunksOnly since metadata was already sent in batch
        await sendFileChunksOnly({
          file: nextFile.file,
          metadata: nextFile.metadata,
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
      {pendingIncomingFiles.length > 0 && (
        <IncomingFilesDialog
          files={pendingIncomingFiles}
          onAccept={handleAcceptFiles}
          onReject={handleRejectFiles}
        />
      )}
      
      {/* Debug: Show pending files count */}
      {process.env.NODE_ENV === 'development' && (
        <div style={{ position: 'fixed', bottom: 10, right: 10, background: 'rgba(0,0,0,0.8)', color: 'white', padding: '10px', borderRadius: '5px', zIndex: 10000, fontSize: '12px' }}>
          Pending files: {pendingIncomingFiles.length}<br/>
          Buffer: {incomingBatchBufferRef.current.length}
        </div>
      )}

      <ReceivingProgress transfers={activeReceivingTransfers} />
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
