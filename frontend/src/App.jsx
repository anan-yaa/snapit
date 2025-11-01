import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { handleOffer, initPeerConnection, sendFile } from "./lib/peer.js";

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
    [registerPeer, triggerFileDownload]
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
      }).catch((error) => {
        console.error("Failed to start peer connection", error);
        setStatusMessage(`Unable to connect to ${peer.name}`);
        updateConnectionState(peer.id, "failed");
      });
    },
    [registerPeer, triggerFileDownload, updateConnectionState]
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
      const file = event.target.files?.[0];
      if (!file || !selectedPeer) return;

      setIsSending(true);
      setStatusMessage(`Sending "${file.name}" to ${selectedPeer.name}...`);

      try {
        await sendFile({
          file,
          targetId: selectedPeer.id,
          peers: peersRef.current,
          onProgress: ({ sentBytes, totalBytes }) => {
            const percent = totalBytes
              ? Math.min(100, Math.round((sentBytes / totalBytes) * 100))
              : 100;

            setStatusMessage(
              `Sending "${file.name}" to ${selectedPeer.name} (${percent}%)`
            );
          },
        });

        setStatusMessage(`Sent "${file.name}" to ${selectedPeer.name}`);
      } catch (error) {
        console.error("Failed to send file", error);
        setStatusMessage(error.message || "Failed to send file");
      } finally {
        setIsSending(false);
        event.target.value = "";
      }
    },
    [selectedPeer]
  );

  const appClassName = useMemo(() => {
    if (isLoadingPeers && availablePeers.length === 0) {
      return "app loading";
    }

    return "app";
  }, [availablePeers.length, isLoadingPeers]);

  return (
    <>
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
          style={{ display: "none" }}
          onChange={handleFileInputChange}
        />

        <button
          id="sendFileBtn"
          type="button"
          onClick={handleSendButtonClick}
          disabled={!selectedPeer || isSending}
        >
          {isSending
            ? "Sending..."
            : selectedPeer
            ? `Send to ${selectedPeer.name}`
            : "Select File"}
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
